import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { prisma } from '../db';
import { assertProjectMembership, requireAuth, requireCsrf } from '../http/auth';
import { ApiError } from '../http/errors';
import { outMoney, outQty } from '../http/money';

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireCsrf);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const COST_CATEGORIES = [
  { key: 'labor', label: '人工' },
  { key: 'material', label: '材料' },
  { key: 'machine', label: '机械' },
  { key: 'subcontract', label: '专业分包' },
  { key: 'turnover', label: '周转料具' },
  { key: 'measure', label: '措施费' },
  { key: 'site_overhead', label: '现场经费' },
  { key: 'other', label: '其他' },
] as const;

type CategoryKey = (typeof COST_CATEGORIES)[number]['key'];

const D = (v: unknown) => new Prisma.Decimal(String(v ?? 0));
const ZERO = new Prisma.Decimal(0);

function parseUntil(req: { query: Record<string, unknown> }): Date | null {
  const until = String(req.query.until ?? '');
  if (!until) return null;
  if (!DATE_RE.test(until)) throw ApiError.badRequest('截止日期格式为 YYYY-MM-DD');
  return new Date(`${until}T23:59:59.999Z`);
}

function parsePeriod(req: { query: Record<string, unknown> }): string | null {
  const period = String(req.query.period ?? '');
  if (!period) return null;
  if (!PERIOD_RE.test(period)) throw ApiError.badRequest('统计期间格式为 YYYY-MM');
  return period;
}

function periodRange(period: string): { start: Date; end: Date } {
  const [y, m] = period.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
  return { start, end };
}

const emptyByCategory = () =>
  Object.fromEntries(COST_CATEGORIES.map((c) => [c.key, ZERO])) as Record<CategoryKey, Prisma.Decimal>;

async function loadCurrentVersion(projectId: string) {
  return prisma.targetCostVersion.findFirst({
    where: { projectId, isCurrent: true, status: 'APPROVED' },
    include: { lines: true },
  });
}

// ============================================================
// 子模块一：清单成本对比
// ============================================================

/**
 * 清单成本对比：以有效清单项为行，收入（清单）／目标（当前批准版本）／实际（已确认净额）
 * 按费用类别横向铺开，支持按单项工程筛选。
 * 不选单项工程时，名称+特征+单位相同的清单项跨单项工程合并为一行。
 */
