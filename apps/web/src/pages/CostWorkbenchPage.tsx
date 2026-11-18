import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Col,
  Collapse,
  DatePicker,
  Drawer,
  Empty,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Popover,
  Radio,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  EditOutlined,
  FileAddOutlined,
  PlusOutlined,
  RollbackOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import {
  api,
  type ActualEntry,
  type CostCaliber,
  type CostComparisonData,
  type CostComparisonRow,
  type CostStatus,
  type ReversalRequestItem,
  type TargetVersion,
  type UnlinkedCostData,
} from '../api';
import { useSession } from '../App';
import { useProject } from '../project/ProjectContext';
import {
  ACTUAL_STATUS_COLORS,
  ACTUAL_STATUS_LABELS,
  EXPENSE_CATEGORY_KEYS,
  EXPENSE_CATEGORY_LABELS,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  fmtQty,
  newIdempotencyKey,
  TARGET_STATUS_COLORS,
  TARGET_STATUS_LABELS,
} from './cost/labels';
import { CreateVersionModal, VersionDrawer } from './cost/TargetVersionEditor';
import { ActualEntryFormModal, EntryDetailDrawer } from './cost/ActualEntryForm';
import EChart from '../components/EChart';

const CALIBER_KEY = 'zs.costCaliber';

function readCaliber(): CostCaliber {
  try {
    return window.localStorage.getItem(CALIBER_KEY) === 'incl' ? 'incl' : 'excl';
  } catch {
    return 'excl';
  }
}

