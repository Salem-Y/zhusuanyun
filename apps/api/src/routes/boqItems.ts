import { Prisma } from '@prisma/client';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
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
import { outMoney, outQty, parsePrice, parseQuantity, parseTaxRate, roundMoney, taxPair } from '../http/money';

const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireCsrf);

const Decimal = Prisma.Decimal;
const WRITE_ROLES = ['PROJECT_LEAD', 'COST_ENGINEER'];

export const BOQ_PROJECT_CATEGORIES = ['divisional', 'measure', 'other'] as const;

/** 清单项所属系统字段（Excel 列可映射到这些字段或 ignore）。 */
const SYSTEM_FIELDS = [
  'projectCategory',
  'sectionCode',
  'sectionName',
  'itemName',
  'itemFeature',
  'unit',
  'quantity',
  // 第六轮：单一综合单价 + 税率（旧模板的含税/不含税两列保留兼容）
  'unitPrice',
  'taxRate',
  'unitPriceTaxIncl',
  'unitPriceTaxExcl',
  'ignore',
] as const;

const itemBodySchema = z.object({
  projectCategory: z.enum(BOQ_PROJECT_CATEGORIES).default('divisional'),
  unitProjectId: z.string().trim().min(1, '请选择单项工程'),
  sectionCode: z.string().trim().max(60).optional().nullable(),
  sectionName: z.string().trim().max(120).optional().nullable(),
  itemName: z.string().trim().min(1, '请填写项目名称').max(200, '项目名称最多 200 字'),
  itemFeature: z.string().trim().max(300).optional().nullable(),
  unit: z.string().trim().max(20).optional().nullable(),
  quantity: z.union([z.string(), z.number()]).optional().nullable(),
  taxRate: z.union([z.string(), z.number()]).optional().nullable(),
  // true=按含税单价录入（默认），false=按不含税单价录入
  priceTaxIncl: z.boolean().optional(),
  unitPrice: z.union([z.string(), z.number()]).optional().nullable(),
  unitPriceTaxIncl: z.union([z.string(), z.number()]).optional().nullable(),
  unitPriceTaxExcl: z.union([z.string(), z.number()]).optional().nullable(),
});

const itemCreateSchema = itemBodySchema.extend({
  idempotencyKey: z.string().trim().min(8).max(80),
});

const mergeSchema = z.object({
  itemIds: z.array(z.string().trim().min(1)).min(2, '合并至少需要 2 条清单项').max(200),
  primaryId: z.string().trim().min(1, '请指定合并后保留的主记录'),
});

const mappingSaveSchema = z.object({
  mapping: z.record(z.string(), z.enum(SYSTEM_FIELDS)),
  templateName: z.string().trim().max(60, '模板名称最多 60 字').optional().nullable(),
});

/** 可选数量：非负、最多 3 位小数；留空返回 null。 */
function parseOptionalQuantity(input: unknown, label: string): Prisma.Decimal | null {
  if (input === null || input === undefined || input === '') return null;
  return parseQuantity(input, label);
}

/** 可选单价：非负、最多 2 位小数；留空返回 null。 */
function parseOptionalPrice(input: unknown, label: string): Prisma.Decimal | null {
  if (input === null || input === undefined || input === '') return null;
  return parsePrice(input, label);
}

/** 合价 = 工程量 × 综合单价（任一为空按 0 计），后端十进制四舍五入到 2 位。 */
function computeAmount(quantity: Prisma.Decimal | null, price: Prisma.Decimal | null): Prisma.Decimal {
  return roundMoney((quantity ?? new Decimal(0)).mul(price ?? new Decimal(0)));
}

const serializeItem = <
  T extends {
    quantity: Prisma.Decimal | null;
    unitPriceTaxIncl: Prisma.Decimal | null;
    unitPriceTaxExcl: Prisma.Decimal | null;
    amountTaxIncl: Prisma.Decimal | null;
    amountTaxExcl: Prisma.Decimal | null;
    taxRate?: Prisma.Decimal | null;
  },
