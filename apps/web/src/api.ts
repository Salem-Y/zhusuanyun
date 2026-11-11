export type RoleCode =
  | 'COMPANY_MANAGEMENT'
  | 'PROJECT_LEAD'
  | 'COST_ENGINEER'
  | 'FIELD_MANAGER'
  | 'SYS_ADMIN';

export interface CurrentUser {
  id: string;
  username: string;
  displayName: string;
  role: RoleCode;
  isDemo: boolean;
}

export interface SessionInfo {
  user: CurrentUser;
  appEnv: string;
  isDemo: boolean;
  demoBannerText: string;
}

export interface Project {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  costCaliberNote?: string | null;
  revenueTaxRate?: string;
  memberCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface HomeSummary {
  total: number;
  active: number;
  archived: number;
  scope: 'ALL' | 'GRANTED';
  dataCutoff: string;
}

export interface ProjectMemberInfo {
  userId: string;
  username: string;
  displayName: string;
  systemRole: RoleCode;
  userActive: boolean;
  roleCode: RoleCode;
  canViewProfit: boolean;
  canViewPrice: boolean;
  grantedAt: string;
}

export interface UserAccount {
  id: string;
  username: string;
  displayName: string;
  role: RoleCode;
  isActive: boolean;
  isDemo: boolean;
  projectCount: number;
  createdAt: string;
}

// ===== 第六轮：单项工程 / 清单分类 / 双模块汇总 =====
export type BoqProjectCategory = 'divisional' | 'measure' | 'other';

export interface UnitProject {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  boqItemCount?: number;
  targetLineCount?: number;
  actualEntryCount?: number;
}

export interface UnitProjectListData {
  units: UnitProject[];
  revenueTaxRate: string;
  myRole: RoleCode;
}

// ===== 第五轮：清单项（BOQ）＋ 目标成本＋实际成本 =====
export type ExpenseCategory =
  | 'labor'
  | 'material'
  | 'machine'
  | 'subcontract'
  | 'turnover'
  | 'measure'
  | 'site_overhead'
  | 'other';
export type PricingMethod = 'QTY_PRICE' | 'LUMP_SUM';
export type TargetVersionStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'RETURNED';
export type ActualEntryStatus = 'DRAFT' | 'SUBMITTED' | 'CONFIRMED' | 'RETURNED';
export type CostSourceType = 'INVOICE' | 'SETTLEMENT' | 'PAYROLL' | 'CONTRACT' | 'OTHER';

export interface BoqMergedItem {
  id: string;
  itemName: string;
  quantity?: string | null;
  amountTaxIncl: string;
  amountTaxExcl: string;
  unitProject?: { id: string; name: string } | null;
}

export interface BoqItem {
  id: string;
  projectId: string;
  projectCategory: BoqProjectCategory;
  unitProjectId?: string | null;
  unitProject?: { id: string; name: string } | null;
  taxRate?: string | null;
  sectionCode?: string | null;
  sectionName?: string | null;
  itemName: string;
  itemFeature?: string | null;
  unit?: string | null;
  quantity?: string | null;
  unitPriceTaxIncl?: string | null;
  unitPriceTaxExcl?: string | null;
  amountTaxIncl: string;
  amountTaxExcl: string;
  source: 'manual' | 'import';
  status: 'active' | 'merged' | 'void';
  mergedIntoId?: string | null;
  mergedCount?: number;
  mergedItems?: BoqMergedItem[];
  hasCost?: boolean;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BoqItemInput {
  projectCategory: BoqProjectCategory;
  unitProjectId: string;
  sectionCode?: string | null;
  sectionName?: string | null;
  itemName: string;
  itemFeature?: string | null;
  unit?: string | null;
  quantity?: string | null;
  taxRate?: string | null;
  priceTaxIncl?: boolean;
  unitPrice?: string | null;
}

export interface BoqCategoryTotal {
  projectCategory: BoqProjectCategory;
  amountTaxIncl: string;
  amountTaxExcl: string;
  count: number;
}

export interface BoqListData {
  items: BoqItem[];
  totals: { amountTaxIncl: string; amountTaxExcl: string; activeCount: number };
  byCategory: BoqCategoryTotal[];
  myRole: RoleCode;
}

export interface ImportTemplate {
  id: string;
  projectId: string;
  name: string;
  mapping: Record<string, string>;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImportLogItem {
  id: string;
  fileName: string;
  status: string;
  templateId?: string | null;
  note?: string | null;
  createdByName?: string | null;
  createdAt: string;
}

export interface TargetVersion {
  id: string;
  versionName: string;
  description?: string | null;
  caliberText?: string | null;
  effectiveDate?: string | null;
  status: TargetVersionStatus;
  isAdjustment: boolean;
  baseVersionId?: string | null;
  adjustReason?: string | null;
  isCurrent: boolean;
  totalAmount: string;
  createdById: string;
  createdByName?: string | null;
  submittedById?: string | null;
  submittedByName?: string | null;
  submittedAt?: string | null;
  decidedById?: string | null;
  decidedByName?: string | null;
  decidedAt?: string | null;
  decisionComment?: string | null;
  createdAt: string;
  lineCount?: number;
  baseVersionName?: string | null;
  baseVersionTotal?: string | null;
}

export interface TargetLine {
  id: string;
  boqItemId?: string | null;
  unitProjectId?: string | null;
  unitProjectName?: string | null;
  unitProject?: { id: string; name: string } | null;
  category: ExpenseCategory;
  summary: string;
  pricingMethod: PricingMethod;
  quantity?: string | null;
  unit?: string | null;
  unitPrice?: string | null;
  amount: string;
  amountTaxIncl?: string | null;
  amountTaxExcl?: string | null;
  priceTaxIncl?: boolean;
  taxRate?: string | null;
  unitPriceTaxIncl?: string | null;
  unitPriceTaxExcl?: string | null;
  basisNote?: string | null;
  sortOrder: number;
  boqItemName?: string | null;
}

export interface TargetLineInput {
  boqItemId?: string | null;
  unitProjectId?: string | null;
  category: ExpenseCategory;
  summary: string;
  pricingMethod: PricingMethod;
  quantity?: string | null;
  unit?: string | null;
  unitPrice?: string | null;
  amount?: string | null;
  taxRate?: string | null;
  priceTaxIncl?: boolean;
  basisNote?: string | null;
  sortOrder?: number;
}

export interface AuditRecordItem {
  id: string;
  action: string;
  actorName?: string | null;
  reason?: string | null;
  result: string;
  createdAt: string;
}

export interface ActualEntry {
  id: string;
  boqItemId?: string | null;
  unitProjectId?: string | null;
  unitProjectName?: string | null;
  category: ExpenseCategory;
  businessDate: string;
  period: string;
  periodReason?: string | null;
  description: string;
  vendorName?: string | null;
  pricingMethod: PricingMethod;
  quantity?: string | null;
  unit?: string | null;
  unitPrice?: string | null;
  amount: string;
  amountTaxIncl?: string | null;
  amountTaxExcl?: string | null;
  priceTaxIncl?: boolean;
  taxRate?: string | null;
  unitPriceTaxIncl?: string | null;
  unitPriceTaxExcl?: string | null;
  basisNote?: string | null;
  kind: 'NORMAL' | 'REVERSAL';
  status: ActualEntryStatus;
  createdById: string;
  createdByName?: string | null;
  submittedById?: string | null;
  submittedByName?: string | null;
  submittedAt?: string | null;
  reviewedById?: string | null;
  reviewedByName?: string | null;
  reviewedAt?: string | null;
  reviewComment?: string | null;
  reversalOfId?: string | null;
  reversedById?: string | null;
  replaceOfId?: string | null;
  createdAt: string;
  boqItemName?: string | null;
  pendingReversal?: boolean;
  pendingReversalId?: string | null;
  reversalOf?: { id: string; description: string } | null;
}

export interface ActualEntryInput {
  boqItemId?: string | null;
  unitProjectId?: string | null;
  category: ExpenseCategory;
  businessDate: string;
  period: string;
  periodReason?: string | null;
  description: string;
  vendorName?: string | null;
  pricingMethod: PricingMethod;
  quantity?: string | null;
  unit?: string | null;
  unitPrice?: string | null;
  amount?: string | null;
  taxRate?: string | null;
  priceTaxIncl?: boolean;
  basisNote?: string | null;
  replaceOfId?: string | null;
}

export interface ReversalRequestItem {
  id: string;
  entryId: string;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  requestedById: string;
  requestedByName?: string | null;
  requestedAt: string;
  reviewedByName?: string | null;
  reviewedAt?: string | null;
  reviewComment?: string | null;
  reversalEntryId?: string | null;
  entry?: { id: string; description: string; amount: string; businessDate: string; status: string } | null;
}

// ===== 第六轮：清单成本对比 / 过程成本统计 =====
export type CostCategoryMap = Record<ExpenseCategory, string>;

/** 第七轮：全局含税/不含税口径 */
export type CostCaliber = 'incl' | 'excl';

export interface CostComparisonRow {
  key: string;
  boqIds: string[];
  itemName: string;
  itemFeature?: string | null;
  unit?: string | null;
  unitProjectId?: string | null;
  unitProjectName?: string | null;
  quantity?: string | null;
  actualQuantity?: string | null;
  income: string;
  incomeTaxIncl: string;
  incomeTaxExcl: string;
  target: string;
  actual: string;
  diff: string;
  hasCost: boolean;
  targetByCategory: CostCategoryMap;
  labor: string;
  material: string;
  machine: string;
  subcontract: string;
  turnover: string;
  measure: string;
  site_overhead: string;
  other: string;
}

export interface CostComparisonData {
  rows: CostComparisonRow[];
  totals: {
    income: string;
    incomeTaxIncl: string;
    incomeTaxExcl: string;
    actualQuantity: string;
    target: string;
    actual: string;
    /** 未关联清单项的实际成本（按当前口径），用于环形图"未分配"扇区 */
    unlinkedActual: string;
    diff: string;
    byCategory: CostCategoryMap;
  };
  caliber: CostCaliber;
  categories: Array<{ key: ExpenseCategory; label: string }>;
  unitProjects: UnitProject[];
  targetVersion: {
    id: string;
    versionName: string;
    totalAmount: string;
    approvedAt?: string | null;
    approvedByName?: string | null;
  } | null;
  caliberNote?: string | null;
  cutoff: string | null;
  unitProjectId: string | null;
  unlinkedTargetCount: number;
  unlinkedActualCount: number;
}

export interface UnlinkedCostData {
  targetLines: Array<{
    id: string;
    category: ExpenseCategory;
    summary: string;
    unitProjectName?: string | null;
    amount: string;
    amountTaxIncl?: string | null;
  }>;
  entries: Array<{
    id: string;
    category: ExpenseCategory;
    description: string;
    vendorName?: string | null;
    businessDate: string;
    unitProjectName?: string | null;
    amount: string;
    amountTaxIncl?: string | null;
    status: string;
    kind: string;
  }>;
}

export type ProcessCostMode = 'period' | 'cumulative' | 'forecast';

export interface ProcessCostRow {
  key: string;
  label: string;
  target: string;
  budgetRevenue: string;
  actual: string;
  diff: string;
  entryCount: number;
}

export interface ProcessCostData {
  mode: ProcessCostMode;
  caliber: CostCaliber;
  trend: Array<{ month: string; actual: string }>;
  period: string | null;
  cutoff: string | null;
  rows: ProcessCostRow[];
  totals: {
    target: string;
    budgetRevenue: string;
    budgetRevenueTaxIncl: string;
    actual: string;
    unallocatedRevenue: string;
  };
  targetVersion: { id: string; versionName: string; totalAmount: string } | null;
  caliberNote?: string | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

function csrfToken(): string {
  const match = document.cookie.match(/(?:^|; )zs_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const response = await fetch(`/api${path}`, {
    credentials: 'include',
    ...options,
    headers: {
      // FormData 由浏览器自动带 boundary，不能手动设 Content-Type
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      'x-csrf-token': csrfToken(),
      ...(options.headers ?? {}),
    },
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(response.status, error.code ?? 'E_UNKNOWN', error.message ?? '请求失败');
  }
  return payload as T;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ data: SessionInfo }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }).then((r) => r.data),

