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
import { outMoney, outQty, parseMoneyInput, parsePrice, parseQuantity, parseTaxRate, taxPair } from '../http/money';

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireCsrf);

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

const entryBodySchema = z.object({
  // 第五轮：关联清单项（可空）＋ 费用类别（必选）
  // 第六轮：单项工程（未关联清单项时必选）＋ 含税/不含税口径
  boqItemId: z.string().trim().min(1).optional().nullable(),
  unitProjectId: z.string().trim().min(1).optional().nullable(),
  category: z.enum(EXPENSE_CATEGORIES, { message: '请选择费用类别' }),
  businessDate: z.string().trim().regex(DATE_RE, '业务日期格式为 YYYY-MM-DD').optional().nullable(),
  period: z.string().trim().regex(PERIOD_RE, '结算周期格式为 YYYY-MM'),
  periodReason: z.string().trim().max(200).optional().nullable(),
  // 第七轮去财务化：成本说明必填，供应商/分包商可空；不再记录发票号与来源单据
  description: z.string().trim().min(1, '请填写成本说明').max(200, '成本说明最多 200 字'),
  vendorName: z.string().trim().max(80).optional().nullable(),
  pricingMethod: z.enum(['QTY_PRICE', 'LUMP_SUM']),
  quantity: z.union([z.string(), z.number()]).optional().nullable(),
  unit: z.string().trim().max(20).optional().nullable(),
  unitPrice: z.union([z.string(), z.number()]).optional().nullable(),
  amount: z.union([z.string(), z.number()]).optional().nullable(),
  taxRate: z.union([z.string(), z.number()]).optional().nullable(),
  priceTaxIncl: z.boolean().optional(),
  basisNote: z.string().trim().max(300).optional().nullable(),
  replaceOfId: z.string().trim().optional().nullable(),
});

const entryCreateSchema = entryBodySchema.extend({
  idempotencyKey: z.string().trim().min(8).max(80),
  submit: z.boolean().optional(),
});

const reviewSchema = z.object({
  comment: z.string().trim().max(300).optional().nullable(),
});

const returnSchema = z.object({
  comment: z.string().trim().min(1, '退回时必须填写意见').max(300),
});

const reversalCreateSchema = z.object({
  reason: z.string().trim().min(1, '请填写冲销原因').max(300),
  idempotencyKey: z.string().trim().min(8).max(80),
});