>(
  item: T,
) => ({
  ...item,
  quantity: outQty(item.quantity),
  unitPriceTaxIncl: outMoney(item.unitPriceTaxIncl),
  unitPriceTaxExcl: outMoney(item.unitPriceTaxExcl),
  amountTaxIncl: outMoney(item.amountTaxIncl),
  amountTaxExcl: outMoney(item.amountTaxExcl),
  taxRate: item.taxRate === null || item.taxRate === undefined ? null : new Decimal(item.taxRate).toFixed(2),
});

/**
 * 统一解析清单项入参：
 * - 税率缺省取项目「收入建安税率」；
 * - 优先按录入口径的单价（unitPrice + priceTaxIncl）反算另一口径；
 * - 未给 unitPrice 时兼容直接传含税/不含税单价。
 */
function normalizeItemBody(
  input: z.infer<typeof itemBodySchema>,
  defaults: { revenueTaxRate: Prisma.Decimal },
) {
  const quantity = parseOptionalQuantity(input.quantity, '工程量');
  const taxRate =
    input.taxRate === null || input.taxRate === undefined || input.taxRate === ''
      ? defaults.revenueTaxRate
      : parseTaxRate(input.taxRate, '税率');
  const priceTaxIncl = input.priceTaxIncl ?? true;
  const enteredPrice = parseOptionalPrice(input.unitPrice, '综合单价');

  let unitPriceTaxIncl: Prisma.Decimal | null = null;
  let unitPriceTaxExcl: Prisma.Decimal | null = null;
  if (enteredPrice !== null) {
    const pair = taxPair(enteredPrice, taxRate, priceTaxIncl);
    unitPriceTaxIncl = pair.incl;
    unitPriceTaxExcl = pair.excl;
  } else {
    const incl = parseOptionalPrice(input.unitPriceTaxIncl, '含税综合单价');
    const excl = parseOptionalPrice(input.unitPriceTaxExcl, '不含税综合单价');
    if (incl !== null || excl !== null) {
      const base = incl ?? excl!;
      const pair = taxPair(base, taxRate, incl !== null);
      unitPriceTaxIncl = pair.incl;
      unitPriceTaxExcl = pair.excl;
    }
  }

  return {
    projectCategory: input.projectCategory,
    unitProjectId: input.unitProjectId,
    taxRate,
    sectionCode: input.sectionCode?.trim() || null,
    sectionName: input.sectionName?.trim() || null,
    itemName: input.itemName.trim(),
    itemFeature: input.itemFeature?.trim() || null,
    unit: input.unit?.trim() || null,
    quantity,
    unitPriceTaxIncl,
    unitPriceTaxExcl,
    amountTaxIncl: computeAmount(quantity, unitPriceTaxIncl),
    amountTaxExcl: computeAmount(quantity, unitPriceTaxExcl),
  };
}

/** 校验单项工程存在、属于本项目且未停用。 */
async function assertUnitProject(projectId: string, unitProjectId: string): Promise<void> {
  const unit = await prisma.projectUnit.findFirst({
    where: { id: unitProjectId, projectId, isActive: true },
    select: { id: true },
  });
  if (!unit) throw ApiError.badRequest('单项工程不存在或已停用');
}

/** 校验当前用户可写清单项（项目负责人 / 造价员）。 */
async function assertBoqWrite(req: Request, projectId: string) {
  const { project, membership } = await assertProjectMembership(req, projectId);
  requireProjectRoles(membership, WRITE_ROLES, '清单项仅项目负责人或造价员可维护');
  assertProjectActive(project);
  return { project, membership };
}

