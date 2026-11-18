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
import {
  outMoney,
  outQty,
  parsePrice,
  parseQuantity,
  parseTaxRate,
  roundMoney,
} from '../http/money';

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
const HUNDRED = new Prisma.Decimal(100);

interface EstimatePrices {
  laborPrice: Prisma.Decimal | null;
  materialPrice: Prisma.Decimal | null;
  subcontractPrice: Prisma.Decimal | null;
}

/** 第 10 列实际单价：分包优先；人工+材料次之；全空返回 null（回退目标成本）。 */
function unitCostOf(p: EstimatePrices): Prisma.Decimal | null {
  if (p.subcontractPrice !== null) return p.subcontractPrice;
  if (p.laborPrice !== null || p.materialPrice !== null) {
    return (p.laborPrice ?? ZERO).add(p.materialPrice ?? ZERO);
  }
  return null;
}

/** 加权平均（按实际工程量加权）；无有效权重时返回 null。 */
function weightedAvg(pairs: Array<{ w: Prisma.Decimal; v: Prisma.Decimal }>): Prisma.Decimal | null {
  const wsum = pairs.reduce((acc, p) => acc.add(p.w), ZERO);
  if (wsum.isZero()) return null;
  return pairs.reduce((acc, p) => acc.add(p.w.mul(p.v)), ZERO).div(wsum);
}

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

  // 第八轮：测算行 + 项目默认税率（人工 3 / 材料 13 / 分包 9）
  const boqIdList = boqItems.map((i) => i.id);
  const estimateRows = boqIdList.length
    ? await prisma.boqCostEstimate.findMany({
        where: { projectId: project.id, boqItemId: { in: boqIdList } },
      })
    : [];
  const estByBoq = new Map(estimateRows.map((e) => [e.boqItemId, e] as const));
  const defRates = {
    labor: D(project.defaultLaborTaxRate),
    material: D(project.defaultMaterialTaxRate),
    subcontract: D(project.defaultSubcontractTaxRate),
  };

  const lines = (version?.lines ?? []).filter((l) => !unitProjectId || l.unitProjectId === unitProjectId);

  const unitName = new Map(units.map((u) => [u.id, u.name]));
  const boqById = new Map(boqItems.map((i) => [i.id, i] as const));

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
  const groupByBoq = new Map<string, Group>();
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
    groupByBoq.set(item.id, group);
    group.quantity = group.quantity.add(D(item.quantity));
    group.incomeTaxIncl = group.incomeTaxIncl.add(D(item.amountTaxIncl));
    group.incomeTaxExcl = group.incomeTaxExcl.add(D(item.amountTaxExcl));
    group.boqIds.push(item.id);
  }

  // 第八轮：目标成本按清单项索引（支撑子行拆分）；仅统计关联到清单项的明细行
  const targetByBoq = new Map<string, Prisma.Decimal>();
  let unlinkedTargetCount = 0;
  for (const line of lines) {
    if (!line.boqItemId) {
      unlinkedTargetCount += 1;
      continue;
    }
    const amount = caliber === 'incl' ? D(line.amountTaxIncl) : D(line.amountTaxExcl);
    targetByBoq.set(line.boqItemId, (targetByBoq.get(line.boqItemId) ?? ZERO).add(amount));
    const group = groupByBoq.get(line.boqItemId);
    if (group) {
      group.target = group.target.add(amount);
      group.targetByCategory[line.category as CategoryKey] =
        group.targetByCategory[line.category as CategoryKey].add(amount);
    }
  }

  // 第八轮：实际成本按清单项索引（支撑子行拆分）；仅统计关联到清单项的已确认净额（含冲销负向记录）
  const actualByBoq = new Map<string, Prisma.Decimal>();
  // 第十四轮：饼图数据源 = 全部已确认实际成本（含未关联清单项的台账/流水）
  const allActualByCategory = emptyByCategory();
  let unlinkedActualCount = 0;
  for (const entry of confirmedEntries) {
    const amount = caliber === 'incl' ? D(entry.amountTaxIncl) : D(entry.amountTaxExcl);
    allActualByCategory[entry.category as CategoryKey] =
      allActualByCategory[entry.category as CategoryKey].add(amount);
    if (!entry.boqItemId) {
      unlinkedActualCount += 1;
      continue;
    }
    actualByBoq.set(entry.boqItemId, (actualByBoq.get(entry.boqItemId) ?? ZERO).add(amount));
    const group = groupByBoq.get(entry.boqItemId);
    if (group) {
      group.actual = group.actual.add(amount);
      group.actualQty = group.actualQty.add(D(entry.quantity ?? 0));
      group.actualByCategory[entry.category as CategoryKey] =
        group.actualByCategory[entry.category as CategoryKey].add(amount);
    }
  }

  // 第八轮：子行构造（每个清单项一行，承载可编辑的测算数据）
  const buildChild = (boqId: string) => {
    const item = boqById.get(boqId);
    if (!item) return null;
    const est = estByBoq.get(boqId);
    const prices: EstimatePrices = {
      laborPrice: est?.laborPrice ?? null,
      materialPrice: est?.materialPrice ?? null,
      subcontractPrice: est?.subcontractPrice ?? null,
    };
    const rates = {
      labor: est?.laborTaxRate ?? defRates.labor,
      material: est?.materialTaxRate ?? defRates.material,
      subcontract: est?.subcontractTaxRate ?? defRates.subcontract,
    };
    // 第 6 列：实际工程量，默认等于清单量
    const qty = est?.actualQuantity ?? D(item.quantity);
    const targetDec = targetByBoq.get(boqId) ?? ZERO;
    const incomeIncl = D(item.amountTaxIncl);
    const incomeExcl = D(item.amountTaxExcl);
    const actualDec = actualByBoq.get(boqId) ?? ZERO;
    const unitCostDec = unitCostOf(prices);
    // 第 9 列：有单价时 = 实际工程量 × 实际单价；11/12/13 全空时回退目标成本
    const costDec = unitCostDec === null ? targetDec : roundMoney(qty.mul(unitCostDec));
    // 含税成本 = 各分项（数量 × 不含税单价 × (1 + 各自税率/100)）之和
    const inclFactor = (rate: Prisma.Decimal) => rate.div(HUNDRED).add(1);
    const costTaxInclDec =
      unitCostDec === null
        ? null
        : roundMoney(
            (prices.laborPrice ? qty.mul(prices.laborPrice).mul(inclFactor(rates.labor)) : ZERO)
              .add(
                prices.materialPrice
                  ? qty.mul(prices.materialPrice).mul(inclFactor(rates.material))
                  : ZERO,
              )
              .add(
                prices.subcontractPrice
                  ? qty.mul(prices.subcontractPrice).mul(inclFactor(rates.subcontract))
                  : ZERO,
              ),
          );
    return {
      key: boqId,
      boqId,
      boqIds: [boqId],
      isMerged: false,
      itemName: item.itemName,
      itemFeature: item.itemFeature,
      unit: item.unit,
      unitProjectId: item.unitProjectId,
      unitProjectName: item.unitProject?.name ?? null,
      quantity: outQty(item.quantity),
      actualQuantity: outQty(qty),
      income: outMoney(caliber === 'incl' ? incomeIncl : incomeExcl),
      incomeTaxIncl: outMoney(incomeIncl),
      incomeTaxExcl: outMoney(incomeExcl),
      target: outMoney(targetDec),
      actual: outMoney(actualDec),
      diff: outMoney((caliber === 'incl' ? incomeIncl : incomeExcl).sub(actualDec)),
      laborPrice: outMoney(prices.laborPrice),
      materialPrice: outMoney(prices.materialPrice),
      subcontractPrice: outMoney(prices.subcontractPrice),
      laborTaxRate: rates.labor.toFixed(2),
      materialTaxRate: rates.material.toFixed(2),
      subcontractTaxRate: rates.subcontract.toFixed(2),
      unitCost: outMoney(unitCostDec),
      cost: outMoney(costDec),
      costTaxIncl: outMoney(costTaxInclDec),
      costStatus: est ? est.costStatus : 'PREDICTED',
      hasDiffPrice: false,
      _qty: qty,
      _unitCost: unitCostDec,
      _cost: costDec,
      _costTaxIncl: costTaxInclDec,
    };
  };

  const rows = [...groups.values()]
    .map((g) => {
      const children = g.boqIds
        .map(buildChild)
        .filter((c): c is NonNullable<typeof c> => c !== null);
      const actualTotal = g.actual;
      const incomeByCaliber = caliber === 'incl' ? g.incomeTaxIncl : g.incomeTaxExcl;
      // 单子行：直接作为叶子行输出（无 [+] 展开）
      if (children.length === 1) {
        const only = children[0];
        const { _qty, _unitCost, _cost, _costTaxIncl, ...leaf } = only;
        return {
          ...leaf,
          key: g.key,
          boqIds: g.boqIds,
          diff: outMoney(incomeByCaliber.sub(actualTotal)),
          ...Object.fromEntries(
            COST_CATEGORIES.map((c) => [c.key, outMoney(g.actualByCategory[c.key])]),
          ),
          targetByCategory: Object.fromEntries(
            COST_CATEGORIES.map((c) => [c.key, outMoney(g.targetByCategory[c.key])]),
          ),
          hasCost: !g.target.isZero() || !actualTotal.isZero(),
          children: null,
        };
      }

      // 合并父行：只读汇总；实际单价取各子行按实际工程量加权的加权平均
      const pricedPairs: Array<{ w: Prisma.Decimal; v: Prisma.Decimal }> = [];
      for (const c of children) {
        if (c._unitCost !== null) pricedPairs.push({ w: c._qty, v: c._unitCost });
      }
      const unitCostDec = weightedAvg(pricedPairs);
      const distinctCosts = new Set(pricedPairs.map((p) => p.v.toFixed(2)));
      const costDec = children.reduce((acc, c) => acc.add(c._cost), ZERO);
      const costTaxInclDec = children.some((c) => c._costTaxIncl !== null)
        ? children.reduce((acc, c) => acc.add(c._costTaxIncl ?? ZERO), ZERO)
        : null;
      const actualQtyDec = children.reduce((acc, c) => acc.add(c._qty), ZERO);
      return {
        key: g.key,
        boqId: null,
        boqIds: g.boqIds,
        isMerged: true,
        itemName: g.itemName,
        itemFeature: g.itemFeature,
        unit: g.unit,
        unitProjectId: g.unitProjectId,
        unitProjectName: g.unitProjectName,
        quantity: outQty(g.quantity),
        actualQuantity: outQty(actualQtyDec),
        income: outMoney(incomeByCaliber),
        incomeTaxIncl: outMoney(g.incomeTaxIncl),
        incomeTaxExcl: outMoney(g.incomeTaxExcl),
        target: outMoney(g.target),
        actual: outMoney(actualTotal),
        // 盈亏差额 = 当前口径收入 − 当前口径实际成本
        diff: outMoney(incomeByCaliber.sub(actualTotal)),
        laborPrice: null,
        materialPrice: null,
        subcontractPrice: null,
        laborTaxRate: null,
        materialTaxRate: null,
        subcontractTaxRate: null,
        unitCost: outMoney(unitCostDec),
        cost: outMoney(costDec),
        costTaxIncl: outMoney(costTaxInclDec),
        costStatus: null,
        hasDiffPrice: distinctCosts.size > 1,
        ...Object.fromEntries(
          COST_CATEGORIES.map((c) => [c.key, outMoney(g.actualByCategory[c.key])]),
        ),
        targetByCategory: Object.fromEntries(
          COST_CATEGORIES.map((c) => [c.key, outMoney(g.targetByCategory[c.key])]),
        ),
        hasCost: !g.target.isZero() || !actualTotal.isZero(),
        children: children.map(({ _qty, _unitCost, _cost, _costTaxIncl, ...rest }) => rest),
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
      cost: acc.cost.add(D(r.cost)),
      costTaxIncl: acc.costTaxIncl.add(D(r.costTaxIncl)),
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
      cost: ZERO,
      costTaxIncl: ZERO,
      actual: ZERO,
      diff: ZERO,
      byCategory: emptyByCategory(),
    },
  );

  // 第十四轮：顶部汇总与饼图统一按“全部已确认实际成本”统计（含未关联清单项的台账/流水）
  totals.byCategory = allActualByCategory;
  totals.actual = COST_CATEGORIES.reduce((acc, c) => acc.add(allActualByCategory[c.key]), ZERO);
  totals.diff = (caliber === 'incl' ? totals.incomeTaxIncl : totals.incomeTaxExcl).sub(totals.actual);

  res.json({
    data: {
      rows,
      totals: {
        income: outMoney(totals.income),
        incomeTaxIncl: outMoney(totals.incomeTaxIncl),
        incomeTaxExcl: outMoney(totals.incomeTaxExcl),
        actualQuantity: outQty(totals.actualQuantity),
        target: outMoney(totals.target),
        cost: outMoney(totals.cost),
        costTaxIncl: outMoney(totals.costTaxIncl),
        actual: outMoney(totals.actual),
        hasUnlinkedActual: unlinkedActualCount > 0,
        diff: outMoney(totals.diff),
        byCategory: Object.fromEntries(
          COST_CATEGORIES.map((c) => [c.key, outMoney(totals.byCategory[c.key])]),
        ),
      },
      caliber,
      categories: COST_CATEGORIES,
      // 第八轮：全局默认不含税税率（人工 3% / 材料 13% / 分包 9%）
      defaultTaxRates: {
        labor: outMoney(defRates.labor),
        material: outMoney(defRates.material),
        subcontract: outMoney(defRates.subcontract),
      },
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

// ============================================================
// 第八轮：测算大宽表录入（第 6/11/12/13/14 列）
// ============================================================

const optNumber = z.union([z.string(), z.number()]).nullish();

const estimateSaveSchema = z.object({
  boqItemId: z.string().trim().min(1, '缺少清单项'),
  actualQuantity: optNumber,
  laborPrice: optNumber,
  materialPrice: optNumber,
  subcontractPrice: optNumber,
  laborTaxRate: optNumber,
  materialTaxRate: optNumber,
  subcontractTaxRate: optNumber,
  costStatus: z.enum(['PREDICTED', 'FIXED']).optional(),
});

const optionalPrice = (v: unknown, label: string) =>
  v === null || v === undefined || v === '' ? null : parsePrice(v, label);
const optionalRate = (v: unknown, label: string) =>
  v === null || v === undefined || v === '' ? null : parseTaxRate(v, label);
const decOut = (v: Prisma.Decimal | null | undefined) => (v === null || v === undefined ? null : v.toFixed(2));

/**
 * 保存清单测算行：实际工程量、互斥单价（人工/材料 ↔ 专业分包）、单条税率、成本状态。
 * 互斥规则：专业分包有值时人工/材料必须为空，反之亦然。
 */
router.put('/:id/cost-estimates', async (req, res) => {
  const { project, membership } = await assertProjectMembership(req, req.params.id);
  requireProjectRoles(
    membership,
    ['COST_ENGINEER', 'PROJECT_LEAD'],
    '成本测算由造价员或项目负责人维护',
  );
  assertProjectActive(project);

  const parsed = estimateSaveSchema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '信息不完整');
  const input = parsed.data;

  const boq = await prisma.projectBoqItem.findFirst({
    where: { id: input.boqItemId, projectId: project.id },
    select: { id: true },
  });
  if (!boq) throw ApiError.badRequest('清单项不存在或不属于本项目');

  const laborPrice = optionalPrice(input.laborPrice, '人工单价');
  const materialPrice = optionalPrice(input.materialPrice, '材料单价');
  const subcontractPrice = optionalPrice(input.subcontractPrice, '专业分包单价');
  const actualQuantity =
    input.actualQuantity === null || input.actualQuantity === undefined || input.actualQuantity === ''
      ? null
      : parseQuantity(input.actualQuantity, '实际工程量');

  // 互斥校验：分包与人工/材料不能同时录入
  if (subcontractPrice !== null && (laborPrice !== null || materialPrice !== null)) {
    throw ApiError.badRequest('专业分包与人工/材料不能同时录入，请先清空其中一侧');
  }

  const before = await prisma.boqCostEstimate.findUnique({ where: { boqItemId: boq.id } });
  const data = {
    projectId: project.id,
    actualQuantity,
    laborPrice,
    materialPrice,
    subcontractPrice,
    laborTaxRate: optionalRate(input.laborTaxRate, '人工税率'),
    materialTaxRate: optionalRate(input.materialTaxRate, '材料税率'),
    subcontractTaxRate: optionalRate(input.subcontractTaxRate, '专业分包税率'),
    ...(input.costStatus ? { costStatus: input.costStatus } : {}),
    updatedById: req.user?.id ?? null,
    updatedByName: req.user?.displayName ?? null,
  };
  const saved = await prisma.boqCostEstimate.upsert({
    where: { boqItemId: boq.id },
    create: { boqItemId: boq.id, ...data },
    update: data,
  });

  await writeAudit({
    req,
    action: before ? 'COST_ESTIMATE_UPDATE' : 'COST_ESTIMATE_CREATE',
    objectType: 'BoqCostEstimate',
    objectId: saved.id,
    projectId: project.id,
    before: before
      ? {
          actualQuantity: decOut(before.actualQuantity),
          laborPrice: decOut(before.laborPrice),
          materialPrice: decOut(before.materialPrice),
          subcontractPrice: decOut(before.subcontractPrice),
          costStatus: before.costStatus,
        }
      : null,
    after: {
      actualQuantity: decOut(saved.actualQuantity),
      laborPrice: decOut(saved.laborPrice),
      materialPrice: decOut(saved.materialPrice),
      subcontractPrice: decOut(saved.subcontractPrice),
      costStatus: saved.costStatus,
    },
  });

  res.json({
    data: {
      boqItemId: saved.boqItemId,
      actualQuantity: outQty(saved.actualQuantity),
      laborPrice: outMoney(saved.laborPrice),
      materialPrice: outMoney(saved.materialPrice),
      subcontractPrice: outMoney(saved.subcontractPrice),
      laborTaxRate: decOut(saved.laborTaxRate),
      materialTaxRate: decOut(saved.materialTaxRate),
      subcontractTaxRate: decOut(saved.subcontractTaxRate),
      costStatus: saved.costStatus,
    },
  });
});

const defaultTaxRatesSchema = z.object({
  laborTaxRate: z.union([z.string(), z.number()]),
  materialTaxRate: z.union([z.string(), z.number()]),
  subcontractTaxRate: z.union([z.string(), z.number()]),
});

/** 维护项目默认不含税税率（人工 3% / 材料 13% / 分包 9%）。 */
router.put('/:id/default-tax-rates', async (req, res) => {
  const { project, membership } = await assertProjectMembership(req, req.params.id);
  requireProjectRoles(
    membership,
    ['COST_ENGINEER', 'PROJECT_LEAD'],
    '默认税率由造价员或项目负责人维护',
  );
  assertProjectActive(project);

  const parsed = defaultTaxRatesSchema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '信息不完整');

  const labor = parseTaxRate(parsed.data.laborTaxRate, '人工税率');
  const material = parseTaxRate(parsed.data.materialTaxRate, '材料税率');
  const subcontract = parseTaxRate(parsed.data.subcontractTaxRate, '专业分包税率');

  const updated = await prisma.project.update({
    where: { id: project.id },
    data: {
      defaultLaborTaxRate: labor,
      defaultMaterialTaxRate: material,
      defaultSubcontractTaxRate: subcontract,
    },
    select: {
      defaultLaborTaxRate: true,
      defaultMaterialTaxRate: true,
      defaultSubcontractTaxRate: true,
    },
  });

  await writeAudit({
    req,
    action: 'PROJECT_DEFAULT_TAX_RATES_UPDATE',
    objectType: 'Project',
    objectId: project.id,
    projectId: project.id,
    before: {
      labor: decOut(project.defaultLaborTaxRate),
      material: decOut(project.defaultMaterialTaxRate),
      subcontract: decOut(project.defaultSubcontractTaxRate),
    },
    after: {
      labor: decOut(updated.defaultLaborTaxRate),
      material: decOut(updated.defaultMaterialTaxRate),
      subcontract: decOut(updated.defaultSubcontractTaxRate),
    },
  });

  res.json({
    data: {
      labor: decOut(updated.defaultLaborTaxRate),
      material: decOut(updated.defaultMaterialTaxRate),
      subcontract: decOut(updated.defaultSubcontractTaxRate),
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
  // 第十轮：实际成本严格按“成本周期”筛选；目标/预测不参与时间回溯
  const targetMonth =
    period ?? (until ? until.toISOString().slice(0, 7) : new Date().toISOString().slice(0, 7));
  // 第十一轮：一次性取截至所选月份的全部流水，同时产出本期与累计口径
  // 第十三轮：无成本周期的总账台账计入累计实际，但不计入本期
  actualWhere.OR = [{ period: { lte: targetMonth } }, { period: null }];
  const [entries, trendEntries] = await Promise.all([
    prisma.actualCostEntry.findMany({
      where: actualWhere,
      select: { category: true, amountTaxIncl: true, amountTaxExcl: true, period: true },
    }),
    // 折线图展示截至所选月份的逐月实际成本，不受"本期"过滤影响
    prisma.actualCostEntry.findMany({
      where: {
        projectId: project.id,
        status: 'CONFIRMED',
        period: { lte: targetMonth },
      },
      select: { amountTaxIncl: true, amountTaxExcl: true, period: true },
      orderBy: { period: 'asc' },
    }),
  ]);

  const boqItems = await prisma.projectBoqItem.findMany({
    where: { projectId: project.id, status: 'active' },
    select: { id: true, quantity: true, amountTaxExcl: true, amountTaxIncl: true },
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
  void unallocatedRevenue;
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
  void allocatedRevenue;

  const actualByCategory = emptyByCategory();
  const actualPeriodByCategory = emptyByCategory();
  const entryCountByCategory = Object.fromEntries(
    COST_CATEGORIES.map((c) => [c.key, 0]),
  ) as Record<CategoryKey, number>;
  // 第十一轮：同时产出"本期实际"与"累计实际"两套口径
  for (const e of entries) {
    const key = e.category as CategoryKey;
    actualByCategory[key] = actualByCategory[key].add(money(e));
    if (e.period === targetMonth) {
      actualPeriodByCategory[key] = actualPeriodByCategory[key].add(money(e));
      entryCountByCategory[key] += 1;
    }
  }

  const targetTotal = lines.reduce((acc, l) => acc.add(money(l)), ZERO);

  // 第十轮：预测成本 = 当前总账大盘即时汇总（不随日期回溯）
  const estimateRows = await prisma.boqCostEstimate.findMany({
    where: { projectId: project.id },
  });
  const estMap = new Map(estimateRows.map((e) => [e.boqItemId, e] as const));
  const defLaborRate = D(project.defaultLaborTaxRate);
  const defMaterialRate = D(project.defaultMaterialTaxRate);
  const defSubRate = D(project.defaultSubcontractTaxRate);
  let predictedTotal = ZERO;
  for (const b of boqItems) {
    const est = estMap.get(b.id);
    const target = targetByBoq.get(b.id) ?? ZERO;
    const qty = est?.actualQuantity ? D(est.actualQuantity) : D(b.quantity);
    const labor = est?.laborPrice ? D(est.laborPrice) : null;
    const material = est?.materialPrice ? D(est.materialPrice) : null;
    const sub = est?.subcontractPrice ? D(est.subcontractPrice) : null;
    let unitCost: Prisma.Decimal | null = null;
    if (sub !== null) unitCost = sub;
    else if (labor !== null || material !== null) unitCost = (labor ?? ZERO).add(material ?? ZERO);
    if (unitCost === null) {
      predictedTotal = predictedTotal.add(target);
      continue;
    }
    if (caliber === 'excl') {
      predictedTotal = predictedTotal.add(roundMoney(qty.mul(unitCost)));
      continue;
    }
    const inclFactor = (rate: Prisma.Decimal) => rate.div(HUNDRED).add(1);
    const laborRate = est?.laborTaxRate ? D(est.laborTaxRate) : defLaborRate;
    const materialRate = est?.materialTaxRate ? D(est.materialTaxRate) : defMaterialRate;
    const subRate = est?.subcontractTaxRate ? D(est.subcontractTaxRate) : defSubRate;
    predictedTotal = predictedTotal.add(
      roundMoney(
        (labor ? qty.mul(labor).mul(inclFactor(laborRate)) : ZERO)
          .add(material ? qty.mul(material).mul(inclFactor(materialRate)) : ZERO)
          .add(sub ? qty.mul(sub).mul(inclFactor(subRate)) : ZERO),
      ),
    );
  }

  const trendMap = new Map<string, Prisma.Decimal>();
  for (const e of trendEntries) {
    if (!e.period) continue; // 无周期的总账台账不计入月度趋势
    trendMap.set(e.period, (trendMap.get(e.period) ?? ZERO).add(money(e)));
  }
  const trend = [...trendMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, amount]) => ({ month, actual: outMoney(amount) }));

  interface ProcessRow {
    key: string;
    label: string;
    target: string | null;
    predicted: string | null;
    actualPeriod: string | null;
    actualCumulative: string | null;
    diff: string | null;
    entryCount: number;
  }

  // 预测成本按目标金额占比分摊到各费用类别，使合计可对齐
  const predictedByCategory = emptyByCategory();
  if (!targetTotal.isZero()) {
    for (const c of COST_CATEGORIES) {
      predictedByCategory[c.key] = predictedTotal.mul(targetByCategory[c.key].div(targetTotal));
    }
  }

  const rows: ProcessRow[] = COST_CATEGORIES.map((c) => {
    const target = targetByCategory[c.key];
    const cumulative = actualByCategory[c.key];
    return {
      key: c.key,
      label: c.label,
      target: outMoney(target),
      predicted: outMoney(predictedByCategory[c.key]),
      actualPeriod: outMoney(actualPeriodByCategory[c.key]),
      actualCumulative: outMoney(cumulative),
      diff: outMoney(target.sub(cumulative)),
      entryCount: entryCountByCategory[c.key],
    };
  });

  const totalCumulative = COST_CATEGORIES.reduce((acc, c) => acc.add(actualByCategory[c.key]), ZERO);
  const totalPeriod = COST_CATEGORIES.reduce(
    (acc, c) => acc.add(actualPeriodByCategory[c.key]),
    ZERO,
  );
  rows.push({
    key: 'total',
    label: '合计',
    target: outMoney(targetTotal),
    predicted: outMoney(predictedTotal),
    actualPeriod: outMoney(totalPeriod),
    actualCumulative: outMoney(totalCumulative),
    diff: outMoney(targetTotal.sub(totalCumulative)),
    entryCount: entries.filter((e) => e.period === targetMonth).length,
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
        predicted: outMoney(predictedTotal),
        budgetRevenue: outMoney(boqIncome),
        budgetRevenueTaxIncl: outMoney(boqIncomeIncl),
        actual: outMoney(totalCumulative),
        actualPeriod: outMoney(totalPeriod),
        actualCumulative: outMoney(totalCumulative),
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
  // 第十轮：下钻流水同样按“成本周期”筛选（无周期的总账台账一并展示）
  const targetMonth =
    period ?? (until ? until.toISOString().slice(0, 7) : new Date().toISOString().slice(0, 7));
  actualWhere.OR = [{ period: { lte: targetMonth } }, { period: null }];

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
