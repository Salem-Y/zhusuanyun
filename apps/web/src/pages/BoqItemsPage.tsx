import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Collapse,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import type { TableProps } from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  ImportOutlined,
  InboxOutlined,
  MergeCellsOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  api,
  type BoqItem,
  type BoqListData,
  type BoqProjectCategory,
  type CxXmlPreviewData,
  type ImportLogItem,
  type UnitProject,
} from '../api';
import { useProject } from '../project/ProjectContext';
import { useSession } from '../App';
import {
  BOQ_IMPORT_STATUS_LABELS,
  BOQ_PROJECT_CATEGORY_KEYS,
  BOQ_PROJECT_CATEGORY_LABELS,
  fmtDateTime,
  fmtMoney,
  fmtQty,
  newIdempotencyKey,
} from './cost/labels';

const { Text } = Typography;

type PriceMode = 'incl' | 'excl';

interface ItemFormValues {
  projectCategory: BoqProjectCategory;
  unitProjectId: string;
  sectionCode?: string;
  sectionName?: string;
  itemName: string;
  itemFeature?: string;
  unit?: string;
  quantity?: number | null;
  taxRate?: number | null;
  priceMode: PriceMode;
  unitPriceTaxIncl?: number | null;
  unitPriceTaxExcl?: number | null;
}

/** 前端仅用于即时联动展示，最终数值仍以后端十进制计算为准。 */
function calcCounterpart(
  value: number | null | undefined,
  rate: number | null | undefined,
  fromIncl: boolean,
): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const percent = rate === null || rate === undefined || Number.isNaN(rate) ? 0 : Number(rate);
  const factor = 1 + percent / 100;
  if (factor <= 0) return null;
  const raw = fromIncl ? value / factor : value * factor;
  return Math.round(raw * 100) / 100;
}

