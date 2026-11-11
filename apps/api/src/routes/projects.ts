import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { writeAudit } from '../http/audit';
import { requireAuth, requireCsrf } from '../http/auth';
import { assertProjectAccess, requireSysAdmin } from '../http/auth';
import { ApiError } from '../http/errors';

const router = Router();
router.use(requireAuth);
router.use(requireCsrf);

/**
 * 项目编码统一规则：去除首尾空格后转为大写，只允许字母、数字、下划线和连字符。
 * 唯一性按“不区分大小写”判断，避免大小写不同的编码被当成两个项目。
 */
const projectCodeSchema = z
  .string()
  .trim()
  .min(2, '项目编码至少 2 个字符')
  .max(40, '项目编码最多 40 个字符')
  .regex(/^[A-Za-z0-9_-]+$/, '项目编码仅允许字母、数字、下划线和连字符')
  .transform((value) => value.toUpperCase());

const projectCreateSchema = z.object({
  code: projectCodeSchema,
  name: z.string().trim().min(2, '项目名称至少 2 个字符').max(80, '项目名称最多 80 个字符'),
  description: z.string().trim().max(500, '项目说明最多 500 个字符').optional().nullable(),
});

const projectUpdateSchema = z.object({
  code: projectCodeSchema.optional(),
  name: z.string().trim().min(2, '项目名称至少 2 个字符').max(80, '项目名称最多 80 个字符').optional(),
  description: z.string().trim().max(500, '项目说明最多 500 个字符').optional().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  /** 前端读取到的原编码，用于防止两人同时修改时静默覆盖。 */
  expectedCode: z.string().trim().max(40).optional(),
});

/** 编码是否已被其他项目占用（不区分大小写）。 */
async function isCodeTaken(code: string, excludeProjectId?: string): Promise<boolean> {
  const found = await prisma.project.findFirst({
    where: {
      code: { equals: code, mode: 'insensitive' },
      ...(excludeProjectId ? { id: { not: excludeProjectId } } : {}),
    },
    select: { id: true },
  });
  return Boolean(found);
}

/** 当前用户可见项目的基础范围：管理员可管理全部；其他角色仅可见被授权项目。 */
async function visibleProjectIds(userId: string, role: string): Promise<string[] | 'ALL'> {
  if (role === 'SYS_ADMIN') return 'ALL';
  const memberships = await prisma.projectMember.findMany({
    where: { userId },
    select: { projectId: true },
  });
  return memberships.map((m) => m.projectId);
}

router.get('/', async (req, res) => {
  const user = req.user!;
  const scope = await visibleProjectIds(user.id, user.role);
  const keyword = String(req.query.keyword ?? '').trim();
  const status = String(req.query.status ?? '').trim();

  const where: Prisma.ProjectWhereInput = {
    ...(scope === 'ALL' ? {} : { id: { in: scope } }),
    ...(status === 'ACTIVE' || status === 'ARCHIVED' ? { status: status as 'ACTIVE' | 'ARCHIVED' } : {}),
    ...(keyword
      ? {
          OR: [
            { name: { contains: keyword, mode: 'insensitive' as const } },
            { code: { contains: keyword, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const projects = await prisma.project.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { members: true } } },
  });

  res.json({
    data: projects.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      description: p.description,
      status: p.status,
      memberCount: p._count.members,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
    meta: { scope: scope === 'ALL' ? 'ALL' : 'GRANTED', total: projects.length },
  });
});

router.get('/summary', async (req, res) => {
  const user = req.user!;
  const scope = await visibleProjectIds(user.id, user.role);
  const base = scope === 'ALL' ? {} : { id: { in: scope } };

  const [total, active, archived] = await Promise.all([
    prisma.project.count({ where: base }),
    prisma.project.count({ where: { ...base, status: 'ACTIVE' } }),
    prisma.project.count({ where: { ...base, status: 'ARCHIVED' } }),
  ]);

  res.json({
    data: {
      total,
      active,
      archived,
      scope: scope === 'ALL' ? 'ALL' : 'GRANTED',
      dataCutoff: new Date().toISOString(),
    },
  });
});

router.post('/', async (req, res) => {
  // 项目的创建仅由系统管理员负责；管理员不因此自动获得项目经营数据权限。
  const user = requireSysAdmin(req);

  const parsed = projectCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '项目信息不完整');
  }

  const exists = await isCodeTaken(parsed.data.code);
  if (exists) throw ApiError.conflict('项目编码已存在（不区分大小写），请更换编码', 'E_DUPLICATE_CODE');

  const project = await prisma.project.create({
    data: {
      code: parsed.data.code,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      createdById: user.id,
    },
  });

  await writeAudit({
    req,
    action: 'PROJECT_CREATE',
    objectType: 'Project',
    objectId: project.id,
    projectId: project.id,
    after: { code: project.code, name: project.name, status: project.status },
  });

  res.status(201).json({ data: project });
});