// ============ 清单项列表（?status=active|merged|void，?projectCategory=，?unitProjectId=） ============
router.get('/:id/boq-items', async (req, res) => {
  const { project, membership } = await assertProjectMembership(req, req.params.id);
  const statusFilter = req.query.status === 'merged' ? 'merged' : req.query.status === 'void' ? 'void' : 'active';
  const categoryFilter = BOQ_PROJECT_CATEGORIES.includes(String(req.query.projectCategory ?? '') as never)
    ? (String(req.query.projectCategory) as (typeof BOQ_PROJECT_CATEGORIES)[number])
    : undefined;
  const unitFilter = req.query.unitProjectId ? String(req.query.unitProjectId) : undefined;

  const items = await prisma.projectBoqItem.findMany({
    where: {
      projectId: project.id,
      status: statusFilter,
      ...(categoryFilter ? { projectCategory: categoryFilter } : {}),
      ...(unitFilter ? { unitProjectId: unitFilter } : {}),
    },
    orderBy: [{ projectCategory: 'asc' }, { sectionName: 'asc' }, { createdAt: 'asc' }],
    include: {
      unitProject: { select: { id: true, name: true } },
      mergedInto: { select: { id: true, itemName: true } },
      mergedItems: {
        select: {
          id: true,
          itemName: true,
          quantity: true,
          amountTaxIncl: true,
          amountTaxExcl: true,
          unitProject: { select: { id: true, name: true } },
        },
      },
      _count: { select: { targetLines: true, actualEntries: true } },
    },
  });

  // 顶部汇总只统计符合当前筛选项的 active 记录
  const actives = await prisma.projectBoqItem.findMany({
    where: {
      projectId: project.id,
      status: 'active',
      ...(categoryFilter ? { projectCategory: categoryFilter } : {}),
      ...(unitFilter ? { unitProjectId: unitFilter } : {}),
    },
    select: { amountTaxIncl: true, amountTaxExcl: true },
  });
  const totals = actives.reduce(
    (acc, it) => ({
      amountTaxIncl: acc.amountTaxIncl.add(it.amountTaxIncl),
      amountTaxExcl: acc.amountTaxExcl.add(it.amountTaxExcl),
    }),
    { amountTaxIncl: new Decimal(0), amountTaxExcl: new Decimal(0) },
  );

  // 各分类合计（供三大分类按钮展示）
  const byCategory = await prisma.projectBoqItem.groupBy({
    by: ['projectCategory'],
    where: { projectId: project.id, status: 'active' },
    _sum: { amountTaxIncl: true, amountTaxExcl: true },
    _count: { _all: true },
  });

  res.json({
    data: {
      items: items.map((it) => ({
        ...serializeItem(it),
        hasCost: it._count.targetLines + it._count.actualEntries > 0,
        mergedCount: it.mergedItems.length,
        mergedItems: it.mergedItems.map((m) => ({
          ...m,
          quantity: outQty(m.quantity),
          amountTaxIncl: outMoney(m.amountTaxIncl),
          amountTaxExcl: outMoney(m.amountTaxExcl),
        })),
      })),
      totals: {
        amountTaxIncl: outMoney(totals.amountTaxIncl),
        amountTaxExcl: outMoney(totals.amountTaxExcl),
        activeCount: actives.length,
      },
      byCategory: byCategory.map((c) => ({
        projectCategory: c.projectCategory,
        amountTaxIncl: outMoney(c._sum.amountTaxIncl ?? new Decimal(0)),
        amountTaxExcl: outMoney(c._sum.amountTaxExcl ?? new Decimal(0)),
        count: c._count._all,
      })),
      myRole: membership.roleCode,
    },
  });
});

// ============ 手动新增 ============
router.post('/:id/boq-items', async (req, res) => {
  const { project } = await assertBoqWrite(req, req.params.id);
  const parsed = itemCreateSchema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '信息不完整');
  const input = parsed.data;

  // 幂等：同一幂等键重试直接返回已创建记录
  const replay = await prisma.projectBoqItem.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (replay) {
    res.json({ data: serializeItem(replay), meta: { idempotent: true } });
    return;
  }

  await assertUnitProject(project.id, input.unitProjectId);
  const data = normalizeItemBody(input, { revenueTaxRate: project.revenueTaxRate });
  const item = await prisma.projectBoqItem.create({
    data: {
      ...data,
      projectId: project.id,
      source: 'manual',
      createdById: req.user!.id,
      createdByName: req.user!.displayName ?? req.user!.username,
      idempotencyKey: input.idempotencyKey,
    },
  });
  await writeAudit({
    req,
    action: 'BOQ_ITEM_CREATE',
    objectType: 'ProjectBoqItem',
    objectId: item.id,
    projectId: project.id,
    after: { itemName: item.itemName, amountTaxIncl: outMoney(item.amountTaxIncl) },
  });
  res.status(201).json({ data: serializeItem(item) });
});