export default function CostWorkbenchPage() {
  const { project, members } = useProject();
  const session = useSession();
  const { message } = AntApp.useApp();

  const [comparison, setComparison] = useState<CostComparisonData | null>(null);
  const [versions, setVersions] = useState<TargetVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [cutoff, setCutoff] = useState<Dayjs>(dayjs());
  const [unitProjectId, setUnitProjectId] = useState<string | undefined>(undefined);
  // 第七轮：默认不含税显示
  const [caliber, setCaliber] = useState<CostCaliber>(readCaliber);

  const [createOpen, setCreateOpen] = useState(false);
  const [createBase, setCreateBase] = useState<TargetVersion | null>(null);
  const [versionDrawerId, setVersionDrawerId] = useState<string | null>(null);

  const [entryFormOpen, setEntryFormOpen] = useState(false);
  const [entryEditId, setEntryEditId] = useState<string | null>(null);
  const [presetBoqItemId, setPresetBoqItemId] = useState<string | null>(null);
  const [entryDetailId, setEntryDetailId] = useState<string | null>(null);

  const [unlinkedOpen, setUnlinkedOpen] = useState(false);
  const [unlinkedData, setUnlinkedData] = useState<UnlinkedCostData | null>(null);
  const [unlinkedLoading, setUnlinkedLoading] = useState(false);

  const [myDraftsOpen, setMyDraftsOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [myDraftEntries, setMyDraftEntries] = useState<ActualEntry[]>([]);
  const [pendingReversals, setPendingReversals] = useState<ReversalRequestItem[]>([]);

  const [rrModal, setRrModal] = useState<{ rr: ReversalRequestItem; action: 'approve' | 'reject' } | null>(null);
  const [rrComment, setRrComment] = useState('');
  const [acting, setActing] = useState(false);

  const myRole = members.find((m) => m.userId === session.user.id)?.roleCode;
  const isCostEngineer = myRole === 'COST_ENGINEER';
  const isLead = myRole === 'PROJECT_LEAD';
  const projectActive = project.status === 'ACTIVE';

  const cutoffStr = cutoff.format('YYYY-MM-DD');
  const caliberLabel = caliber === 'incl' ? '含税' : '不含税';

  useEffect(() => {
    try {
      window.localStorage.setItem(CALIBER_KEY, caliber);
    } catch {
      // 忽略隐私模式写入失败
    }
  }, [caliber]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [cmp, v, mine, reversals] = await Promise.all([
        api.getCostComparison(project.id, { unitProjectId, until: cutoffStr, caliber }),
        api.listTargetVersions(project.id),
        api.listActualEntries(project.id, { view: 'mine-draft' }),
        api.listReversalRequests(project.id, 'PENDING'),
      ]);
      setComparison(cmp);
      setVersions(v);
      setMyDraftEntries(mine);
      setPendingReversals(reversals);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [project.id, cutoffStr, unitProjectId, caliber, message]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const openUnlinked = async () => {
    setUnlinkedOpen(true);
    setUnlinkedLoading(true);
    try {
      setUnlinkedData(await api.getUnlinkedCosts(project.id, { unitProjectId, until: cutoffStr }));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setUnlinkedLoading(false);
    }
  };

  const pendingVersion = versions.find((v) => ['DRAFT', 'SUBMITTED', 'RETURNED'].includes(v.status));
  const myPendingVersion = pendingVersion && pendingVersion.createdById === session.user.id ? pendingVersion : null;
  const currentApproved = versions.find((v) => v.isCurrent && v.status === 'APPROVED') ?? null;
  const submittedTargetVersions = versions.filter((v) => v.status === 'SUBMITTED');
  const myConfirmCount =
    (isLead ? submittedTargetVersions.filter((v) => v.submittedById !== session.user.id).length : 0) +
    pendingReversals.filter((r) => r.requestedById !== session.user.id).length;

  const openEntryForm = (boqItemId?: string | null) => {
    setEntryEditId(null);
    setPresetBoqItemId(boqItemId ?? null);
    setEntryFormOpen(true);
  };

  const handleRr = async () => {
    if (!rrModal) return;
    if (rrModal.action === 'reject' && !rrComment.trim()) {
      message.error('驳回必须填写意见');
      return;
    }
    setActing(true);
    try {
      if (rrModal.action === 'approve') {
        await api.approveReversal(project.id, rrModal.rr.id, rrComment.trim() || undefined);
        message.success('冲销已复核通过，负向冲销记录已生成并计入净额');
      } else {
        await api.rejectReversal(project.id, rrModal.rr.id, rrComment.trim());
        message.success('冲销申请已驳回');
      }
      setRrModal(null);
      setRrComment('');
      await loadAll();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setActing(false);
    }
  };

  const rows = comparison?.rows ?? [];
  const totals = comparison?.totals;

  // ===== 第八轮：测算大宽表行内编辑 =====
  /** 未落库的编辑快照（按清单项 id） */
  type EstimateDraft = {
    actualQuantity?: string | null;
    laborPrice?: string | null;
    materialPrice?: string | null;
    subcontractPrice?: string | null;
    laborTaxRate?: string | null;
    materialTaxRate?: string | null;
    subcontractTaxRate?: string | null;
    costStatus?: CostStatus;
  };
  const [drafts, setDrafts] = useState<Record<string, EstimateDraft>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [taxDraft, setTaxDraft] = useState({ labor: '3', material: '13', subcontract: '9' });
  const [taxSaving, setTaxSaving] = useState(false);

  useEffect(() => {
    const t = comparison?.defaultTaxRates;
    if (t) setTaxDraft({ labor: t.labor, material: t.material, subcontract: t.subcontract });
  }, [comparison?.defaultTaxRates]);

  /** 取当前展示值：优先未保存草稿，其次服务端值 */
  const pick = (row: CostComparisonRow, key: keyof EstimateDraft) => {
    const boqId = row.boqId;
    if (!boqId) return null;
    const draft = drafts[boqId];
    if (draft && draft[key] !== undefined) return draft[key] as string | null;
    return (row as unknown as Record<string, string | null | undefined>)[key] ?? null;
  };

  /** 空字符串视为清空 → null */
  const toApi = (v: string | null | undefined) => (v === undefined || v === '' ? null : v);

  const patchDraft = (boqId: string, patch: EstimateDraft) => {
    setDrafts((prev) => ({ ...prev, [boqId]: { ...(prev[boqId] ?? {}), ...patch } }));
  };

  /** 失焦保存：提交该行当前全部测算字段，成功后清空草稿并刷新 */
  const persistRow = async (row: CostComparisonRow, patch: EstimateDraft) => {
    const boqId = row.boqId;
    if (!boqId) return;
    const merged = { ...(drafts[boqId] ?? {}), ...patch };
    setDrafts((prev) => ({ ...prev, [boqId]: merged }));
    const get = (k: keyof EstimateDraft) =>
      toApi(merged[k] !== undefined ? merged[k] : (row as unknown as Record<string, string | null>)[k]);
    setSavingKey(boqId);
    try {
      await api.saveCostEstimate(project.id, {
        boqItemId: boqId,
        actualQuantity: get('actualQuantity'),
        laborPrice: get('laborPrice'),
        materialPrice: get('materialPrice'),
        subcontractPrice: get('subcontractPrice'),
        laborTaxRate: get('laborTaxRate'),
        materialTaxRate: get('materialTaxRate'),
        subcontractTaxRate: get('subcontractTaxRate'),
        costStatus: (merged.costStatus ?? row.costStatus ?? 'PREDICTED') as CostStatus,
      });
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[boqId];
        return next;
      });
      await loadAll();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSavingKey(null);
    }
  };

  /** 行内联动：第 10 列实际单价与第 9 列预测/实际成本（全空回退目标成本） */
  const rowCalc = (row: CostComparisonRow) => {
    const num = (v: string | null | undefined) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const qty = num(pick(row, 'actualQuantity')) ?? num(row.quantity) ?? 0;
    const labor = num(pick(row, 'laborPrice'));
    const material = num(pick(row, 'materialPrice'));
    const sub = num(pick(row, 'subcontractPrice'));
    let unitCost: number | null = null;
    if (sub !== null) unitCost = sub;
    else if (labor !== null || material !== null) unitCost = (labor ?? 0) + (material ?? 0);
    const target = num(row.target) ?? 0;
    const cost = unitCost === null ? target : qty * unitCost;
    return { qty, labor, material, sub, unitCost, cost, fallback: unitCost === null };
  };

  const saveDefaultTaxRates = async () => {
    setTaxSaving(true);
    try {
      await api.updateDefaultTaxRates(project.id, {
        laborTaxRate: taxDraft.labor,
        materialTaxRate: taxDraft.material,
        subcontractTaxRate: taxDraft.subcontract,
      });
      message.success('默认税率已保存');
      await loadAll();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setTaxSaving(false);
    }
  };

  // ===== 第八轮：子表 2-6 台账（大型机械 / 周转料具 / 措施费 / 现场经费 / 其他费用） =====
  type LedgerCategory = 'machine' | 'turnover' | 'measure' | 'site_overhead' | 'other';
  const LEDGER_CATEGORIES: Array<{ key: LedgerCategory; label: string }> = [
    { key: 'machine', label: '大型机械' },
    { key: 'turnover', label: '周转料具' },
    { key: 'measure', label: '措施费' },
    { key: 'site_overhead', label: '现场经费' },
    { key: 'other', label: '其他费用' },
  ];
  const [ledgerCategory, setLedgerCategory] = useState<LedgerCategory>('machine');
  const [ledgerEntries, setLedgerEntries] = useState<ActualEntry[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerIncome, setLedgerIncome] = useState<Record<string, { target: string; actual: string }>>({});

  const loadLedger = useCallback(async () => {
    setLedgerLoading(true);
    try {
      const [entries, processCosts] = await Promise.all([
        api.listActualEntries(project.id, { category: ledgerCategory }),
        api.getProcessCosts(project.id, { mode: 'cumulative', caliber }),
      ]);
      setLedgerEntries(entries);
      const map: Record<string, { target: string; actual: string }> = {};
      for (const r of processCosts.rows) map[r.key] = { target: r.target, actual: r.actualCumulative };
      setLedgerIncome(map);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLedgerLoading(false);
    }
  }, [project.id, ledgerCategory, caliber, message]);

  useEffect(() => {
    void loadLedger();
  }, [loadLedger]);

  const voidLedgerEntry = async (entry: ActualEntry) => {
    try {
      await api.deleteActualEntry(project.id, entry.id);
      message.success('成本明细已作废');
      await loadLedger();
      await loadAll();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  /** 第九轮：台账成本状态快捷切换（直接覆盖保存） */
  const updateLedgerStatus = async (entry: ActualEntry, costStatus: CostStatus) => {
    try {
      await api.updateActualEntry(project.id, entry.id, {
        boqItemId: entry.boqItemId ?? null,
        unitProjectId: entry.unitProjectId ?? null,
        category: entry.category,
        businessDate: (entry.businessDate ?? '').slice(0, 10),
        period: entry.period,
        description: entry.description,
        vendorName: entry.vendorName ?? null,
        pricingMethod: entry.pricingMethod,
        quantity: entry.quantity ?? null,
        unit: entry.unit ?? null,
        unitPrice: entry.unitPrice ?? null,
        amount: entry.amount,
        taxRate: entry.taxRate ?? null,
        priceTaxIncl: entry.priceTaxIncl ?? false,
        basisNote: entry.basisNote ?? null,
        costStatus,
      });
      message.success('成本状态已更新');
      await loadLedger();
      await loadAll();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const ledgerColumns: ColumnsType<ActualEntry> = [
    {
      title: '单项工程',
      key: 'unitProject',
      width: 120,
      render: (_, e) => e.unitProjectName ?? '—',
    },
    { title: '成本说明', dataIndex: 'description', width: 240 },
    { title: '供应商', dataIndex: 'vendorName', width: 150, render: (v) => v ?? '—' },
    {
      title: '数量',
      dataIndex: 'quantity',
      width: 90,
      align: 'right',
      render: (v, e) => (e.pricingMethod === 'LUMP_SUM' ? '—' : fmtQty(v)),
    },
    {
      title: '单价',
      dataIndex: 'unitPriceTaxExcl',
      width: 110,
      align: 'right',
      render: (v, e) => (e.pricingMethod === 'LUMP_SUM' ? '—' : fmtMoney(v ?? e.unitPrice)),
    },
    {
      title: '金额（含税）',
      dataIndex: 'amountTaxIncl',
      width: 130,
      align: 'right',
      render: (v) => fmtMoney(v),
    },
    {
      title: '金额（不含税）',
      dataIndex: 'amountTaxExcl',
      width: 130,
      align: 'right',
      render: (v) => fmtMoney(v),
    },
    {
      title: '成本状态',
      key: 'costStatus',
      width: 110,
      render: (_, e) => (
        <Select
          size="small"
          style={{ width: '100%' }}
          disabled={!canEdit}
          value={e.costStatus ?? 'PREDICTED'}
          onChange={(v) => void updateLedgerStatus(e, v as CostStatus)}
          options={[
            { value: 'PREDICTED', label: '预测' },
            { value: 'FIXED', label: '已定标' },
          ]}
        />
      ),
    },
    {
      title: '操作',
      key: 'op',
      width: 140,
      fixed: 'right',
      render: (_, e) => (
        <Space size={0}>
          <Button
            size="small"
            type="link"
            disabled={!canEdit}
            onClick={() => {
              setEntryEditId(e.id);
              setPresetBoqItemId(null);
              setEntryFormOpen(true);
            }}
          >
            修改
          </Button>
          <Popconfirm
            title="确认删除该条成本明细？"
            description="删除后大盘数据将同步扣减"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            disabled={!canEdit}
            onConfirm={() => void voidLedgerEntry(e)}
          >
            <Button size="small" type="link" danger disabled={!canEdit}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const pieOption = useMemo(() => {
    const data = EXPENSE_CATEGORY_KEYS.map((key) => ({
      name: EXPENSE_CATEGORY_LABELS[key],
      value: Number(totals?.byCategory?.[key] ?? 0),
    })).filter((d) => d.value > 0);
    // 第十三轮：饼图严格按 8 大类统计，不再额外展示“未分配成本”
    return {
      tooltip: { trigger: 'item', formatter: (p: { name: string; value: number; percent: number }) =>
        `${p.name}<br/>¥${fmtMoney(String(p.value))}（${p.percent}%）` },
      legend: { bottom: 0, type: 'scroll' as const, icon: 'circle' },
      series: [
        {
          name: `实际成本构成（${caliberLabel}）`,
          type: 'pie' as const,
          radius: ['42%', '68%'],
          center: ['50%', '44%'],
          avoidLabelOverlap: true,
          itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
          label: { formatter: '{b}\n{d}%', fontSize: 11 },
          data: data.length > 0 ? data : [{ name: '暂无实际成本', value: 1 }],
        },
      ],
    };
  }, [totals, caliberLabel]);

  const barOption = useMemo(() => {
    const income = Number(totals?.income ?? 0);
    const target = Number(totals?.target ?? 0);
    const actual = Number(totals?.actual ?? 0);
    const diff = Number(totals?.diff ?? 0);
    return {
      tooltip: {
        trigger: 'axis' as const,
        axisPointer: { type: 'shadow' as const },
        valueFormatter: (v: number) => `¥${fmtMoney(String(v))}`,
      },
      grid: { left: 8, right: 16, top: 32, bottom: 8, containLabel: true },
      xAxis: { type: 'category' as const, data: ['收入合计', '目标成本', '实际成本', '盈亏差额'] },
      yAxis: {
        type: 'value' as const,
        axisLabel: { formatter: (v: number) => (Math.abs(v) >= 10000 ? `${(v / 10000).toFixed(0)}万` : String(v)) },
      },
      series: [
        {
          type: 'bar' as const,
          barWidth: 40,
          label: {
            show: true,
            position: 'top' as const,
            fontSize: 11,
            formatter: (p: { value: number }) => fmtMoney(String(p.value)),
          },
          data: [
            { value: income, itemStyle: { color: '#1677ff', borderRadius: [4, 4, 0, 0] } },
            { value: target, itemStyle: { color: '#faad14', borderRadius: [4, 4, 0, 0] } },
            { value: actual, itemStyle: { color: '#722ed1', borderRadius: [4, 4, 0, 0] } },
            {
              value: diff,
              itemStyle: { color: diff >= 0 ? '#52c41a' : '#ff4d4f', borderRadius: [4, 4, 0, 0] },
            },
          ],
        },
      ],
    };
  }, [totals]);

  // ===== 第八轮：14 列测算大宽表 =====
  const canEdit = projectActive && (isCostEngineer || isLead);
  const orDash = (v: string | null | undefined) =>
    v === null || v === undefined || v === '' ? '—' : fmtMoney(v);

  /** 互斥录入单元格：单价 + 双击税率气泡 */
  const priceCell = (row: CostComparisonRow, kind: 'labor' | 'material' | 'subcontract') => {
    const boqId = row.boqId;
    if (!boqId) return <Typography.Text type="secondary">—</Typography.Text>;
    const priceKey =
      kind === 'labor' ? 'laborPrice' : kind === 'material' ? 'materialPrice' : 'subcontractPrice';
    const rateKey =
      kind === 'labor' ? 'laborTaxRate' : kind === 'material' ? 'materialTaxRate' : 'subcontractTaxRate';
    const value = pick(row, priceKey);
    const defaultRate =
      kind === 'labor' ? taxDraft.labor : kind === 'material' ? taxDraft.material : taxDraft.subcontract;
    const rate = pick(row, rateKey) ?? defaultRate;
    const calc = rowCalc(row);
    // 互斥：分包有值 → 人工/材料锁定；人工或材料有值 → 分包锁定
    const locked =
      kind === 'subcontract'
        ? calc.labor !== null || calc.material !== null
        : calc.sub !== null;
    return (
      <Space size={2} direction="vertical" style={{ width: '100%' }}>
        <InputNumber
          size="small"
          style={{ width: '100%' }}
          min={0}
          precision={2}
          disabled={!canEdit || locked}
          value={value === null || value === undefined ? undefined : Number(value)}
          placeholder={locked ? '已锁定' : '不含税'}
          onChange={(v) => patchDraft(boqId, { [priceKey]: v === null ? null : String(v) })}
          onBlur={() => void persistRow(row, {})}
        />
        <Popover
          trigger="click"
          title={`${kind === 'labor' ? '人工' : kind === 'material' ? '材料' : '专业分包'}税率（%）`}
          content={
            <Space size={6}>
              <InputNumber
                size="small"
                min={0}
                max={100}
                precision={2}
                value={Number(rate ?? 0)}
                onChange={(v) => patchDraft(boqId, { [rateKey]: v === null ? null : String(v) })}
              />
              <Button size="small" type="primary" onClick={() => void persistRow(row, {})}>
                保存
              </Button>
            </Space>
          }
        >
          <Typography.Text type="secondary" style={{ fontSize: 11, cursor: 'pointer' }}>
            税率 {rate ?? '—'}%
          </Typography.Text>
        </Popover>
      </Space>
    );
  };

  const columns: ColumnsType<CostComparisonRow> = [
    {
      title: '',
      key: 'expand',
      width: 46,
      fixed: 'left',
      render: (_, row) => {
        if (!row.isMerged || !row.children?.length) return null;
        const open = expandedKeys.includes(row.key);
        return (
          <Button
            size="small"
            type="text"
            style={{ padding: 0, fontFamily: 'monospace' }}
            onClick={() =>
              setExpandedKeys((prev) =>
                prev.includes(row.key) ? prev.filter((k) => k !== row.key) : [...prev, row.key],
              )
            }
          >
            {open ? '[－]' : '[＋]'}
          </Button>
        );
      },
    },
    {
      title: '单项工程',
      key: 'unitProject',
      width: 110,
      fixed: 'left',
      render: (_, row) => row.unitProjectName ?? (row.isMerged ? '跨工程合并' : '—'),
    },
    {
      title: '清单名称及特征',
      key: 'item',
      width: 240,
      fixed: 'left',
      render: (_, row) => (
        <div>
          <Space size={4}>
            <span>{row.itemName}</span>
            {row.hasDiffPrice && (
              <Tooltip title="已包含差异化单价：子行单价不一致，父行按实际工程量加权平均">
                <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                  差异化
                </Tag>
              </Tooltip>
            )}
          </Space>
          {row.itemFeature && (
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              {row.itemFeature}
            </Typography.Text>
          )}
        </div>
      ),
    },
    { title: '单位', dataIndex: 'unit', width: 60, render: (v) => v ?? '—' },
    { title: '清单工程量', dataIndex: 'quantity', width: 100, align: 'right', render: (v) => fmtQty(v) },
    {
      title: '实际工程量',
      key: 'actualQuantity',
      width: 110,
      align: 'right',
      render: (_, row) => {
        const boqId = row.boqId;
        if (!boqId || row.isMerged) return <span>{fmtQty(row.actualQuantity)}</span>;
        const value = pick(row, 'actualQuantity');
        return (
          <InputNumber
            size="small"
            style={{ width: '100%' }}
            min={0}
            precision={3}
            disabled={!canEdit}
            value={value === null || value === undefined ? undefined : Number(value)}
            placeholder={row.quantity ?? '0'}
            onChange={(v) => patchDraft(boqId, { actualQuantity: v === null ? null : String(v) })}
            onBlur={() => void persistRow(row, {})}
          />
        );
      },
    },
    {
      title: `收入合价（${caliberLabel}）`,
      dataIndex: 'income',
      width: 120,
      align: 'right',
      render: (v: string) => fmtMoney(v),
    },
    {
      title: '目标成本',
      dataIndex: 'target',
      width: 120,
      align: 'right',
      render: (v: string) => fmtMoney(v),
    },
    {
      title: '预测/实际成本',
      key: 'cost',
      width: 130,
      align: 'right',
      render: (_, row) => {
        if (row.isMerged) {
          return <Typography.Text strong>{orDash(row.cost)}</Typography.Text>;
        }
        const calc = rowCalc(row);
        return (
          <Tooltip title={calc.fallback ? '未录入单价，回退目标成本' : '实际工程量 × 实际单价'}>
            <Typography.Text strong type={calc.fallback ? 'secondary' : undefined}>
              {calc.cost.toFixed(2)}
            </Typography.Text>
          </Tooltip>
        );
      },
    },
    {
      title: '实际单价',
      key: 'unitCost',
      width: 110,
      align: 'right',
      render: (_, row) => {
        if (row.isMerged) return <span>{orDash(row.unitCost)}</span>;
        const calc = rowCalc(row);
        return <span>{calc.unitCost === null ? '—' : calc.unitCost.toFixed(2)}</span>;
      },
    },
    {
      title: '人工(含机辅)',
      key: 'laborPrice',
      width: 110,
      render: (_, row) => priceCell(row, 'labor'),
    },
    {
      title: '材料',
      key: 'materialPrice',
      width: 110,
      render: (_, row) => priceCell(row, 'material'),
    },
    {
      title: '专业分包',
      key: 'subcontractPrice',
      width: 110,
      render: (_, row) => priceCell(row, 'subcontract'),
    },
    {
      title: '成本状态',
      key: 'costStatus',
      width: 110,
      fixed: 'right',
      render: (_, row) => {
        const boqId = row.boqId;
        if (!boqId || row.isMerged) {
          return <Typography.Text type="secondary">—</Typography.Text>;
        }
        const status = (pick(row, 'costStatus') ?? 'PREDICTED') as CostStatus;
        return (
          <Select
            size="small"
            style={{ width: '100%' }}
            disabled={!canEdit}
            value={status}
            onChange={(v) => void persistRow(row, { costStatus: v as CostStatus })}
            options={[
              { value: 'PREDICTED', label: '预测' },
              { value: 'FIXED', label: '已定标' },
            ]}
          />
        );
      },
    },
  ];

  const versionsTab = (
    <Table
      size="small"
      rowKey="id"
      loading={loading}
      pagination={false}
      dataSource={versions}
      locale={{ emptyText: <Empty description="尚无目标版本；造价员可点击上方「编制目标」开始" /> }}
      columns={[
        {
          title: '版本',
          dataIndex: 'versionName',
          render: (name: string, v) => (
            <Space size={6}>
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setVersionDrawerId(v.id)}>
                {name}
              </Button>
              <Tag color={TARGET_STATUS_COLORS[v.status]}>{TARGET_STATUS_LABELS[v.status]}</Tag>
              {v.isCurrent && <Tag color="green">当前适用</Tag>}
              {v.isAdjustment && <Tag color="purple">调整</Tag>}
            </Space>
          ),
        },
        { title: '金额（元）', dataIndex: 'totalAmount', align: 'right' as const, render: (v: string) => fmtMoney(v) },
        { title: '适用日期', dataIndex: 'effectiveDate', width: 110, render: (v) => fmtDate(v) },
        { title: '编制', width: 130, render: (_: unknown, v: TargetVersion) => `${v.createdByName ?? '—'}` },
        {
          title: '审批',
          width: 180,
          render: (_: unknown, v: TargetVersion) =>
            v.decidedByName
              ? `${v.decidedByName} · ${fmtDateTime(v.decidedAt)}${v.decisionComment ? ` · ${v.decisionComment}` : ''}`
              : '—',
        },
      ]}
    />
  );

  // ===== 第八轮：子表 2-6 上下两区结构 =====
  const ledgerTab = (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Tabs
        size="small"
        activeKey={ledgerCategory}
        onChange={(k) => setLedgerCategory(k as LedgerCategory)}
        items={LEDGER_CATEGORIES.map((c) => ({ key: c.key, label: c.label }))}
      />
      <Collapse
        size="small"
        defaultActiveKey={['income']}
        items={[
          {
            key: 'income',
            label: `上半区 · 目标与实际成本（${
              LEDGER_CATEGORIES.find((c) => c.key === ledgerCategory)?.label ?? ''
            }，只读）`,
            children: (
              <Space size={40} wrap>
                <Statistic
                  title="目标成本（元）"
                  value={fmtMoney(ledgerIncome[ledgerCategory]?.target ?? '0')}
                />
                <Statistic
                  title="累计实际成本（元）"
                  value={fmtMoney(ledgerIncome[ledgerCategory]?.actual ?? '0')}
                />
                <Typography.Text type="secondary" style={{ maxWidth: 360 }}>
                  目标成本取当前批准版本；累计实际按成本周期汇总自台账流水。
                </Typography.Text>
              </Space>
            ),
          },
        ]}
      />
      <Space wrap>
        {projectActive && (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEntryEditId(null);
              setPresetBoqItemId(null);
              setEntryFormOpen(true);
            }}
          >
            新增成本明细
          </Button>
        )}
        <Button onClick={() => void loadLedger()} loading={ledgerLoading}>
          刷新
        </Button>
        <Typography.Text type="secondary">
          下半区 · 台账录入：全部通过「新增成本明细」弹窗录入，可直接修改或删除
        </Typography.Text>
      </Space>
      <Table<ActualEntry>
        size="small"
        rowKey="id"
        loading={ledgerLoading}
        pagination={false}
        dataSource={ledgerEntries}
        columns={ledgerColumns}
        scroll={{ x: 1200 }}
        locale={{ emptyText: '该类别暂无成本明细' }}
      />
    </Space>
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {!projectActive && (
        <Alert
          type="warning"
          showIcon
          message="项目已归档"
          description="已归档项目仅允许授权历史查看，禁止新增、修改及审批成本业务。"
        />
      )}

      <Card size="small">
        <Space wrap size={12} align="center">
          <Typography.Text strong>金额口径：</Typography.Text>
          <Radio.Group
            value={caliber}
            onChange={(e) => setCaliber(e.target.value as CostCaliber)}
            optionType="button"
            buttonStyle="solid"
            options={[
              { label: '含税显示', value: 'incl' },
              { label: '不含税显示', value: 'excl' },
            ]}
          />
          <Typography.Text>单项工程：</Typography.Text>
          <Select
            style={{ width: 200 }}
            allowClear
            placeholder="全部（同名清单跨工程合并）"
            value={unitProjectId}
            onChange={(v) => setUnitProjectId(v ?? undefined)}
            options={(comparison?.unitProjects ?? []).map((u) => ({
              value: u.id,
              label: u.isActive ? u.name : `${u.name}（已停用）`,
            }))}
          />
          <Typography.Text>实际成本截止日期：</Typography.Text>
          <DatePicker value={cutoff} onChange={(d) => d && setCutoff(d)} allowClear={false} />
          <Button onClick={() => void loadAll()} loading={loading}>
            刷新
          </Button>
          <Space size={4} wrap>
            <Typography.Text type="secondary">默认不含税税率：</Typography.Text>
            {(
              [
                { key: 'labor' as const, label: '人工' },
                { key: 'material' as const, label: '材料' },
                { key: 'subcontract' as const, label: '分包' },
              ]
            ).map((item) => (
              <Space key={item.key} size={2}>
                <Typography.Text type="secondary">{item.label}</Typography.Text>
                <InputNumber
                  size="small"
                  style={{ width: 72 }}
                  min={0}
                  max={100}
                  precision={2}
                  disabled={!canEdit}
                  value={Number(taxDraft[item.key])}
                  onChange={(v) =>
                    setTaxDraft((prev) => ({ ...prev, [item.key]: v === null ? '0' : String(v) }))
                  }
                />
                <Typography.Text type="secondary">%</Typography.Text>
              </Space>
            ))}
            <Button size="small" loading={taxSaving} disabled={!canEdit} onClick={() => void saveDefaultTaxRates()}>
              保存税率
            </Button>
          </Space>
        </Space>
      </Card>

      <Row gutter={16}>
        <Col xs={24} lg={12}>
          <Card size="small" title={`实际成本构成（${caliberLabel}）`}>
            <EChart option={pieOption} height={280} empty={Number(totals?.actual ?? 0) === 0} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title={`收入 / 目标 / 实际 / 盈亏（${caliberLabel}）`}>
            <EChart option={barOption} height={280} empty={rows.length === 0} />
          </Card>
        </Col>
      </Row>

      <Card size="small">
        <Space size={24} wrap>
          <Statistic title={`收入合价（${caliberLabel}，元）`} value={fmtMoney(totals?.income ?? '0')} loading={loading} />
          <Statistic
            title={`目标成本（${comparison?.targetVersion?.versionName ?? '尚无批准目标'}，元）`}
            value={comparison?.targetVersion ? fmtMoney(totals?.target ?? '0') : '尚无批准目标'}
            loading={loading}
          />
          <Statistic title="实际成本（元）" value={fmtMoney(totals?.actual ?? '0')} loading={loading} />
          <Statistic
            title="盈亏差额（元）"
            value={fmtMoney(totals?.diff ?? '0')}
            loading={loading}
            valueStyle={{ color: Number(totals?.diff ?? 0) < 0 ? '#cf1322' : '#389e0d' }}
          />
        </Space>
      </Card>

      <Card size="small" title="操作">
        <Space wrap>
          {isCostEngineer && projectActive && !pendingVersion && (
            <Button
              type="primary"
              icon={<EditOutlined />}
              onClick={() => {
                setCreateBase(null);
                setCreateOpen(true);
              }}
            >
              编制目标
            </Button>
          )}
          {isCostEngineer &&
            projectActive &&
            myPendingVersion &&
            ['DRAFT', 'RETURNED'].includes(myPendingVersion.status) && (
              <Button type="primary" icon={<EditOutlined />} onClick={() => setVersionDrawerId(myPendingVersion.id)}>
                继续编辑「{myPendingVersion.versionName}」
              </Button>
            )}
          {isCostEngineer && projectActive && currentApproved && !pendingVersion && (
            <Button
              icon={<RollbackOutlined />}
              onClick={() => {
                setCreateBase(currentApproved);
                setCreateOpen(true);
              }}
            >
              调整目标
            </Button>
          )}
          <Badge count={isCostEngineer ? myDraftEntries.length : 0} size="small">
            <Button onClick={() => setMyDraftsOpen(true)}>我的待提交</Button>
          </Badge>
          <Badge count={myConfirmCount} size="small">
            <Button onClick={() => setConfirmOpen(true)} disabled={!isLead && pendingReversals.length === 0}>
              待我确认
            </Button>
          </Badge>
        </Space>
      </Card>

      <Card size="small">
        <Tabs
          items={[
            {
              key: 'comparison',
              label: '分部分项测算',
              children: (
                <Table<CostComparisonRow>
                  size="small"
                  rowKey="key"
                  loading={loading}
                  pagination={false}
                  dataSource={rows}
                  scroll={{ x: 1760 }}
                  expandable={{
                    expandedRowKeys: expandedKeys,
                    onExpandedRowsChange: (keys) => setExpandedKeys(keys as string[]),
                    expandIcon: () => null,
                  }}
                  locale={{
                    emptyText: (
                      <Empty description="尚无有效清单项或成本明细；请先在「收入与收付款 → 合同清单」维护清单项" />
                    ),
                  }}
                  columns={columns}
                  summary={() =>
                    rows.length > 0 ? (
                      <Table.Summary fixed>
                        <Table.Summary.Row>
                          <Table.Summary.Cell index={0} colSpan={3}>
                            <Typography.Text strong>合计</Typography.Text>
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={3} align="right">
                            —
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={4} align="right">
                            —
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={5} align="right">
                            <Typography.Text strong>{fmtQty(totals?.actualQuantity ?? '0')}</Typography.Text>
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={6} align="right">
                            <Typography.Text strong>{fmtMoney(totals?.income ?? '0')}</Typography.Text>
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={7} align="right">
                            <Typography.Text strong>{fmtMoney(totals?.target ?? '0')}</Typography.Text>
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={8} align="right">
                            <Typography.Text strong>{fmtMoney(totals?.cost ?? '0')}</Typography.Text>
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={9} align="right">
                            —
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={10} align="right">
                            —
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={11} align="right">
                            —
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={12} align="right">
                            —
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={13} align="right">
                            含税 {fmtMoney(totals?.costTaxIncl ?? '0')}
                          </Table.Summary.Cell>
                        </Table.Summary.Row>
                      </Table.Summary>
                    ) : null
                  }
                />
              ),
            },
            { key: 'versions', label: '版本与调整记录', children: versionsTab },
            {
              key: 'ledger',
              label: '其他费用台账',
              children: ledgerTab,
            },
          ]}
        />
      </Card>

      <CreateVersionModal
        open={createOpen}
        baseVersion={createBase}
        caliberNote={comparison?.caliberNote ?? ''}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          setVersionDrawerId(id);
          void loadAll();
        }}
      />
      <VersionDrawer versionId={versionDrawerId} onClose={() => setVersionDrawerId(null)} onChanged={loadAll} />

      <ActualEntryFormModal
        open={entryFormOpen}
        entryId={entryEditId}
        presetBoqItemId={presetBoqItemId}
        hidePeriod
        onClose={() => setEntryFormOpen(false)}
        onSaved={loadAll}
      />
      <EntryDetailDrawer
        entryId={entryDetailId}
        onClose={() => setEntryDetailId(null)}
        onChanged={loadAll}
      />

      <Drawer title="我的待提交" width={620} open={myDraftsOpen} onClose={() => setMyDraftsOpen(false)}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {isCostEngineer ? (
            <>
              <Typography.Text strong>目标草稿</Typography.Text>
              <List
                size="small"
                dataSource={versions.filter(
                  (v) => ['DRAFT', 'RETURNED'].includes(v.status) && v.createdById === session.user.id,
                )}
                locale={{ emptyText: '无待提交目标草稿' }}
                renderItem={(v) => (
                  <List.Item
                    actions={[
                      <Button
                        size="small"
                        key="open"
                        onClick={() => {
                          setMyDraftsOpen(false);
                          setVersionDrawerId(v.id);
                        }}
                      >
                        打开
                      </Button>,
                    ]}
                  >
                    <List.Item.Meta
                      title={
                        <Space size={6}>
                          {v.versionName}
                          <Tag color={TARGET_STATUS_COLORS[v.status]}>{TARGET_STATUS_LABELS[v.status]}</Tag>
                        </Space>
                      }
                      description={`合计 ${fmtMoney(v.totalAmount)} 元${
                        v.status === 'RETURNED' && v.decisionComment ? ` · 退回意见：${v.decisionComment}` : ''
                      }`}
                    />
                  </List.Item>
                )}
              />
              <Typography.Text strong>成本草稿（未计入实际成本）</Typography.Text>
              <List
                size="small"
                dataSource={myDraftEntries}
                locale={{ emptyText: '无成本草稿' }}
                renderItem={(e) => (
                  <List.Item
                    actions={[
                      <Button
                        size="small"
                        key="open"
                        onClick={() => {
                          setMyDraftsOpen(false);
                          setEntryDetailId(e.id);
                        }}
                      >
                        查看
                      </Button>,
                    ]}
                  >
                    <List.Item.Meta
                      title={
                        <Space size={6}>
                          {e.description}
                          <Tag color={ACTUAL_STATUS_COLORS[e.status]}>{ACTUAL_STATUS_LABELS[e.status]}</Tag>
                        </Space>
                      }
                      description={`${fmtMoney(e.amount)} 元 · ${fmtDate(e.businessDate)} · ${
                        e.boqItemName ?? EXPENSE_CATEGORY_LABELS[e.category] ?? ''
                      }`}
                    />
                  </List.Item>
                )}
              />
            </>
          ) : (
            <Empty description="造价员账号登录后可编制目标草稿与成本草稿" />
          )}
        </Space>
      </Drawer>

      <Drawer title="待我确认" width={720} open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Typography.Text strong>待批准目标版本</Typography.Text>
          <List
            size="small"
            dataSource={submittedTargetVersions}
            locale={{ emptyText: '无待批准目标版本' }}
            renderItem={(v) => (
              <List.Item
                actions={[
                  <Button
                    size="small"
                    key="open"
                    onClick={() => {
                      setConfirmOpen(false);
                      setVersionDrawerId(v.id);
                    }}
                  >
                    查看并审批
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={v.versionName}
                  description={`提交人 ${v.submittedByName} · ${fmtMoney(v.totalAmount)} 元${
                    v.submittedById === session.user.id ? ' · 本人提交，需其他负责人审批' : ''
                  }`}
                />
              </List.Item>
            )}
          />
        </Space>
      </Drawer>

      <Modal
        title={rrModal?.action === 'approve' ? '复核通过冲销（将生成等额负向冲销记录）' : '驳回冲销申请'}
        open={!!rrModal}
        onOk={handleRr}
        onCancel={() => setRrModal(null)}
        okText="确定"
        cancelText="取消"
        confirmLoading={acting}
      >
        <Input.TextArea
          rows={3}
          placeholder={rrModal?.action === 'approve' ? '复核意见（可选）' : '驳回意见（必填）'}
          value={rrComment}
          onChange={(e) => setRrComment(e.target.value)}
          maxLength={300}
        />
      </Modal>
    </Space>
  );
}
