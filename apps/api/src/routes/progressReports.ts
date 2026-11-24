import { Prisma } from '@prisma/client';
import { Router, type Request } from 'express';
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
import { outMoney, outQty, roundMoney } from '../http/money';

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireCsrf);

const Decimal = Prisma.Decimal;
const WRITE_ROLES = ['PROJECT_LEAD', 'COST_ENGINEER'];

/** 允许负数的数量解析（最多 3 位小数，空值按 0）。 */
function parseSignedQty(input: unknown, label: string): Prisma.Decimal {
  const text = String(input ?? '').trim() || '0';
  if (!/^-?\d+(\.\d{1,3})?$/.test(text)) {
    throw ApiError.badRequest(`${label}必须是最多 3 位小数的数字（可为负）`);
  }
  return new Decimal(text);
}

/** 允许负数的金额解析（最多 2 位小数，空值按 0）。 */
function parseSignedMoney(input: unknown, label: string): Prisma.Decimal {
  const text = String(input ?? '').trim() || '0';
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) {
    throw ApiError.badRequest(`${label}必须是最多 2 位小数的金额（可为负）`);
  }
  return new Decimal(text);
}

const periodCreateSchema = z.object({
  period: z
    .string()
    .trim()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, '期次格式应为 YYYY-MM，如 2026-11'),
  label: z.string().trim().max(40, '期次名称最多 40 字').optional().nullable(),
});

const boqLinesSchema = z.object({
  lines: z
    .array(
      z.object({
        boqItemId: z.string().trim().min(1),
        confirmedCumQty: z.union([z.string(), z.number()]).nullable().optional(),
        remark: z.string().trim().max(200).optional().nullable(),
      }),
    )
    .max(5000),
});

const extraLinesSchema = z.object({
  lines: z
    .array(
      z.object({
        name: z.string().trim().min(1, '请填写费用名称').max(120, '费用名称最多 120 字'),
        confirmedCumAmount: z.union([z.string(), z.number()]).nullable().optional(),
        remark: z.string().trim().max(200).optional().nullable(),
      }),
    )
    .max(200),
});

function defaultLabel(period: string): string {
  const [year, month] = period.split('-');
  return `${year}年${Number(month)}月报量`;
}

/** 校验当前用户可写过程报量（项目负责人 / 造价员）。 */
async function assertProgressWrite(req: Request, projectId: string) {
  const { project, membership } = await assertProjectMembership(req, projectId);
  requireProjectRoles(membership, WRITE_ROLES, '过程报量仅项目负责人或造价员可维护');
  assertProjectActive(project);
  return { project, membership };
}

/** 读取期次并校验归属项目。 */
async function getPeriod(projectId: string, periodId: string) {
  const period = await prisma.progressPeriod.findFirst({
    where: { id: periodId, projectId },
  });
  if (!period) throw ApiError.notFound('报量期次不存在');
  return period;
}

/** 取上一期（period 严格小于当前期，取最近一期）。 */
async function findPreviousPeriod(projectId: string, period: string) {
  return prisma.progressPeriod.findFirst({
    where: { projectId, period: { lt: period } },
    orderBy: { period: 'desc' },
  });
}

// ============ 期次列表（含各期产值汇总，供趋势图使用） ============
router.get('/:id/progress-periods', async (req, res) => {
  const { project, membership } = await assertProjectMembership(req, req.params.id);
  const periods = await prisma.progressPeriod.findMany({
    where: { projectId: project.id },
    orderBy: { period: 'desc' },
    include: {
      _count: { select: { boqLines: true, extraLines: true } },
      boqLines: {
        include: {
          boqItem: { select: { status: true, unitPriceTaxIncl: true, unitPriceTaxExcl: true } },
        },
      },
    },
  });
  res.json({
    data: periods.map((p) => {
      let periodIncl = new Decimal(0);
      let periodExcl = new Decimal(0);
      let cumIncl = new Decimal(0);
      let cumExcl = new Decimal(0);
      for (const line of p.boqLines) {
        if (line.boqItem.status !== 'active') continue;
        const qty = line.confirmedCumQty.sub(line.prevCumQty);
        const priceIncl = line.boqItem.unitPriceTaxIncl ?? new Decimal(0);
        const priceExcl = line.boqItem.unitPriceTaxExcl ?? new Decimal(0);
        periodIncl = periodIncl.add(roundMoney(qty.mul(priceIncl)));
        periodExcl = periodExcl.add(roundMoney(qty.mul(priceExcl)));
        cumIncl = cumIncl.add(roundMoney(line.confirmedCumQty.mul(priceIncl)));
        cumExcl = cumExcl.add(roundMoney(line.confirmedCumQty.mul(priceExcl)));
      }
      return {
        id: p.id,
        period: p.period,
        label: p.label,
        createdByName: p.createdByName,
        createdAt: p.createdAt,
        boqLineCount: p._count.boqLines,
        extraLineCount: p._count.extraLines,
        periodAmountIncl: outMoney(periodIncl),
        periodAmountExcl: outMoney(periodExcl),
        cumAmountIncl: outMoney(cumIncl),
        cumAmountExcl: outMoney(cumExcl),
      };
    }),
    meta: { myRole: membership.roleCode },
  });
});