// ============ 编辑（仅 active） ============
router.patch('/:id/boq-items/:itemId', async (req, res) => {
  const { project } = await assertBoqWrite(req, req.params.id);
  const parsed = itemBodySchema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '信息不完整');

  const existing = await prisma.projectBoqItem.findFirst({
    where: { id: req.params.itemId, projectId: project.id },
  });
  if (!existing) throw ApiError.notFound('清单项不存在');
  if (existing.status !== 'active') throw ApiError.conflict('仅有效状态的清单项可编辑');

  await assertUnitProject(project.id, parsed.data.unitProjectId);
  const data = normalizeItemBody(parsed.data, { revenueTaxRate: project.revenueTaxRate });
  const item = await prisma.projectBoqItem.update({ where: { id: existing.id }, data });
  await writeAudit({
    req,
    action: 'BOQ_ITEM_UPDATE',
    objectType: 'ProjectBoqItem',
    objectId: item.id,
    projectId: project.id,
    before: { itemName: existing.itemName, amountTaxIncl: outMoney(existing.amountTaxIncl) },
    after: { itemName: item.itemName, amountTaxIncl: outMoney(item.amountTaxIncl) },
  });
  res.json({ data: serializeItem(item) });
});

// ============ 同类项合并 ============
router.post('/:id/boq-items/merge', async (req, res) => {
  const { project } = await assertBoqWrite(req, req.params.id);
  const parsed = mergeSchema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '信息不完整');
  const { itemIds, primaryId } = parsed.data;
  if (!itemIds.includes(primaryId)) throw ApiError.badRequest('主记录必须包含在勾选的清单项中');
  if (new Set(itemIds).size !== itemIds.length) throw ApiError.badRequest('勾选的清单项存在重复');

  const result = await prisma.$transaction(async (tx) => {
    // 行锁：防止合并过程中被并发编辑/关联
    const locked = await tx.$queryRaw<
      Array<{
        id: string;
        status: string;
        itemName: string;
        itemFeature: string | null;
        unit: string | null;
        projectCategory: string;
        quantity: Prisma.Decimal | null;
        unitPriceTaxIncl: Prisma.Decimal | null;
        unitPriceTaxExcl: Prisma.Decimal | null;
        mergedIntoId: string | null;
      }>
    >`SELECT "id", "status", "itemName", "itemFeature", "unit", "projectCategory", "quantity",
             "unitPriceTaxIncl", "unitPriceTaxExcl", "mergedIntoId"
      FROM "ProjectBoqItem" WHERE "id" IN (${Prisma.join(itemIds)}) AND "projectId" = ${project.id}
      ORDER BY "id" FOR UPDATE`;
    if (locked.length !== itemIds.length) throw ApiError.badRequest('存在不属于本项目的清单项');

    const primary = locked.find((it) => it.id === primaryId)!;
    const others = locked.filter((it) => it.id !== primaryId);

    // 幂等：其余记录已全部合并到主记录 → 直接返回现状
    if (others.every((it) => it.status === 'merged' && it.mergedIntoId === primaryId)) {
      const current = await tx.projectBoqItem.findUniqueOrThrow({ where: { id: primaryId } });
      return { item: current, idempotent: true };
    }

    const notActive = locked.find((it) => it.status !== 'active');
    if (notActive) throw ApiError.conflict('仅有效状态的清单项可参与合并');

    // 同类校验：项目名称 + 特征 + 单位 完全一致（空值按空串比较）
    const key = (it: { itemName: string; itemFeature: string | null; unit: string | null }) =>
      `${it.itemName}||${it.itemFeature ?? ''}||${it.unit ?? ''}`;
    const primaryKey = key(primary);
    const mismatch = others.find((it) => key(it) !== primaryKey);
    if (mismatch) {
      throw ApiError.badRequest('仅项目名称、项目特征、单位完全一致的清单项可合并');
    }
    const categoryMismatch = others.find((it) => it.projectCategory !== primary.projectCategory);
    if (categoryMismatch) throw ApiError.badRequest('不同分类（分部分项/措施/其他）的清单项不可合并');

    // 主记录汇总工程量，按自身单价重算合价
    const totalQty = locked.reduce(
      (acc, it) => acc.add(it.quantity ?? new Decimal(0)),
      new Decimal(0),
    );
    const updated = await tx.projectBoqItem.update({
      where: { id: primaryId },
      data: {
        quantity: totalQty,
        amountTaxIncl: computeAmount(totalQty, primary.unitPriceTaxIncl),
        amountTaxExcl: computeAmount(totalQty, primary.unitPriceTaxExcl),
      },
    });
    await tx.projectBoqItem.updateMany({
      where: { id: { in: others.map((it) => it.id) } },
      data: { status: 'merged', mergedIntoId: primaryId },
    });
    return { item: updated, idempotent: false, mergedCount: others.length };
  });

  await writeAudit({
    req,
    action: 'BOQ_ITEM_MERGE',
    objectType: 'ProjectBoqItem',
    objectId: primaryId,
    projectId: project.id,
    after: { itemIds, mergedCount: result.mergedCount ?? 0 },
  });
  res.json({
    data: serializeItem(result.item),
    ...(result.idempotent ? { meta: { idempotent: true } } : {}),
  });
});

