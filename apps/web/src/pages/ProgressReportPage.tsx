import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Collapse,
  DatePicker,
  Empty,
  Input,
  InputNumber,
  Modal,
  Radio,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import EChart from '../components/EChart';
import {
  api,
  type BoqProjectCategory,
  type ProgressBoqLineRow,
  type ProgressPeriodDetail,
  type ProgressPeriodSummary,
} from '../api';
import { useProject } from '../project/ProjectContext';
import { useSession } from '../App';
import {
  BOQ_PROJECT_CATEGORY_KEYS,
  BOQ_PROJECT_CATEGORY_LABELS,
  fmtMoney,
  fmtQty,
} from './cost/labels';

const { Text } = Typography;

type PriceMode = 'incl' | 'excl';

interface ExtraDraft {
  key: string;
  name: string;
  prevCumAmount: string;
  confirmedCumAmount: number | null;
  remark: string;
}

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const num = (value: string | null | undefined) => {
  const n = Number(value);
  return Number.isNaN(n) ? 0 : n;
};
const round2 = (value: number) => Math.round(value * 100) / 100;
const q3 = (value: number) => Number(value.toFixed(3));
const money = (value: number) => fmtMoney(value.toFixed(2));
const qtyText = (value: number) => fmtQty(String(q3(value)));
/** 图表坐标轴金额缩写（≥1 万显示为 x.x万）。 */
const compactMoney = (value: number) =>
  Math.abs(value) >= 10000 ? `${(value / 10000).toFixed(1)}万` : `${Math.round(value)}`;

/** 单条清单项的本期反算（前端即时预览，保存后以后端十进制为准）。 */
function computeLine(item: ProgressBoqLineRow, confirmed: number, priceMode: PriceMode) {
  const prev = num(item.prevCumQty);
  const qty = confirmed - prev;
  const price = num(priceMode === 'incl' ? item.unitPriceTaxIncl : item.unitPriceTaxExcl);
  const contractQty =
    item.quantity === null || item.quantity === undefined || item.quantity === ''
      ? null
      : num(item.quantity);
  return {
    prev,
    qty,
    price,
    periodAmount: round2(qty * price),
    cumAmount: round2(confirmed * price),
    negative: qty < 0,
    overContract: contractQty !== null && confirmed > contractQty,
  };
}

