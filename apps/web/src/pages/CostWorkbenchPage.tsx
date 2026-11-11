import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Col,
  DatePicker,
  Drawer,
  Empty,
  Input,
  List,
  Modal,
  Radio,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
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
  const unlinkedTotal = (comparison?.unlinkedTargetCount ?? 0) + (comparison?.unlinkedActualCount ?? 0);

  const pieOption = useMemo(() => {
    const data = EXPENSE_CATEGORY_KEYS.map((key) => ({
      name: EXPENSE_CATEGORY_LABELS[key],
      value: Number(totals?.byCategory?.[key] ?? 0),
    })).filter((d) => d.value > 0);
    const unlinked = Number(totals?.unlinkedActual ?? 0);
    if (unlinked > 0) data.push({ name: '未分配成本', value: unlinked });
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

  const columns: ColumnsType<CostComparisonRow> = [
    {
      title: '单项工程',
      key: 'unitProject',
      width: 100,
      fixed: 'left',
      render: (_, row) => row.unitProjectName ?? '全部',
    },
    {
      title: '清单名称及特征',
      key: 'item',
      width: 210,
      fixed: 'left',
      render: (_, row) => (
        <div>
          <div>{row.itemName}</div>
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
      dataIndex: 'actualQuantity',
      width: 100,
      align: 'right',
      render: (v: string) => {
        const num = Number(v ?? 0);
        return (
          <span style={{ color: num === 0 ? undefined : '#0958d9', fontWeight: num === 0 ? undefined : 600 }}>
            {num === 0 ? '—' : fmtQty(v)}
          </span>
        );
      },
    },
    { title: `收入合价（${caliberLabel}）`, dataIndex: 'income', width: 130, align: 'right', render: (v: string) => fmtMoney(v) },
    { title: '目标成本', dataIndex: 'target', width: 120, align: 'right', render: (v: string) => fmtMoney(v) },
    { title: '实际成本', dataIndex: 'actual', width: 120, align: 'right', render: (v: string) => fmtMoney(v) },
    {
      title: '盈亏差额',
      dataIndex: 'diff',
      width: 120,
      align: 'right',
      render: (v: string) => (
        <span style={{ color: Number(v) < 0 ? '#cf1322' : '#389e0d' }}>{fmtMoney(v)}</span>
      ),
    },
    ...EXPENSE_CATEGORY_KEYS.map((key) => ({
      title: EXPENSE_CATEGORY_LABELS[key],
      key,
      width: 96,
      align: 'right' as const,
      render: (_: unknown, row: CostComparisonRow) => fmtMoney(row[key]),
    })),
    ...(projectActive
      ? [
          {
            title: '操作',
            key: 'op',
            width: 110,
            fixed: 'right' as const,
            render: (_: unknown, row: CostComparisonRow) => (
              <Button
                size="small"
                type="link"
                icon={<PlusOutlined />}
                onClick={() => openEntryForm(row.boqIds[0])}
              >
                录入结算
              </Button>
            ),
          },
        ]
      : []),
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
          {unlinkedTotal > 0 && (
            <Button type="primary" danger ghost onClick={() => void openUnlinked()}>
              有 {unlinkedTotal} 条成本未分配，点击查看
            </Button>
          )}
          {projectActive && (
            <Button icon={<PlusOutlined />} onClick={() => openEntryForm(null)}>
              录入未分配成本
            </Button>
          )}
          <Button onClick={() => void loadAll()} loading={loading}>
            刷新
          </Button>
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
          {projectActive && (
            <Button icon={<FileAddOutlined />} onClick={() => openEntryForm(null)}>
              新增实际成本
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
              label: '清单成本对比',
              children: (
                <Table<CostComparisonRow>
                  size="small"
                  rowKey="key"
                  loading={loading}
                  pagination={false}
                  dataSource={rows}
                  scroll={{ x: 1900 }}
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
                            <Typography.Text strong>{fmtQty(totals?.actualQuantity ?? '0')}</Typography.Text>
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={5} align="right">
                            <Typography.Text strong>{fmtMoney(totals?.income ?? '0')}</Typography.Text>
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={6} align="right">
                            <Typography.Text strong>{fmtMoney(totals?.target ?? '0')}</Typography.Text>
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={7} align="right">
                            <Typography.Text strong>{fmtMoney(totals?.actual ?? '0')}</Typography.Text>
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={8} align="right">
                            <Typography.Text
                              strong
                              type={Number(totals?.diff ?? 0) < 0 ? 'danger' : undefined}
                            >
                              {fmtMoney(totals?.diff ?? '0')}
                            </Typography.Text>
                          </Table.Summary.Cell>
                          {EXPENSE_CATEGORY_KEYS.map((key, i) => (
                            <Table.Summary.Cell key={key} index={9 + i} align="right">
                              {fmtMoney(totals?.byCategory?.[key] ?? '0')}
                            </Table.Summary.Cell>
                          ))}
                          <Table.Summary.Cell index={17} />
                        </Table.Summary.Row>
                      </Table.Summary>
                    ) : null
                  }
                />
              ),
            },
            { key: 'versions', label: '版本与调整记录', children: versionsTab },
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
        onClose={() => setEntryFormOpen(false)}
        onSaved={loadAll}
      />
      <EntryDetailDrawer
        entryId={entryDetailId}
        onClose={() => setEntryDetailId(null)}
        onChanged={loadAll}
      />

      <Modal
        title="未分配成本池（未关联清单项）"
        open={unlinkedOpen}
        onCancel={() => setUnlinkedOpen(false)}
        footer={<Button onClick={() => setUnlinkedOpen(false)}>关闭</Button>}
        width={880}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            message={`目标明细 ${unlinkedData?.targetLines.length ?? 0} 条 · 实际单据 ${unlinkedData?.entries.length ?? 0} 条未关联清单项`}
            description="此处为只读明细：可点击实际单据查看详情，不会触发重录或冲销。"
          />
          <Typography.Text strong>目标明细</Typography.Text>
          <Table
            size="small"
            rowKey="id"
            loading={unlinkedLoading}
            pagination={{ pageSize: 10 }}
            dataSource={unlinkedData?.targetLines ?? []}
            locale={{ emptyText: '无未关联目标明细' }}
            columns={[
              { title: '摘要', dataIndex: 'summary' },
              {
                title: '费用类别',
                dataIndex: 'category',
                width: 100,
                render: (c: keyof typeof EXPENSE_CATEGORY_LABELS) => EXPENSE_CATEGORY_LABELS[c] ?? c,
              },
              { title: '单项工程', dataIndex: 'unitProjectName', width: 120, render: (v) => v ?? '—' },
              {
                title: '金额（不含税）',
                dataIndex: 'amount',
                width: 130,
                align: 'right',
                render: (v: string) => fmtMoney(v),
              },
            ]}
          />
          <Typography.Text strong>实际单据（已确认）</Typography.Text>
          <Table
            size="small"
            rowKey="id"
            loading={unlinkedLoading}
            pagination={{ pageSize: 10 }}
            dataSource={unlinkedData?.entries ?? []}
            locale={{ emptyText: '无未关联实际单据' }}
            onRow={(e) => ({ onClick: () => setEntryDetailId(e.id), style: { cursor: 'pointer' } })}
            columns={[
              { title: '业务日期', dataIndex: 'businessDate', width: 110, render: (v: string) => fmtDate(v) },
              { title: '成本说明', dataIndex: 'description' },
              {
                title: '费用类别',
                dataIndex: 'category',
                width: 100,
                render: (c: keyof typeof EXPENSE_CATEGORY_LABELS) => EXPENSE_CATEGORY_LABELS[c] ?? c,
              },
              { title: '单项工程', dataIndex: 'unitProjectName', width: 110, render: (v) => v ?? '—' },
              { title: '供应商', dataIndex: 'vendorName', width: 140, render: (v) => v || '—' },
              { title: '金额', dataIndex: 'amount', width: 120, align: 'right', render: (v: string) => fmtMoney(v) },
            ]}
          />
        </Space>
      </Modal>

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
              <Typography.Text strong>结算草稿（未计入实际成本）</Typography.Text>
              <List
                size="small"
                dataSource={myDraftEntries}
                locale={{ emptyText: '无结算草稿' }}
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
            <Empty description="造价员账号登录后可编制目标草稿与结算草稿" />
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
          <Typography.Text strong>待复核冲销申请</Typography.Text>
          <List
            size="small"
            dataSource={pendingReversals}
            locale={{ emptyText: '无待复核冲销申请' }}
            renderItem={(r) => (
              <List.Item
                actions={
                  r.requestedById === session.user.id
                    ? [<Tag key="self" color="orange">本人发起，需其他负责人复核</Tag>]
                    : [
                        <Button
                          size="small"
                          type="primary"
                          key="ok"
                          loading={acting}
                          onClick={() => setRrModal({ rr: r, action: 'approve' })}
                        >
                          复核通过
                        </Button>,
                        <Button size="small" danger key="no" onClick={() => setRrModal({ rr: r, action: 'reject' })}>
                          驳回
                        </Button>,
                      ]
                }
              >
                <List.Item.Meta
                  title={`冲销「${r.entry?.description ?? ''}」 · ${fmtMoney(r.entry?.amount ?? '0')} 元`}
                  description={`发起人 ${r.requestedByName} · ${fmtDateTime(r.requestedAt)} · 原因：${r.reason}`}
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