// ============ 作废（已被成本明细关联的禁止作废） ============
router.post('/:id/boq-items/:itemId/void', async (req, res) => {
  const { project } = await assertBoqWrite(req, req.params.id);
  const existing = await prisma.projectBoqItem.findFirst({
    where: { id: req.params.itemId, projectId: project.id },
  });
  if (!existing) throw ApiError.notFound('清单项不存在');
  if (existing.status === 'void') {
    res.json({ data: serializeItem(existing), meta: { idempotent: true } });
    return;
  }
  if (existing.status === 'merged') throw ApiError.conflict('已合并记录无需作废');

  const [targetRefs, actualRefs] = await Promise.all([
    prisma.targetCostLine.count({ where: { boqItemId: existing.id } }),
    prisma.actualCostEntry.count({ where: { boqItemId: existing.id } }),
  ]);
  if (targetRefs + actualRefs > 0) {
    throw ApiError.conflict(
      `该清单项已被 ${targetRefs + actualRefs} 条成本明细关联，禁止作废`,
      'E_BOQ_ITEM_REFERENCED',
    );
  }

  const item = await prisma.projectBoqItem.update({
    where: { id: existing.id },
    data: { status: 'void' },
  });
  await writeAudit({
    req,
    action: 'BOQ_ITEM_VOID',
    objectType: 'ProjectBoqItem',
    objectId: item.id,
    projectId: project.id,
    before: { itemName: existing.itemName },
  });
  res.json({ data: serializeItem(item) });
});

// ============ 导入框架（本轮不做解析写入） ============

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

function uploadSingle(field: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    upload.single(field)(req, res, (err: unknown) => {
      if (err) {
        const msg = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
          ? '文件大小不能超过 5MB'
          : '文件上传失败，请重试';
        next(ApiError.badRequest(msg));
        return;
      }
      next();
    });
  };
}

/** 上传 Excel → 读取表头，建立导入日志。 */
router.post('/:id/boq-imports/preview', uploadSingle('file'), async (req, res) => {
  const { project } = await assertBoqWrite(req, String(req.params.id));
  const file = req.file;
  if (!file) throw ApiError.badRequest('请选择要上传的 Excel 文件');
  const fileName = Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 200);
  if (!/\.(xlsx|xls|csv)$/i.test(fileName)) {
    throw ApiError.badRequest('仅支持 .xlsx / .xls / .csv 文件');
  }

  let headers: string[] = [];
  try {
    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('empty');
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
      header: 1,
      defval: '',
      blankrows: false,
    });
    const firstRow = rows[0] ?? [];
    headers = firstRow.map((cell) => String(cell).trim()).filter((h) => h.length > 0).slice(0, 60);
  } catch {
    throw ApiError.badRequest('无法读取文件内容，请确认是有效的 Excel/CSV 文件');
  }
  if (headers.length === 0) throw ApiError.badRequest('未在首行识别到任何表头');

  const log = await prisma.importLog.create({
    data: {
      projectId: project.id,
      fileName,
      status: 'HEADERS_READ',
      headerJson: headers,
      createdById: req.user!.id,
      createdByName: req.user!.displayName ?? req.user!.username,
    },
  });
  const templates = await prisma.importMappingTemplate.findMany({
    where: { projectId: project.id },
    orderBy: { updatedAt: 'desc' },
  });
  await writeAudit({
    req,
    action: 'BOQ_IMPORT_PREVIEW',
    objectType: 'ImportLog',
    objectId: log.id,
    projectId: project.id,
    after: { fileName, headers },
  });
  res.status(201).json({
    data: {
      logId: log.id,
      fileName: log.fileName,
      headers,
      templates,
    },
  });
});

