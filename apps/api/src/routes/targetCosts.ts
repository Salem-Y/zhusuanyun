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
import { outMoney, outQty, parseMoneyInput, parsePrice, parseQuantity, parseTaxRate, sumMoney, taxPair } from '../http/money';

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireCsrf);

const PENDING_STATUSES = ['DRAFT', 'SUBMITTED', 'RETURNED'] as const;

const versionCreateSchema = z.object({
  versionName: z.string().trim().min(1, '请填写版本名称').max(60, '版本名称最多 60 个字符'),
  description: z.string().trim().max(500).optional().nullable(),
  caliberText: z.string().trim().max(1000).optional().nullable(),
  effectiveDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, '适用日期格式为 YYYY-MM-DD').optional().nullable(),
  baseVersionId: z.string().trim().optional().nullable(),
  adjustReason: z.string().trim().max(500).optional().nullable(),
  idempotencyKey: z.string().trim().min(8).max(80),
});

const versionUpdateSchema = z.object({
  versionName: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  caliberText: z.string().trim().max(1000).optional().nullable(),
  effectiveDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

const EXPENSE_CATEGORIES = [
  'labor',
  'material',
  'machine',
  'subcontract',
  'turnover',
  'measure',
  'site_overhead',
  'other',
] as const;

const lineSchema = z.object({
  // 第五轮：关联清单项（可空）＋ 费用类别（必选）
  // 第六轮：单项工程（未关联清单项时必选）＋ 含税/不含税口径
  boqItemId: z.string().trim().min(1).optional().nullable(),
  unitProjectId: z.string().trim().min(1).optional().nullable(),
  category: z.enum(EXPENSE_CATEGORIES, { message: '请选择费用类别' }),
  summary: z.string().trim().min(1, '请填写摘要').max(120, '摘要最多 120 字'),
  pricingMethod: z.enum(['QTY_PRICE', 'LUMP_SUM']),
  quantity: z.union([z.string(), z.number()]).optional().nullable(),
  unit: z.string().trim().max(20).optional().nullable(),
  unitPrice: z.union([z.string(), z.number()]).optional().nullable(),
  amount: z.union([z.string(), z.number()]).optional().nullable(),
  taxRate: z.union([z.string(), z.number()]).optional().nullable(),
  priceTaxIncl: z.boolean().optional(),
  basisNote: z.string().trim().max(300).optional().nullable(),
  sortOrder: z.number().int().optional(),
});

const linesSaveSchema = z.object({
  lines: z.array(lineSchema).max(500, '单版本明细最多 500 行'),
});

const decisionSchema = z.object({
  comment: z.string().trim().max(300).optional().nullable(),
});

const returnSchema = z.object({
  comment: z.string().trim().min(1, '退回时必须填写意见').max(300),
});

async function lockVersion(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT "id", "status" FROM "TargetCostVersion" WHERE "id" = ${id} FOR UPDATE`;
  return rows[0] ?? null;
}

/** 金额统一输出 2 位小数字符串；数量/单价保留原始精度字符串。 */
const serializeVersion = <T extends { totalAmount: Prisma.Decimal | null }>(v: T) => ({
  ...v,
  totalAmount: outMoney(v.totalAmount),
});
const serializeLine = <
  T extends {
    quantity: Prisma.Decimal | null;
    unitPrice: Prisma.Decimal | null;
    amount: Prisma.Decimal | null;
    taxRate?: Prisma.Decimal | null;
    unitPriceTaxIncl?: Prisma.Decimal | null;
    unitPriceTaxExcl?: Prisma.Decimal | null;
    amountTaxIncl?: Prisma.Decimal | null;
    amountTaxExcl?: Prisma.Decimal | null;
  },
>(
  l: T,
) => ({
  ...l,
  quantity: outQty(l.quantity),
  unitPrice: outMoney(l.unitPrice),
  amount: outMoney(l.amount),
  taxRate: l.taxRate === null || l.taxRate === undefined ? null : new Prisma.Decimal(l.taxRate).toFixed(2),
  unitPriceTaxIncl: outMoney(l.unitPriceTaxIncl ?? null),
  unitPriceTaxExcl: outMoney(l.unitPriceTaxExcl ?? null),
  amountTaxIncl: outMoney(l.amountTaxIncl ?? null),
  amountTaxExcl: outMoney(l.amountTaxExcl ?? null),
});

/** 校验并规范化明细行；返回可写入的数据与合计。 */
async function normalizeLines(projectId: string, lines: z.infer<typeof lineSchema>[]) {
  // 清单项（可空）必须属于本项目且为有效状态
  const boqIds = [...new Set(lines.map((l) => l.boqItemId).filter((v): v is string => Boolean(v)))];
  const boqItems = boqIds.length
    ? await prisma.projectBoqItem.findMany({ where: { id: { in: boqIds }, projectId } })
    : [];
  const boqMap = new Map(boqItems.map((b) => [b.id, b]));

  // 单项工程必须属于本项目且未停用（含由清单项自动带出的单项工程）
  const unitIds = [
    ...new Set(
      lines
        .map(
          (l) =>
            l.unitProjectId ??
            (l.boqItemId ? boqMap.get(l.boqItemId)?.unitProjectId ?? null : null),
        )
        .filter((v): v is string => Boolean(v)),
    ),
  ];
  const units = unitIds.length
    ? await prisma.projectUnit.findMany({ where: { id: { in: unitIds }, projectId, isActive: true }, select: { id: true } })
    : [];
  const unitSet = new Set(units.map((u) => u.id));

  return lines.map((line, index) => {
    let boqItemName: string | null = null;
    let unitProjectId = line.unitProjectId ?? null;
    if (line.boqItemId) {
      const boq = boqMap.get(line.boqItemId);
      if (!boq) throw ApiError.badRequest(`第 ${index + 1} 行：清单项不存在或不属于本项目`);
      if (boq.status !== 'active') throw ApiError.badRequest(`第 ${index + 1} 行：清单项「${boq.itemName}」已合并或作废`);
      boqItemName = boq.itemName;
      // 选了清单项则自动带出所属单项工程；显式传入时必须一致
      if (!unitProjectId) unitProjectId = boq.unitProjectId ?? null;
      else if (boq.unitProjectId && boq.unitProjectId !== unitProjectId) {
        throw ApiError.badRequest(`第 ${index + 1} 行：单项工程与清单项所属单项工程不一致`);
      }
    }
    if (!unitProjectId) {
      throw ApiError.badRequest(`第 ${index + 1} 行：未关联清单项时必须选择单项工程`);
    }
    if (!unitSet.has(unitProjectId)) {
      throw ApiError.badRequest(`第 ${index + 1} 行：单项工程不存在或已停用`);
    }

    const taxRate = line.taxRate === null || line.taxRate === undefined || line.taxRate === ''
      ? null
      : parseTaxRate(line.taxRate, `第 ${index + 1} 行税率`);
    const priceTaxIncl = line.priceTaxIncl ?? true;

    let quantity: Prisma.Decimal | null = null;
    let unitPrice: Prisma.Decimal | null = null;
    let amountInput: Prisma.Decimal | null = null;
    let unitPriceTaxIncl: Prisma.Decimal | null = null;
    let unitPriceTaxExcl: Prisma.Decimal | null = null;
    if (line.pricingMethod === 'QTY_PRICE') {
      quantity = parseQuantity(line.quantity, `第 ${index + 1} 行数量`);
      unitPrice = parsePrice(line.unitPrice, `第 ${index + 1} 行单价`);
      if (!line.unit?.trim()) throw ApiError.badRequest(`第 ${index + 1} 行：数量×单价必须填写单位`);
      const pair = taxPair(unitPrice, taxRate, priceTaxIncl);
      unitPriceTaxIncl = pair.incl;
      unitPriceTaxExcl = pair.excl;
    } else {
      amountInput = parseMoneyInput(line.amount, `第 ${index + 1} 行金额`);
      if (!line.basisNote?.trim()) {
        throw ApiError.badRequest(`第 ${index + 1} 行：按总额登记必须填写依据说明`);
      }
    }

    const amountTax = amountInput !== null
      ? taxPair(amountInput, taxRate, priceTaxIncl)
      : {
          incl: roundMoneySafe(quantity, unitPriceTaxIncl),
          excl: roundMoneySafe(quantity, unitPriceTaxExcl),
        };
    // 成本口径：amount 统一为不含税金额
    const amount = amountTax.excl;
    if (amount.isNegative()) throw ApiError.badRequest(`第 ${index + 1} 行：目标成本明细不接受负数`);

    return {
      boqItemId: line.boqItemId ?? null,
      boqItemName,
      unitProjectId,
      category: line.category,
      summary: line.summary,
      pricingMethod: line.pricingMethod,
      quantity,
      unit: line.pricingMethod === 'QTY_PRICE' ? line.unit!.trim() : line.unit?.trim() || null,
      unitPrice,
      amount,
      amountTaxIncl: amountTax.incl,
      amountTaxExcl: amountTax.excl,
      priceTaxIncl,
      taxRate,
      unitPriceTaxIncl,
      unitPriceTaxExcl,
      basisNote: line.basisNote?.trim() || null,
      sortOrder: line.sortOrder ?? index,
    };
  });
}

/** 数量 × 单价 → 金额（任一为空按 0），四舍五入到 2 位。 */
function roundMoneySafe(quantity: Prisma.Decimal | null, price: Prisma.Decimal | null): Prisma.Decimal {
  return new Prisma.Decimal(quantity ?? 0).mul(new Prisma.Decimal(price ?? 0)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

const versionSelect = {
  id: true,
  projectId: true,
  versionName: true,
  description: true,
  caliberText: true,
  effectiveDate: true,
  status: true,
  isAdjustment: true,
  baseVersionId: true,
  adjustReason: true,
  isCurrent: true,
  totalAmount: true,
  createdById: true,
  createdByName: true,
  submittedById: true,
  submittedByName: true,
  submittedAt: true,
  decidedById: true,
  decidedByName: true,
  decidedAt: true,
  decisionComment: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TargetCostVersionSelect;

router.get('/:id/target-versions', async (req, res) => {
  const { project } = await assertProjectMembership(req, req.params.id);
  const versions = await prisma.targetCostVersion.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: 'desc' },
    select: {
      ...versionSelect,
      _count: { select: { lines: true } },
      baseVersion: { select: { id: true, versionName: true, totalAmount: true } },
    },
  });
  res.json({
    data: versions.map((v) => ({
      ...serializeVersion(v),
      lineCount: v._count.lines,
      baseVersionName: v.baseVersion?.versionName ?? null,
      baseVersionTotal: outMoney(v.baseVersion?.totalAmount),
      baseVersion: undefined,
      _count: undefined,
    })),
  });
});

router.get('/:id/target-versions/:vid', async (req, res) => {
  const { project } = await assertProjectMembership(req, req.params.id);
  const version = await prisma.targetCostVersion.findFirst({
    where: { id: req.params.vid, projectId: project.id },
    include: {
      lines: {
        orderBy: { sortOrder: 'asc' },
        include: { unitProject: { select: { id: true, name: true } } },
      },
      baseVersion: { select: { id: true, versionName: true, totalAmount: true } },
    },
  });
  if (!version) throw ApiError.notFound('目标版本不存在');

  // 审批/操作记录来自审计日志
  const records = await prisma.auditLog.findMany({
    where: { objectType: 'TargetCostVersion', objectId: version.id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      action: true,
      actorName: true,
      reason: true,
      result: true,
      createdAt: true,
      afterJson: true,
    },
  });
  res.json({
    data: {
      ...serializeVersion(version),
      baseVersion: version.baseVersion
        ? { ...version.baseVersion, totalAmount: outMoney(version.baseVersion.totalAmount) }
        : null,
      lines: version.lines.map(serializeLine),
      records,
    },
  });
});

router.post('/:id/target-versions', async (req, res) => {
  const { project, membership } = await assertProjectMembership(req, req.params.id);
  requireProjectRoles(membership, ['COST_ENGINEER'], '目标成本由造价员编制');
  assertProjectActive(project);

  const parsed = versionCreateSchema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '信息不完整');
  const input = parsed.data;

  // 幂等：同一幂等键重试直接返回已创建的版本
  const replay = await prisma.targetCostVersion.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: versionSelect,
  });
  if (replay) {
    res.json({ data: serializeVersion(replay), meta: { idempotent: true } });
    return;
  }

  // 本轮每项目只保留一个待处理目标草稿，避免并行分支
  const pending = await prisma.targetCostVersion.findFirst({
    where: { projectId: project.id, status: { in: [...PENDING_STATUSES] } },
    select: { id: true, versionName: true, status: true },
  });
  if (pending) {
    throw ApiError.conflict(
      `已存在待处理的目标版本「${pending.versionName}」，请先完成审批或退回后再新建`,
      'E_PENDING_VERSION',
    );
  }

  let baseLines: Prisma.TargetCostLineCreateWithoutVersionInput[] = [];
  let baseTotalAmount = new Prisma.Decimal(0);
  if (input.baseVersionId) {
    const base = await prisma.targetCostVersion.findFirst({
      where: { id: input.baseVersionId, projectId: project.id },
      include: { lines: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!base) throw ApiError.badRequest('调整所基于的原版本不存在');
    if (base.status !== 'APPROVED') throw ApiError.badRequest('只能基于已批准的版本发起调整');
    if (!input.adjustReason?.trim()) throw ApiError.badRequest('调整必须填写调整原因');
    baseTotalAmount = new Prisma.Decimal(base.totalAmount);
    baseLines = base.lines.map((l, i) => ({
      boqItemId: l.boqItemId,
      boqItemName: l.boqItemName,
      unitProjectId: l.unitProjectId,
      category: l.category,
      summary: l.summary,
      pricingMethod: l.pricingMethod,
      quantity: l.quantity,
      unit: l.unit,
      unitPrice: l.unitPrice,
      amount: l.amount,
      amountTaxIncl: l.amountTaxIncl,
      amountTaxExcl: l.amountTaxExcl,
      priceTaxIncl: l.priceTaxIncl,
      taxRate: l.taxRate,
      unitPriceTaxIncl: l.unitPriceTaxIncl,
      unitPriceTaxExcl: l.unitPriceTaxExcl,
      basisNote: l.basisNote,
      sortOrder: i,
    }));
  } else if (input.adjustReason?.trim()) {
    throw ApiError.badRequest('首次编制不需要调整原因；调整原因仅用于基于原版本的调整');
  }

  const total = baseTotalAmount;
  const created = await prisma.targetCostVersion.create({
    data: {
      projectId: project.id,
      versionName: input.versionName,
      description: input.description ?? null,
      caliberText: input.caliberText?.trim() || project.costCaliberNote || null,
      effectiveDate: input.effectiveDate ? new Date(`${input.effectiveDate}T00:00:00.000Z`) : null,
      status: 'DRAFT',
      isAdjustment: Boolean(input.baseVersionId),
      baseVersionId: input.baseVersionId ?? null,
      adjustReason: input.baseVersionId ? input.adjustReason!.trim() : null,
      totalAmount: total,
      createdById: req.user!.id,
      createdByName: req.user!.displayName,
      idempotencyKey: input.idempotencyKey,
      lines: { create: baseLines },
    },
    select: versionSelect,
  });

  await writeAudit({
    req,
    action: input.baseVersionId ? 'TARGET_VERSION_ADJUST_CREATE' : 'TARGET_VERSION_CREATE',
    objectType: 'TargetCostVersion',
    objectId: created.id,
    projectId: project.id,
    after: { versionName: created.versionName, baseVersionId: created.baseVersionId, totalAmount: String(total) },
    reason: input.adjustReason ?? null,
  });
  res.status(201).json({ data: serializeVersion(created) });
});

router.patch('/:id/target-versions/:vid', async (req, res) => {
  const { project } = await assertProjectMembership(req, req.params.id);
  assertProjectActive(project);
  const version = await prisma.targetCostVersion.findFirst({
    where: { id: req.params.vid, projectId: project.id },
  });
  if (!version) throw ApiError.notFound('目标版本不存在');
  if (!['DRAFT', 'RETURNED'].includes(version.status)) {
    throw ApiError.conflict('已提交或已批准的目标版本不能直接编辑', 'E_VERSION_LOCKED');
  }
  if (version.createdById !== req.user!.id) {
    throw ApiError.forbidden('只能编辑自己编制的目标草稿');
  }

  const parsed = versionUpdateSchema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '信息不完整');

  const updated = await prisma.targetCostVersion.update({
    where: { id: version.id },
    data: {
      ...(parsed.data.versionName !== undefined ? { versionName: parsed.data.versionName } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      ...(parsed.data.caliberText !== undefined ? { caliberText: parsed.data.caliberText } : {}),
      ...(parsed.data.effectiveDate !== undefined
        ? { effectiveDate: parsed.data.effectiveDate ? new Date(`${parsed.data.effectiveDate}T00:00:00.000Z`) : null }
        : {}),
    },
    select: versionSelect,
  });
  res.json({ data: serializeVersion(updated) });
});

router.put('/:id/target-versions/:vid/lines', async (req, res) => {
  const { project } = await assertProjectMembership(req, req.params.id);
  assertProjectActive(project);
  const version = await prisma.targetCostVersion.findFirst({
    where: { id: req.params.vid, projectId: project.id },
  });
  if (!version) throw ApiError.notFound('目标版本不存在');
  if (!['DRAFT', 'RETURNED'].includes(version.status)) {
    throw ApiError.conflict('已提交或已批准的目标版本不能直接编辑明细', 'E_VERSION_LOCKED');
  }
  if (version.createdById !== req.user!.id) {
    throw ApiError.forbidden('只能编辑自己编制的目标草稿');
  }

  const parsed = linesSaveSchema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '明细不完整');

  const normalized = await normalizeLines(project.id, parsed.data.lines);
  const total = sumMoney(normalized.map((l) => l.amount));

  await prisma.$transaction(async (tx) => {
    await tx.targetCostLine.deleteMany({ where: { versionId: version.id } });
    await tx.targetCostLine.createMany({ data: normalized.map((l) => ({ ...l, versionId: version.id })) });
    await tx.targetCostVersion.update({ where: { id: version.id }, data: { totalAmount: total } });
  });

  const fresh = await prisma.targetCostVersion.findUnique({
    where: { id: version.id },
    include: { lines: { orderBy: { sortOrder: 'asc' } } },
  });
  res.json({ data: { ...serializeVersion(fresh!), lines: fresh!.lines.map(serializeLine) } });
});

router.delete('/:id/target-versions/:vid', async (req, res) => {
  const { project } = await assertProjectMembership(req, req.params.id);
  assertProjectActive(project);
  const version = await prisma.targetCostVersion.findFirst({
    where: { id: req.params.vid, projectId: project.id },
  });
  if (!version) throw ApiError.notFound('目标版本不存在');
  if (!['DRAFT', 'RETURNED'].includes(version.status)) {
    throw ApiError.conflict('只有草稿或已退回的版本可以删除；已批准版本保留历史', 'E_VERSION_LOCKED');
  }
  if (version.createdById !== req.user!.id) {
    throw ApiError.forbidden('只能删除自己编制的目标草稿');
  }
  await prisma.targetCostVersion.delete({ where: { id: version.id } });
  await writeAudit({
    req,
    action: 'TARGET_VERSION_DELETE',
    objectType: 'TargetCostVersion',
    objectId: version.id,
    projectId: project.id,
    before: { versionName: version.versionName, status: version.status, totalAmount: String(version.totalAmount) },
  });
  res.json({ data: { ok: true } });
});

router.post('/:id/target-versions/:vid/submit', async (req, res) => {
  const { project, membership } = await assertProjectMembership(req, req.params.id);
  requireProjectRoles(membership, ['COST_ENGINEER'], '目标成本由造价员提交');
  assertProjectActive(project);

  const result = await prisma.$transaction(async (tx) => {
    const locked = await lockVersion(tx, req.params.vid);
    if (!locked) return { kind: 'not_found' as const };
    const full = await tx.targetCostVersion.findFirst({
      where: { id: locked.id, projectId: project.id },
      include: { _count: { select: { lines: true } } },
    });
    if (!full) return { kind: 'not_found' as const };

    if (full.status === 'SUBMITTED') {
      // 幂等重放：同一提交人重复提交返回已有结果
      if (full.submittedById === req.user!.id) return { kind: 'replayed' as const, id: full.id };
      return { kind: 'conflict' as const, message: '该版本已提交，请等待审批' };
    }
    if (!['DRAFT', 'RETURNED'].includes(full.status)) {
      return { kind: 'conflict' as const, message: '已批准的版本不能重复提交' };
    }
    if (full.createdById !== req.user!.id) {
      return { kind: 'forbidden' as const, message: '只能提交自己编制的目标版本' };
    }
    if (full._count.lines === 0) {
      return { kind: 'bad' as const, message: '目标明细为空，请先保存至少一行明细' };
    }

    await tx.targetCostVersion.update({
      where: { id: full.id },
      data: {
        status: 'SUBMITTED',
        submittedById: req.user!.id,
        submittedByName: req.user!.displayName,
        submittedAt: new Date(),
        decisionComment: null,
      },
    });
    return { kind: 'ok' as const, id: full.id };
  });

  if (result.kind === 'not_found') throw ApiError.notFound('目标版本不存在');
  if (result.kind === 'forbidden') throw ApiError.forbidden(result.message);
  if (result.kind === 'bad') throw ApiError.badRequest(result.message);
  if (result.kind === 'conflict') throw ApiError.conflict(result.message, 'E_VERSION_STATE');

  if (result.kind === 'ok') {
    await writeAudit({
      req,
      action: 'TARGET_VERSION_SUBMIT',
      objectType: 'TargetCostVersion',
      objectId: result.id,
      projectId: project.id,
    });
  }
  const fresh = await prisma.targetCostVersion.findUnique({ where: { id: result.id }, select: versionSelect });
  res.json({ data: serializeVersion(fresh!), meta: result.kind === 'replayed' ? { idempotent: true } : undefined });
});

router.post('/:id/target-versions/:vid/approve', async (req, res) => {
  const { project, membership } = await assertProjectMembership(req, req.params.id);
  requireProjectRoles(membership, ['PROJECT_LEAD'], '目标成本由项目负责人审批');
  assertProjectActive(project);

  const parsed = decisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '信息不完整');

  const result = await prisma.$transaction(async (tx) => {
    const locked = await lockVersion(tx, req.params.vid);
    if (!locked) return { kind: 'not_found' as const };
    const full = await tx.targetCostVersion.findFirst({
      where: { id: locked.id, projectId: project.id },
    });
    if (!full) return { kind: 'not_found' as const };

    if (full.status === 'APPROVED') {
      if (full.decidedById === req.user!.id) return { kind: 'replayed' as const, id: full.id };
      return { kind: 'conflict' as const, message: '该版本已被批准，请勿重复操作' };
    }
    if (full.status !== 'SUBMITTED') {
      return { kind: 'conflict' as const, message: '只有已提交的版本可以批准' };
    }
    // 职责分离：禁止本人提交又批准
    if (full.submittedById === req.user!.id) {
      return { kind: 'forbidden' as const, message: '不能批准自己提交的版本，请由其他项目负责人审批' };
    }

    // 防止覆盖其他更新：批准新版本时原批准版本必须仍是当前适用版本
    const current = await tx.targetCostVersion.findFirst({
      where: { projectId: project.id, isCurrent: true },
    });
    if (full.baseVersionId) {
      if (!current || current.id !== full.baseVersionId) {
        return {
          kind: 'conflict' as const,
          message: '原批准版本已变化，请基于最新批准版本重新调整后再提交',
        };
      }
    } else if (current) {
      return {
        kind: 'conflict' as const,
        message: `项目已存在适用的批准版本「${current.versionName}」，首次编制口径不能覆盖；请改用「调整目标」`,
      };
    }

    if (current) {
      await tx.targetCostVersion.update({ where: { id: current.id }, data: { isCurrent: false } });
    }
    await tx.targetCostVersion.update({
      where: { id: full.id },
      data: {
        status: 'APPROVED',
        isCurrent: true,
        decidedById: req.user!.id,
        decidedByName: req.user!.displayName,
        decidedAt: new Date(),
        decisionComment: parsed.data.comment ?? null,
      },
    });
    return { kind: 'ok' as const, id: full.id, replacedId: current?.id ?? null };
  });

  if (result.kind === 'not_found') throw ApiError.notFound('目标版本不存在');
  if (result.kind === 'forbidden') throw ApiError.forbidden(result.message);
  if (result.kind === 'conflict') throw ApiError.conflict(result.message, 'E_VERSION_STATE');

  if (result.kind === 'ok') {
    await writeAudit({
      req,
      action: 'TARGET_VERSION_APPROVE',
      objectType: 'TargetCostVersion',
      objectId: result.id,
      projectId: project.id,
      after: { replacedVersionId: result.replacedId },
      reason: parsed.data.comment ?? null,
    });
  }
  const fresh = await prisma.targetCostVersion.findUnique({ where: { id: result.id }, select: versionSelect });
  res.json({ data: serializeVersion(fresh!), meta: result.kind === 'replayed' ? { idempotent: true } : undefined });
});

router.post('/:id/target-versions/:vid/return', async (req, res) => {
  const { project, membership } = await assertProjectMembership(req, req.params.id);
  requireProjectRoles(membership, ['PROJECT_LEAD'], '目标成本由项目负责人审批');
  assertProjectActive(project);

  const parsed = returnSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '退回必须填写意见');

  const result = await prisma.$transaction(async (tx) => {
    const locked = await lockVersion(tx, req.params.vid);
    if (!locked) return { kind: 'not_found' as const };
    const full = await tx.targetCostVersion.findFirst({
      where: { id: locked.id, projectId: project.id },
    });
    if (!full) return { kind: 'not_found' as const };
    if (full.status === 'RETURNED') {
      if (full.decidedById === req.user!.id) return { kind: 'replayed' as const, id: full.id };
      return { kind: 'conflict' as const, message: '该版本已被退回' };
    }
    if (full.status !== 'SUBMITTED') {
      return { kind: 'conflict' as const, message: '只有已提交的版本可以退回' };
    }
    await tx.targetCostVersion.update({
      where: { id: full.id },
      data: {
        status: 'RETURNED',
        decidedById: req.user!.id,
        decidedByName: req.user!.displayName,
        decidedAt: new Date(),
        decisionComment: parsed.data.comment,
      },
    });
    return { kind: 'ok' as const, id: full.id };
  });

  if (result.kind === 'not_found') throw ApiError.notFound('目标版本不存在');
  if (result.kind === 'conflict') throw ApiError.conflict(result.message, 'E_VERSION_STATE');

  if (result.kind === 'ok') {
    await writeAudit({
      req,
      action: 'TARGET_VERSION_RETURN',
      objectType: 'TargetCostVersion',
      objectId: result.id,
      projectId: project.id,
      reason: parsed.data.comment,
    });
  }
  const fresh = await prisma.targetCostVersion.findUnique({ where: { id: result.id }, select: versionSelect });
  res.json({ data: serializeVersion(fresh!), meta: result.kind === 'replayed' ? { idempotent: true } : undefined });
});

export default router;
