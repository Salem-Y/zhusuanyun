import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { writeAudit } from '../http/audit';
import {
  assertProjectActive,
  assertProjectMembership,
  requireAuth,
  requireCsrf,
  requireProjectRoles,
} from '../http/auth';
import { ApiError } from '../http/errors';
import { parseTaxRate } from '../http/money';

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireCsrf);

const Decimal = Prisma.Decimal;
// 单项工程属于成本/收入基础字典：项目负责人与造价员均可维护
const WRITE_ROLES = ['PROJECT_LEAD', 'COST_ENGINEER'];

const unitBodySchema = z.object({
  name: z.string().trim().min(1, '请填写单项工程名称').max(60, '名称最多 60 字'),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

const unitPatchSchema = z.object({
  name: z.string().trim().min(1, '请填写单项工程名称').max(60, '名称最多 60 字').optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  isActive: z.boolean().optional(),
});

const taxRateSchema = z.object({
  revenueTaxRate: z.union([z.string(), z.number()]),
});

async function assertUnitWrite(req: Parameters<typeof assertProjectMembership>[0], projectId: string) {
  const { project, membership } = await assertProjectMembership(req, projectId);
  requireProjectRoles(membership, WRITE_ROLES, '单项工程仅项目负责人或造价员可维护');
  assertProjectActive(project);
  return { project, membership };
}

/** 单项工程列表（默认含已停用，供成本/清单下拉过滤）。 */
router.get('/:id/unit-projects', async (req, res) => {
  const { project, membership } = await assertProjectMembership(req, req.params.id);
  const units = await prisma.projectUnit.findMany({
    where: { projectId: project.id },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: { _count: { select: { boqItems: true, targetLines: true, actualEntries: true } } },
  });
  res.json({
    data: units.map((u) => ({
      id: u.id,
      name: u.name,
      sortOrder: u.sortOrder,
      isActive: u.isActive,
      boqItemCount: u._count.boqItems,
      targetLineCount: u._count.targetLines,
      actualEntryCount: u._count.actualEntries,
    })),
    meta: { myRole: membership.roleCode, revenueTaxRate: new Decimal(project.revenueTaxRate).toFixed(2) },
  });
});

/** 新增单项工程。 */
router.post('/:id/unit-projects', async (req, res) => {
  const { project } = await assertUnitWrite(req, req.params.id);
  const parsed = unitBodySchema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '信息不完整');

  const duplicate = await prisma.projectUnit.findFirst({
    where: { projectId: project.id, name: parsed.data.name },
    select: { id: true },
  });
  if (duplicate) throw ApiError.conflict('同名单项工程已存在');

  const unit = await prisma.projectUnit.create({
    data: {
      projectId: project.id,
      name: parsed.data.name,
      sortOrder: parsed.data.sortOrder ?? 0,
      createdById: req.user!.id,
    },
  });
  await writeAudit({
    req,
    action: 'UNIT_PROJECT_CREATE',
    objectType: 'ProjectUnit',
    objectId: unit.id,
    projectId: project.id,
    after: { name: unit.name },
  });
  res.status(201).json({ data: { id: unit.id, name: unit.name, sortOrder: unit.sortOrder, isActive: unit.isActive } });
});

/** 编辑名称/排序/启停用。 */
router.patch('/:id/unit-projects/:unitId', async (req, res) => {
  const { project } = await assertUnitWrite(req, req.params.id);
  const parsed = unitPatchSchema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '信息不完整');

  const existing = await prisma.projectUnit.findFirst({
    where: { id: req.params.unitId, projectId: project.id },
  });
  if (!existing) throw ApiError.notFound('单项工程不存在');

  if (parsed.data.name && parsed.data.name !== existing.name) {
    const duplicate = await prisma.projectUnit.findFirst({
      where: { projectId: project.id, name: parsed.data.name, id: { not: existing.id } },
      select: { id: true },
    });
    if (duplicate) throw ApiError.conflict('同名单项工程已存在');
  }

  const unit = await prisma.projectUnit.update({
    where: { id: existing.id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.sortOrder !== undefined ? { sortOrder: parsed.data.sortOrder } : {}),
      ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
    },
  });
  await writeAudit({
    req,
    action: 'UNIT_PROJECT_UPDATE',
    objectType: 'ProjectUnit',
    objectId: unit.id,
    projectId: project.id,
    before: { name: existing.name, isActive: existing.isActive },
    after: { name: unit.name, isActive: unit.isActive },
  });
  res.json({ data: { id: unit.id, name: unit.name, sortOrder: unit.sortOrder, isActive: unit.isActive } });
});

/** 删除：仅当未被清单项/成本明细引用时允许物理删除，否则提示改用停用。 */
router.delete('/:id/unit-projects/:unitId', async (req, res) => {
  const { project } = await assertUnitWrite(req, req.params.id);
  const existing = await prisma.projectUnit.findFirst({
    where: { id: req.params.unitId, projectId: project.id },
  });
  if (!existing) throw ApiError.notFound('单项工程不存在');

  const [boqCount, targetCount, actualCount] = await Promise.all([
    prisma.projectBoqItem.count({ where: { unitProjectId: existing.id } }),
    prisma.targetCostLine.count({ where: { unitProjectId: existing.id } }),
    prisma.actualCostEntry.count({ where: { unitProjectId: existing.id } }),
  ]);
  if (boqCount + targetCount + actualCount > 0) {
    throw ApiError.conflict(
      `该单项工程已被 ${boqCount + targetCount + actualCount} 条业务数据引用，不能删除；可改为停用`,
      'E_UNIT_PROJECT_REFERENCED',
    );
  }

  await prisma.projectUnit.delete({ where: { id: existing.id } });
  await writeAudit({
    req,
    action: 'UNIT_PROJECT_DELETE',
    objectType: 'ProjectUnit',
    objectId: existing.id,
    projectId: project.id,
    before: { name: existing.name },
  });
  res.json({ data: { id: existing.id, deleted: true } });
});

/** 设置收入建安税率（仅项目负责人）。 */
router.put('/:id/revenue-tax-rate', async (req, res) => {
  const { project, membership } = await assertProjectMembership(req, req.params.id);
  requireProjectRoles(membership, ['PROJECT_LEAD'], '收入建安税率仅项目负责人可设置');
  assertProjectActive(project);

  const parsed = taxRateSchema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest('税率不合法');
  const rate = parseTaxRate(parsed.data.revenueTaxRate, '收入建安税率');

  const updated = await prisma.project.update({
    where: { id: project.id },
    data: { revenueTaxRate: rate },
  });
  await writeAudit({
    req,
    action: 'PROJECT_REVENUE_TAX_RATE_UPDATE',
    objectType: 'Project',
    objectId: project.id,
    projectId: project.id,
    before: { revenueTaxRate: new Decimal(project.revenueTaxRate).toFixed(2) },
    after: { revenueTaxRate: rate.toFixed(2) },
  });
  res.json({ data: { revenueTaxRate: new Decimal(updated.revenueTaxRate).toFixed(2) } });
});

export default router;