router.get('/:id', async (req, res) => {
  const project = await assertProjectAccess(req, req.params.id, 'read');
  const members = await prisma.projectMember.findMany({
    where: { projectId: project.id },
    include: { user: { select: { id: true, username: true, displayName: true, role: true } } },
  });

  res.json({
    data: {
      ...project,
      members: members.map((m) => ({
        userId: m.userId,
        displayName: m.user.displayName,
        username: m.user.username,
        roleCode: m.roleCode,
        canViewProfit: m.canViewProfit,
        canViewPrice: m.canViewPrice,
      })),
    },
  });
});

router.patch('/:id', async (req, res) => {
  // 项目基础信息（含编码）仅系统管理员可修改。
  requireSysAdmin(req);
  const project = await assertProjectAccess(req, req.params.id, 'write');

  const parsed = projectUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '项目信息不完整');
  }

  // 并发保护：前端带上读取时的原编码，若已被他人改动则拒绝，避免静默覆盖。
  const expectedCode = parsed.data.expectedCode?.toUpperCase();
  if (expectedCode && expectedCode !== project.code) {
    throw ApiError.conflict(
      `项目编码已被他人修改为 ${project.code}，请刷新后重新编辑`,
      'E_STALE_WRITE',
    );
  }

  const nextCode = parsed.data.code;
  if (nextCode && nextCode !== project.code && (await isCodeTaken(nextCode, project.id))) {
    throw ApiError.conflict('项目编码已存在（不区分大小写），请更换编码', 'E_DUPLICATE_CODE');
  }

  const updated = await prisma.project.update({
    where: { id: project.id },
    data: {
      ...(nextCode !== undefined ? { code: nextCode } : {}),
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    },
  });

  await writeAudit({
    req,
    action: 'PROJECT_UPDATE',
    objectType: 'Project',
    objectId: project.id,
    projectId: project.id,
    before: { code: project.code, name: project.name, description: project.description, status: project.status },
    after: { code: updated.code, name: updated.name, description: updated.description, status: updated.status },
  });

  res.json({ data: updated });
});

/**
 * 项目删除前的业务依赖检查（在数据库事务内执行）。
 * 已实现的关联：项目成员授权 → 随项目清理，不阻断删除。
 * 审计记录不阻断删除：项目审计保留，只把项目ID置空，操作人与名称文字快照不变。
 * 成本业务（第四轮）：存在批准目标、已确认成本、冲销或审批记录 → 拒绝删除并提示归档；
 * 存在目标草稿、实际草稿等关联 → 同样阻断并提示先处理，不静默级联删除。
 * 后续新增收入与收付款、批准预测、附件等业务表时，必须在本函数登记对应检查。
 */