  logout: () => request<{ data: { ok: boolean } }>('/auth/logout', { method: 'POST' }),

  me: () =>
    request<{ data: SessionInfo }>('/auth/me').then((r) => r.data),

  health: () =>
    request<{ data: Record<string, unknown> }>('/health').then((r) => r.data),

  listProjects: (params: { keyword?: string; status?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.keyword) query.set('keyword', params.keyword);
    if (params.status) query.set('status', params.status);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return request<{ data: Project[]; meta: { scope: string; total: number } }>(`/projects${suffix}`).then(
      (r) => r,
    );
  },

  summary: () => request<{ data: HomeSummary }>('/projects/summary').then((r) => r.data),

  getProject: (id: string) =>
    request<{ data: Project & { members: Array<{ userId: string; displayName: string; roleCode: RoleCode }> } }>(
      `/projects/${id}`,
    ).then((r) => r.data),

  createProject: (input: { code: string; name: string; description?: string }) =>
    request<{ data: Project }>('/projects', { method: 'POST', body: JSON.stringify(input) }).then(
      (r) => r.data,
    ),

  updateProject: (
    id: string,
    input: Partial<{ code: string; name: string; description: string; status: string; expectedCode: string }>,
  ) =>
    request<{ data: Project }>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(input) }).then(
      (r) => r.data,
    ),