// ============ 新建期次（自动带入上一期累计确认量） ============
router.post('/:id/progress-periods', async (req, res) => {
  const { project } = await assertProgressWrite(req, req.params.id);
  const parsed = periodCreateSchema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '信息不完整');
  const { period, label } = parsed.data;

  const exists = await prisma.progressPeriod.findUnique({
    where: { projectId_period: { projectId: project.id, period } },
    select: { id: true },
  });
  if (exists) throw ApiError.conflict(`期次 ${period} 已存在，请直接选择该期次`);

  const previous = await findPreviousPeriod(project.id, period);

  const created = await prisma.$transaction(async (tx) => {
    const record = await tx.progressPeriod.create({
      data: {
        projectId: project.id,
        period,
        label: label?.trim() || defaultLabel(period),
        createdById: req.user!.id,
        createdByName: req.user!.displayName ?? req.user!.username,
      },
    });

    if (previous) {
      // 上期清单行 → 本期基数快照（上期累计 = 本期上期累计，确认累计默认等于上期累计）
      const prevLines = await tx.progressBoqLine.findMany({
        where: { periodId: previous.id },
        include: { boqItem: { select: { status: true } } },
      });
      const carry = prevLines.filter((line) => line.boqItem.status === 'active');
      if (carry.length > 0) {
        await tx.progressBoqLine.createMany({
          data: carry.map((line) => ({
            periodId: record.id,
            boqItemId: line.boqItemId,
            prevCumQty: line.confirmedCumQty,
            confirmedCumQty: line.confirmedCumQty,
            remark: null,
          })),
        });
      }

      // 上期签证及其他确认行 → 本期（上期累计=上期确认累计，本期确认累计默认持平）
      const prevExtras = await tx.progressExtraLine.findMany({
        where: { periodId: previous.id },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
      if (prevExtras.length > 0) {
        await tx.progressExtraLine.createMany({
          data: prevExtras.map((line, index) => ({
            periodId: record.id,
            name: line.name,
            prevCumAmount: line.confirmedCumAmount,
            confirmedCumAmount: line.confirmedCumAmount,
            remark: line.remark,
            sortOrder: index,
          })),
        });
      }
    }

    return record;
  });

  await writeAudit({
    req,
    action: 'PROGRESS_PERIOD_CREATE',
    objectType: 'ProgressPeriod',
    objectId: created.id,
    projectId: project.id,
    after: { period, label: created.label, carriedFrom: previous?.period ?? null },
  });

  res.status(201).json({
    data: {
      id: created.id,
      period: created.period,
      label: created.label,
      createdByName: created.createdByName,
      createdAt: created.createdAt,
    },
    meta: { carriedFrom: previous?.period ?? null },
  });
});

// ============ 期次详情（三层树所需数据 + 自动反算） ============
router.get('/:id/progress-periods/:periodId', async (req, res) => {
  const { project, membership } = await assertProjectMembership(req, req.params.id);
  const period = await getPeriod(project.id, req.params.periodId);

  const [items, lines, extras] = await Promise.all([
    prisma.projectBoqItem.findMany({
      where: { projectId: project.id, status: 'active' },
      orderBy: [{ projectCategory: 'asc' }, { sectionName: 'asc' }, { createdAt: 'asc' }],
      include: { unitProject: { select: { id: true, name: true, sortOrder: true } } },
    }),
    prisma.progressBoqLine.findMany({ where: { periodId: period.id } }),
    prisma.progressExtraLine.findMany({
      where: { periodId: period.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
  ]);

  const lineMap = new Map(lines.map((line) => [line.boqItemId, line] as const));

  type Totals = {
    periodAmountIncl: Prisma.Decimal;
    periodAmountExcl: Prisma.Decimal;
    cumAmountIncl: Prisma.Decimal;
    cumAmountExcl: Prisma.Decimal;
    count: number;
  };
  const emptyTotals = (): Totals => ({
    periodAmountIncl: new Decimal(0),
    periodAmountExcl: new Decimal(0),
    cumAmountIncl: new Decimal(0),
    cumAmountExcl: new Decimal(0),
    count: 0,
  });
  const totalAll = emptyTotals();
  const byCategory = new Map<string, Totals>();
  for (const key of ['divisional', 'measure', 'other']) byCategory.set(key, emptyTotals());

  const outItems = items.map((item) => {
    const line = lineMap.get(item.id);
    const prevCumQty = line?.prevCumQty ?? new Decimal(0);
    const confirmedCumQty = line?.confirmedCumQty ?? prevCumQty;
    const periodQty = confirmedCumQty.sub(prevCumQty);
    const priceIncl = item.unitPriceTaxIncl ?? new Decimal(0);
    const priceExcl = item.unitPriceTaxExcl ?? new Decimal(0);
    const periodAmountIncl = roundMoney(periodQty.mul(priceIncl));
    const periodAmountExcl = roundMoney(periodQty.mul(priceExcl));
    const cumAmountIncl = roundMoney(confirmedCumQty.mul(priceIncl));
    const cumAmountExcl = roundMoney(confirmedCumQty.mul(priceExcl));

    const bucket = byCategory.get(item.projectCategory) ?? emptyTotals();
    byCategory.set(item.projectCategory, bucket);
    for (const target of [bucket, totalAll]) {
      target.periodAmountIncl = target.periodAmountIncl.add(periodAmountIncl);
      target.periodAmountExcl = target.periodAmountExcl.add(periodAmountExcl);
      target.cumAmountIncl = target.cumAmountIncl.add(cumAmountIncl);
      target.cumAmountExcl = target.cumAmountExcl.add(cumAmountExcl);
      target.count += 1;
    }

    return {
      boqItemId: item.id,
      projectCategory: item.projectCategory,
      unitProjectId: item.unitProjectId,
      unitProject: item.unitProject,
      sectionCode: item.sectionCode,
      sectionName: item.sectionName,
      itemName: item.itemName,
      itemFeature: item.itemFeature,
      unit: item.unit,
      quantity: outQty(item.quantity),
      unitPriceTaxIncl: outMoney(item.unitPriceTaxIncl),
      unitPriceTaxExcl: outMoney(item.unitPriceTaxExcl),
      prevCumQty: outQty(prevCumQty),
      confirmedCumQty: outQty(confirmedCumQty),
      periodQty: outQty(periodQty),
      periodAmountIncl: outMoney(periodAmountIncl),
      periodAmountExcl: outMoney(periodAmountExcl),
      cumAmountIncl: outMoney(cumAmountIncl),
      cumAmountExcl: outMoney(cumAmountExcl),
      remark: line?.remark ?? null,
      // 前端提示用（后端保存不做拦截，仅提示）
      isNegative: periodQty.lessThan(0),
      overContract:
        item.quantity !== null && item.quantity !== undefined
          ? confirmedCumQty.greaterThan(item.quantity)
          : false,
    };
  });

  const outExtras = extras.map((line) => {
    const periodAmount = roundMoney(line.confirmedCumAmount.sub(line.prevCumAmount));
    return {
      id: line.id,
      name: line.name,
      prevCumAmount: outMoney(line.prevCumAmount),
      confirmedCumAmount: outMoney(line.confirmedCumAmount),
      periodAmount: outMoney(periodAmount),
      remark: line.remark,
      sortOrder: line.sortOrder,
    };
  });
  const extraTotals = outExtras.reduce(
    (acc, line) => ({
      prevCumAmount: acc.prevCumAmount.add(line.prevCumAmount ?? 0),
      confirmedCumAmount: acc.confirmedCumAmount.add(line.confirmedCumAmount ?? 0),
      periodAmount: acc.periodAmount.add(line.periodAmount ?? 0),
    }),
    { prevCumAmount: new Decimal(0), confirmedCumAmount: new Decimal(0), periodAmount: new Decimal(0) },
  );

  const outTotals = (t: Totals) => ({
    periodAmountIncl: outMoney(t.periodAmountIncl),
    periodAmountExcl: outMoney(t.periodAmountExcl),
    cumAmountIncl: outMoney(t.cumAmountIncl),
    cumAmountExcl: outMoney(t.cumAmountExcl),
    count: t.count,
  });

  const previous = await findPreviousPeriod(project.id, period.period);

  res.json({
    data: {
      period: {
        id: period.id,
        period: period.period,
        label: period.label,
        createdByName: period.createdByName,
        createdAt: period.createdAt,
        previousPeriod: previous?.period ?? null,
        previousLabel: previous?.label ?? null,
      },
      items: outItems,
      totals: {
        ...outTotals(totalAll),
        byCategory: ['divisional', 'measure', 'other'].map((key) => ({
          projectCategory: key,
          ...outTotals(byCategory.get(key) ?? emptyTotals()),
        })),
      },
      extras: {
        lines: outExtras,
        totals: {
          prevCumAmount: outMoney(extraTotals.prevCumAmount),
          confirmedCumAmount: outMoney(extraTotals.confirmedCumAmount),
          periodAmount: outMoney(extraTotals.periodAmount),
        },
      },
      myRole: membership.roleCode,
    },
  });
});

// ============ 保存清单报量（允许负数与超合同量，仅提示不拦截） ============
router.put('/:id/progress-periods/:periodId/boq-lines', async (req, res) => {
  const { project } = await assertProgressWrite(req, req.params.id);
  const period = await getPeriod(project.id, req.params.periodId);
  const parsed = boqLinesSchema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '信息不完整');

  const inputs = parsed.data.lines;
  const ids = [...new Set(inputs.map((line) => line.boqItemId))];

  const [items, existing, previous] = await Promise.all([
    ids.length > 0
      ? prisma.projectBoqItem.findMany({
          where: { id: { in: ids }, projectId: project.id, status: 'active' },
          select: { id: true },
        })
      : Promise.resolve([]),
    prisma.progressBoqLine.findMany({ where: { periodId: period.id } }),
    findPreviousPeriod(project.id, period.period),
  ]);
  const validIds = new Set(items.map((item) => item.id));
  const existingMap = new Map(existing.map((line) => [line.boqItemId, line] as const));

  // 本期尚未建立行的清单项：上期累计量取上一期确认累计量（无上一期则为 0）
  const prevMap = new Map<string, Prisma.Decimal>();
  if (previous) {
    const prevLines = await prisma.progressBoqLine.findMany({
      where: { periodId: previous.id, boqItemId: { in: ids } },
      select: { boqItemId: true, confirmedCumQty: true },
    });
    for (const line of prevLines) prevMap.set(line.boqItemId, line.confirmedCumQty);
  }

  const ops: Prisma.PrismaPromise<unknown>[] = [];
  let skipped = 0;
  for (const input of inputs) {
    if (!validIds.has(input.boqItemId)) {
      skipped += 1;
      continue;
    }
    const confirmedCumQty = parseSignedQty(input.confirmedCumQty, '业主确认累计量');
    const remark = input.remark?.trim() || null;
    const current = existingMap.get(input.boqItemId);
    if (current) {
      // 上期累计量为快照，编辑时不改动
      ops.push(
        prisma.progressBoqLine.update({
          where: { id: current.id },
          data: { confirmedCumQty, remark },
        }),
      );
    } else {
      ops.push(
        prisma.progressBoqLine.create({
          data: {
            periodId: period.id,
            boqItemId: input.boqItemId,
            prevCumQty: prevMap.get(input.boqItemId) ?? new Decimal(0),
            confirmedCumQty,
            remark,
          },
        }),
      );
    }
  }

  if (ops.length > 0) await prisma.$transaction(ops);

  await writeAudit({
    req,
    action: 'PROGRESS_BOQ_SAVE',
    objectType: 'ProgressPeriod',
    objectId: period.id,
    projectId: project.id,
    after: { period: period.period, saved: ops.length, skipped, requested: inputs.length },
  });

  res.json({ data: { saved: ops.length, skipped, requested: inputs.length } });
});

// ============ 保存本期签证及其他确认（允许负数） ============
router.put('/:id/progress-periods/:periodId/extra-lines', async (req, res) => {
  const { project } = await assertProgressWrite(req, req.params.id);
  const period = await getPeriod(project.id, req.params.periodId);
  const parsed = extraLinesSchema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '信息不完整');

  const [existing, previous] = await Promise.all([
    prisma.progressExtraLine.findMany({ where: { periodId: period.id } }),
    findPreviousPeriod(project.id, period.period),
  ]);
  const existingByName = new Map<string, (typeof existing)[number]>();
  for (const line of existing) {
    if (!existingByName.has(line.name)) existingByName.set(line.name, line);
  }
  const prevByName = new Map<string, Prisma.Decimal>();
  if (previous) {
    const prevLines = await prisma.progressExtraLine.findMany({ where: { periodId: previous.id } });
    for (const line of prevLines) prevByName.set(line.name, line.confirmedCumAmount);
  }

  const rows = parsed.data.lines.map((line, index) => {
    const current = existingByName.get(line.name);
    return {
      periodId: period.id,
      name: line.name,
      prevCumAmount:
        current?.prevCumAmount ?? prevByName.get(line.name) ?? new Decimal(0),
      confirmedCumAmount: parseSignedMoney(line.confirmedCumAmount, '本期业主确认累计金额'),
      remark: line.remark?.trim() || null,
      sortOrder: index,
    };
  });

  await prisma.$transaction([
    prisma.progressExtraLine.deleteMany({ where: { periodId: period.id } }),
    ...(rows.length > 0 ? [prisma.progressExtraLine.createMany({ data: rows })] : []),
  ]);

  await writeAudit({
    req,
    action: 'PROGRESS_EXTRA_SAVE',
    objectType: 'ProgressPeriod',
    objectId: period.id,
    projectId: project.id,
    after: { period: period.period, saved: rows.length },
  });

  res.json({ data: { saved: rows.length } });
});

// ============ 一键清空本期报量（恢复上期累计状态） ============
router.post('/:id/progress-periods/:periodId/reset', async (req, res) => {
  const { project } = await assertProgressWrite(req, req.params.id);
  const period = await getPeriod(project.id, req.params.periodId);

  const [items, existing, previous, extraCount] = await Promise.all([
    prisma.projectBoqItem.findMany({
      where: { projectId: project.id, status: 'active' },
      select: { id: true },
    }),
    prisma.progressBoqLine.findMany({ where: { periodId: period.id } }),
    findPreviousPeriod(project.id, period.period),
    prisma.progressExtraLine.count({ where: { periodId: period.id } }),
  ]);
  const existingMap = new Map(existing.map((line) => [line.boqItemId, line] as const));

  // 上期累计量以上一期当前确认量为准；无上一期时沿用行内快照或 0
  const prevMap = new Map<string, Prisma.Decimal>();
  if (previous) {
    const prevLines = await prisma.progressBoqLine.findMany({
      where: { periodId: previous.id },
      select: { boqItemId: true, confirmedCumQty: true },
    });
    for (const line of prevLines) prevMap.set(line.boqItemId, line.confirmedCumQty);
  }

  const ops = items.map((item) => {
    const prev =
      prevMap.get(item.id) ?? existingMap.get(item.id)?.prevCumQty ?? new Decimal(0);
    return prisma.progressBoqLine.upsert({
      where: { periodId_boqItemId: { periodId: period.id, boqItemId: item.id } },
      create: {
        periodId: period.id,
        boqItemId: item.id,
        prevCumQty: prev,
        confirmedCumQty: prev,
        remark: null,
      },
      update: { prevCumQty: prev, confirmedCumQty: prev, remark: null },
    });
  });

  await prisma.$transaction([
    ...ops,
    prisma.progressExtraLine.deleteMany({ where: { periodId: period.id } }),
  ]);

  await writeAudit({
    req,
    action: 'PROGRESS_PERIOD_RESET',
    objectType: 'ProgressPeriod',
    objectId: period.id,
    projectId: project.id,
    after: { period: period.period, resetLines: ops.length, clearedExtras: extraCount },
  });

  res.json({
    data: { resetLines: ops.length, clearedExtras: extraCount, restoredFrom: previous?.period ?? null },
  });
});

export default router;