async function findDeleteBlockers(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<string[]> {
  const blockers: string[] = [];

  const approvedTargets = await tx.targetCostVersion.count({
    where: { projectId, status: 'APPROVED' },
  });
  if (approvedTargets > 0) blockers.push(`已批准目标成本 ${approvedTargets} 个版本`);

  const confirmedEntries = await tx.actualCostEntry.count({
    where: { projectId, status: 'CONFIRMED' },
  });
  if (confirmedEntries > 0) blockers.push(`已确认实际成本 ${confirmedEntries} 条`);

  const reversals = await tx.costReversalRequest.count({ where: { projectId } });
  if (reversals > 0) blockers.push(`冲销记录 ${reversals} 条`);

  const draftTargets = await tx.targetCostVersion.count({
    where: { projectId, status: { in: ['DRAFT', 'SUBMITTED', 'RETURNED'] } },
  });
  if (draftTargets > 0) blockers.push(`待处理目标版本 ${draftTargets} 个（请先处理或删除草稿）`);

  const draftEntries = await tx.actualCostEntry.count({
    where: { projectId, status: { in: ['DRAFT', 'SUBMITTED', 'RETURNED'] } },
  });
  if (draftEntries > 0) blockers.push(`待处理实际成本单据 ${draftEntries} 条（请先处理或删除草稿）`);

  // 第五轮：存在有效合同清单项的项目不允许直接删除，请先作废或改用归档
  const activeBoqItems = await tx.projectBoqItem.count({
    where: { projectId, status: 'active' },
  });
  if (activeBoqItems > 0) blockers.push(`合同清单项 ${activeBoqItems} 条（请先作废或改用归档）`);

  return blockers;
}

const projectDeleteSchema = z.object({
  code: z.string().trim().min(1, '请输入项目编码以确认删除'),
});

router.delete('/:id', async (req, res) => {
  // 仅系统管理员可删除项目；其他角色即使直接调用接口也会被拒绝。
  requireSysAdmin(req);

  const parsed = projectDeleteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '请输入项目编码以确认删除');
  }
  const confirmCode = parsed.data.code.toUpperCase();

  const outcome = await prisma.$transaction(async (tx) => {
    // 行级锁住项目，避免检查依赖后、删除前又被并发写入新的业务关联。
    const rows = await tx.$queryRaw<Array<{ id: string; code: string; name: string }>>`
      SELECT "id", "code", "name" FROM "Project" WHERE "id" = ${req.params.id} FOR UPDATE`;
    if (rows.length === 0) return { kind: 'not_found' as const };

    const project = rows[0];
    if (project.code.toUpperCase() !== confirmCode) return { kind: 'code_mismatch' as const, project };

    const blockers = await findDeleteBlockers(tx, project.id);
    if (blockers.length > 0) return { kind: 'blocked' as const, project, blockers };

    // 仅清理项目内的成员授权关系；不删除用户账号、其他项目或任何业务数据。
    await tx.projectMember.deleteMany({ where: { projectId: project.id } });
    await tx.project.delete({ where: { id: project.id } });

    return { kind: 'deleted' as const, project };
  });

  if (outcome.kind === 'not_found') {
    throw ApiError.notFound('项目不存在或已被删除');
  }
  if (outcome.kind === 'code_mismatch') {
    throw ApiError.conflict('项目编码不匹配，未执行删除', 'E_CODE_MISMATCH');
  }
  if (outcome.kind === 'blocked') {
    throw ApiError.conflict(
      `项目存在需保留的业务记录（${outcome.blockers.join('、')}），请改用归档`,
      'E_HAS_BUSINESS',
    );
  }

  // 项目已删除，审计以 projectId=null 单独留存，不随项目消失。
  await writeAudit({
    req,
    action: 'PROJECT_DELETE',
    objectType: 'Project',
    objectId: outcome.project.id,
    projectId: null,
    before: {
      id: outcome.project.id,
      code: outcome.project.code,
      name: outcome.project.name,
    },
    reason: '系统管理员确认删除误建项目',
  });

  res.json({ data: { ok: true } });
});

/** 项目内可授予的角色：项目角色不能用于授予系统管理员身份；已取消的“公司管理层”不再授予。 */
const PROJECT_ROLE_CODES = ['PROJECT_LEAD', 'COST_ENGINEER', 'FIELD_MANAGER'] as const;
type ProjectRoleCode = (typeof PROJECT_ROLE_CODES)[number];

function parseProjectRole(input: unknown): ProjectRoleCode {
  if (typeof input !== 'string' || !PROJECT_ROLE_CODES.includes(input as ProjectRoleCode)) {
    throw ApiError.badRequest('项目角色仅支持：项目负责人、造价员、项目其他管理人员', 'E_BAD_ROLE');
  }
  return input as ProjectRoleCode;
}

const memberAddSchema = z.object({
  userId: z.string().trim().min(1, '请选择要添加的账号'),
  roleCode: z.unknown(),
  canViewProfit: z.boolean().optional(),
  canViewPrice: z.boolean().optional(),
});

const memberUpdateSchema = z.object({
  roleCode: z.unknown().optional(),
  canViewProfit: z.boolean().optional(),
  canViewPrice: z.boolean().optional(),
});

