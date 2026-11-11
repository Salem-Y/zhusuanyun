import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  DatePicker,
  Drawer,
  Empty,
  Radio,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import {
  api,
  type ActualEntry,
  type CostCaliber,
  type ExpenseCategory,
  type ProcessCostData,
  type ProcessCostMode,
  type ProcessCostRow,
  type TargetLine,
} from '../api';
import { useProject } from '../project/ProjectContext';
import {
  ACTUAL_STATUS_COLORS,
  ACTUAL_STATUS_LABELS,
  EXPENSE_CATEGORY_KEYS,
  EXPENSE_CATEGORY_LABELS,
  fmtDate,
  fmtMoney,
} from './cost/labels';
import EChart from '../components/EChart';

const CALIBER_KEY = 'zs.costCaliber';

function readCaliber(): CostCaliber {
  try {
    return window.localStorage.getItem(CALIBER_KEY) === 'incl' ? 'incl' : 'excl';
  } catch {
    return 'excl';
  }
}

const MODE_OPTIONS: Array<{ value: ProcessCostMode; label: string }> = [
  { value: 'period', label: '本期数据' },
  { value: 'cumulative', label: '累计数据' },
  { value: 'forecast', label: '预测目标数据' },
];

interface VendorRow {
  key: string;
  vendorName: string;
  actual: string;
  count: number;
  share: number;
  entries: ActualEntry[];
}