/** 保存字段映射（可命名存为模板复用）。 */
router.post('/:id/boq-imports/:logId/mapping', async (req, res) => {
  const { project } = await assertBoqWrite(req, req.params.id);
  const parsed = mappingSaveSchema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '信息不完整');
  const { mapping, templateName } = parsed.data;

  const log = await prisma.importLog.findFirst({
    where: { id: req.params.logId, projectId: project.id },
  });
  if (!log) throw ApiError.notFound('导入记录不存在');
  if (!['HEADERS_READ', 'MAPPING_SAVED'].includes(log.status)) {
    throw ApiError.conflict('该导入记录已完成确认，不能重复保存映射');
  }

  const headers = Array.isArray(log.headerJson) ? (log.headerJson as string[]) : [];
  const unknownHeader = Object.keys(mapping).find((h) => !headers.includes(h));
  if (unknownHeader) throw ApiError.badRequest(`映射中包含文件中不存在的表头「${unknownHeader}」`);
  if (!Object.values(mapping).includes('itemName')) {
    throw ApiError.badRequest('必须至少把一列映射为「项目名称」');
  }

  let templateId: string | null = null;
  if (templateName?.trim()) {
    const template = await prisma.importMappingTemplate.upsert({
      where: { projectId_name: { projectId: project.id, name: templateName.trim() } },
      create: {
        projectId: project.id,
        name: templateName.trim(),
        mapping,
        createdById: req.user!.id,
        createdByName: req.user!.displayName ?? req.user!.username,
      },
      update: { mapping },
    });
    templateId = template.id;
  }

  const updated = await prisma.importLog.update({
    where: { id: log.id },
    data: { status: 'MAPPING_SAVED', templateId },
  });
  await writeAudit({
    req,
    action: 'BOQ_IMPORT_MAPPING',
    objectType: 'ImportLog',
    objectId: log.id,
    projectId: project.id,
    after: { mapping, templateName: templateName?.trim() || null },
  });
  res.json({ data: { logId: updated.id, status: updated.status, templateId } });
});

/** 确认导入：本轮解析逻辑未开放，只记录日志，不写入清单数据。 */
router.post('/:id/boq-imports/:logId/confirm', async (req, res) => {
  const { project } = await assertBoqWrite(req, req.params.id);
  const log = await prisma.importLog.findFirst({
    where: { id: req.params.logId, projectId: project.id },
  });
  if (!log) throw ApiError.notFound('导入记录不存在');
  if (log.status === 'CONFIRM_PENDING_PARSE') {
    res.json({
      data: { logId: log.id, status: log.status },
      meta: { idempotent: true, message: '解析逻辑待模板确认后开放，本次未写入清单数据' },
    });
    return;
  }
  if (log.status !== 'MAPPING_SAVED') throw ApiError.conflict('请先完成字段映射后再确认导入');

  const updated = await prisma.importLog.update({
    where: { id: log.id },
    data: { status: 'CONFIRM_PENDING_PARSE', note: '解析逻辑待模板确认后开放，本次未写入清单数据' },
  });
  await writeAudit({
    req,
    action: 'BOQ_IMPORT_CONFIRM',
    objectType: 'ImportLog',
    objectId: log.id,
    projectId: project.id,
  });
  res.json({
    data: { logId: updated.id, status: updated.status },
    meta: { message: '解析逻辑待模板确认后开放，本次未写入清单数据' },
  });
});

/** 映射模板列表。 */
router.get('/:id/boq-imports/templates', async (req, res) => {
  const { project } = await assertProjectMembership(req, req.params.id);
  const templates = await prisma.importMappingTemplate.findMany({
    where: { projectId: project.id },
    orderBy: { updatedAt: 'desc' },
  });
  res.json({ data: templates });
});

/** 导入日志列表。 */
router.get('/:id/boq-imports', async (req, res) => {
  const { project } = await assertProjectMembership(req, req.params.id);
  const logs = await prisma.importLog.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json({ data: logs });
});

export default router;