router.get('/:id/members', async (req, res) => {
  const project = await assertProjectAccess(req, req.params.id, 'read');
  const members = await prisma.projectMember.findMany({
    where: { projectId: project.id },
    orderBy: { grantedAt: 'asc' },
    include: { user: { select: { id: true, username: true, displayName: true, role: true, isActive: true } } },
  });
  res.json({
    data: members.map((m) => ({
      userId: m.userId,
      username: m.user.username,
      displayName: m.user.displayName,
      systemRole: m.user.role,
      userActive: m.user.isActive,
      roleCode: m.roleCode,
      canViewProfit: m.canViewProfit,
      canViewPrice: m.canViewPrice,
      grantedAt: m.grantedAt,
    })),
  });
});

router.post('/:id/members', async (req, res) => {
  requireSysAdmin(req);
  const project = await prisma.project.findUnique({ where: { id: req.params.id } });
  if (!project) throw ApiError.notFound('项目不存在');

  const parsed = memberAddSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '成员信息不完整');
  }
  const roleCode = parseProjectRole(parsed.data.roleCode);

  const target = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
  if (!target || !target.isActive) throw ApiError.badRequest('所选账号不存在或已停用');

  const exists = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: project.id, userId: target.id } },
  });
  if (exists) throw ApiError.conflict('该用户已是项目成员，请勿重复添加', 'E_DUPLICATE_MEMBER');

  const member = await prisma.projectMember.create({
    data: {
      projectId: project.id,
      userId: target.id,
      roleCode,
      canViewProfit: parsed.data.canViewProfit ?? false,
      canViewPrice: parsed.data.canViewPrice ?? false,
    },
  });

  await writeAudit({
    req,
    action: 'MEMBER_ADD',
    objectType: 'ProjectMember',
    objectId: member.id,
    projectId: project.id,
    after: {
      userId: target.id,
      username: target.username,
      roleCode: member.roleCode,
      canViewProfit: member.canViewProfit,
      canViewPrice: member.canViewPrice,
    },
  });

  res.status(201).json({ data: { userId: member.userId, roleCode: member.roleCode } });
});

router.patch('/:id/members/:userId', async (req, res) => {
  requireSysAdmin(req);
  const projectId = req.params.id;
  const targetUserId = req.params.userId;

  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: targetUserId } },
    include: { user: { select: { username: true } } },
  });
  if (!member) throw ApiError.notFound('该用户不是项目成员');

  const parsed = memberUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '成员信息不完整');
  }
  const roleCode = parsed.data.roleCode !== undefined ? parseProjectRole(parsed.data.roleCode) : undefined;

  const before = {
    roleCode: member.roleCode,
    canViewProfit: member.canViewProfit,
    canViewPrice: member.canViewPrice,
  };

  const updated = await prisma.projectMember.update({
    where: { id: member.id },
    data: {
      ...(roleCode !== undefined ? { roleCode } : {}),
      ...(parsed.data.canViewProfit !== undefined ? { canViewProfit: parsed.data.canViewProfit } : {}),
      ...(parsed.data.canViewPrice !== undefined ? { canViewPrice: parsed.data.canViewPrice } : {}),
    },
  });

  await writeAudit({
    req,
    action: 'MEMBER_UPDATE',
    objectType: 'ProjectMember',
    objectId: member.id,
    projectId,
    before: { userId: targetUserId, username: member.user.username, ...before },
    after: {
      userId: targetUserId,
      username: member.user.username,
      roleCode: updated.roleCode,
      canViewProfit: updated.canViewProfit,
      canViewPrice: updated.canViewPrice,
    },
  });

  res.json({
    data: {
      userId: updated.userId,
      roleCode: updated.roleCode,
      canViewProfit: updated.canViewProfit,
      canViewPrice: updated.canViewPrice,
    },
  });
});

router.delete('/:id/members/:userId', async (req, res) => {
  requireSysAdmin(req);
  const projectId = req.params.id;
  const targetUserId = req.params.userId;

  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: targetUserId } },
    include: { user: { select: { username: true } } },
  });
  if (!member) throw ApiError.notFound('该用户不是项目成员');

  // 仅移出项目授权，不删除用户账号，也不影响其历史业务与审计记录。
  await prisma.projectMember.delete({ where: { id: member.id } });

  await writeAudit({
    req,
    action: 'MEMBER_REMOVE',
    objectType: 'ProjectMember',
    objectId: member.id,
    projectId,
    before: {
      userId: targetUserId,
      username: member.user.username,
      roleCode: member.roleCode,
      canViewProfit: member.canViewProfit,
      canViewPrice: member.canViewPrice,
    },
  });

  res.json({ data: { ok: true } });
});

export default router;