router.get('/:id/cost-comparison', async (req, res) => {
  const { project } = await assertProjectMembership(req, req.params.id);
  const until = parseUntil(req);
  const unitProjectId = req.query.unitProjectId ? String(req.query.unitProjectId) : null;
  // 第七轮：全局含税/不含税口径；默认不含税（成本口径）
  const caliber: 'incl' | 'excl' = String(req.query.caliber ?? '') === 'incl' ? 'incl' : 'excl';

  const [version, units, boqItems, confirmedEntries] = await Promise.all([
    loadCurrentVersion(project.id),
    prisma.projectUnit.findMany({
      where: { projectId: project.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true, isActive: true },
    }),
    prisma.projectBoqItem.findMany({
      where: {
        projectId: project.id,
        status: 'active',
        ...(unitProjectId ? { unitProjectId } : {}),
      },
      orderBy: [{ projectCategory: 'asc' }, { sectionName: 'asc' }, { createdAt: 'asc' }],
      include: { unitProject: { select: { id: true, name: true } } },
    }),
    prisma.actualCostEntry.findMany({
      where: {
        projectId: project.id,
        status: 'CONFIRMED',
        ...(until ? { businessDate: { lte: until } } : {}),
        ...(unitProjectId ? { unitProjectId } : {}),
      },
      select: {
        boqItemId: true,
        unitProjectId: true,
        category: true,
        amount: true,
        amountTaxIncl: true,
        amountTaxExcl: true,
        quantity: true,
      },
    }),
  ]);

  const lines = (version?.lines ?? []).filter((l) => !unitProjectId || l.unitProjectId === unitProjectId);

  const unitName = new Map(units.map((u) => [u.id, u.name]));

  // 清单按分组键聚合（选了单项工程时按记录 id 分行）
  interface Group {
    key: string;
    itemName: string;
    itemFeature: string | null;
    unit: string | null;
    unitProjectId: string | null;
    unitProjectName: string | null;
    quantity: Prisma.Decimal;
    incomeTaxIncl: Prisma.Decimal;
    incomeTaxExcl: Prisma.Decimal;
    boqIds: string[];
    actualQty: Prisma.Decimal;
    target: Prisma.Decimal;
    actual: Prisma.Decimal;
    targetByCategory: Record<CategoryKey, Prisma.Decimal>;
    actualByCategory: Record<CategoryKey, Prisma.Decimal>;
  }

  const groups = new Map<string, Group>();
  for (const item of boqItems) {
    const key = unitProjectId
      ? item.id
      : `${item.itemName}||${item.itemFeature ?? ''}||${item.unit ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        itemName: item.itemName,
        itemFeature: item.itemFeature,
        unit: item.unit,
        unitProjectId: unitProjectId ? item.unitProjectId : null,
        unitProjectName: unitProjectId ? item.unitProject?.name ?? null : null,
        quantity: ZERO,
        incomeTaxIncl: ZERO,
        incomeTaxExcl: ZERO,
        boqIds: [],
        actualQty: ZERO,
        target: ZERO,
        actual: ZERO,
        targetByCategory: emptyByCategory(),
        actualByCategory: emptyByCategory(),
      };
      groups.set(key, group);
    }
    group.quantity = group.quantity.add(D(item.quantity));
    group.incomeTaxIncl = group.incomeTaxIncl.add(D(item.amountTaxIncl));
    group.incomeTaxExcl = group.incomeTaxExcl.add(D(item.amountTaxExcl));
    group.boqIds.push(item.id);
  }

  // 目标成本：仅统计关联到清单项的明细行
  let unlinkedTargetCount = 0;
  for (const line of lines) {
    if (!line.boqItemId) {
      unlinkedTargetCount += 1;
      continue;
    }
    for (const group of groups.values()) {
      if (group.boqIds.includes(line.boqItemId)) {
        const amount = caliber === 'incl' ? D(line.amountTaxIncl) : D(line.amountTaxExcl);
        group.target = group.target.add(amount);
        group.targetByCategory[line.category as CategoryKey] =
          group.targetByCategory[line.category as CategoryKey].add(amount);
        break;
      }
    }
  }

  // 实际成本：仅统计关联到清单项的已确认净额（含冲销负向记录）
  let unlinkedActualCount = 0;
  let unlinkedActualTotal = ZERO;
  for (const entry of confirmedEntries) {
    if (!entry.boqItemId) {
      unlinkedActualCount += 1;
      unlinkedActualTotal = unlinkedActualTotal.add(
        caliber === 'incl' ? D(entry.amountTaxIncl) : D(entry.amountTaxExcl),
      );
      continue;
    }
    for (const group of groups.values()) {
      if (group.boqIds.includes(entry.boqItemId)) {
        const amount = caliber === 'incl' ? D(entry.amountTaxIncl) : D(entry.amountTaxExcl);
        group.actual = group.actual.add(amount);
        group.actualQty = group.actualQty.add(D(entry.quantity ?? 0));
        group.actualByCategory[entry.category as CategoryKey] =
          group.actualByCategory[entry.category as CategoryKey].add(amount);
        break;
      }
    }
  }

  const rows = [...groups.values()]
    .map((g) => {
      const actualTotal = g.actual;
      return {
        key: g.key,
        boqIds: g.boqIds,
        itemName: g.itemName,
        itemFeature: g.itemFeature,
        unit: g.unit,
        unitProjectId: g.unitProjectId,
        unitProjectName: g.unitProjectName,
        quantity: outQty(g.quantity),
        actualQuantity: outQty(g.actualQty),
        income: outMoney(caliber === 'incl' ? g.incomeTaxIncl : g.incomeTaxExcl),
        incomeTaxIncl: outMoney(g.incomeTaxIncl),
        incomeTaxExcl: outMoney(g.incomeTaxExcl),
        target: outMoney(g.target),
        actual: outMoney(actualTotal),
        // 盈亏差额 = 当前口径收入 − 当前口径实际成本
        diff: outMoney((caliber === 'incl' ? g.incomeTaxIncl : g.incomeTaxExcl).sub(actualTotal)),
        ...Object.fromEntries(COST_CATEGORIES.map((c) => [c.key, outMoney(g.actualByCategory[c.key])])),
        targetByCategory: Object.fromEntries(
          COST_CATEGORIES.map((c) => [c.key, outMoney(g.targetByCategory[c.key])]),
        ),
        hasCost: !g.target.isZero() || !actualTotal.isZero(),
      };
    })
    .sort((a, b) => {
      const ua = a.unitProjectName ?? '';
      const ub = b.unitProjectName ?? '';
      if (ua !== ub) return ua.localeCompare(ub, 'zh-CN');
      return a.itemName.localeCompare(b.itemName, 'zh-CN');
    });

  const totals = rows.reduce(
    (acc, r) => ({
      incomeTaxIncl: acc.incomeTaxIncl.add(D(r.incomeTaxIncl)),
      incomeTaxExcl: acc.incomeTaxExcl.add(D(r.incomeTaxExcl)),
      income: acc.income.add(D(r.income)),
      actualQuantity: acc.actualQuantity.add(D(r.actualQuantity)),
      target: acc.target.add(D(r.target)),
      actual: acc.actual.add(D(r.actual)),
      diff: acc.diff.add(D(r.diff)),
      byCategory: Object.fromEntries(
        COST_CATEGORIES.map((c) => [
          c.key,
          (acc.byCategory[c.key] ?? ZERO).add(D((r as unknown as Record<string, string>)[c.key])),
        ]),
      ) as Record<CategoryKey, Prisma.Decimal>,
    }),
    {
      incomeTaxIncl: ZERO,
      incomeTaxExcl: ZERO,
      income: ZERO,
      actualQuantity: ZERO,
      target: ZERO,
      actual: ZERO,
      diff: ZERO,
      byCategory: emptyByCategory(),
    },
  );

  res.json({
    data: {
      rows,
      totals: {
        income: outMoney(totals.income),
        incomeTaxIncl: outMoney(totals.incomeTaxIncl),
        incomeTaxExcl: outMoney(totals.incomeTaxExcl),
        actualQuantity: outQty(totals.actualQuantity),
        target: outMoney(totals.target),
        actual: outMoney(totals.actual),
        unlinkedActual: outMoney(unlinkedActualTotal),
        diff: outMoney(totals.diff),
        byCategory: Object.fromEntries(
          COST_CATEGORIES.map((c) => [c.key, outMoney(totals.byCategory[c.key])]),
        ),
      },
      caliber,
      categories: COST_CATEGORIES,
      unitProjects: units.map((u) => ({ id: u.id, name: u.name, isActive: u.isActive })),
      targetVersion: version
        ? {
            id: version.id,
            versionName: version.versionName,
            totalAmount: outMoney(version.totalAmount),
            approvedAt: version.decidedAt,
            approvedByName: version.decidedByName,
          }
        : null,
      caliberNote: project.costCaliberNote ?? null,
      cutoff: until ? until.toISOString().slice(0, 10) : null,
      unitProjectId,
      unlinkedTargetCount,
      unlinkedActualCount,
    },
  });
});

/** 未分配成本池：未关联清单项的目标明细与实际单据。 */
router.get('/:id/cost-comparison/unlinked', async (req, res) => {
  const { project } = await assertProjectMembership(req, req.params.id);
  const until = parseUntil(req);
  const unitProjectId = req.query.unitProjectId ? String(req.query.unitProjectId) : null;

  const version = await loadCurrentVersion(project.id);
  const targetLines = (version?.lines ?? []).filter(
    (l) => !l.boqItemId && (!unitProjectId || l.unitProjectId === unitProjectId),
  );
  const entries = await prisma.actualCostEntry.findMany({
    where: {
      projectId: project.id,
      status: 'CONFIRMED',
      boqItemId: null,
      ...(until ? { businessDate: { lte: until } } : {}),
      ...(unitProjectId ? { unitProjectId } : {}),
    },
    orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
    take: 500,
  });
  const units = await prisma.projectUnit.findMany({
    where: { projectId: project.id },
    select: { id: true, name: true },
  });
  const unitName = new Map(units.map((u) => [u.id, u.name]));

  res.json({
    data: {
      targetLines: targetLines.map((l) => ({
        id: l.id,
        category: l.category,
        summary: l.summary,
        unitProjectName: l.unitProjectId ? unitName.get(l.unitProjectId) ?? null : null,
        amount: outMoney(l.amount),
        amountTaxIncl: outMoney(l.amountTaxIncl),
      })),
      entries: entries.map((e) => ({
        id: e.id,
        category: e.category,
        description: e.description,
        vendorName: e.vendorName,
        businessDate: e.businessDate,
        unitProjectName: e.unitProjectId ? unitName.get(e.unitProjectId) ?? null : null,
        amount: outMoney(e.amount),
        amountTaxIncl: outMoney(e.amountTaxIncl),
        status: e.status,
        kind: e.kind,
      })),
    },
  });
});

/** 清单成本对比下钻：某清单项下的目标明细或已确认实际单据。 */
router.get('/:id/cost-comparison/drilldown', async (req, res) => {
  const { project } = await assertProjectMembership(req, req.params.id);
  const until = parseUntil(req);
  const boqItemId = String(req.query.boqItemId ?? '');
  const side = String(req.query.side ?? 'actual');
  if (!boqItemId) throw ApiError.badRequest('缺少清单项参数');

  if (side === 'target') {
    const version = await loadCurrentVersion(project.id);
    if (!version) {
      res.json({ data: { version: null, lines: [] } });
      return;
    }
    const lines = await prisma.targetCostLine.findMany({
      where: { versionId: version.id, boqItemId },
      orderBy: { sortOrder: 'asc' },
      include: { unitProject: { select: { name: true } } },
    });
    res.json({
      data: {
        version: { id: version.id, versionName: version.versionName },
        lines: lines.map((l) => ({
          ...l,
          quantity: outQty(l.quantity),
          unitPrice: outMoney(l.unitPrice),
          amount: outMoney(l.amount),
          taxRate: l.taxRate === null ? null : D(l.taxRate).toFixed(2),
          unitPriceTaxIncl: outMoney(l.unitPriceTaxIncl),
          unitPriceTaxExcl: outMoney(l.unitPriceTaxExcl),
          amountTaxIncl: outMoney(l.amountTaxIncl),
          amountTaxExcl: outMoney(l.amountTaxExcl),
          unitProjectName: l.unitProject?.name ?? null,
          unitProject: undefined,
        })),
      },
    });
    return;
  }

  const entries = await prisma.actualCostEntry.findMany({
    where: {
      projectId: project.id,
      status: 'CONFIRMED',
      boqItemId,
      ...(until ? { businessDate: { lte: until } } : {}),
    },
    orderBy: [{ businessDate: 'asc' }, { createdAt: 'asc' }],
    take: 500,
    include: { unitProject: { select: { name: true } } },
  });
  res.json({
    data: {
      entries: entries.map((e) => ({
        ...e,
        quantity: outQty(e.quantity),
        unitPrice: outMoney(e.unitPrice),
        amount: outMoney(e.amount),
        taxRate: e.taxRate === null ? null : D(e.taxRate).toFixed(2),
        unitPriceTaxIncl: outMoney(e.unitPriceTaxIncl),
        unitPriceTaxExcl: outMoney(e.unitPriceTaxExcl),
        amountTaxIncl: outMoney(e.amountTaxIncl),
        amountTaxExcl: outMoney(e.amountTaxExcl),
        unitProjectName: e.unitProject?.name ?? null,
        unitProject: undefined,
      })),
    },
  });
});

// ============================================================
// 子模块二：过程成本统计
// ============================================================

type Mode = 'period' | 'cumulative' | 'forecast';

/**
 * 过程成本统计：行固定为 8 大费用类别 + 合计。
 * - 本期：实际 = 所选期间内已确认单据净额；
 * - 累计：实际 = 截至统计截止日已确认净额；
 * - 预测：实际 = 截至统计截止日已确认净额，目标列作为预测完成成本。
 * 预算收入按目标明细金额占比分摊到各类别，未分摊部分计入合计并单独提示。
 */
router.get('/:id/process-costs', async (req, res) => {
  const { project } = await assertProjectMembership(req, req.params.id);
  const until = parseUntil(req);
  const period = parsePeriod(req);
  const mode: Mode =
    req.query.mode === 'period' ? 'period' : req.query.mode === 'forecast' ? 'forecast' : 'cumulative';
  const caliber: 'incl' | 'excl' = String(req.query.caliber ?? '') === 'incl' ? 'incl' : 'excl';
  const money = (v: { amountTaxIncl: unknown; amountTaxExcl: unknown }) =>
    caliber === 'incl' ? D(v.amountTaxIncl) : D(v.amountTaxExcl);

  const version = await loadCurrentVersion(project.id);
  const lines = version?.lines ?? [];

  const actualWhere: Prisma.ActualCostEntryWhereInput = {
    projectId: project.id,
    status: 'CONFIRMED',
  };
  if (mode === 'period') {
    const p = period ?? (until ? until.toISOString().slice(0, 7) : new Date().toISOString().slice(0, 7));
    const range = periodRange(p);
    actualWhere.businessDate = { gte: range.start, lte: range.end };
  } else if (until) {
    actualWhere.businessDate = { lte: until };
  }
  const [entries, trendEntries] = await Promise.all([
    prisma.actualCostEntry.findMany({
      where: actualWhere,
      select: { category: true, amountTaxIncl: true, amountTaxExcl: true, businessDate: true },
    }),
    // 折线图始终展示截至截止日的逐月实际成本，不受"本期"过滤影响
    prisma.actualCostEntry.findMany({
      where: {
        projectId: project.id,
        status: 'CONFIRMED',
        ...(until ? { businessDate: { lte: until } } : {}),
      },
      select: { amountTaxIncl: true, amountTaxExcl: true, businessDate: true },
      orderBy: { businessDate: 'asc' },
    }),
  ]);

  const boqItems = await prisma.projectBoqItem.findMany({
    where: { projectId: project.id, status: 'active' },
    select: { id: true, amountTaxExcl: true, amountTaxIncl: true },
  });
  const boqIncome = boqItems.reduce(
    (acc, b) => acc.add(caliber === 'incl' ? D(b.amountTaxIncl) : D(b.amountTaxExcl)),
    ZERO,
  );
  const boqIncomeIncl = boqItems.reduce((acc, b) => acc.add(D(b.amountTaxIncl)), ZERO);

  // 预算收入按目标明细金额占比分摊到费用类别
  const targetByCategory = emptyByCategory();
  const revenueByCategory = emptyByCategory();
  const targetByBoq = new Map<string, Prisma.Decimal>();
  for (const l of lines) {
    if (l.boqItemId) {
      targetByBoq.set(
        l.boqItemId,
        (targetByBoq.get(l.boqItemId) ?? ZERO).add(money(l)),
      );
    }
  }
  let unallocatedRevenue = ZERO;
  for (const l of lines) {
    targetByCategory[l.category as CategoryKey] =
      targetByCategory[l.category as CategoryKey].add(money(l));
    if (!l.boqItemId) continue;
    const boq = boqItems.find((b) => b.id === l.boqItemId);
    if (!boq) continue;
    const total = targetByBoq.get(l.boqItemId) ?? ZERO;
    if (total.isZero()) continue;
    const share = money(l).div(total);
    revenueByCategory[l.category as CategoryKey] =
      revenueByCategory[l.category as CategoryKey].add(
        (caliber === 'incl' ? D(boq.amountTaxIncl) : D(boq.amountTaxExcl)).mul(share),
      );
  }
  const allocatedRevenue = COST_CATEGORIES.reduce(
    (acc, c) => acc.add(revenueByCategory[c.key]),
    ZERO,
  );
  unallocatedRevenue = boqIncome.sub(allocatedRevenue);

  const actualByCategory = emptyByCategory();
  const entryCountByCategory = Object.fromEntries(
    COST_CATEGORIES.map((c) => [c.key, 0]),
  ) as Record<CategoryKey, number>;
  for (const e of entries) {
    actualByCategory[e.category as CategoryKey] =
      actualByCategory[e.category as CategoryKey].add(money(e));
    entryCountByCategory[e.category as CategoryKey] += 1;
  }

  const targetTotal = lines.reduce((acc, l) => acc.add(money(l)), ZERO);

  const trendMap = new Map<string, Prisma.Decimal>();
  for (const e of trendEntries) {
    const month = e.businessDate.toISOString().slice(0, 7);
    trendMap.set(month, (trendMap.get(month) ?? ZERO).add(money(e)));
  }
  const trend = [...trendMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, amount]) => ({ month, actual: outMoney(amount) }));

  interface ProcessRow {
    key: string;
    label: string;
    target: string | null;
    budgetRevenue: string | null;
    actual: string | null;
    diff: string | null;
    entryCount: number;
  }

  const rows: ProcessRow[] = COST_CATEGORIES.map((c) => {
    const target = targetByCategory[c.key];
    const revenue = revenueByCategory[c.key];
    const actual = actualByCategory[c.key];
    // 本期看收入与实际的盈亏；累计/预测看目标与实际的差额
    const diff = mode === 'period' ? revenue.sub(actual) : target.sub(actual);
    return {
      key: c.key,
      label: c.label,
      target: outMoney(target),
      budgetRevenue: outMoney(revenue),
      actual: outMoney(actual),
      diff: outMoney(diff),
      entryCount: entryCountByCategory[c.key],
    };
  });

  const totalActual = COST_CATEGORIES.reduce((acc, c) => acc.add(actualByCategory[c.key]), ZERO);
  rows.push({
    key: 'total',
    label: '合计',
    target: outMoney(targetTotal),
    budgetRevenue: outMoney(boqIncome),
    actual: outMoney(totalActual),
    diff: outMoney(mode === 'period' ? boqIncome.sub(totalActual) : targetTotal.sub(totalActual)),
    entryCount: entries.length,
  });

  res.json({
    data: {
      mode,
      caliber,
      trend,
      period: mode === 'period' ? period ?? (until ? until.toISOString().slice(0, 7) : new Date().toISOString().slice(0, 7)) : null,
      cutoff: until ? until.toISOString().slice(0, 10) : null,
      rows,
      totals: {
        target: outMoney(targetTotal),
        budgetRevenue: outMoney(boqIncome),
        budgetRevenueTaxIncl: outMoney(boqIncomeIncl),
        actual: outMoney(totalActual),
        unallocatedRevenue: outMoney(unallocatedRevenue),
      },
      targetVersion: version
        ? { id: version.id, versionName: version.versionName, totalAmount: outMoney(version.totalAmount) }
        : null,
      caliberNote: project.costCaliberNote ?? null,
    },
  });
});

/** 过程成本统计下钻：某费用类别在所选模式下的流水。 */
router.get('/:id/process-costs/drilldown', async (req, res) => {
  const { project } = await assertProjectMembership(req, req.params.id);
  const until = parseUntil(req);
  const period = parsePeriod(req);
  const mode: Mode =
    req.query.mode === 'period' ? 'period' : req.query.mode === 'forecast' ? 'forecast' : 'cumulative';
  const category = String(req.query.category ?? '');
  if (!COST_CATEGORIES.some((c) => c.key === category)) throw ApiError.badRequest('费用类别不合法');

  const actualWhere: Prisma.ActualCostEntryWhereInput = {
    projectId: project.id,
    status: 'CONFIRMED',
    category: category as CategoryKey,
  };
  if (mode === 'period') {
    const p = period ?? (until ? until.toISOString().slice(0, 7) : new Date().toISOString().slice(0, 7));
    const range = periodRange(p);
    actualWhere.businessDate = { gte: range.start, lte: range.end };
  } else if (until) {
    actualWhere.businessDate = { lte: until };
  }

  const [entries, version] = await Promise.all([
    prisma.actualCostEntry.findMany({
      where: actualWhere,
      orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
      take: 500,
      include: {
        boqItem: { select: { itemName: true } },
        unitProject: { select: { name: true } },
      },
    }),
    loadCurrentVersion(project.id),
  ]);
  const targetLines = (version?.lines ?? [])
    .filter((l) => l.category === category)
    .map((l) => ({
      id: l.id,
      summary: l.summary,
      boqItemName: l.boqItemName,
      amount: outMoney(l.amount),
      amountTaxIncl: outMoney(l.amountTaxIncl),
      category: l.category,
      unitProjectId: l.unitProjectId,
    }));

  res.json({
    data: {
      mode,
      category,
      targetLines,
      entries: entries.map((e) => ({
        ...e,
        quantity: outQty(e.quantity),
        unitPrice: outMoney(e.unitPrice),
        amount: outMoney(e.amount),
        amountTaxIncl: outMoney(e.amountTaxIncl),
        taxRate: e.taxRate === null ? null : D(e.taxRate).toFixed(2),
        boqItemName: e.boqItem?.itemName ?? null,
        unitProjectName: e.unitProject?.name ?? null,
        boqItem: undefined,
        unitProject: undefined,
      })),
    },
  });
});

export default router;