export default function ProgressReportPage() {
  const { message, modal } = App.useApp();
  const { project, members } = useProject();
  const session = useSession();
  const myRole = members.find((m) => m.userId === session.user.id)?.roleCode ?? null;
  const canWrite = (myRole === 'PROJECT_LEAD' || myRole === 'COST_ENGINEER') && project.status === 'ACTIVE';

  const [periods, setPeriods] = useState<ProgressPeriodSummary[]>([]);
  const [periodsLoading, setPeriodsLoading] = useState(true);
  const [activePeriodId, setActivePeriodId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProgressPeriodDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  const [category, setCategory] = useState<BoqProjectCategory>('divisional');
  const [priceMode, setPriceMode] = useState<PriceMode>('incl');
  /** 图2 统计范围：all=全项目总体，其余为指定单项工程 */
  const [contributionScope, setContributionScope] = useState<string>('all');

  // 清单项「业主确认累计量」草稿：boqItemId -> 输入值
  const [draft, setDraft] = useState<Record<string, number | null>>({});
  // 本期签证及其他确认草稿
  const [extras, setExtras] = useState<ExtraDraft[]>([]);

  // 新建期次
  const [newOpen, setNewOpen] = useState(false);
  const [newMonth, setNewMonth] = useState<Dayjs | null>(null);
  const [creating, setCreating] = useState(false);

  const loadPeriods = useCallback(
    async (selectId?: string) => {
      setPeriodsLoading(true);
      try {
        const { periods: list } = await api.listProgressPeriods(project.id);
        setPeriods(list);
        setActivePeriodId((current) => {
          if (selectId) return selectId;
          if (current && list.some((p) => p.id === current)) return current;
          return list[0]?.id ?? null;
        });
      } catch (e) {
        message.error((e as Error).message);
      } finally {
        setPeriodsLoading(false);
      }
    },
    [project.id, message],
  );

  const loadDetail = useCallback(
    async (periodId: string) => {
      setDetailLoading(true);
      try {
        const data = await api.getProgressPeriod(project.id, periodId);
        setDetail(data);
        const nextDraft: Record<string, number | null> = {};
        for (const item of data.items) nextDraft[item.boqItemId] = num(item.confirmedCumQty);
        setDraft(nextDraft);
        setExtras(
          data.extras.lines.map((line) => ({
            key: line.id ?? uid(),
            name: line.name,
            prevCumAmount: line.prevCumAmount,
            confirmedCumAmount: num(line.confirmedCumAmount),
            remark: line.remark ?? '',
          })),
        );
      } catch (e) {
        message.error((e as Error).message);
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [project.id, message],
  );

  useEffect(() => {
    void loadPeriods();
  }, [loadPeriods]);

  useEffect(() => {
    if (activePeriodId) void loadDetail(activePeriodId);
    else setDetail(null);
  }, [activePeriodId, loadDetail]);

  /** 取某条清单项的业主确认累计量（未录入时默认等于上期累计量）。 */
  const confirmedOf = (item: ProgressBoqLineRow) => {
    const value = draft[item.boqItemId];
    return value === undefined || value === null ? num(item.prevCumQty) : value;
  };

  const priceLabel = priceMode === 'incl' ? '含税' : '不含税';

  // 顶部汇总（随输入实时联动，跨三大分类）
  const grand = useMemo(() => {
    const acc = { periodIncl: 0, periodExcl: 0, cumIncl: 0, cumExcl: 0 };
    if (!detail) return acc;
    for (const item of detail.items) {
      const confirmed = confirmedOf(item);
      const qty = confirmed - num(item.prevCumQty);
      acc.periodIncl += round2(qty * num(item.unitPriceTaxIncl));
      acc.periodExcl += round2(qty * num(item.unitPriceTaxExcl));
      acc.cumIncl += round2(confirmed * num(item.unitPriceTaxIncl));
      acc.cumExcl += round2(confirmed * num(item.unitPriceTaxExcl));
    }
    return acc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, draft]);

  const categoryTotals = useMemo(() => {
    const map = new Map<BoqProjectCategory, { count: number; periodIncl: number; periodExcl: number }>();
    for (const key of BOQ_PROJECT_CATEGORY_KEYS) {
      map.set(key, { count: 0, periodIncl: 0, periodExcl: 0 });
    }
    if (!detail) return map;
    for (const item of detail.items) {
      const bucket = map.get(item.projectCategory);
      if (!bucket) continue;
      const confirmed = confirmedOf(item);
      const qty = confirmed - num(item.prevCumQty);
      bucket.count += 1;
      bucket.periodIncl += round2(qty * num(item.unitPriceTaxIncl));
      bucket.periodExcl += round2(qty * num(item.unitPriceTaxExcl));
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, draft]);

  // 三级树：单项工程 → 分部工程 → 清单项（仅当前分类）
  const groups = useMemo(() => {
    if (!detail) return [];
    const map = new Map<
      string,
      {
        key: string;
        name: string;
        sort: number;
        items: ProgressBoqLineRow[];
        sections: Map<string, ProgressBoqLineRow[]>;
      }
    >();
    for (const item of detail.items) {
      if (item.projectCategory !== category) continue;
      const key = item.unitProjectId ?? '__none__';
      if (!map.has(key)) {
        map.set(key, {
          key,
          name: item.unitProject?.name ?? '未指定单项工程',
          sort: item.unitProject?.sortOrder ?? 999,
          items: [],
          sections: new Map(),
        });
      }
      const group = map.get(key)!;
      group.items.push(item);
      const sectionName = item.sectionName?.trim() || '未划分分部';
      if (!group.sections.has(sectionName)) group.sections.set(sectionName, []);
      group.sections.get(sectionName)!.push(item);
    }
    return [...map.values()]
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'zh-CN'))
      .map((group) => ({
        ...group,
        sections: [...group.sections.entries()].map(([name, items]) => ({ name, items })),
      }));
  }, [detail, category]);

  /** 自底向上汇总：分部/单项工程行直接对底层清单项产值求和。 */
  const aggregate = (rows: ProgressBoqLineRow[]) => {
    const acc = { periodQty: 0, periodAmount: 0, cumAmount: 0 };
    for (const item of rows) {
      const computed = computeLine(item, confirmedOf(item), priceMode);
      acc.periodQty += computed.qty;
      acc.periodAmount += computed.periodAmount;
      acc.cumAmount += computed.cumAmount;
    }
    return acc;
  };

  const extraPrevTotal = extras.reduce((acc, row) => acc + num(row.prevCumAmount), 0);
  const extraConfirmedTotal = extras.reduce((acc, row) => acc + (row.confirmedCumAmount ?? 0), 0);
  const extraPeriodTotal = round2(extraConfirmedTotal - extraPrevTotal);

  const updateExtra = (index: number, patch: Partial<ExtraDraft>) => {
    setExtras((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  const removeExtra = (index: number) => setExtras((prev) => prev.filter((_, i) => i !== index));
  const addExtra = () =>
    setExtras((prev) => [
      ...prev,
      { key: uid(), name: '', prevCumAmount: '0.00', confirmedCumAmount: 0, remark: '' },
    ]);

  const openNewPeriod = () => {
    const latest = periods[0]?.period;
    setNewMonth(latest ? dayjs(`${latest}-01`).add(1, 'month') : dayjs().startOf('month'));
    setNewOpen(true);
  };

  const doCreatePeriod = async () => {
    if (!newMonth) {
      message.warning('请选择报量月份');
      return;
    }
    setCreating(true);
    try {
      const created = await api.createProgressPeriod(project.id, {
        period: newMonth.format('YYYY-MM'),
      });
      message.success(
        `已创建期次「${created.data.label}」${
          created.meta.carriedFrom ? `，已带入上期（${created.meta.carriedFrom}）累计确认量` : ''
        }`,
      );
      setNewOpen(false);
      await loadPeriods(created.data.id);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const doSave = async () => {
    if (!detail) return;
    const invalidExtra = extras.find(
      (row) =>
        !row.name.trim() && ((row.confirmedCumAmount ?? 0) !== 0 || row.remark.trim().length > 0),
    );
    if (invalidExtra) {
      message.error('签证及其他确认存在未填写费用名称的行，请补充名称或删除该行');
      return;
    }

    const rows = detail.items.map((item) => ({
      item,
      computed: computeLine(item, confirmedOf(item), priceMode),
    }));
    const negativeRows = rows.filter((row) => row.computed.negative);
    const overRows = rows.filter((row) => row.computed.overContract);

    const lines = detail.items.map((item) => {
      const value = draft[item.boqItemId];
      const confirmed = value === null || value === undefined ? num(item.prevCumQty) : value;
      return { boqItemId: item.boqItemId, confirmedCumQty: confirmed.toFixed(3), remark: null };
    });
    const extraLines = extras
      .filter((row) => row.name.trim())
      .map((row) => ({
        name: row.name.trim(),
        confirmedCumAmount: (row.confirmedCumAmount ?? 0).toFixed(2),
        remark: row.remark.trim() || null,
      }));

    const run = async () => {
      setSaving(true);
      try {
        await api.saveProgressBoqLines(project.id, detail.period.id, lines);
        await api.saveProgressExtraLines(project.id, detail.period.id, extraLines);
        message.success('本期报量已保存');
        await loadDetail(detail.period.id);
        await loadPeriods();
      } catch (e) {
        message.error((e as Error).message);
      } finally {
        setSaving(false);
      }
    };

    if (negativeRows.length > 0) {
      modal.confirm({
        title: '存在负值倒扣记录',
        content: `共 ${negativeRows.length} 条清单项的「业主确认累计量」小于上期累计量，本期完成量为负。系统允许此类倒扣保存（如本期甲方扣回上期多报量），是否继续？`,
        okText: '仍要保存',
        okButtonProps: { danger: true },
        cancelText: '返回检查',
        onOk: () => run(),
      });
      return;
    }
    if (overRows.length > 0) {
      message.warning(`有 ${overRows.length} 条清单项累计量已超合同量，已按累计量计算产值`);
    }
    await run();
  };

  const doReset = () => {
    if (!detail) return;
    modal.confirm({
      title: '确认清空当前期次的所有填报数据吗？',
      content:
        '清空后所有清单项的业主确认累计量将恢复为上期累计确认量（首期为 0），底部签证明细一并清空，本期产值归零。',
      okText: '确认清空',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setResetting(true);
        try {
          const result = await api.resetProgressPeriod(project.id, detail.period.id);
          message.success(
            `已清空本期报量：重置 ${result.resetLines} 条清单项${
              result.clearedExtras > 0 ? `，清除 ${result.clearedExtras} 条签证及其他确认` : ''
            }`,
          );
          await loadDetail(detail.period.id);
          await loadPeriods();
        } catch (e) {
          message.error((e as Error).message);
          throw e;
        } finally {
          setResetting(false);
        }
      },
    });
  };

  // ===== 图表数据（与下方表格草稿实时联动） =====
  /** 合同总价：按当前含税/不含税口径汇总清单量 × 单价。 */
  const contractTotal = useMemo(() => {
    if (!detail) return 0;
    return detail.items.reduce(
      (acc, item) =>
        acc +
        round2(
          num(item.quantity) *
            num(priceMode === 'incl' ? item.unitPriceTaxIncl : item.unitPriceTaxExcl),
        ),
      0,
    );
  }, [detail, priceMode]);

  /** 单项工程选项（图2 切换统计范围）。 */
  const unitOptions = useMemo(() => {
    if (!detail) return [] as Array<{ value: string; label: string }>;
    const map = new Map<string, string>();
    for (const item of detail.items) {
      const key = item.unitProjectId ?? '__none__';
      if (!map.has(key)) map.set(key, item.unitProject?.name ?? '未指定单项工程');
    }
    return [...map.entries()].map(([value, label]) => ({ value, label }));
  }, [detail]);

  /** 选中单项工程已不存在时（切换期次/项目）回落到总体。 */
  const effectiveScope =
    contributionScope === 'all' || unitOptions.some((unit) => unit.value === contributionScope)
      ? contributionScope
      : 'all';

  /** 本期产值贡献：按分部工程归集，可切换「全项目总体 / 指定单项工程」。 */
  const contribution = useMemo(() => {
    if (!detail) return [] as Array<{ name: string; value: number }>;
    const scoped =
      effectiveScope === 'all'
        ? detail.items
        : detail.items.filter((item) => (item.unitProjectId ?? '__none__') === effectiveScope);
    const map = new Map<string, number>();
    for (const item of scoped) {
      const name = item.sectionName?.trim() || '未划分分部';
      const qty = confirmedOf(item) - num(item.prevCumQty);
      const amount = round2(
        qty * num(priceMode === 'incl' ? item.unitPriceTaxIncl : item.unitPriceTaxExcl),
      );
      map.set(name, (map.get(name) ?? 0) + amount);
    }
    return [...map.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, draft, priceMode, effectiveScope]);

  /** 图2 超过 16 个分部时启用横向缩放，保证横轴名称可读。 */
  const contributionZoom = contribution.length > 16;
  const contributionEnd = contributionZoom
    ? Math.max(0, (16 / contribution.length) * 100)
    : 100;

  /** 历期趋势：当前期用表格草稿实时值，其余期次用后端汇总。 */
  const trend = useMemo(() => {
    const sorted = [...periods].sort((a, b) => a.period.localeCompare(b.period));
    if (!detail) return { labels: [] as string[], period: [] as number[], cum: [] as number[] };
    const livePeriod = priceMode === 'incl' ? grand.periodIncl : grand.periodExcl;
    const liveCum = priceMode === 'incl' ? grand.cumIncl : grand.cumExcl;
    return {
      labels: sorted.map((p) => p.period),
      period: sorted.map((p) =>
        p.id === detail.period.id
          ? livePeriod
          : num(priceMode === 'incl' ? p.periodAmountIncl : p.periodAmountExcl),
      ),
      cum: sorted.map((p) =>
        p.id === detail.period.id
          ? liveCum
          : num(priceMode === 'incl' ? p.cumAmountIncl : p.cumAmountExcl),
      ),
    };
  }, [periods, detail, grand, priceMode]);

  const progressOption = useMemo(() => {
    const liveCum = priceMode === 'incl' ? grand.cumIncl : grand.cumExcl;
    const remaining = Math.max(contractTotal - liveCum, 0);
    const pct = contractTotal > 0 ? (liveCum / contractTotal) * 100 : 0;
    return {
      title: {
        text: `${pct.toFixed(1)}%`,
        subtext: `累计已确认 ¥${money(liveCum)}  /  合同总价 ¥${money(contractTotal)}`,
        left: 'center',
        top: 26,
        textStyle: { fontSize: 34, fontWeight: 600, color: '#1677ff' },
        subtextStyle: { fontSize: 12, color: '#8c8c8c' },
        itemGap: 8,
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        valueFormatter: (value: unknown) => `¥${fmtMoney(Number(value).toFixed(2))}`,
      },
      legend: { bottom: 0 },
      grid: { left: 12, right: 24, top: 132, bottom: 48, containLabel: true },
      xAxis: { type: 'value', axisLabel: { formatter: compactMoney } },
      yAxis: { type: 'category', data: ['合同产值'], axisTick: { show: false } },
      series: [
        {
          name: '累计已确认',
          type: 'bar',
          stack: 'total',
          data: [liveCum],
          barMaxWidth: 42,
          itemStyle: { color: '#1677ff' },
        },
        {
          name: '剩余未确认',
          type: 'bar',
          stack: 'total',
          data: [remaining],
          barMaxWidth: 42,
          itemStyle: { color: '#d9d9d9' },
        },
      ],
    };
  }, [grand, priceMode, contractTotal]);

  const contributionOption = useMemo(
    () => ({
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        valueFormatter: (value: unknown) => `¥${fmtMoney(Number(value).toFixed(2))}`,
      },
      grid: {
        left: 12,
        right: 20,
        top: 28,
        bottom: contributionZoom ? 76 : 62,
        containLabel: true,
      },
      dataZoom: contributionZoom
        ? [
            { type: 'inside', xAxisIndex: 0, start: 0, end: contributionEnd },
            {
              type: 'slider',
              xAxisIndex: 0,
              height: 14,
              bottom: 8,
              start: 0,
              end: contributionEnd,
              brushSelect: false,
            },
          ]
        : [],
      xAxis: {
        type: 'category',
        data: contribution.map((row) => row.name),
        axisLabel: { interval: 0, rotate: 30, width: 70, overflow: 'truncate' },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        axisLabel: { formatter: compactMoney },
        splitLine: { lineStyle: { type: 'dashed' } },
      },
      series: [
        {
          name: '本期产值',
          type: 'bar',
          data: contribution.map((row) => row.value),
          barMaxWidth: 36,
          itemStyle: { color: '#52c41a', borderRadius: [4, 4, 0, 0] },
          label: {
            show: true,
            position: 'top',
            color: '#595959',
            formatter: (params: { value?: unknown }) =>
              Number(params.value ?? 0) === 0 ? '' : compactMoney(Number(params.value ?? 0)),
          },
        },
      ],
    }),
    [contribution, contributionZoom, contributionEnd],
  );

  /** 图3 默认只展示最近 12 期，可拖动缩放查看全部。 */
  const trendWindow = 12;
  const trendStart =
    trend.labels.length > trendWindow
      ? Math.max(0, ((trend.labels.length - trendWindow) / trend.labels.length) * 100)
      : 0;

  const trendOption = useMemo(
    () => ({
      tooltip: {
        trigger: 'axis',
        valueFormatter: (value: unknown) => `¥${fmtMoney(Number(value).toFixed(2))}`,
      },
      legend: { bottom: 0 },
      grid: { left: 12, right: 20, top: 28, bottom: 76, containLabel: true },
      dataZoom: [
        { type: 'inside', xAxisIndex: 0, start: trendStart, end: 100 },
        {
          type: 'slider',
          xAxisIndex: 0,
          height: 16,
          bottom: 30,
          start: trendStart,
          end: 100,
          brushSelect: false,
        },
      ],
      xAxis: {
        type: 'category',
        data: trend.labels,
        axisLabel: { rotate: trend.labels.length > 10 ? 30 : 0 },
      },
      yAxis: [
        { type: 'value', name: '本期', axisLabel: { formatter: compactMoney } },
        { type: 'value', name: '累计', axisLabel: { formatter: compactMoney } },
      ],
      series: [
        {
          name: '本期完成产值',
          type: 'bar',
          data: trend.period,
          barMaxWidth: 32,
          itemStyle: { color: '#faad14', borderRadius: [4, 4, 0, 0] },
          label: {
            show: trend.labels.length > 0 && trend.labels.length <= 8,
            position: 'top',
            color: '#8c8c8c',
            formatter: (params: { value?: unknown }) => compactMoney(Number(params.value ?? 0)),
          },
        },
        {
          name: '累计完成产值',
          type: 'line',
          yAxisIndex: 1,
          data: trend.cum,
          smooth: true,
          symbolSize: 6,
          itemStyle: { color: '#1677ff' },
          areaStyle: { opacity: 0.08 },
        },
      ],
    }),
    [trend, trendStart],
  );

  const columns: ColumnsType<ProgressBoqLineRow> = [
    {
      title: '清单名称及特征',
      dataIndex: 'itemName',
      width: 260,
      render: (_, item) => (
        <div>
          <div>{item.itemName}</div>
          {item.itemFeature && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              {item.itemFeature}
            </Text>
          )}
        </div>
      ),
    },
    { title: '单位', dataIndex: 'unit', width: 64, render: (v) => v ?? '—' },
    {
      title: '合同量',
      dataIndex: 'quantity',
      width: 100,
      align: 'right',
      render: (v) => fmtQty(v),
    },
    {
      title: `合同单价（${priceLabel}）`,
      key: 'price',
      width: 120,
      align: 'right',
      render: (_, item) =>
        fmtMoney(priceMode === 'incl' ? item.unitPriceTaxIncl : item.unitPriceTaxExcl),
    },
    {
      title: '上期累计确认量',
      dataIndex: 'prevCumQty',
      width: 130,
      align: 'right',
      render: (v) => fmtQty(v),
    },
    {
      title: '业主确认累计量',
      key: 'confirmed',
      width: 180,
      render: (_, item) => {
        const confirmed = confirmedOf(item);
        const computed = computeLine(item, confirmed, priceMode);
        const value = draft[item.boqItemId] ?? num(item.prevCumQty);
        return (
          <div>
            {canWrite ? (
              <InputNumber
                value={value}
                precision={3}
                style={{ width: '100%' }}
                status={computed.negative ? 'error' : computed.overContract ? 'warning' : undefined}
                onChange={(v) => {
                  const next = v === null || v === undefined ? null : Number(v);
                  setDraft((prev) => ({ ...prev, [item.boqItemId]: next }));
                }}
              />
            ) : (
              qtyText(confirmed)
            )}
            {computed.negative && (
              <div>
                <Text type="danger" style={{ fontSize: 11 }}>
                  本期完成量为负，请核实是否发生错报倒扣
                </Text>
              </div>
            )}
            {!computed.negative && computed.overContract && (
              <div>
                <Text type="warning" style={{ fontSize: 11 }}>
                  累计量已超合同量
                </Text>
              </div>
            )}
          </div>
        );
      },
    },
    {
      title: '本期完成量',
      key: 'periodQty',
      width: 110,
      align: 'right',
      render: (_, item) => {
        const computed = computeLine(item, confirmedOf(item), priceMode);
        return (
          <Text type={computed.negative ? 'danger' : undefined}>{qtyText(computed.qty)}</Text>
        );
      },
    },
    {
      title: `本期产值（${priceLabel}）`,
      key: 'periodAmount',
      width: 140,
      align: 'right',
      render: (_, item) => {
        const computed = computeLine(item, confirmedOf(item), priceMode);
        return <Text type={computed.negative ? 'danger' : undefined}>{money(computed.periodAmount)}</Text>;
      },
    },
    {
      title: `累计产值（${priceLabel}）`,
      key: 'cumAmount',
      width: 140,
      align: 'right',
      render: (_, item) => money(computeLine(item, confirmedOf(item), priceMode).cumAmount),
    },
  ];

  const extraColumns: ColumnsType<ExtraDraft> = [
    {
      title: '费用名称',
      dataIndex: 'name',
      width: 240,
      render: (_, row, index) =>
        canWrite ? (
          <Input
            value={row.name}
            maxLength={120}
            placeholder="如 设计变更、现场签证"
            onChange={(e) => updateExtra(index, { name: e.target.value })}
          />
        ) : (
          row.name || '—'
        ),
    },
    {
      title: '上期累计确认金额',
      dataIndex: 'prevCumAmount',
      width: 160,
      align: 'right',
      render: (v) => fmtMoney(v),
    },
    {
      title: '本期业主确认累计金额',
      dataIndex: 'confirmedCumAmount',
      width: 190,
      render: (_, row, index) => {
        const period = round2((row.confirmedCumAmount ?? 0) - num(row.prevCumAmount));
        if (!canWrite) {
          return fmtMoney(row.confirmedCumAmount === null ? null : row.confirmedCumAmount.toFixed(2));
        }
        return (
          <InputNumber
            value={row.confirmedCumAmount}
            precision={2}
            style={{ width: '100%' }}
            status={period < 0 ? 'error' : undefined}
            onChange={(v) => {
              const next = v === null || v === undefined ? null : Number(v);
              updateExtra(index, { confirmedCumAmount: next });
            }}
          />
        );
      },
    },
    {
      title: '本期新增确认金额',
      key: 'periodAmount',
      width: 160,
      align: 'right',
      render: (_, row) => {
        const period = round2((row.confirmedCumAmount ?? 0) - num(row.prevCumAmount));
        return <Text type={period < 0 ? 'danger' : undefined}>{money(period)}</Text>;
      },
    },
    {
      title: '备注',
      dataIndex: 'remark',
      render: (_, row, index) =>
        canWrite ? (
          <Input
            value={row.remark}
            maxLength={200}
            onChange={(e) => updateExtra(index, { remark: e.target.value })}
          />
        ) : (
          row.remark || '—'
        ),
    },
    ...(canWrite
      ? [
          {
            title: '操作',
            key: 'op',
            width: 80,
            render: (_: unknown, __: ExtraDraft, index: number) => (
              <Button type="link" danger size="small" onClick={() => removeExtra(index)}>
                删除
              </Button>
            ),
          } satisfies ColumnsType<ExtraDraft>[number],
        ]
      : []),
  ];

  const renderBody = () => {
    if (periodsLoading) {
      return (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Spin tip="加载报量期次…" />
        </div>
      );
    }
    if (periods.length === 0) {
      return (
        <Empty description="暂无报量期次">
          {canWrite && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openNewPeriod}>
              新建期次
            </Button>
          )}
        </Empty>
      );
    }
    if (detailLoading) {
      return (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Spin tip="加载报量数据…" />
        </div>
      );
    }
    if (!detail) {
      return <Empty description="请选择报量期次" />;
    }

    return (
      <>
        <Space size={32} wrap style={{ marginBottom: 16 }}>
          <Statistic
            title="本期报量产值（含税）"
            value={money(grand.periodIncl)}
            prefix="¥"
            valueStyle={grand.periodIncl < 0 ? { color: '#cf1322' } : undefined}
          />
          <Statistic
            title="本期报量产值（不含税）"
            value={money(grand.periodExcl)}
            prefix="¥"
            valueStyle={grand.periodExcl < 0 ? { color: '#cf1322' } : undefined}
          />
          <Statistic title="累计确认产值（含税）" value={money(grand.cumIncl)} prefix="¥" />
          <Statistic
            title="本期签证及其他确认"
            value={money(extraPeriodTotal)}
            prefix="¥"
            valueStyle={extraPeriodTotal < 0 ? { color: '#cf1322' } : undefined}
          />
          <Statistic title="有效清单项" value={detail.items.length} suffix="条" />
        </Space>

        <Row gutter={[16, 16]} style={{ marginBottom: 16 }} align="stretch">
          <Col xs={24} xl={8}>
            <Card
              size="small"
              title="项目总产值进度"
              extra={<Text type="secondary">累计确认 / 合同总价</Text>}
              style={{ height: '100%' }}
            >
              <EChart option={progressOption} height={320} empty={contractTotal === 0} />
            </Card>
          </Col>
          <Col xs={24} xl={16}>
            <Card
              size="small"
              title="本期分部工程产值贡献"
              extra={
                <Select
                  size="small"
                  style={{ width: 200 }}
                  value={effectiveScope}
                  onChange={setContributionScope}
                  options={[{ value: 'all', label: '总体（全部单项工程）' }, ...unitOptions]}
                />
              }
            >
              <EChart
                option={contributionOption}
                height={320}
                empty={contribution.length === 0}
              />
            </Card>
          </Col>
        </Row>

        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          <Col span={24}>
            <Card
              size="small"
              title="历期产值趋势"
              extra={<Text type="secondary">本期柱状 / 累计折线，可拖动缩放</Text>}
            >
              <EChart option={trendOption} height={300} empty={trend.labels.length === 0} />
            </Card>
          </Col>
        </Row>

        {detail.period.previousPeriod ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={`上期累计确认量取自「${detail.period.previousLabel ?? detail.period.previousPeriod}」的业主确认累计量`}
          />
        ) : (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="本期为首期报量，上期累计确认量默认为 0"
          />
        )}

        <Space size={12} style={{ marginBottom: 12 }} wrap>
          {BOQ_PROJECT_CATEGORY_KEYS.map((key) => {
            const total = categoryTotals.get(key) ?? { count: 0, periodIncl: 0, periodExcl: 0 };
            const amount = priceMode === 'incl' ? total.periodIncl : total.periodExcl;
            return (
              <Button
                key={key}
                size="large"
                type={category === key ? 'primary' : 'default'}
                onClick={() => setCategory(key)}
                style={{ minWidth: 200, height: 56, textAlign: 'left' }}
              >
                <div style={{ fontWeight: 600 }}>{BOQ_PROJECT_CATEGORY_LABELS[key]}</div>
                <div style={{ fontSize: 12, opacity: 0.85 }}>
                  {total.count} 条 · 本期 ¥{money(amount)}
                </div>
              </Button>
            );
          })}
        </Space>

        <Collapse
          key={`${detail.period.id}-${category}`}
          defaultActiveKey={groups.map((group) => group.key)}
          items={groups.map((group) => {
            const unitTotal = aggregate(group.items);
            return {
              key: group.key,
              label: (
                <Space size={12} wrap>
                  <Text strong>单项工程：{group.name}</Text>
                  <Text type="secondary">
                    {group.items.length} 条 · 本期产值（{priceLabel}）¥{money(unitTotal.periodAmount)} ·
                    累计产值 ¥{money(unitTotal.cumAmount)}
                  </Text>
                </Space>
              ),
              children: (
                <Collapse
                  ghost
                  size="small"
                  defaultActiveKey={group.sections.slice(0, 1).map((section) => section.name)}
                  items={group.sections.map((section) => {
                    const sectionTotal = aggregate(section.items);
                    return {
                      key: section.name,
                      label: `分部工程：${section.name}（${section.items.length} 条 · 本期 ¥${money(
                        sectionTotal.periodAmount,
                      )} · 累计 ¥${money(sectionTotal.cumAmount)}）`,
                      children: (
                        <Table<ProgressBoqLineRow>
                          rowKey="boqItemId"
                          size="small"
                          columns={columns}
                          dataSource={section.items}
                          pagination={false}
                          scroll={{ x: 1240 }}
                          summary={() => {
                            const sum = aggregate(section.items);
                            return (
                              <Table.Summary fixed>
                                <Table.Summary.Row>
                                  <Table.Summary.Cell index={0}>
                                    <Text strong>本分部小计</Text>
                                  </Table.Summary.Cell>
                                  <Table.Summary.Cell index={1} />
                                  <Table.Summary.Cell index={2} />
                                  <Table.Summary.Cell index={3} />
                                  <Table.Summary.Cell index={4} />
                                  <Table.Summary.Cell index={5} />
                                  <Table.Summary.Cell index={6} align="right">
                                    <Text strong>{qtyText(sum.periodQty)}</Text>
                                  </Table.Summary.Cell>
                                  <Table.Summary.Cell index={7} align="right">
                                    <Text strong>{money(sum.periodAmount)}</Text>
                                  </Table.Summary.Cell>
                                  <Table.Summary.Cell index={8} align="right">
                                    <Text strong>{money(sum.cumAmount)}</Text>
                                  </Table.Summary.Cell>
                                </Table.Summary.Row>
                              </Table.Summary>
                            );
                          }}
                        />
                      ),
                    };
                  })}
                />
              ),
            };
          })}
        />

        {groups.length === 0 && (
          <Alert
            type="info"
            showIcon
            message={`「${BOQ_PROJECT_CATEGORY_LABELS[category]}」暂无可报量清单项`}
            description="请先在「收入与收付款 - 合同清单」中录入或导入清单项。"
          />
        )}

        <Collapse
          style={{ marginTop: 16 }}
          defaultActiveKey={['extras']}
          items={[
            {
              key: 'extras',
              label: (
                <Space size={12} wrap>
                  <Text strong>本期签证及其他确认</Text>
                  <Text type="secondary">
                    {extras.length} 项 · 本期新增确认 ¥{money(extraPeriodTotal)}
                  </Text>
                </Space>
              ),
              children: (
                <>
                  {canWrite && (
                    <Space style={{ marginBottom: 8 }}>
                      <Button icon={<PlusOutlined />} onClick={addExtra}>
                        新增一行
                      </Button>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        上期累计确认金额按上一期同名费用自动带入；本期新增 = 本期确认累计 − 上期累计，允许负数。
                      </Text>
                    </Space>
                  )}
                  <Table<ExtraDraft>
                    rowKey="key"
                    size="small"
                    columns={extraColumns}
                    dataSource={extras}
                    pagination={false}
                    scroll={{ x: 900 }}
                    locale={{ emptyText: '暂无签证及其他确认' }}
                    summary={() => (
                      <Table.Summary fixed>
                        <Table.Summary.Row>
                          <Table.Summary.Cell index={0}>
                            <Text strong>合计</Text>
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={1} align="right">
                            <Text strong>{money(extraPrevTotal)}</Text>
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={2} align="right">
                            <Text strong>{money(extraConfirmedTotal)}</Text>
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={3} align="right">
                            <Text strong type={extraPeriodTotal < 0 ? 'danger' : undefined}>
                              {money(extraPeriodTotal)}
                            </Text>
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={4} />
                          {canWrite && <Table.Summary.Cell index={5} />}
                        </Table.Summary.Row>
                      </Table.Summary>
                    )}
                  />
                </>
              ),
            },
          ]}
        />

        {canWrite && (
          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={saving}
              onClick={() => void doSave()}
            >
              保存本期报量
            </Button>
          </div>
        )}
      </>
    );
  };

  return (
    <Card
      title="过程报量"
      extra={
        <Space wrap>
          <Select
            style={{ width: 220 }}
            placeholder="选择报量期次"
            loading={periodsLoading}
            value={activePeriodId ?? undefined}
            onChange={(value) => setActivePeriodId(value)}
            options={periods.map((p) => ({ value: p.id, label: p.label }))}
          />
          <Radio.Group
            value={priceMode}
            onChange={(e) => setPriceMode(e.target.value as PriceMode)}
            optionType="button"
            buttonStyle="solid"
            options={[
              { label: '含税显示', value: 'incl' },
              { label: '不含税显示', value: 'excl' },
            ]}
          />
          {canWrite && (
            <Button icon={<PlusOutlined />} onClick={openNewPeriod}>
              新建期次
            </Button>
          )}
          {canWrite && detail && (
            <Button danger icon={<DeleteOutlined />} loading={resetting} onClick={doReset}>
              作废/清空本期报量
            </Button>
          )}
          {canWrite && detail && (
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={saving}
              onClick={() => void doSave()}
            >
              保存本期报量
            </Button>
          )}
        </Space>
      }
    >
      {renderBody()}

      <Modal
        title="新建报量期次"
        open={newOpen}
        onCancel={() => setNewOpen(false)}
        onOk={() => void doCreatePeriod()}
        confirmLoading={creating}
        okText="创建期次"
        destroyOnHidden
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <div style={{ marginBottom: 6 }}>报量月份</div>
            <DatePicker
              picker="month"
              style={{ width: '100%' }}
              value={newMonth}
              onChange={(value) => setNewMonth(value)}
              allowClear={false}
            />
          </div>
          <Alert
            type="info"
            showIcon
            message="新期次会自动带入上一期的业主确认累计量作为本期「上期累计确认量」基数，本期确认量默认等于上期累计量。"
            description="若上一期尚未创建，则本期上期累计量默认为 0。"
          />
        </Space>
      </Modal>
    </Card>
  );
}