async function lockEntry(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT "id", "status" FROM "ActualCostEntry" WHERE "id" = ${id} FOR UPDATE`;
  return rows[0] ?? null;
}

/** 金额统一输出 2 位小数字符串；数量保留 3 位小数，单价 2 位。 */
const serializeEntry = <
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
  e: T,
) => ({
  ...e,
  quantity: outQty(e.quantity),
  unitPrice: outMoney(e.unitPrice),
  amount: outMoney(e.amount),
  taxRate: e.taxRate === null || e.taxRate === undefined ? null : new Prisma.Decimal(e.taxRate).toFixed(2),
  unitPriceTaxIncl: outMoney(e.unitPriceTaxIncl ?? null),
  unitPriceTaxExcl: outMoney(e.unitPriceTaxExcl ?? null),
  amountTaxIncl: outMoney(e.amountTaxIncl ?? null),
  amountTaxExcl: outMoney(e.amountTaxExcl ?? null),
});

/** 校验并规范化单据字段；金额由后端十进制计算（成本口径 amount = 不含税）。 */
async function normalizeEntry(projectId: string, input: z.infer<typeof entryBodySchema>) {
  // 清单项（可空）必须属于本项目且为有效状态；选了清单项自动带出单项工程
  let unitProjectId = input.unitProjectId ?? null;
  if (input.boqItemId) {
    const boq = await prisma.projectBoqItem.findFirst({ where: { id: input.boqItemId, projectId } });
    if (!boq) throw ApiError.badRequest('清单项不存在或不属于本项目');
    if (boq.status !== 'active') throw ApiError.badRequest(`清单项「${boq.itemName}」已合并或作废`);
    if (!unitProjectId) unitProjectId = boq.unitProjectId ?? null;
    else if (boq.unitProjectId && boq.unitProjectId !== unitProjectId) {
      throw ApiError.badRequest('单项工程与清单项所属单项工程不一致');
    }
  }
  if (!unitProjectId) throw ApiError.badRequest('未关联清单项时必须选择单项工程');
  const unit = await prisma.projectUnit.findFirst({
    where: { id: unitProjectId, projectId, isActive: true },
    select: { id: true },
  });
  if (!unit) throw ApiError.badRequest('单项工程不存在或已停用');

  // 业务日期缺省取结算周期首日，保证月度趋势与结算周期一致
  const businessDateStr = input.businessDate?.trim() || `${input.period}-01`;
  const businessDate = new Date(`${businessDateStr}T00:00:00.000Z`);
  if (Number.isNaN(businessDate.getTime())) throw ApiError.badRequest('业务日期无效');
  const datePeriod = businessDateStr.slice(0, 7);
  if (input.period !== datePeriod && !input.periodReason?.trim()) {
    throw ApiError.badRequest('所属期间与业务日期不一致，请填写原因');
  }

  const taxRate =
    input.taxRate === null || input.taxRate === undefined || input.taxRate === ''
      ? null
      : parseTaxRate(input.taxRate, '税率');
  const priceTaxIncl = input.priceTaxIncl ?? true;

  let quantity: Prisma.Decimal | null = null;
  let unitPrice: Prisma.Decimal | null = null;
  let amountInput: Prisma.Decimal | null = null;
  let unitPriceTaxIncl: Prisma.Decimal | null = null;
  let unitPriceTaxExcl: Prisma.Decimal | null = null;
  if (input.pricingMethod === 'QTY_PRICE') {
    quantity = parseQuantity(input.quantity, '数量');
    unitPrice = parsePrice(input.unitPrice, '单价');
    if (!input.unit?.trim()) throw ApiError.badRequest('数量×单价计价方式必须填写单位');
    const pair = taxPair(unitPrice, taxRate, priceTaxIncl);
    unitPriceTaxIncl = pair.incl;
    unitPriceTaxExcl = pair.excl;
  } else {
    amountInput = parseMoneyInput(input.amount, '金额');
    if (!input.basisNote?.trim()) throw ApiError.badRequest('按总额登记必须填写依据说明');
  }

  const amountPair = amountInput !== null
    ? taxPair(amountInput, taxRate, priceTaxIncl)
    : {
        incl: new Prisma.Decimal(quantity ?? 0).mul(new Prisma.Decimal(unitPriceTaxIncl ?? 0)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
        excl: new Prisma.Decimal(quantity ?? 0).mul(new Prisma.Decimal(unitPriceTaxExcl ?? 0)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      };
  const amount = amountPair.excl;
  // 负向金额仅由受控冲销流程生成，普通单据不接受负数
  if (amount.isNegative()) throw ApiError.badRequest('金额不接受负数；纠错请使用冲销流程');

  return {
    boqItemId: input.boqItemId ?? null,
    unitProjectId,
    category: input.category,
    businessDate,
    period: input.period,
    periodReason: input.period !== datePeriod ? input.periodReason!.trim() : null,
    description: input.description,
    vendorName: input.vendorName?.trim() || null,
    pricingMethod: input.pricingMethod,
    quantity,
    unit: input.pricingMethod === 'QTY_PRICE' ? input.unit!.trim() : input.unit?.trim() || null,
    unitPrice,
    amount,
    amountTaxIncl: amountPair.incl,
    amountTaxExcl: amountPair.excl,
    priceTaxIncl,
    taxRate,
    unitPriceTaxIncl,
    unitPriceTaxExcl,
    basisNote: input.basisNote?.trim() || null,
    replaceOfId: input.replaceOfId ?? null,
  };
}

async function findEntry(projectId: string, id: string) {
  const entry = await prisma.actualCostEntry.findFirst({ where: { id, projectId } });
  if (!entry) throw ApiError.notFound('实际成本单据不存在');
  return entry;
}

/** 列表附带的冲销状态：是否已有待复核冲销申请。 */
async function attachReversalState<T extends { id: string }>(entries: T[]) {
  if (entries.length === 0) return entries.map((e) => ({ ...e, pendingReversal: false }));
  const pending = await prisma.costReversalRequest.findMany({
    where: { entryId: { in: entries.map((e) => e.id) }, status: 'PENDING' },
    select: { entryId: true, id: true },
  });
  const set = new Map(pending.map((p) => [p.entryId, p.id]));
  return entries.map((e) => ({ ...e, pendingReversal: set.has(e.id), pendingReversalId: set.get(e.id) ?? null }));
}

router.get('/:id/actual-entries', async (req, res) => {
  const { project } = await assertProjectMembership(req, req.params.id);
  const view = String(req.query.view ?? 'all');
  const status = String(req.query.status ?? '');
  const until = String(req.query.until ?? '');

  const where: Prisma.ActualCostEntryWhereInput = { projectId: project.id };
  if (['DRAFT', 'SUBMITTED', 'CONFIRMED', 'RETURNED'].includes(status)) {
    where.status = status as 'DRAFT' | 'SUBMITTED' | 'CONFIRMED' | 'RETURNED';
  }
  if (until && DATE_RE.test(until)) {
    where.businessDate = { lte: new Date(`${until}T23:59:59.999Z`) };
  }
  if (view === 'mine-draft') {
    where.createdById = req.user!.id;
    where.status = { in: ['DRAFT', 'RETURNED'] };
    where.kind = 'NORMAL';
  } else if (view === 'mine-submitted') {
    where.submittedById = req.user!.id;
    where.status = 'SUBMITTED';
  } else if (view === 'pending-confirm') {
    where.status = 'SUBMITTED';
  }

  const entries = await prisma.actualCostEntry.findMany({
    where,
    orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
    take: 500,
    include: {
      boqItem: { select: { itemName: true } },
      unitProject: { select: { id: true, name: true } },
      reversalOf: { select: { id: true, description: true, businessDate: true } },
    },
  });
  const withState = await attachReversalState(entries);
  res.json({
    data: withState.map((e) => ({
      ...serializeEntry(e),
      boqItemName: e.boqItem?.itemName ?? null,
      unitProjectName: e.unitProject?.name ?? null,
      boqItem: undefined,
      unitProject: undefined,
    })),
  });
});

router.get('/:id/actual-entries/:eid', async (req, res) => {
  const { project } = await assertProjectMembership(req, req.params.id);
  const entry = await prisma.actualCostEntry.findFirst({
    where: { id: req.params.eid, projectId: project.id },
    include: {
      boqItem: { select: { itemName: true } },
      unitProject: { select: { id: true, name: true } },
      reversalOf: { select: { id: true, description: true, businessDate: true, amount: true } },
    },
  });
  if (!entry) throw ApiError.notFound('实际成本单据不存在');

  const reversedBy = entry.reversedById
    ? await prisma.actualCostEntry.findUnique({
        where: { id: entry.reversedById },
        select: { id: true, description: true, businessDate: true, amount: true },
      })
    : null;
  const replaceOf = entry.replaceOfId
    ? await prisma.actualCostEntry.findUnique({
        where: { id: entry.replaceOfId },
        select: { id: true, description: true, status: true },
      })
    : null;
  const requests = await prisma.costReversalRequest.findMany({
    where: { entryId: entry.id },
    orderBy: { requestedAt: 'desc' },
  });
  const records = await prisma.auditLog.findMany({
    where: { objectType: 'ActualCostEntry', objectId: entry.id },
    orderBy: { createdAt: 'asc' },
    select: { id: true, action: true, actorName: true, reason: true, result: true, createdAt: true },
  });

  const [withState] = await attachReversalState([entry]);
  res.json({
    data: {
      ...serializeEntry(withState),
      boqItemName: entry.boqItem?.itemName ?? null,
      unitProjectName: entry.unitProject?.name ?? null,
      boqItem: undefined,
      unitProject: undefined,
      reversalOf: entry.reversalOf ? { ...entry.reversalOf, amount: outMoney(entry.reversalOf.amount) } : null,
      reversedBy: reversedBy ? { ...reversedBy, amount: outMoney(reversedBy.amount) } : null,
      replaceOf,
      reversalRequests: requests,
      records,
    },
  });
});

router.post('/:id/actual-entries', async (req, res) => {
  const { project, membership } = await assertProjectMembership(req, req.params.id);
  requireProjectRoles(membership, ['COST_ENGINEER'], '实际成本由造价员登记');
  assertProjectActive(project);

  const parsed = entryCreateSchema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '信息不完整');

  // 幂等：同一幂等键重试返回已有结果，不产生重复入账
  const replay = await prisma.actualCostEntry.findUnique({
    where: { idempotencyKey: parsed.data.idempotencyKey },
  });
  if (replay) {
    res.json({ data: serializeEntry(replay), meta: { idempotent: true } });
    return;
  }

  const data = await normalizeEntry(project.id, parsed.data);
  if (data.replaceOfId) {
    const origin = await prisma.actualCostEntry.findFirst({
      where: { id: data.replaceOfId, projectId: project.id },
    });
    if (!origin) throw ApiError.badRequest('重录关联的原记录不存在');
    if (origin.status !== 'CONFIRMED') throw ApiError.badRequest('只有已确认记录可以作为重录来源');
  }

  const now = new Date();
  const created = await prisma.actualCostEntry.create({
    data: {
      ...data,
      projectId: project.id,
      kind: 'NORMAL',
      status: parsed.data.submit ? 'SUBMITTED' : 'DRAFT',
      createdById: req.user!.id,
      createdByName: req.user!.displayName,
      ...(parsed.data.submit
        ? { submittedById: req.user!.id, submittedByName: req.user!.displayName, submittedAt: now }
        : {}),
      idempotencyKey: parsed.data.idempotencyKey,
    },
  });
  await writeAudit({
    req,
    action: parsed.data.submit ? 'ACTUAL_CREATE_SUBMIT' : 'ACTUAL_CREATE_DRAFT',
    objectType: 'ActualCostEntry',
    objectId: created.id,
    projectId: project.id,
    after: { amount: String(created.amount), description: created.description, status: created.status },
  });
  res.status(201).json({ data: serializeEntry(created) });
});

router.patch('/:id/actual-entries/:eid', async (req, res) => {
  const { project } = await assertProjectMembership(req, req.params.id);
  assertProjectActive(project);
  const entry = await findEntry(project.id, req.params.eid);
  if (!['DRAFT', 'RETURNED'].includes(entry.status)) {
    throw ApiError.conflict('只有草稿或已退回的单据可以编辑；已确认记录请走冲销流程', 'E_ENTRY_LOCKED');
  }
  if (entry.createdById !== req.user!.id) throw ApiError.forbidden('只能编辑自己登记的单据');

  const parsed = entryBodySchema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '信息不完整');
  const data = await normalizeEntry(project.id, parsed.data);

  const updated = await prisma.actualCostEntry.update({
    where: { id: entry.id },
    data: { ...data, replaceOfId: entry.replaceOfId },
  });
  res.json({ data: serializeEntry(updated) });
});

router.delete('/:id/actual-entries/:eid', async (req, res) => {
  const { project } = await assertProjectMembership(req, req.params.id);
  assertProjectActive(project);
  const entry = await findEntry(project.id, req.params.eid);
  if (!['DRAFT', 'RETURNED'].includes(entry.status) || entry.kind !== 'NORMAL') {
    throw ApiError.conflict('只有草稿或已退回的单据可以删除；正式记录不允许无痕删除', 'E_ENTRY_LOCKED');
  }
  if (entry.createdById !== req.user!.id) throw ApiError.forbidden('只能删除自己登记的单据');

  await prisma.actualCostEntry.delete({ where: { id: entry.id } });
  await writeAudit({
    req,
    action: 'ACTUAL_DELETE_DRAFT',
    objectType: 'ActualCostEntry',
    objectId: entry.id,
    projectId: project.id,
    before: { amount: String(entry.amount), description: entry.description, status: entry.status },
  });
  res.json({ data: { ok: true } });
});

router.post('/:id/actual-entries/:eid/submit', async (req, res) => {
  const { project, membership } = await assertProjectMembership(req, req.params.id);
  requireProjectRoles(membership, ['COST_ENGINEER'], '实际成本由造价员提交');
  assertProjectActive(project);

  const result = await prisma.$transaction(async (tx) => {
    const locked = await lockEntry(tx, req.params.eid);
    if (!locked) return { kind: 'not_found' as const };
    const full = await tx.actualCostEntry.findFirst({ where: { id: locked.id, projectId: project.id } });
    if (!full) return { kind: 'not_found' as const };

    if (full.status === 'SUBMITTED') {
      if (full.submittedById === req.user!.id) return { kind: 'replayed' as const, id: full.id };
      return { kind: 'conflict' as const, message: '该单据已提交，请等待复核' };
    }
    if (!['DRAFT', 'RETURNED'].includes(full.status) || full.kind !== 'NORMAL') {
      return { kind: 'conflict' as const, message: '只有草稿或已退回的单据可以提交' };
    }
    if (full.createdById !== req.user!.id) {
      return { kind: 'forbidden' as const, message: '只能提交自己登记的单据' };
    }
    await tx.actualCostEntry.update({
      where: { id: full.id },
      data: {
        status: 'SUBMITTED',
        submittedById: req.user!.id,
        submittedByName: req.user!.displayName,
        submittedAt: new Date(),
        reviewComment: null,
      },
    });
    return { kind: 'ok' as const, id: full.id };
  });

  if (result.kind === 'not_found') throw ApiError.notFound('实际成本单据不存在');
  if (result.kind === 'forbidden') throw ApiError.forbidden(result.message);
  if (result.kind === 'conflict') throw ApiError.conflict(result.message, 'E_ENTRY_STATE');

  if (result.kind === 'ok') {
    await writeAudit({
      req,
      action: 'ACTUAL_SUBMIT',
      objectType: 'ActualCostEntry',
      objectId: result.id,
      projectId: project.id,
    });
  }
  const fresh = await prisma.actualCostEntry.findUnique({ where: { id: result.id } });
  res.json({ data: serializeEntry(fresh!), meta: result.kind === 'replayed' ? { idempotent: true } : undefined });
});

router.post('/:id/actual-entries/:eid/confirm', async (req, res) => {
  const { project, membership } = await assertProjectMembership(req, req.params.id);
  // 第七轮简化：确认结算即正式计入实际成本，不再要求他人复核
  requireProjectRoles(membership, ['PROJECT_LEAD', 'COST_ENGINEER'], '确认结算');
  assertProjectActive(project);

  const parsed = reviewSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '信息不完整');

  const result = await prisma.$transaction(async (tx) => {
    const locked = await lockEntry(tx, req.params.eid);
    if (!locked) return { kind: 'not_found' as const };
    const full = await tx.actualCostEntry.findFirst({ where: { id: locked.id, projectId: project.id } });
    if (!full) return { kind: 'not_found' as const };

    if (full.status === 'CONFIRMED') {
      if (full.reviewedById === req.user!.id) return { kind: 'replayed' as const, id: full.id };
      return { kind: 'conflict' as const, message: '该单据已确认，请勿重复操作' };
    }
    if (full.status !== 'SUBMITTED' && full.status !== 'DRAFT') {
      return { kind: 'conflict' as const, message: '只有草稿或已提交的单据可以确认结算' };
    }
    await tx.actualCostEntry.update({
      where: { id: full.id },
      data: {
        status: 'CONFIRMED',
        submittedById: full.submittedById ?? req.user!.id,
        submittedByName: full.submittedByName ?? req.user!.displayName,
        submittedAt: full.submittedAt ?? new Date(),
        reviewedById: req.user!.id,
        reviewedByName: req.user!.displayName,
        reviewedAt: new Date(),
        reviewComment: parsed.data.comment ?? null,
      },
    });
    return { kind: 'ok' as const, id: full.id };
  });

  if (result.kind === 'not_found') throw ApiError.notFound('实际成本单据不存在');
  if (result.kind === 'conflict') throw ApiError.conflict(result.message, 'E_ENTRY_STATE');

  if (result.kind === 'ok') {
    await writeAudit({
      req,
      action: 'ACTUAL_CONFIRM',
      objectType: 'ActualCostEntry',
      objectId: result.id,
      projectId: project.id,
      reason: parsed.data.comment ?? null,
    });
  }
  const fresh = await prisma.actualCostEntry.findUnique({ where: { id: result.id } });
  res.json({ data: serializeEntry(fresh!), meta: result.kind === 'replayed' ? { idempotent: true } : undefined });
});

router.post('/:id/actual-entries/:eid/return', async (req, res) => {
  const { project, membership } = await assertProjectMembership(req, req.params.id);
  requireProjectRoles(membership, ['PROJECT_LEAD'], '实际成本由项目负责人复核');
  assertProjectActive(project);

  const parsed = returnSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '退回必须填写意见');

  const result = await prisma.$transaction(async (tx) => {
    const locked = await lockEntry(tx, req.params.eid);
    if (!locked) return { kind: 'not_found' as const };
    const full = await tx.actualCostEntry.findFirst({ where: { id: locked.id, projectId: project.id } });
    if (!full) return { kind: 'not_found' as const };
    if (full.status === 'RETURNED') {
      if (full.reviewedById === req.user!.id) return { kind: 'replayed' as const, id: full.id };
      return { kind: 'conflict' as const, message: '该单据已退回' };
    }
    if (full.status !== 'SUBMITTED') {
      return { kind: 'conflict' as const, message: '只有已提交的单据可以退回' };
    }
    await tx.actualCostEntry.update({
      where: { id: full.id },
      data: {
        status: 'RETURNED',
        reviewedById: req.user!.id,
        reviewedByName: req.user!.displayName,
        reviewedAt: new Date(),
        reviewComment: parsed.data.comment,
      },
    });
    return { kind: 'ok' as const, id: full.id };
  });

  if (result.kind === 'not_found') throw ApiError.notFound('实际成本单据不存在');
  if (result.kind === 'conflict') throw ApiError.conflict(result.message, 'E_ENTRY_STATE');

  if (result.kind === 'ok') {
    await writeAudit({
      req,
      action: 'ACTUAL_RETURN',
      objectType: 'ActualCostEntry',
      objectId: result.id,
      projectId: project.id,
      reason: parsed.data.comment,
    });
  }
  const fresh = await prisma.actualCostEntry.findUnique({ where: { id: result.id } });
  res.json({ data: serializeEntry(fresh!), meta: result.kind === 'replayed' ? { idempotent: true } : undefined });
});

/** 冲销申请：造价员或负责人可发起，必须由非本人负责人独立复核。 */
router.post('/:id/actual-entries/:eid/reversal-requests', async (req, res) => {
  const { project, membership } = await assertProjectMembership(req, req.params.id);
  requireProjectRoles(membership, ['COST_ENGINEER', 'PROJECT_LEAD'], '冲销申请由造价员或项目负责人发起');
  assertProjectActive(project);

  const parsed = reversalCreateSchema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '信息不完整');

  const replay = await prisma.costReversalRequest.findUnique({
    where: { idempotencyKey: parsed.data.idempotencyKey },
  });
  if (replay) {
    res.json({ data: replay, meta: { idempotent: true } });
    return;
  }

  const entry = await findEntry(project.id, req.params.eid);
  if (entry.status !== 'CONFIRMED') throw ApiError.conflict('只有已确认记录可以申请冲销', 'E_ENTRY_STATE');
  if (entry.kind !== 'NORMAL') throw ApiError.conflict('冲销记录本身不能再冲销', 'E_ENTRY_STATE');
  if (entry.reversedById) throw ApiError.conflict('该记录已被全额冲销，禁止重复冲销', 'E_ALREADY_REVERSED');
  const pending = await prisma.costReversalRequest.findFirst({
    where: { entryId: entry.id, status: 'PENDING' },
  });
  if (pending) throw ApiError.conflict('该记录已有待复核的冲销申请', 'E_DUPLICATE_REVERSAL');

  const created = await prisma.costReversalRequest.create({
    data: {
      projectId: project.id,
      entryId: entry.id,
      reason: parsed.data.reason,
      requestedById: req.user!.id,
      requestedByName: req.user!.displayName,
      idempotencyKey: parsed.data.idempotencyKey,
    },
  });
  await writeAudit({
    req,
    action: 'REVERSAL_REQUEST',
    objectType: 'CostReversalRequest',
    objectId: created.id,
    projectId: project.id,
    after: { entryId: entry.id },
    reason: parsed.data.reason,
  });
  res.status(201).json({ data: created });
});

router.get('/:id/reversal-requests', async (req, res) => {
  const { project } = await assertProjectMembership(req, req.params.id);
  const status = String(req.query.status ?? '');
  const requests = await prisma.costReversalRequest.findMany({
    where: {
      projectId: project.id,
      ...(status === 'PENDING' || status === 'APPROVED' || status === 'REJECTED'
        ? { status: status as 'PENDING' | 'APPROVED' | 'REJECTED' }
        : {}),
    },
    orderBy: { requestedAt: 'desc' },
    take: 200,
  });
  const entryIds = [...new Set(requests.map((r) => r.entryId))];
  const entries = await prisma.actualCostEntry.findMany({
    where: { id: { in: entryIds } },
    select: { id: true, description: true, amount: true, businessDate: true, status: true },
  });
  const entryMap = new Map(entries.map((e) => [e.id, { ...e, amount: outMoney(e.amount) }]));
  res.json({ data: requests.map((r) => ({ ...r, entry: entryMap.get(r.entryId) ?? null })) });
});

/** 复核通过冲销：事务内生成关联负向冲销记录，原记录保留并共同计入净额。 */
router.post('/:id/reversal-requests/:rid/approve', async (req, res) => {
  const { project, membership } = await assertProjectMembership(req, req.params.id);
  requireProjectRoles(membership, ['PROJECT_LEAD'], '冲销由项目负责人独立复核');
  assertProjectActive(project);

  const parsed = reviewSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '信息不完整');

  const result = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status" FROM "CostReversalRequest" WHERE "id" = ${req.params.rid} FOR UPDATE`;
    if (rows.length === 0) return { kind: 'not_found' as const };
    const request = await tx.costReversalRequest.findFirst({
      where: { id: rows[0].id, projectId: project.id },
    });
    if (!request) return { kind: 'not_found' as const };

    if (request.status === 'APPROVED') {
      if (request.reviewedById === req.user!.id) return { kind: 'replayed' as const, id: request.id };
      return { kind: 'conflict' as const, message: '该冲销申请已复核通过' };
    }
    if (request.status !== 'PENDING') {
      return { kind: 'conflict' as const, message: '该冲销申请已被处理' };
    }
    // 职责分离：不能复核自己发起的冲销
    if (request.requestedById === req.user!.id) {
      return { kind: 'forbidden' as const, message: '不能复核自己发起的冲销申请，请由其他负责人复核' };
    }

    const locked = await lockEntry(tx, request.entryId);
    if (!locked) return { kind: 'not_found' as const };
    const entry = await tx.actualCostEntry.findUnique({ where: { id: locked.id } });
    if (!entry || entry.projectId !== project.id) return { kind: 'not_found' as const };
    if (entry.status !== 'CONFIRMED') {
      return { kind: 'conflict' as const, message: '原记录状态已变化，无法冲销' };
    }
    if (entry.reversedById) {
      return { kind: 'conflict' as const, message: '该记录已被全额冲销，禁止重复冲销' };
    }

    const now = new Date();
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const reversal = await tx.actualCostEntry.create({
      data: {
        projectId: project.id,
        boqItemId: entry.boqItemId,
        unitProjectId: entry.unitProjectId,
        category: entry.category,
        businessDate: now,
        period,
        description: `冲销：${entry.description}`,
        pricingMethod: 'LUMP_SUM',
        // 冲销同时回退实物量，保证"实际工程量净额"与金额口径一致
        quantity: entry.quantity ? entry.quantity.neg() : null,
        unit: entry.unit,
        amount: entry.amount.neg(),
        amountTaxIncl: entry.amountTaxIncl.neg(),
        amountTaxExcl: entry.amountTaxExcl.neg(),
        priceTaxIncl: entry.priceTaxIncl,
        taxRate: entry.taxRate,
        vendorName: entry.vendorName,
        basisNote: `冲销原因：${request.reason}`,
        kind: 'REVERSAL',
        status: 'CONFIRMED',
        createdById: req.user!.id,
        createdByName: req.user!.displayName,
        submittedById: req.user!.id,
        submittedByName: req.user!.displayName,
        submittedAt: now,
        reviewedById: req.user!.id,
        reviewedByName: req.user!.displayName,
        reviewedAt: now,
        reviewComment: parsed.data.comment ?? null,
        reversalOfId: entry.id,
      },
    });
    await tx.actualCostEntry.update({
      where: { id: entry.id },
      data: { reversedById: reversal.id },
    });
    await tx.costReversalRequest.update({
      where: { id: request.id },
      data: {
        status: 'APPROVED',
        reviewedById: req.user!.id,
        reviewedByName: req.user!.displayName,
        reviewedAt: now,
        reviewComment: parsed.data.comment ?? null,
        reversalEntryId: reversal.id,
      },
    });
    return { kind: 'ok' as const, id: request.id, reversalEntryId: reversal.id, entryId: entry.id };
  });

  if (result.kind === 'not_found') throw ApiError.notFound('冲销申请不存在');
  if (result.kind === 'forbidden') throw ApiError.forbidden(result.message);
  if (result.kind === 'conflict') throw ApiError.conflict(result.message, 'E_REVERSAL_STATE');

  if (result.kind === 'ok') {
    await writeAudit({
      req,
      action: 'REVERSAL_APPROVE',
      objectType: 'CostReversalRequest',
      objectId: result.id,
      projectId: project.id,
      after: { entryId: result.entryId, reversalEntryId: result.reversalEntryId },
      reason: parsed.data.comment ?? null,
    });
  }
  const fresh = await prisma.costReversalRequest.findUnique({ where: { id: result.id } });
  res.json({ data: fresh, meta: result.kind === 'replayed' ? { idempotent: true } : undefined });
});