export default function BoqItemsPage() {
  const { message } = App.useApp();
  const { project, members } = useProject();
  const session = useSession();
  const myRole = members.find((m) => m.userId === session.user.id)?.roleCode ?? null;
  const canWrite = myRole === 'PROJECT_LEAD' || myRole === 'COST_ENGINEER';
  const projectActive = project.status === 'ACTIVE';

  const [listData, setListData] = useState<BoqListData | null>(null);
  const [mergedItems, setMergedItems] = useState<BoqItem[]>([]);
  const [importLogs, setImportLogs] = useState<ImportLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('active');
  const [category, setCategory] = useState<BoqProjectCategory>('divisional');
  const [priceMode, setPriceMode] = useState<PriceMode>('incl');
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);

  // 单项工程与收入建安税率
  const [unitProjects, setUnitProjects] = useState<UnitProject[]>([]);
  const [revenueTaxRate, setRevenueTaxRate] = useState('9');

  // 新增/编辑弹窗
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<BoqItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<ItemFormValues>();
  const formPriceMode = (Form.useWatch('priceMode', form) ?? 'incl') as PriceMode;

  // 合并弹窗
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergePrimaryId, setMergePrimaryId] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);

  // 工程量清单（晨曦/福建 XML）导入弹窗
  const [importOpen, setImportOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [xmlFile, setXmlFile] = useState<File | null>(null);
  const [xmlPreview, setXmlPreview] = useState<CxXmlPreviewData | null>(null);
  const [previewCategory, setPreviewCategory] = useState<BoqProjectCategory>('divisional');
  const [xmlUnitProjectId, setXmlUnitProjectId] = useState<string | null>(null);
  const [xmlNewUnitName, setXmlNewUnitName] = useState('');
  const [importMode, setImportMode] = useState<'overwrite' | 'keep'>('overwrite');
  const [batchVoiding, setBatchVoiding] = useState(false);

  const loadRefs = useCallback(async () => {
    try {
      const data = await api.listUnitProjects(project.id);
      setUnitProjects(data.units.filter((u) => u.isActive));
      setRevenueTaxRate(data.revenueTaxRate ?? '9');
    } catch (e) {
      message.error((e as Error).message);
    }
  }, [project.id, message]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listBoqItems(project.id, {
        status: tab === 'merged' ? 'merged' : 'active',
        projectCategory: category,
      });
      if (tab === 'merged') {
        setMergedItems(data.items);
      } else {
        setListData(data);
      }
      if (tab === 'imports') {
        setImportLogs(await api.listBoqImports(project.id));
      }
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [project.id, tab, category, message]);

  useEffect(() => {
    void loadRefs();
  }, [loadRefs]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setSelectedRowKeys([]);
  }, [tab, category, project.id]);

  const items = listData?.items ?? [];

  // 展示层级：单项工程（一级）→ 分部工程（二级）→ 清单项
  const unitGroups = useMemo(() => {
    const order = new Map(unitProjects.map((u, i) => [u.id, i]));
    const map = new Map<
      string,
      { key: string; name: string; items: BoqItem[]; sections: Map<string, BoqItem[]> }
    >();
    for (const item of items) {
      const key = item.unitProjectId ?? '__none__';
      if (!map.has(key)) {
        map.set(key, {
          key,
          name: item.unitProject?.name ?? '未指定单项工程',
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
      .sort((a, b) => (order.get(a.key) ?? 999) - (order.get(b.key) ?? 999))
      .map((group) => ({
        ...group,
        sections: [...group.sections.entries()].map(([name, arr]) => ({ name, items: arr })),
      }));
  }, [items, unitProjects]);

  const selectedItems = useMemo(
    () => items.filter((it) => selectedRowKeys.includes(it.id)),
    [items, selectedRowKeys],
  );

  const mergeKey = (it: BoqItem) => `${it.itemName}||${it.itemFeature ?? ''}||${it.unit ?? ''}`;
  const mergeable = selectedItems.length >= 2 && new Set(selectedItems.map(mergeKey)).size === 1;

  const categoryTotal = (key: BoqProjectCategory) =>
    listData?.byCategory.find((c) => c.projectCategory === key);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      projectCategory: category,
      unitProjectId: unitProjects[0]?.id,
      priceMode: 'incl',
      taxRate: Number(revenueTaxRate),
    });
    setEditOpen(true);
  };

  const openEdit = (item: BoqItem) => {
    setEditing(item);
    form.resetFields();
    form.setFieldsValue({
      projectCategory: item.projectCategory,
      unitProjectId: item.unitProjectId ?? undefined,
      sectionCode: item.sectionCode ?? undefined,
      sectionName: item.sectionName ?? undefined,
      itemName: item.itemName,
      itemFeature: item.itemFeature ?? undefined,
      unit: item.unit ?? undefined,
      quantity: item.quantity != null ? Number(item.quantity) : null,
      taxRate: item.taxRate != null ? Number(item.taxRate) : Number(revenueTaxRate),
      priceMode: 'incl',
      unitPriceTaxIncl: item.unitPriceTaxIncl != null ? Number(item.unitPriceTaxIncl) : null,
      unitPriceTaxExcl: item.unitPriceTaxExcl != null ? Number(item.unitPriceTaxExcl) : null,
    });
    setEditOpen(true);
  };

  /** 以当前录入口径的单价为准，反算另一口径并回填。 */
  const syncCounterpart = (rate?: number | null, mode?: PriceMode) => {
    const useMode = mode ?? formPriceMode;
    const useRate = rate ?? (form.getFieldValue('taxRate') as number | null);
    if (useMode === 'incl') {
      const incl = form.getFieldValue('unitPriceTaxIncl') as number | null;
      form.setFieldValue('unitPriceTaxExcl', calcCounterpart(incl, useRate, true));
    } else {
      const excl = form.getFieldValue('unitPriceTaxExcl') as number | null;
      form.setFieldValue('unitPriceTaxIncl', calcCounterpart(excl, useRate, false));
    }
  };

  const saveItem = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const enteredPrice = values.priceMode === 'incl' ? values.unitPriceTaxIncl : values.unitPriceTaxExcl;
      const payload = {
        projectCategory: values.projectCategory,
        unitProjectId: values.unitProjectId,
        sectionCode: values.sectionCode || null,
        sectionName: values.sectionName || null,
        itemName: values.itemName,
        itemFeature: values.itemFeature || null,
        unit: values.unit || null,
        quantity: values.quantity != null ? String(values.quantity) : null,
        taxRate: values.taxRate != null ? String(values.taxRate) : null,
        priceTaxIncl: values.priceMode === 'incl',
        unitPrice: enteredPrice != null ? String(enteredPrice) : null,
      };
      if (editing) {
        await api.updateBoqItem(project.id, editing.id, payload);
        message.success('清单项已更新');
      } else {
        await api.createBoqItem(project.id, { ...payload, idempotencyKey: newIdempotencyKey() });
        message.success('清单项已新增');
      }
      setEditOpen(false);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const doVoid = async (item: BoqItem) => {
    try {
      await api.voidBoqItem(project.id, item.id);
      message.success(`清单项「${item.itemName}」已作废`);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const doBatchVoid = async () => {
    const ids = selectedItems.map((it) => it.id);
    if (ids.length === 0) return;
    setBatchVoiding(true);
    try {
      const result = await api.batchVoidBoqItems(project.id, ids);
      if (result.voided > 0) {
        message.success(
          `已作废 ${result.voided} 条清单项${
            result.skipped.length > 0 ? `，${result.skipped.length} 条因已关联成本被跳过` : ''
          }`,
        );
      } else {
        message.warning(
          `未作废任何清单项${result.skipped.length > 0 ? `：${result.skipped.length} 条已关联成本明细` : ''}`,
        );
      }
      setSelectedRowKeys([]);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBatchVoiding(false);
    }
  };

  const openMerge = () => {
    if (!mergeable) return;
    setMergePrimaryId(selectedItems[0]?.id ?? null);
    setMergeOpen(true);
  };

  const doMerge = async () => {
    if (!mergePrimaryId) {
      message.warning('请选择合并后保留的主记录');
      return;
    }
    setMerging(true);
    try {
      await api.mergeBoqItems(project.id, {
        itemIds: selectedItems.map((it) => it.id),
        primaryId: mergePrimaryId,
      });
      message.success('合并完成：工程量与合价已汇总到主记录');
      setMergeOpen(false);
      setSelectedRowKeys([]);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setMerging(false);
    }
  };

  // ============ 工程量清单（晨曦/福建 XML）导入 ============
  const resetImport = () => {
    setXmlFile(null);
    setXmlPreview(null);
    setPreviewCategory('divisional');
    setXmlUnitProjectId(null);
    setXmlNewUnitName('');
    setImportMode('overwrite');
  };

  const doXmlPreview = async (file: File) => {
    setPreviewing(true);
    try {
      const result = await api.previewBoqXml(project.id, file);
      setXmlFile(file);
      setXmlPreview(result);
      const xmlUnitName = result.unitProjectNames[0] ?? '';
      const matched = unitProjects.find((u) => u.name === xmlUnitName);
      setXmlUnitProjectId(matched?.id ?? null);
      setXmlNewUnitName(matched ? '' : xmlUnitName);
      const firstCategory = (['divisional', 'measure', 'other'] as BoqProjectCategory[]).find(
        (key) => result.sections[key].length > 0,
      );
      setPreviewCategory(firstCategory ?? 'divisional');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setPreviewing(false);
    }
    return false;
  };

  const doXmlConfirm = async () => {
    if (!xmlPreview || !xmlFile) return;
    if (!xmlUnitProjectId && !xmlNewUnitName.trim()) {
      message.warning('请选择已有单项工程，或填写新建单项工程名称');
      return;
    }
    setConfirming(true);
    try {
      const result = await api.confirmBoqXml(project.id, {
        file: xmlFile,
        logId: xmlPreview.logId,
        unitProjectId: xmlUnitProjectId ?? undefined,
        newUnitProjectName: xmlUnitProjectId ? undefined : xmlNewUnitName.trim() || undefined,
        mode: importMode,
      });
      message.success(
        `已导入到「${result.unitProject?.name ?? '单项工程'}」：新增 ${result.created} 条，覆盖 ${result.updated} 条，保留 ${result.kept} 条${
          result.skipped > 0 ? `，跳过 ${result.skipped} 条无效数据` : ''
        }`,
      );
      setImportOpen(false);
      resetImport();
      await loadRefs();
      await load();
      if (tab === 'imports') setImportLogs(await api.listBoqImports(project.id));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setConfirming(false);
    }
  };

  const priceLabel = priceMode === 'incl' ? '含税' : '不含税';
  const priceOf = (item: BoqItem) =>
    priceMode === 'incl' ? item.unitPriceTaxIncl : item.unitPriceTaxExcl;
  const amountOf = (item: BoqItem) =>
    priceMode === 'incl' ? item.amountTaxIncl : item.amountTaxExcl;

  /** 小计（前端仅展示用，精确值以后端十进制为准）。 */
  const sumAmount = (rows: BoqItem[]) =>
    rows.reduce((acc, row) => acc + Number(amountOf(row) ?? 0), 0).toFixed(2);

  const expandable: TableProps<BoqItem>['expandable'] = {
    rowExpandable: (item) => (item.mergedCount ?? 0) > 0,
    expandedRowRender: (item) => (
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={item.mergedItems ?? []}
        columns={[
          { title: '被合并明细', dataIndex: 'itemName' },
          {
            title: '单项工程',
            key: 'unitProject',
            width: 140,
            render: (_, row) => row.unitProject?.name ?? '—',
          },
          { title: '工程量', dataIndex: 'quantity', width: 120, align: 'right', render: (v) => fmtQty(v) },
          {
            title: `合价（${priceLabel}）`,
            key: 'amount',
            width: 140,
            align: 'right',
            render: (_, row) => fmtMoney(priceMode === 'incl' ? row.amountTaxIncl : row.amountTaxExcl),
          },
        ]}
      />
    ),
  };

  const columns: ColumnsType<BoqItem> = [
    {
      title: '清单项名称及特征',
      dataIndex: 'itemName',
      width: 240,
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
      title: '工程量',
      dataIndex: 'quantity',
      width: 100,
      align: 'right',
      render: (v) => fmtQty(v),
    },
    {
      title: `综合单价（${priceLabel}）`,
      key: 'unitPrice',
      width: 120,
      align: 'right',
      render: (_, item) => fmtMoney(priceOf(item)),
    },
    {
      title: `合价（${priceLabel}）`,
      key: 'amount',
      width: 130,
      align: 'right',
      render: (_, item) => fmtMoney(amountOf(item)),
    },
    {
      title: '标记',
      key: 'marks',
      width: 110,
      render: (_, item) => (
        <Space size={4} wrap>
          {item.hasCost && <Tag color="blue">已关联成本</Tag>}
          {(item.mergedCount ?? 0) > 0 && <Tag color="processing">含{item.mergedCount}条合并</Tag>}
        </Space>
      ),
    },
    ...(canWrite && projectActive
      ? [
          {
            title: '操作',
            key: 'op',
            width: 140,
            render: (_: unknown, item: BoqItem) => (
              <Space size={4}>
                <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(item)}>
                  编辑
                </Button>
                {item.hasCost ? (
                  <Tooltip title="已被成本明细关联，无法作废">
                    <Button size="small" danger disabled>
                      作废
                    </Button>
                  </Tooltip>
                ) : (
                  <Popconfirm
                    title="作废该清单项？"
                    description="作废后不再参与汇总，历史记录保留可追溯。"
                    onConfirm={() => void doVoid(item)}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />}>
                      作废
                    </Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          } satisfies ColumnsType<BoqItem>[number],
        ]
      : []),
  ];

  const mergedColumns: ColumnsType<BoqItem> = [
    { title: '分部分类', dataIndex: 'sectionName', width: 140, render: (v) => v ?? '—' },
    { title: '项目名称', dataIndex: 'itemName', width: 180 },
    {
      title: '单项工程',
      key: 'unitProject',
      width: 110,
      render: (_, item) => item.unitProject?.name ?? '—',
    },
    { title: '项目特征', dataIndex: 'itemFeature', ellipsis: true, render: (v) => v ?? '—' },
    { title: '单位', dataIndex: 'unit', width: 70, render: (v) => v ?? '—' },
    { title: '工程量', dataIndex: 'quantity', width: 110, align: 'right', render: (v) => fmtQty(v) },
    {
      title: `合价（${priceLabel}）`,
      key: 'amount',
      width: 120,
      align: 'right',
      render: (_, item) => fmtMoney(amountOf(item)),
    },
    { title: '合并时间', dataIndex: 'updatedAt', width: 160, render: (v) => fmtDateTime(v) },
  ];

  const logColumns: ColumnsType<ImportLogItem> = [
    { title: '文件名', dataIndex: 'fileName', width: 220, ellipsis: true },
    {
      title: '状态',
      dataIndex: 'status',
      width: 170,
      render: (v: string) => <Tag>{BOQ_IMPORT_STATUS_LABELS[v] ?? v}</Tag>,
    },
    { title: '备注', dataIndex: 'note', ellipsis: true, render: (v) => v ?? '—' },
    { title: '上传人', dataIndex: 'createdByName', width: 110, render: (v) => v ?? '—' },
    { title: '时间', dataIndex: 'createdAt', width: 170, render: (v) => fmtDateTime(v) },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="合同清单"
        extra={
          <Space>
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
            {canWrite && projectActive && (
              <>
                <Button icon={<ImportOutlined />} onClick={() => { resetImport(); setImportOpen(true); }}>
                  导入工程量清单（晨曦/福建 XML）
                </Button>
                <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                  手动新增
                </Button>
              </>
            )}
          </Space>
        }
      >
        <Space size={32} style={{ marginBottom: 16 }}>
          <Statistic
            title={`${BOQ_PROJECT_CATEGORY_LABELS[category]}（${priceLabel}）`}
            value={fmtMoney(
              categoryTotal(category)?.[priceMode === 'incl' ? 'amountTaxIncl' : 'amountTaxExcl'] ?? '0',
            )}
            prefix="¥"
          />
          <Statistic title="有效清单项" value={categoryTotal(category)?.count ?? 0} suffix="条" />
          <Statistic
            title="本项目全部有效清单（含税）"
            value={fmtMoney(listData?.totals.amountTaxIncl ?? '0.00')}
            prefix="¥"
          />
        </Space>

        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: 'active',
              label: '清单列表',
              children: (
                <>
                  <Space size={12} style={{ marginBottom: 12 }} wrap>
                    {BOQ_PROJECT_CATEGORY_KEYS.map((key) => {
                      const total = categoryTotal(key);
                      const amount =
                        priceMode === 'incl' ? total?.amountTaxIncl : total?.amountTaxExcl;
                      return (
                        <Button
                          key={key}
                          size="large"
                          type={category === key ? 'primary' : 'default'}
                          onClick={() => setCategory(key)}
                          style={{ minWidth: 190, height: 56, textAlign: 'left' }}
                        >
                          <div style={{ fontWeight: 600 }}>{BOQ_PROJECT_CATEGORY_LABELS[key]}</div>
                          <div style={{ fontSize: 12, opacity: 0.85 }}>
                            {total?.count ?? 0} 条 · ¥{fmtMoney(amount ?? '0')}
                          </div>
                        </Button>
                      );
                    })}
                  </Space>

                  {canWrite && projectActive && (
                    <Space style={{ marginBottom: 12 }}>
                      <Button icon={<MergeCellsOutlined />} disabled={!mergeable} onClick={openMerge}>
                        合并选中（{selectedItems.length}）
                      </Button>
                      <Popconfirm
                        title={`批量作废选中的 ${selectedItems.length} 条清单项？`}
                        description="作废后不再参与汇总，历史记录保留可追溯；已被成本明细关联的将自动跳过。"
                        okText="确认作废"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => void doBatchVoid()}
                        disabled={selectedItems.length === 0}
                      >
                        <Button
                          danger
                          icon={<DeleteOutlined />}
                          disabled={selectedItems.length === 0}
                          loading={batchVoiding}
                        >
                          批量作废（{selectedItems.length}）
                        </Button>
                      </Popconfirm>
                      {selectedItems.length >= 2 && !mergeable && (
                        <Text type="warning" style={{ fontSize: 12 }}>
                          仅项目名称、特征、单位完全一致的清单项可合并
                        </Text>
                      )}
                    </Space>
                  )}

                  <Collapse
                    defaultActiveKey={unitGroups.map((g) => g.key)}
                    items={unitGroups.map((group) => ({
                      key: group.key,
                      label: (
                        <Space size={10}>
                          <Text strong>{group.name}</Text>
                          <Text type="secondary">
                            {group.items.length} 条 · 合价（{priceLabel}）¥{fmtMoney(sumAmount(group.items))}
                          </Text>
                        </Space>
                      ),
                      children: (
                        <Collapse
                          ghost
                          size="small"
                          defaultActiveKey={group.sections.slice(0, 1).map((s) => s.name)}
                          items={group.sections.map((section) => ({
                            key: section.name,
                            label: `${section.name}（${section.items.length} 条 · ¥${fmtMoney(
                              sumAmount(section.items),
                            )}）`,
                            children: (
                              <Table<BoqItem>
                                rowKey="id"
                                size="small"
                                loading={loading}
                                columns={columns}
                                dataSource={section.items}
                                pagination={false}
                                scroll={{ x: 860 }}
                                expandable={expandable}
                                rowSelection={
                                  canWrite && projectActive
                                    ? {
                                        selectedRowKeys,
                                        onChange: (keys) => setSelectedRowKeys(keys),
                                      }
                                    : undefined
                                }
                                summary={() => (
                                  <Table.Summary fixed>
                                    <Table.Summary.Row>
                                      {columns.map((_, index) => (
                                        <Table.Summary.Cell
                                          key={index}
                                          index={index}
                                          align={index === 4 ? 'right' : undefined}
                                        >
                                          {index === 0 ? (
                                            <Text strong>本分部小计</Text>
                                          ) : index === 4 ? (
                                            <Text strong>¥{fmtMoney(sumAmount(section.items))}</Text>
                                          ) : null}
                                        </Table.Summary.Cell>
                                      ))}
                                    </Table.Summary.Row>
                                  </Table.Summary>
                                )}
                              />
                            ),
                          }))}
                        />
                      ),
                    }))}
                  />
                  {!loading && unitGroups.length === 0 && (
                    <Alert
                      type="info"
                      showIcon
                      message={`「${BOQ_PROJECT_CATEGORY_LABELS[category]}」暂无清单项`}
                      description="可手动新增、导入晨曦/福建 XML，或切换上方其它分类查看。"
                    />
                  )}
                </>
              ),
            },
            {
              key: 'merged',
              label: '已合并记录',
              children: (
                <Table<BoqItem>
                  rowKey="id"
                  size="small"
                  loading={loading}
                  columns={mergedColumns}
                  dataSource={mergedItems}
                  pagination={{ pageSize: 20 }}
                />
              ),
            },
            {
              key: 'imports',
              label: '导入日志',
              children: (
                <Table<ImportLogItem>
                  rowKey="id"
                  size="small"
                  loading={loading}
                  columns={logColumns}
                  dataSource={importLogs}
                  pagination={{ pageSize: 20 }}
                />
              ),
            },
          ]}
        />
      </Card>

      {/* 新增/编辑弹窗 */}
      <Modal
        title={editing ? '编辑清单项' : '新增清单项'}
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={() => void saveItem()}
        confirmLoading={saving}
        width={680}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Space.Compact block>
            <Form.Item
              name="projectCategory"
              label="清单分类"
              style={{ width: '50%', marginRight: 8 }}
              rules={[{ required: true, message: '请选择清单分类' }]}
            >
              <Select
                options={BOQ_PROJECT_CATEGORY_KEYS.map((k) => ({
                  value: k,
                  label: BOQ_PROJECT_CATEGORY_LABELS[k],
                }))}
              />
            </Form.Item>
            <Form.Item
              name="unitProjectId"
              label="单项工程"
              style={{ width: '50%' }}
              rules={[{ required: true, message: '请选择单项工程' }]}
            >
              <Select
                placeholder="请选择单项工程"
                options={unitProjects.map((u) => ({ value: u.id, label: u.name }))}
                notFoundContent="请先在「项目设置 - 单项工程」中维护"
              />
            </Form.Item>
          </Space.Compact>
          <Space.Compact block>
            <Form.Item name="sectionCode" label="分部分类编码" style={{ width: '50%', marginRight: 8 }}>
              <Input maxLength={60} placeholder="如 01、0101（可空）" />
            </Form.Item>
            <Form.Item name="sectionName" label="分部分类名称" style={{ width: '50%' }}>
              <Input maxLength={120} placeholder="如 土石方工程" />
            </Form.Item>
          </Space.Compact>
          <Form.Item
            name="itemName"
            label="项目名称"
            rules={[{ required: true, message: '请填写项目名称' }]}
          >
            <Input maxLength={200} placeholder="如 挖一般土方" />
          </Form.Item>
          <Form.Item name="itemFeature" label="项目特征">
            <Input.TextArea rows={2} maxLength={300} placeholder="土壤类别、开挖深度等" />
          </Form.Item>
          <Space.Compact block>
            <Form.Item name="unit" label="单位" style={{ width: '33%', marginRight: 8 }}>
              <Input maxLength={20} placeholder="m³ / m² / 项" />
            </Form.Item>
            <Form.Item name="quantity" label="工程量（最多 3 位小数）" style={{ width: '67%' }}>
              <InputNumber style={{ width: '100%' }} min={0} precision={3} placeholder="如 1200.500" />
            </Form.Item>
          </Space.Compact>

          <Space.Compact block>
            <Form.Item name="priceMode" label="录入方式" style={{ width: '40%', marginRight: 8 }}>
              <Radio.Group
                onChange={(e) => syncCounterpart(form.getFieldValue('taxRate'), e.target.value as PriceMode)}
              >
                <Radio.Button value="incl">含税录入</Radio.Button>
                <Radio.Button value="excl">不含税录入</Radio.Button>
              </Radio.Group>
            </Form.Item>
            <Form.Item
              name="taxRate"
              label="税率（%）"
              style={{ width: '25%', marginRight: 8 }}
              rules={[{ required: true, message: '请填写税率' }]}
            >
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                max={100}
                precision={2}
                onChange={(v) => syncCounterpart(v as number | null)}
              />
            </Form.Item>
          </Space.Compact>

          <Space.Compact block>
            <Form.Item name="unitPriceTaxIncl" label="含税综合单价（2 位小数）" style={{ width: '50%', marginRight: 8 }}>
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                precision={2}
                disabled={formPriceMode === 'excl'}
                onChange={(v) => {
                  if (formPriceMode !== 'incl') return;
                  form.setFieldValue(
                    'unitPriceTaxExcl',
                    calcCounterpart(v as number | null, form.getFieldValue('taxRate') as number | null, true),
                  );
                }}
              />
            </Form.Item>
            <Form.Item name="unitPriceTaxExcl" label="不含税综合单价（2 位小数）" style={{ width: '50%' }}>
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                precision={2}
                disabled={formPriceMode === 'incl'}
                onChange={(v) => {
                  if (formPriceMode !== 'excl') return;
                  form.setFieldValue(
                    'unitPriceTaxIncl',
                    calcCounterpart(v as number | null, form.getFieldValue('taxRate') as number | null, false),
                  );
                }}
              />
            </Form.Item>
          </Space.Compact>

          <Alert
            type="info"
            showIcon
            message="合价 = 工程量 × 综合单价，由后端十进制实时计算（四舍五入 2 位）；工程量最多 3 位小数、单价最多 2 位小数。"
          />
        </Form>
      </Modal>

      {/* 合并弹窗 */}
      <Modal
        title="合并同类清单项"
        open={mergeOpen}
        onCancel={() => setMergeOpen(false)}
        onOk={() => void doMerge()}
        confirmLoading={merging}
        okText="确认合并"
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="合并后仅保留一条主记录（工程量与合价汇总），其余标记为已合并，可展开追溯。"
        />
        <div style={{ marginBottom: 8 }}>请选择合并后保留的主记录：</div>
        <Select
          style={{ width: '100%' }}
          value={mergePrimaryId}
          onChange={setMergePrimaryId}
          options={selectedItems.map((it) => ({
            value: it.id,
            label: `${it.sectionName ?? '未分组'} / ${it.itemName}（工程量 ${fmtQty(it.quantity)}）`,
          }))}
        />
      </Modal>

      {/* 工程量清单（晨曦/福建 XML）导入 */}
      <Modal
        title="导入工程量清单（晨曦/福建 XML）"
        open={importOpen}
        onCancel={() => { setImportOpen(false); resetImport(); }}
        width={1040}
        destroyOnHidden
        footer={
          xmlPreview
            ? [
                <Button key="reset" onClick={() => resetImport()}>
                  重新选择文件
                </Button>,
                <Button key="ok" type="primary" loading={confirming} onClick={() => void doXmlConfirm()}>
                  确认导入（{xmlPreview.summary.total.count} 条）
                </Button>,
              ]
            : null
        }
      >
        <Upload.Dragger
          accept=".xml"
          maxCount={1}
          showUploadList={false}
          beforeUpload={(file) => { void doXmlPreview(file); return false; }}
          disabled={previewing}
        >
          <p className="ant-upload-drag-icon"><InboxOutlined /></p>
          <p className="ant-upload-text">点击或拖拽晨曦/福建计价导出的 XML 文件</p>
          <p className="ant-upload-hint">
            识别《福建省房屋建筑与市政基础设施工程造价电子数据交换导则 2017》XML（VER 2.x），
            自动拆分「分部分项工程费 / 措施项目费 / 其他项目费」；文件不超过 20MB。
          </p>
        </Upload.Dragger>

        {xmlPreview && (
          <>
            <Descriptions
              size="small"
              bordered
              column={3}
              style={{ marginTop: 16 }}
              items={[
                { key: 'name', label: '工程名称', children: xmlPreview.project.name || '—' },
                { key: 'profession', label: '专业类别', children: xmlPreview.project.profession || '—' },
                { key: 'bidType', label: '标书类别', children: xmlPreview.project.bidType || '—' },
                { key: 'priceMethod', label: '计价方式', children: xmlPreview.project.priceMethod || '—' },
                {
                  key: 'rule',
                  label: '计价规则',
                  children: `${xmlPreview.project.ruleName || '—'}${
                    xmlPreview.project.version ? `（VER ${xmlPreview.project.version}）` : ''
                  }`,
                },
                {
                  key: 'file',
                  label: '文件',
                  children: <Text ellipsis style={{ maxWidth: 260 }} title={xmlPreview.fileName}>{xmlPreview.fileName}</Text>,
                },
              ]}
            />

            <Space size={32} style={{ margin: '16px 0' }} wrap>
              {BOQ_PROJECT_CATEGORY_KEYS.map((key) => (
                <Statistic
                  key={key}
                  title={`${BOQ_PROJECT_CATEGORY_LABELS[key]}（含税）`}
                  value={fmtMoney(xmlPreview.summary[key].amount)}
                  prefix="¥"
                  suffix={`/ ${xmlPreview.summary[key].count} 条`}
                />
              ))}
              <Statistic
                title="清单合计（含税）"
                value={fmtMoney(xmlPreview.summary.total.amount)}
                prefix="¥"
                valueStyle={{ fontWeight: 600 }}
              />
            </Space>

            {xmlPreview.existingItemCount > 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message={`本项目已有 ${xmlPreview.existingItemCount} 条有效清单项`}
                description="本次导入为追加写入，不会覆盖或删除原有清单项；如需重来，请先在清单列表中作废后再导入。"
              />
            )}

            <Space direction="vertical" size={8} style={{ width: '100%', marginBottom: 12 }}>
              <Text strong>导入到单项工程</Text>
              <Select
                style={{ width: '100%' }}
                allowClear
                placeholder="选择已有单项工程（选择后忽略下方新建名称）"
                value={xmlUnitProjectId ?? undefined}
                onChange={(value) => setXmlUnitProjectId(value ?? null)}
                options={unitProjects.map((u) => ({ value: u.id, label: u.name }))}
              />
              {!xmlUnitProjectId && (
                <Input
                  style={{ width: '100%' }}
                  maxLength={60}
                  placeholder="新建单项工程名称（默认取文件内单项工程名）"
                  value={xmlNewUnitName}
                  onChange={(e) => setXmlNewUnitName(e.target.value)}
                />
              )}
            </Space>

            <Space direction="vertical" size={8} style={{ width: '100%', marginBottom: 12 }}>
              <Text strong>重复清单处理（清单名称 + 项目特征相同）</Text>
              <Radio.Group value={importMode} onChange={(e) => setImportMode(e.target.value as 'overwrite' | 'keep')}>
                <Radio value="overwrite">覆盖原数据：更新原清单的单位、工程量、综合单价与合价</Radio>
                <Radio value="keep">保留原数据：不修改原清单，仅新增未出现过的项目</Radio>
              </Radio.Group>
              {xmlPreview.duplicateCount > 0 ? (
                <Text type="warning">
                  检测到 {xmlPreview.duplicateCount} 条与本项目已有清单同名同特征，将按上述方式处理。
                </Text>
              ) : (
                <Text type="secondary">未检测到同名同特征清单，本次全部为新增项。</Text>
              )}
            </Space>

            <Tabs
              activeKey={previewCategory}
              onChange={(key) => setPreviewCategory(key as BoqProjectCategory)}
              items={BOQ_PROJECT_CATEGORY_KEYS.map((key) => ({
                key,
                label: `${BOQ_PROJECT_CATEGORY_LABELS[key]}（${xmlPreview.summary[key].count}）`,
                children:
                  xmlPreview.sections[key].length === 0 ? (
                    <Alert type="info" showIcon message="该分类无清单项" />
                  ) : (
                    <Collapse
                      size="small"
                      defaultActiveKey={xmlPreview.sections[key].slice(0, 3).map((s) => s.name)}
                      items={xmlPreview.sections[key].map((section) => ({
                        key: section.name,
                        label: `${section.name}（${section.items.length} 条 · ¥${fmtMoney(section.total)}）`,
                        children: (
                          <Table
                            size="small"
                            rowKey={(row) => `${row.code}-${row.name}-${row.unit}-${row.quantity}`}
                            pagination={false}
                            scroll={{ x: 780, y: 300 }}
                            dataSource={section.items}
                            columns={[
                              { title: '编码', dataIndex: 'code', width: 120, render: (v) => v || '—' },
                              {
                                title: '清单项名称及特征',
                                dataIndex: 'name',
                                render: (_, row) => (
                                  <div>
                                    <div>{row.name}</div>
                                    {row.feature && (
                                      <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                                        {row.feature}
                                      </Text>
                                    )}
                                  </div>
                                ),
                              },
                              { title: '单位', dataIndex: 'unit', width: 70, render: (v) => v ?? '—' },
                              {
                                title: '工程量',
                                dataIndex: 'quantity',
                                width: 100,
                                align: 'right',
                                render: (v) => fmtQty(v),
                              },
                              {
                                title: '综合单价（含税）',
                                dataIndex: 'unitPrice',
                                width: 120,
                                align: 'right',
                                render: (v) => fmtMoney(v),
                              },
                              {
                                title: '合价（含税）',
                                dataIndex: 'amount',
                                width: 130,
                                align: 'right',
                                render: (v) => fmtMoney(v),
                              },
                            ]}
                          />
                        ),
                      }))}
                    />
                  ),
              }))}
            />
          </>
        )}
      </Modal>
    </Space>
  );
}