  deleteProject: (id: string, code: string) =>
    request<{ data: { ok: boolean } }>(`/projects/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ code }),
    }).then((r) => r.data),

  listUsers: () => request<{ data: UserAccount[] }>('/users').then((r) => r.data),

  listMembers: (projectId: string) =>
    request<{ data: ProjectMemberInfo[] }>(`/projects/${projectId}/members`).then((r) => r.data),

  addMember: (projectId: string, input: { userId: string; roleCode: RoleCode }) =>
    request<{ data: { userId: string; roleCode: RoleCode } }>(`/projects/${projectId}/members`, {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.data),

  updateMember: (projectId: string, userId: string, input: { roleCode: RoleCode }) =>
    request<{ data: { userId: string; roleCode: RoleCode } }>(
      `/projects/${projectId}/members/${userId}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    ).then((r) => r.data),

  removeMember: (projectId: string, userId: string) =>
    request<{ data: { ok: boolean } }>(`/projects/${projectId}/members/${userId}`, {
      method: 'DELETE',
    }).then((r) => r.data),

  // ===== 核算口径说明 =====
  saveCaliber: (projectId: string, note: string) =>
    request<{ data: { caliberNote: string } }>(`/projects/${projectId}/cost-caliber`, {
      method: 'PUT',
      body: JSON.stringify({ note }),
    }).then((r) => r.data),

