import type {
  ActualEntryStatus,
  BoqProjectCategory,
  ExpenseCategory,
  PricingMethod,
  TargetVersionStatus,
} from '../../api';

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  labor: '人工',
  material: '材料',
  machine: '机械',
  subcontract: '专业分包',
  turnover: '周转料具',
  measure: '措施费',
  site_overhead: '现场经费',
  other: '其他',
};

/** 8 大费用类别固定顺序（过程成本统计行顺序一致）。 */
export const EXPENSE_CATEGORY_KEYS: ExpenseCategory[] = [
  'labor',
  'material',
  'machine',
  'subcontract',
  'turnover',
  'measure',
  'site_overhead',
  'other',
];

export const BOQ_PROJECT_CATEGORY_LABELS: Record<BoqProjectCategory, string> = {
  divisional: '分部分项工程费',
  measure: '措施项目费',
  other: '其他项目费',
};

export const BOQ_PROJECT_CATEGORY_KEYS: BoqProjectCategory[] = ['divisional', 'measure', 'other'];

export const PRICING_METHOD_LABELS: Record<PricingMethod, string> = {
  QTY_PRICE: '数量×单价',
  LUMP_SUM: '按总额登记',
};

export const TARGET_STATUS_LABELS: Record<TargetVersionStatus, string> = {
  DRAFT: '草稿',
  SUBMITTED: '待批准',
  APPROVED: '已批准',
  RETURNED: '已退回',
};

export const TARGET_STATUS_COLORS: Record<TargetVersionStatus, string> = {
  DRAFT: 'default',
  SUBMITTED: 'processing',
  APPROVED: 'success',
  RETURNED: 'warning',
};

export const ACTUAL_STATUS_LABELS: Record<ActualEntryStatus, string> = {
  DRAFT: '草稿',
  SUBMITTED: '待确认',
  CONFIRMED: '已保存',
  RETURNED: '已退回',
};

export const ACTUAL_STATUS_COLORS: Record<ActualEntryStatus, string> = {
  DRAFT: 'default',
  SUBMITTED: 'processing',
  CONFIRMED: 'success',
  RETURNED: 'warning',
};

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  TARGET_VERSION_CREATE: '新建目标草稿',
  TARGET_VERSION_ADJUST_CREATE: '基于原版本新建调整草稿',
  TARGET_VERSION_SUBMIT: '提交目标版本',
  TARGET_VERSION_APPROVE: '批准目标版本',
  TARGET_VERSION_RETURN: '退回目标版本',
  TARGET_VERSION_DELETE: '删除目标草稿',
  ACTUAL_CREATE_DRAFT: '保存实际成本草稿',
  ACTUAL_CREATE_SUBMIT: '登记并提交实际成本',
  ACTUAL_SUBMIT: '提交实际成本',
  ACTUAL_CONFIRM: '确认实际成本',
  ACTUAL_RETURN: '退回实际成本',
  ACTUAL_DELETE_DRAFT: '删除实际成本草稿',
  REVERSAL_REQUEST: '发起冲销申请',
  REVERSAL_APPROVE: '复核通过冲销',
  REVERSAL_REJECT: '驳回冲销申请',
  BOQ_ITEM_CREATE: '新增清单项',
  BOQ_ITEM_UPDATE: '编辑清单项',
  BOQ_ITEM_MERGE: '合并清单项',
  BOQ_ITEM_VOID: '作废清单项',
  BOQ_IMPORT_PREVIEW: '上传导入文件',
  BOQ_IMPORT_MAPPING: '保存字段映射',
  BOQ_IMPORT_CONFIRM: '确认导入',
  UNIT_PROJECT_CREATE: '新增单项工程',
  UNIT_PROJECT_UPDATE: '编辑单项工程',
  UNIT_PROJECT_DELETE: '删除单项工程',
  PROJECT_REVENUE_TAX_RATE_UPDATE: '更新收入建安税率',
};

export const BOQ_SOURCE_LABELS: Record<string, string> = {
  manual: '手动录入',
  import: '导入',
};

export const BOQ_STATUS_LABELS: Record<string, string> = {
  active: '有效',
  merged: '已合并',
  void: '已作废',
};

export const BOQ_IMPORT_STATUS_LABELS: Record<string, string> = {
  HEADERS_READ: '已读取表头',
  MAPPING_SAVED: '映射已保存',
  CONFIRM_PENDING_PARSE: '已确认（待解析开放）',
  XML_PREVIEW: 'XML 已解析',
  CONFIRMED: '已导入',
};

/** 清单导入可映射的系统字段。 */
export const BOQ_SYSTEM_FIELD_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'projectCategory', label: '清单分类（分部分项/措施/其他）' },
  { value: 'sectionCode', label: '分部分类编码' },
  { value: 'sectionName', label: '分部分类名称' },
  { value: 'itemName', label: '项目名称（必选）' },
  { value: 'itemFeature', label: '项目特征' },
  { value: 'unit', label: '单位' },
  { value: 'quantity', label: '工程量' },
  { value: 'unitPrice', label: '综合单价' },
  { value: 'taxRate', label: '税率（%）' },
  { value: 'unitPriceTaxIncl', label: '含税综合单价（旧模板兼容）' },
  { value: 'unitPriceTaxExcl', label: '不含税综合单价（旧模板兼容）' },
  { value: 'ignore', label: '忽略此列' },
];

/** 数量展示：最多 3 位小数，去掉无意义的尾零。 */
export function fmtQty(value?: string | null): string {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (Number.isNaN(num)) return String(value);
  return num.toLocaleString('zh-CN', { maximumFractionDigits: 3 });
}

/** 金额展示：仅格式化显示，不参与计算；计算一律以后端十进制为准。 */
export function fmtMoney(value?: string | null): string {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (Number.isNaN(num)) return String(value);
  return num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtDate(value?: string | null): string {
  if (!value) return '—';
  return value.slice(0, 10);
}

export function fmtDateTime(value?: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN');
}

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