export default function ProcessCostPage() {
  const { project } = useProject();
  const { message } = AntApp.useApp();

  const [mode, setMode] = useState<ProcessCostMode>('cumulative');
  const [category, setCategory] = useState<'all' | ExpenseCategory>('all');
  const [caliber, setCaliber] = useState<CostCaliber>(readCaliber);
  const [until, setUntil] = useState<Dayjs>(dayjs());
  const [period, setPeriod] = useState<Dayjs>(dayjs());
  const [data, setData] = useState<ProcessCostData | null>(null);
  const [loading, setLoading] = useState(true);

  const [drill, setDrill] = useState<{ category: ExpenseCategory; label: string } | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillData, setDrillData] = useState<{ targetLines: TargetLine[]; entries: ActualEntry[] } | null>(null);

  const untilStr = until.format('YYYY-MM-DD');
  const periodStr = period.format('YYYY-MM');
  const caliberLabel = caliber === 'incl' ? '含税' : '不含税';

  useEffect(() => {
    try {
      window.localStorage.setItem(CALIBER_KEY, caliber);
    } catch {
      // 忽略隐私模式写入失败
    }
  }, [caliber]);

  const fetchDrill = useCallback(
    async (cat: ExpenseCategory) => {
      setDrillLoading(true);
      try {
        const result = await api.getProcessDrilldown(project.id, {
          category: cat,
          mode,
          until: untilStr,
          period: mode === 'period' ? periodStr : undefined,
        });
        setDrillData({ targetLines: result.targetLines as TargetLine[], entries: result.entries });
      } catch (e) {
        message.error((e as Error).message);
      } finally {
        setDrillLoading(false);
      }
    },
    [project.id, mode, untilStr, periodStr, message],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.getProcessCosts(project.id, {
        mode,
        until: untilStr,
        period: mode === 'period' ? periodStr : undefined,
        caliber,
      });
      setData(result);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [project.id, mode, untilStr, periodStr, caliber, message]);

  useEffect(() => {
    void load();
  }, [load]);

  // 类别视图：拉取该类别流水并按供应商聚合
  useEffect(() => {
    if (category === 'all') {
      setDrillData(null);
      return;
    }
    void fetchDrill(category);
  }, [category, fetchDrill]);

  const vendorRows = useMemo<VendorRow[]>(() => {
    if (category === 'all' || !drillData) return [];
    const map = new Map<string, VendorRow>();
    for (const e of drillData.entries) {
      const name = (e.vendorName ?? '').trim() || '未填写供应商';
      const row =
        map.get(name) ??
        ({ key: name, vendorName: name, actual: '0', count: 0, share: 0, entries: [] } as VendorRow);
      row.actual = String(Number(row.actual) + Number(e.amount));
      row.count += 1;
      row.entries.push(e);
      map.set(name, row);
    }
    const rows = [...map.values()].sort((a, b) => Number(b.actual) - Number(a.actual));
    const total = rows.reduce((acc, r) => acc + Number(r.actual), 0);
    for (const r of rows) r.share = total === 0 ? 0 : Math.round((Number(r.actual) / total) * 1000) / 10;
    return rows;
  }, [category, drillData]);

  const activeCategoryTotal = useMemo(() => {
    if (category === 'all' || !data) return 0;
    const row = data.rows.find((r) => r.key === category);
    return Number(row?.actual ?? 0);
  }, [category, data]);

  const trendOption = useMemo(() => {
    const trend = data?.trend ?? [];
    return {
      tooltip: {
        trigger: 'axis' as const,
        valueFormatter: (v: number) => `¥${fmtMoney(String(v))}`,
      },
      grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
      xAxis: { type: 'category' as const, boundaryGap: false, data: trend.map((t) => t.month) },
      yAxis: {
        type: 'value' as const,
        axisLabel: {
          formatter: (v: number) => (Math.abs(v) >= 10000 ? `${(v / 10000).toFixed(0)}万` : String(v)),
        },
      },
      series: [
        {
          name: `月度实际成本（${caliberLabel}）`,
          type: 'line' as const,
          smooth: true,
          symbolSize: 6,
          lineStyle: { width: 3, color: '#1677ff' },
          itemStyle: { color: '#1677ff' },
          areaStyle: { color: 'rgba(22,119,255,0.16)' },
          data: trend.map((t) => Number(t.actual)),
        },
      ],
    };
  }, [data, caliberLabel]);

  const overviewColumns: ColumnsType<ProcessCostRow> = [
    {
      title: '费用类别',
      dataIndex: 'label',
      width: 140,
      render: (label: string, row) =>
        row.key === 'total' ? <Typography.Text strong>{label}</Typography.Text> : label,
    },
    {
      title: `预算收入（${caliberLabel}）`,
      dataIndex: 'budgetRevenue',
      align: 'right',
      render: (v: string, row) => (
        <span style={{ fontWeight: row.key === 'total' ? 600 : undefined }}>{fmtMoney(v)}</span>
      ),
    },
    {
      title: mode === 'forecast' ? '预测成本' : '目标成本',
      dataIndex: 'target',
      align: 'right',
      render: (v: string, row) => (
        <span style={{ fontWeight: row.key === 'total' ? 600 : undefined }}>{fmtMoney(v)}</span>
      ),
    },
    {
      title: '实际成本',
      dataIndex: 'actual',
      align: 'right',
      render: (v: string, row) => (
        <span style={{ fontWeight: row.key === 'total' ? 600 : undefined }}>{fmtMoney(v)}</span>
      ),
    },
    {
      title: mode === 'period' ? '差额（预算收入 − 实际）' : '差额（目标 − 实际）',
      dataIndex: 'diff',
      align: 'right',
      render: (v: string, row) => (
        <span
          style={{ color: Number(v) < 0 ? '#cf1322' : undefined, fontWeight: row.key === 'total' ? 600 : undefined }}
        >
          {fmtMoney(v)}
        </span>
      ),
    },
    {
      title: '节超率',
      key: 'rate',
      width: 100,
      align: 'right',
      render: (_, row) => {
        const target = Number(row.target ?? 0);
        if (row.key === 'total' || target === 0) return '—';
        const rate = ((target - Number(row.actual ?? 0)) / target) * 100;
        return (
          <span style={{ color: rate < 0 ? '#cf1322' : '#389e0d' }}>
            {rate >= 0 ? '+' : ''}
            {rate.toFixed(1)}%
          </span>
        );
      },
    },
    ...(category === 'all'
      ? [
          {
            title: '流水',
            key: 'flow',
            width: 100,
            render: (_: unknown, row: ProcessCostRow) =>
              row.key === 'total' ? (
                '—'
              ) : (
                <Button
                  size="small"
                  type="link"
                  onClick={() => {
                    const cat = row.key as ExpenseCategory;
                    setCategory(cat);
                  }}
                >
                  查看流水
                </Button>
              ),
          },
        ]
      : []),
  ];

  const vendorColumns: ColumnsType<VendorRow> = [
    { title: '供应商 / 分包商', dataIndex: 'vendorName' },
    {
      title: `实际成本（${caliberLabel}）`,
      dataIndex: 'actual',
      align: 'right',
      render: (v: string) => fmtMoney(Number(v).toFixed(2)),
    },
    { title: '结算单据', dataIndex: 'count', width: 100, align: 'right', render: (v: number) => `${v} 笔` },
    { title: '占比', dataIndex: 'share', width: 90, align: 'right', render: (v: number) => `${v}%` },
    {
      title: '流水',
      key: 'flow',
      width: 100,
      render: (_, row) => (
        <Button
          size="small"
          type="link"
          onClick={() => {
            setDrill({ category: category as ExpenseCategory, label: EXPENSE_CATEGORY_LABELS[category as ExpenseCategory] });
          }}
        >
          查看流水
        </Button>
      ),
    },
  ];

  const unallocated = Number(data?.totals.unallocatedRevenue ?? 0);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {project.status !== 'ACTIVE' && (
        <Alert type="warning" showIcon message="项目已归档" description="已归档项目仅允许授权历史查看。" />
      )}

      <Card size="small" title="过程成本统计">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap size={12}>
            {MODE_OPTIONS.map((opt) => (
              <Button
                key={opt.value}
                size="large"
                type={mode === opt.value ? 'primary' : 'default'}
                onClick={() => setMode(opt.value)}
                style={{ minWidth: 132, height: 46 }}
              >
                {opt.label}
              </Button>
            ))}
            <span style={{ width: 16 }} />
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
          </Space>
          <Space wrap>
            {mode === 'period' && (
              <>
                <Typography.Text>统计月份：</Typography.Text>
                <DatePicker picker="month" value={period} onChange={(d) => d && setPeriod(d)} allowClear={false} />
              </>
            )}
            <Typography.Text>统计截止日期：</Typography.Text>
            <DatePicker value={until} onChange={(d) => d && setUntil(d)} allowClear={false} />
            <Button onClick={() => void load()} loading={loading}>
              刷新
            </Button>
          </Space>
          <Alert
            type="info"
            showIcon
            message={`当前视图：${MODE_OPTIONS.find((m) => m.value === mode)?.label ?? ''}`}
            description={
              <>
                {mode === 'period'
                  ? `展示 ${periodStr} 期间发生的已确认实际成本；差额为预算收入 − 实际。`
                  : mode === 'cumulative'
                    ? `展示开工至 ${untilStr} 的累计已确认实际成本；差额为目标 − 实际。`
                    : `预测目标数据：目标列取当前批准版本作为预测完成成本，实际为截至 ${untilStr} 已确认净额。`}
                预算收入按目标明细金额占比分摊到各费用类别，未分摊部分计入合计。
                {data?.targetVersion ? ` 目标版本：${data.targetVersion.versionName}。` : ' 尚无批准目标版本。'}
              </>
            }
          />
        </Space>
      </Card>

      <Card size="small" title="实际成本发生趋势（按结算月份）">
        <EChart option={trendOption} height={260} empty={(data?.trend?.length ?? 0) === 0} />
      </Card>

      <Card size="small">
        <Space size={32} style={{ marginBottom: 16 }} wrap>
          <Statistic
            title={mode === 'forecast' ? `预测成本合计（${caliberLabel}，元）` : `目标成本合计（${caliberLabel}，元）`}
            value={fmtMoney(data?.totals.target ?? '0')}
            loading={loading}
          />
          <Statistic
            title={`预算收入合计（${caliberLabel}，元）`}
            value={fmtMoney(data?.totals.budgetRevenue ?? '0')}
            loading={loading}
          />
          <Statistic
            title={`实际成本合计（${caliberLabel}，元）`}
            value={fmtMoney(data?.totals.actual ?? '0')}
            loading={loading}
          />
          <Statistic
            title="未分摊预算收入（元）"
            value={fmtMoney(data?.totals.unallocatedRevenue ?? '0')}
            loading={loading}
            valueStyle={unallocated !== 0 ? { color: '#d46b08' } : undefined}
          />
        </Space>

        <Space size={8} wrap style={{ marginBottom: 12 }}>
          <Button
            type={category === 'all' ? 'primary' : 'default'}
            onClick={() => setCategory('all')}
          >
            总览（8 大类）
          </Button>
          {EXPENSE_CATEGORY_KEYS.map((key) => (
            <Button
              key={key}
              type={category === key ? 'primary' : 'default'}
              onClick={() => setCategory(key)}
            >
              {EXPENSE_CATEGORY_LABELS[key]}
            </Button>
          ))}
        </Space>

        {category === 'all' ? (
          <Table<ProcessCostRow>
            size="small"
            rowKey="key"
            loading={loading}
            pagination={false}
            dataSource={data?.rows ?? []}
            columns={overviewColumns}
            locale={{ emptyText: <Empty description="尚无数据；请先批准目标版本并登记结算" /> }}
            onRow={(row) => ({
              onClick: () => {
                if (row.key !== 'total') setCategory(row.key as ExpenseCategory);
              },
              style: { cursor: row.key === 'total' ? 'default' : 'pointer' },
            })}
          />
        ) : (
          <>
            <Space style={{ marginBottom: 8 }}>
              <Typography.Text strong>{EXPENSE_CATEGORY_LABELS[category]}</Typography.Text>
              <Typography.Text type="secondary">
                共 {vendorRows.length} 家供应商 · 实际 {fmtMoney(activeCategoryTotal.toFixed(2))} 元
              </Typography.Text>
            </Space>
            <Table<VendorRow>
              size="small"
              rowKey="key"
              loading={drillLoading}
              pagination={false}
              dataSource={vendorRows}
              columns={vendorColumns}
              locale={{ emptyText: '该类别本期无已确认结算' }}
            />
          </>
        )}
      </Card>

      <Drawer
        title={drill ? `${drill.label} · 结算流水` : '结算流水'}
        width={820}
        open={!!drill}
        onClose={() => setDrill(null)}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Typography.Text strong>目标明细（当前批准版本）</Typography.Text>
          <Table
            size="small"
            rowKey="id"
            loading={drillLoading}
            pagination={false}
            dataSource={drillData?.targetLines ?? []}
            locale={{ emptyText: '该类别无目标明细' }}
            columns={[
              { title: '摘要', dataIndex: 'summary' },
              { title: '关联清单项', dataIndex: 'boqItemName', width: 160, render: (v) => v || '—' },
              {
                title: '金额（不含税）',
                dataIndex: 'amount',
                width: 130,
                align: 'right',
                render: (v: string) => fmtMoney(v),
              },
            ]}
          />
          <Typography.Text strong>结算单据（已确认净额，含冲销）</Typography.Text>
          <Table
            size="small"
            rowKey="id"
            loading={drillLoading}
            pagination={{ pageSize: 15 }}
            dataSource={drillData?.entries ?? []}
            locale={{ emptyText: '该类别无已确认单据' }}
            columns={[
              { title: '业务日期', dataIndex: 'businessDate', width: 105, render: (v: string) => fmtDate(v) },
              { title: '成本说明', dataIndex: 'description' },
              { title: '供应商', dataIndex: 'vendorName', width: 140, render: (v) => v || '—' },
              {
                title: '金额（元）',
                dataIndex: 'amount',
                width: 125,
                align: 'right',
                render: (v: string, e: ActualEntry) => (
                  <span style={{ color: Number(v) < 0 ? '#cf1322' : undefined }}>
                    {fmtMoney(v)}
                    {e.kind === 'REVERSAL' ? '（冲销）' : ''}
                  </span>
                ),
              },
              {
                title: '状态',
                dataIndex: 'status',
                width: 88,
                render: (s: ActualEntry['status']) => (
                  <Tag color={ACTUAL_STATUS_COLORS[s]}>{ACTUAL_STATUS_LABELS[s]}</Tag>
                ),
              },
            ]}
          />
        </Space>
      </Drawer>
    </Space>
  );
}