router.post('/:id/reversal-requests/:rid/reject', async (req, res) => {
  const { project, membership } = await assertProjectMembership(req, req.params.id);
  requireProjectRoles(membership, ['PROJECT_LEAD'], '冲销由项目负责人独立复核');
  assertProjectActive(project);

  const parsed = returnSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '驳回必须填写意见');

  const request = await prisma.costReversalRequest.findFirst({
    where: { id: req.params.rid, projectId: project.id },
  });
  if (!request) throw ApiError.notFound('冲销申请不存在');
  if (request.status !== 'PENDING') throw ApiError.conflict('该冲销申请已被处理', 'E_REVERSAL_STATE');
  if (request.requestedById === req.user!.id) {
    throw ApiError.forbidden('不能复核自己发起的冲销申请，请由其他负责人复核');
  }

  const updated = await prisma.costReversalRequest.update({
    where: { id: request.id },
    data: {
      status: 'REJECTED',
      reviewedById: req.user!.id,
      reviewedByName: req.user!.displayName,
      reviewedAt: new Date(),
      reviewComment: parsed.data.comment,
    },
  });
  await writeAudit({
    req,
    action: 'REVERSAL_REJECT',
    objectType: 'CostReversalRequest',
    objectId: request.id,
    projectId: project.id,
    after: { entryId: request.entryId },
    reason: parsed.data.comment,
  });
  res.json({ data: updated });
});

export default router;