  // ===== 第六轮：单项工程与收入建安税率 =====
  listUnitProjects: (projectId: string) =>
    request<{ data: UnitProject[]; meta: { myRole: RoleCode; revenueTaxRate: string } }>(
      `/projects/${projectId}/unit-projects`,
    ).then((r) => ({ units: r.data, revenueTaxRate: r.meta.revenueTaxRate, myRole: r.meta.myRole })),

  createUnitProject: (projectId: string, input: { name: string; sortOrder?: number }) =>
    request<{ data: UnitProject }>(`/projects/${projectId}/unit-projects`, {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.data),

  updateUnitProject: (
    projectId: string,
    unitId: string,
    input: Partial<{ name: string; sortOrder: number; isActive: boolean }>,
  ) =>
    request<{ data: UnitProject }>(`/projects/${projectId}/unit-projects/${unitId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }).then((r) => r.data),

  deleteUnitProject: (projectId: string, unitId: string) =>
    request<{ data: { id: string; deleted: boolean } }>(`/projects/${projectId}/unit-projects/${unitId}`, {
      method: 'DELETE',
    }).then((r) => r.data),

  saveRevenueTaxRate: (projectId: string, revenueTaxRate: string) =>
    request<{ data: { revenueTaxRate: string } }>(`/projects/${projectId}/revenue-tax-rate`, {
      method: 'PUT',
      body: JSON.stringify({ revenueTaxRate }),
    }).then((r) => r.data),

  // ===== 第五轮：合同清单（BOQ） =====
  listBoqItems: (
    projectId: string,
    params: {
      status?: 'active' | 'merged' | 'void';
      projectCategory?: BoqProjectCategory;
      unitProjectId?: string;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.projectCategory) query.set('projectCategory', params.projectCategory);
    if (params.unitProjectId) query.set('unitProjectId', params.unitProjectId);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return request<{ data: BoqListData }>(`/projects/${projectId}/boq-items${suffix}`).then((r) => r.data);
  },

  createBoqItem: (projectId: string, input: BoqItemInput & { idempotencyKey: string }) =>
    request<{ data: BoqItem }>(`/projects/${projectId}/boq-items`, {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.data),

  updateBoqItem: (projectId: string, itemId: string, input: BoqItemInput) =>
    request<{ data: BoqItem }>(`/projects/${projectId}/boq-items/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }).then((r) => r.data),

  mergeBoqItems: (projectId: string, input: { itemIds: string[]; primaryId: string }) =>
    request<{ data: BoqItem; meta?: { idempotent?: boolean } }>(`/projects/${projectId}/boq-items/merge`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  voidBoqItem: (projectId: string, itemId: string) =>
    request<{ data: BoqItem }>(`/projects/${projectId}/boq-items/${itemId}/void`, {
      method: 'POST',
      body: JSON.stringify({}),
    }).then((r) => r.data),

  // ===== 第五轮：清单导入框架 =====
  uploadBoqPreview: (projectId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{
      data: { logId: string; fileName: string; headers: string[]; templates: ImportTemplate[] };
    }>(`/projects/${projectId}/boq-imports/preview`, { method: 'POST', body: form }).then((r) => r.data);
  },

  saveBoqMapping: (projectId: string, logId: string, input: { mapping: Record<string, string>; templateName?: string }) =>
    request<{ data: { logId: string; status: string; templateId: string | null } }>(
      `/projects/${projectId}/boq-imports/${logId}/mapping`,
      { method: 'POST', body: JSON.stringify(input) },
    ).then((r) => r.data),

  confirmBoqImport: (projectId: string, logId: string) =>
    request<{ data: { logId: string; status: string }; meta?: { message?: string; idempotent?: boolean } }>(
      `/projects/${projectId}/boq-imports/${logId}/confirm`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  listBoqTemplates: (projectId: string) =>
    request<{ data: ImportTemplate[] }>(`/projects/${projectId}/boq-imports/templates`).then((r) => r.data),

  listBoqImports: (projectId: string) =>
    request<{ data: ImportLogItem[] }>(`/projects/${projectId}/boq-imports`).then((r) => r.data),

  // ===== 目标成本 =====
  listTargetVersions: (projectId: string) =>
    request<{ data: TargetVersion[] }>(`/projects/${projectId}/target-versions`).then((r) => r.data),

  getTargetVersion: (projectId: string, vid: string) =>
    request<{
      data: TargetVersion & {
        lines: TargetLine[];
        records: AuditRecordItem[];
        baseVersion?: { id: string; versionName: string; totalAmount: string } | null;
      };
    }>(`/projects/${projectId}/target-versions/${vid}`).then((r) => r.data),

  createTargetVersion: (
    projectId: string,
    input: {
      versionName: string;
      description?: string;
      caliberText?: string;
      effectiveDate?: string;
      baseVersionId?: string;
      adjustReason?: string;
      idempotencyKey: string;
    },
  ) =>
    request<{ data: TargetVersion }>(`/projects/${projectId}/target-versions`, {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.data),

  saveTargetLines: (projectId: string, vid: string, lines: TargetLineInput[]) =>
    request<{ data: TargetVersion & { lines: TargetLine[] } }>(
      `/projects/${projectId}/target-versions/${vid}/lines`,
      { method: 'PUT', body: JSON.stringify({ lines }) },
    ).then((r) => r.data),

  updateTargetVersion: (
    projectId: string,
    vid: string,
    input: Partial<{ versionName: string; description: string; caliberText: string; effectiveDate: string | null }>,
  ) =>
    request<{ data: TargetVersion }>(`/projects/${projectId}/target-versions/${vid}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }).then((r) => r.data),

  deleteTargetVersion: (projectId: string, vid: string) =>
    request<{ data: { ok: boolean } }>(`/projects/${projectId}/target-versions/${vid}`, { method: 'DELETE' }).then(
      (r) => r.data,
    ),

  submitTargetVersion: (projectId: string, vid: string) =>
    request<{ data: TargetVersion }>(`/projects/${projectId}/target-versions/${vid}/submit`, {
      method: 'POST',
      body: JSON.stringify({}),
    }).then((r) => r.data),

  approveTargetVersion: (projectId: string, vid: string, comment?: string) =>
    request<{ data: TargetVersion }>(`/projects/${projectId}/target-versions/${vid}/approve`, {
      method: 'POST',
      body: JSON.stringify({ comment }),
    }).then((r) => r.data),

  returnTargetVersion: (projectId: string, vid: string, comment: string) =>
    request<{ data: TargetVersion }>(`/projects/${projectId}/target-versions/${vid}/return`, {
      method: 'POST',
      body: JSON.stringify({ comment }),
    }).then((r) => r.data),

  // ===== 第四轮：实际成本 =====
  listActualEntries: (projectId: string, params: { view?: string; status?: string; until?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.view) query.set('view', params.view);
    if (params.status) query.set('status', params.status);
    if (params.until) query.set('until', params.until);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return request<{ data: ActualEntry[] }>(`/projects/${projectId}/actual-entries${suffix}`).then((r) => r.data);
  },

  getActualEntry: (projectId: string, eid: string) =>
    request<{
      data: ActualEntry & {
        reversedBy?: { id: string; description: string; businessDate: string; amount: string } | null;
        replaceOf?: { id: string; description: string; status: string } | null;
        reversalRequests: ReversalRequestItem[];
        records: AuditRecordItem[];
      };
    }>(`/projects/${projectId}/actual-entries/${eid}`).then((r) => r.data),

  createActualEntry: (projectId: string, input: ActualEntryInput & { idempotencyKey: string; submit?: boolean }) =>
    request<{ data: ActualEntry }>(`/projects/${projectId}/actual-entries`, {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.data),

  updateActualEntry: (projectId: string, eid: string, input: ActualEntryInput) =>
    request<{ data: ActualEntry }>(`/projects/${projectId}/actual-entries/${eid}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }).then((r) => r.data),

  deleteActualEntry: (projectId: string, eid: string) =>
    request<{ data: { ok: boolean } }>(`/projects/${projectId}/actual-entries/${eid}`, { method: 'DELETE' }).then(
      (r) => r.data,
    ),

  submitActualEntry: (projectId: string, eid: string) =>
    request<{ data: ActualEntry }>(`/projects/${projectId}/actual-entries/${eid}/submit`, {
      method: 'POST',
      body: JSON.stringify({}),
    }).then((r) => r.data),

  confirmActualEntry: (projectId: string, eid: string, comment?: string) =>
    request<{ data: ActualEntry }>(`/projects/${projectId}/actual-entries/${eid}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ comment }),
    }).then((r) => r.data),

  returnActualEntry: (projectId: string, eid: string, comment: string) =>
    request<{ data: ActualEntry }>(`/projects/${projectId}/actual-entries/${eid}/return`, {
      method: 'POST',
      body: JSON.stringify({ comment }),
    }).then((r) => r.data),

  createReversalRequest: (projectId: string, eid: string, input: { reason: string; idempotencyKey: string }) =>
    request<{ data: ReversalRequestItem }>(`/projects/${projectId}/actual-entries/${eid}/reversal-requests`, {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.data),

  listReversalRequests: (projectId: string, status?: string) =>
    request<{ data: ReversalRequestItem[] }>(
      `/projects/${projectId}/reversal-requests${status ? `?status=${status}` : ''}`,
    ).then((r) => r.data),

  approveReversal: (projectId: string, rid: string, comment?: string) =>
    request<{ data: ReversalRequestItem }>(`/projects/${projectId}/reversal-requests/${rid}/approve`, {
      method: 'POST',
      body: JSON.stringify({ comment }),
    }).then((r) => r.data),

  rejectReversal: (projectId: string, rid: string, comment: string) =>
    request<{ data: ReversalRequestItem }>(`/projects/${projectId}/reversal-requests/${rid}/reject`, {
      method: 'POST',
      body: JSON.stringify({ comment }),
    }).then((r) => r.data),

  // ===== 第六轮：清单成本对比 =====
  getCostComparison: (
    projectId: string,
    params: { unitProjectId?: string; until?: string; caliber?: CostCaliber } = {},
  ) => {
    const query = new URLSearchParams();
    if (params.unitProjectId) query.set('unitProjectId', params.unitProjectId);
    if (params.until) query.set('until', params.until);
    if (params.caliber) query.set('caliber', params.caliber);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return request<{ data: CostComparisonData }>(`/projects/${projectId}/cost-comparison${suffix}`).then(
      (r) => r.data,
    );
  },

  getUnlinkedCosts: (projectId: string, params: { unitProjectId?: string; until?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.unitProjectId) query.set('unitProjectId', params.unitProjectId);
    if (params.until) query.set('until', params.until);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return request<{ data: UnlinkedCostData }>(`/projects/${projectId}/cost-comparison/unlinked${suffix}`).then(
      (r) => r.data,
    );
  },

  getComparisonDrilldown: (
    projectId: string,
    params: { boqItemId: string; side: 'target' | 'actual'; until?: string },
  ) => {
    const query = new URLSearchParams({ boqItemId: params.boqItemId, side: params.side });
    if (params.until) query.set('until', params.until);
    return request<{
      data: {
        version?: { id: string; versionName: string } | null;
        lines?: TargetLine[];
        entries?: ActualEntry[];
      };
    }>(`/projects/${projectId}/cost-comparison/drilldown?${query.toString()}`).then((r) => r.data);
  },

  // ===== 第六轮：过程成本统计 =====
  getProcessCosts: (
    projectId: string,
    params: { mode: ProcessCostMode; until?: string; period?: string; caliber?: CostCaliber } = {
      mode: 'cumulative',
    },
  ) => {
    const query = new URLSearchParams({ mode: params.mode });
    if (params.until) query.set('until', params.until);
    if (params.period) query.set('period', params.period);
    if (params.caliber) query.set('caliber', params.caliber);
    return request<{ data: ProcessCostData }>(`/projects/${projectId}/process-costs?${query.toString()}`).then(
      (r) => r.data,
    );
  },

  getProcessDrilldown: (
    projectId: string,
    params: { category: string; mode: ProcessCostMode; until?: string; period?: string },
  ) => {
    const query = new URLSearchParams({ category: params.category, mode: params.mode });
    if (params.until) query.set('until', params.until);
    if (params.period) query.set('period', params.period);
    return request<{
      data: {
        mode: ProcessCostMode;
        category: string;
        targetLines: Array<{
          id: string;
          summary: string;
          boqItemName?: string | null;
          amount: string;
          amountTaxIncl?: string | null;
          category: ExpenseCategory;
        }>;
        entries: ActualEntry[];
      };
    }>(`/projects/${projectId}/process-costs/drilldown?${query.toString()}`).then((r) => r.data);
  },
};
