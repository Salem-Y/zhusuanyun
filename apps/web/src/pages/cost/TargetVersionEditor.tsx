import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  DatePicker,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
  App as AntApp,
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import {
  api,
  type BoqItem,
  type ExpenseCategory,
  type PricingMethod,
  type TargetLineInput,
  type TargetVersion,
  type UnitProject,
} from '../../api';
import { useSession } from '../../App';
import { useProject } from '../../project/ProjectContext';
import {
  AUDIT_ACTION_LABELS,
  EXPENSE_CATEGORY_LABELS,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  newIdempotencyKey,
  PRICING_METHOD_LABELS,
  TARGET_STATUS_COLORS,
  TARGET_STATUS_LABELS,
} from './labels';

interface EditLine {
  key: string;
  boqItemId?: string | null;
  unitProjectId?: string | null;
  category?: ExpenseCategory;
  summary: string;
  pricingMethod: PricingMethod;
  quantity?: string | null;
  unit?: string | null;
  unitPrice?: string | null;
  unitPriceTaxIncl?: string | null;
  unitPriceTaxExcl?: string | null;
  taxRate?: string | null;
  priceTaxIncl?: boolean;
  amount?: string | null;
  basisNote?: string | null;
}

let lineSeq = 0;
const nextKey = () => `L${Date.now()}_${lineSeq++}`;

/** 新建目标版本（含基于原批准版本的调整）。 */
export function CreateVersionModal({
  open,
  baseVersion,
  caliberNote,
  onClose,
  onCreated,
}: {
  open: boolean;
  baseVersion?: TargetVersion | null;
  caliberNote?: string;
  onClose: () => void;
  onCreated: (versionId: string) => void;
}) {
  const { project } = useProject();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [idemKey, setIdemKey] = useState(newIdempotencyKey());

  useEffect(() => {
    if (open) {
      setIdemKey(newIdempotencyKey());
      form.setFieldsValue({
        versionName: baseVersion ? `${baseVersion.versionName}-调整` : '',
        description: '',
        caliberText: caliberNote ?? '',
        effectiveDate: null,
        adjustReason: '',
      });
    }
  }, [open, baseVersion, caliberNote, form]);

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      const created = await api.createTargetVersion(project.id, {
        versionName: values.versionName.trim(),
        description: values.description?.trim() || undefined,
        caliberText: values.caliberText?.trim() || undefined,
        effectiveDate: values.effectiveDate ? (values.effectiveDate as Dayjs).format('YYYY-MM-DD') : undefined,
        baseVersionId: baseVersion?.id,
        adjustReason: baseVersion ? values.adjustReason?.trim() : undefined,
        idempotencyKey: idemKey,
      });
      message.success(baseVersion ? '已基于原批准版本生成调整草稿' : '目标草稿已创建，请继续编辑明细');
      onClose();
      onCreated(created.id);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={baseVersion ? `调整目标 · 基于「${baseVersion.versionName}」` : '编制目标成本'}
      open={open}
      onOk={submit}
      onCancel={onClose}
      okText={baseVersion ? '生成调整草稿' : '创建草稿'}
      cancelText="取消"
      confirmLoading={submitting}
      destroyOnHidden
    >
      {baseVersion && (
        <Alert
          style={{ marginBottom: 12 }}
          type="info"
          showIcon
          message={`原批准版本金额 ${fmtMoney(baseVersion.totalAmount)} 元，调整草稿将复制其明细`}
          description="批准前可随时修改明细；批准时系统会核对原版本仍为当前适用版本，防止覆盖他人更新。"
        />
      )}
      <Form form={form} layout="vertical">
        <Form.Item name="versionName" label="版本名称" rules={[{ required: true, message: '请填写版本名称' }, { max: 60 }]}>
          <Input placeholder="如 2026 年初始目标" />
        </Form.Item>
        {baseVersion && (
          <Form.Item
            name="adjustReason"
            label="调整原因"
            rules={[{ required: true, message: '调整必须填写原因' }, { max: 500 }]}
          >
            <Input.TextArea rows={2} placeholder="说明本次调整的业务原因" />
          </Form.Item>
        )}
        <Form.Item name="description" label="编制说明" rules={[{ max: 500 }]}>
          <Input.TextArea rows={2} />
        </Form.Item>
        <Form.Item name="caliberText" label="核算口径" rules={[{ max: 1000 }]}>
          <Input.TextArea rows={2} placeholder="默认沿用项目核算口径说明，可按版本补充" />
        </Form.Item>
        <Form.Item name="effectiveDate" label="适用日期">
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** 目标版本抽屉：草稿可编辑明细并提交；已提交由负责人批准/退回；已批准只读。 */
export function VersionDrawer({
  versionId,
  onClose,
  onChanged,
}: {
  versionId: string | null;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const { project, members } = useProject();
  const session = useSession();
  const { message } = AntApp.useApp();

  const [version, setVersion] = useState<(TargetVersion & { lines: EditLine[] }) | null>(null);
  const [raw, setRaw] = useState<Awaited<ReturnType<typeof api.getTargetVersion>> | null>(null);
  const [boqItems, setBoqItems] = useState<BoqItem[]>([]);
  const [unitProjects, setUnitProjects] = useState<UnitProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [headForm] = Form.useForm();
  const [approveOpen, setApproveOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [decisionComment, setDecisionComment] = useState('');

  const myProjectRole = members.find((m) => m.userId === session.user.id)?.roleCode;
  const isCostEngineer = myProjectRole === 'COST_ENGINEER';
  const isLead = myProjectRole === 'PROJECT_LEAD';

  const load = useCallback(async () => {
    if (!versionId) return;
    setLoading(true);
    try {
      const [detail, boqData, unitData] = await Promise.all([
        api.getTargetVersion(project.id, versionId),
        api.listBoqItems(project.id),
        api.listUnitProjects(project.id),
      ]);
      setRaw(detail);
      setBoqItems(boqData.items);
      setUnitProjects(unitData.units.filter((u) => u.isActive));
      headForm.setFieldsValue({
        versionName: detail.versionName,
        description: detail.description ?? '',
        caliberText: detail.caliberText ?? '',
        effectiveDate: detail.effectiveDate ? dayjs(detail.effectiveDate) : null,
      });
      setVersion({
        ...detail,
        lines: detail.lines.map((l) => ({
          key: l.id,
          boqItemId: l.boqItemId,
          unitProjectId: l.unitProjectId,
          category: l.category,
          summary: l.summary,
          pricingMethod: l.pricingMethod,
          quantity: l.quantity,
          unit: l.unit,
          unitPrice: l.unitPrice,
          unitPriceTaxIncl: l.unitPriceTaxIncl,
          unitPriceTaxExcl: l.unitPriceTaxExcl,
          taxRate: l.taxRate,
          priceTaxIncl: l.priceTaxIncl ?? true,
          amount: l.amount,
          basisNote: l.basisNote,
        })),
      });
    } catch (e) {
      message.error((e as Error).message);
      onClose();
    } finally {
      setLoading(false);
    }
  }, [versionId, project.id, headForm, message, onClose]);

  useEffect(() => {
    void load();
  }, [load]);

  const editable =
    !!version && ['DRAFT', 'RETURNED'].includes(version.status) && version.createdById === session.user.id && isCostEngineer;

  const boqOptions = useMemo(
    () =>
      boqItems.map((b) => ({
        value: b.id,
        label: `${b.sectionName ? `[${b.sectionName}] ` : ''}${b.itemName}${b.unit ? `（${b.unit}）` : ''}`,
      })),
    [boqItems],
  );
  const categoryOptions = Object.entries(EXPENSE_CATEGORY_LABELS).map(([value, label]) => ({ value, label }));

  const updateLine = (key: string, patch: Partial<EditLine>) => {
    setVersion((v) => (v ? { ...v, lines: v.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) } : v));
  };

  const previewAmount = (line: EditLine): string => {
    if (line.pricingMethod === 'QTY_PRICE') {
      const q = Number(line.quantity);
      const p = Number(line.unitPrice);
      if (!Number.isFinite(q) || !Number.isFinite(p)) return '—';
      return fmtMoney((Math.round(q * p * 100) / 100).toFixed(2));
    }
    return line.amount ? fmtMoney(line.amount) : '—';
  };

  /** 展示另一口径单价（前端即时反算，仅供录入参考，后端会重新计算）。 */
  const counterpartPrice = (line: EditLine): string | null => {
    if (!line.unitPrice || line.unitPrice === '') return null;
    const price = Number(line.unitPrice);
    if (!Number.isFinite(price)) return null;
    const rate = line.taxRate != null && line.taxRate !== '' ? Number(line.taxRate) : 0;
    const factor = 1 + rate / 100;
    if (factor <= 0) return null;
    const fromIncl = line.priceTaxIncl !== false;
    const raw = fromIncl ? price / factor : price * factor;
    return (Math.round(raw * 100) / 100).toFixed(2);
  };

  const save = async (): Promise<boolean> => {
    if (!version) return false;
    const head = await headForm.validateFields();
    for (let i = 0; i < version.lines.length; i++) {
      const l = version.lines[i];
      if (!l.category || !l.summary?.trim()) {
        message.error(`第 ${i + 1} 行：请选择费用类别并填写摘要`);
        return false;
      }
      if (!l.boqItemId && !l.unitProjectId) {
        message.error(`第 ${i + 1} 行：未关联清单项时必须选择单项工程`);
        return false;
      }
    }
    setSaving(true);
    try {
      await api.updateTargetVersion(project.id, version.id, {
        versionName: head.versionName.trim(),
        description: head.description?.trim() ?? '',
        caliberText: head.caliberText?.trim() ?? '',
        effectiveDate: head.effectiveDate ? (head.effectiveDate as Dayjs).format('YYYY-MM-DD') : null,
      });
      const payload: TargetLineInput[] = version.lines.map((l, i) => ({
        boqItemId: l.boqItemId ?? null,
        unitProjectId: l.unitProjectId ?? null,
        category: l.category!,
        summary: l.summary.trim(),
        pricingMethod: l.pricingMethod,
        quantity: l.pricingMethod === 'QTY_PRICE' ? l.quantity : undefined,
        unit: l.unit ?? undefined,
        unitPrice: l.pricingMethod === 'QTY_PRICE' ? l.unitPrice : undefined,
        amount: l.pricingMethod === 'LUMP_SUM' ? l.amount : undefined,
        taxRate: l.taxRate ?? undefined,
        priceTaxIncl: l.priceTaxIncl ?? true,
        basisNote: l.basisNote ?? undefined,
        sortOrder: i,
      }));
      await api.saveTargetLines(project.id, version.id, payload);
      message.success('草稿已保存（金额以后端十进制计算为准）');
      await load();
      await onChanged();
      return true;
    } catch (e) {
      message.error((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const submit = async () => {
    if (!version) return;
    const ok = await save();
    if (!ok) return;
    try {
      await api.submitTargetVersion(project.id, version.id);
      message.success('已提交，等待项目负责人批准');
      await load();
      await onChanged();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const decide = async (kind: 'approve' | 'return') => {
    if (!version) return;
    if (kind === 'return' && !decisionComment.trim()) {
      message.error('退回必须填写意见');
      return;
    }
    setSaving(true);
    try {
      if (kind === 'approve') await api.approveTargetVersion(project.id, version.id, decisionComment.trim() || undefined);
      else await api.returnTargetVersion(project.id, version.id, decisionComment.trim());
      message.success(kind === 'approve' ? '已批准，成为当前适用目标版本' : '已退回，编制人可修改后重新提交');
      setApproveOpen(false);
      setReturnOpen(false);
      setDecisionComment('');
      await load();
      await onChanged();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const removeDraft = async () => {
    if (!version) return;
    try {
      await api.deleteTargetVersion(project.id, version.id);
      message.success('草稿已删除');
      onClose();
      await onChanged();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const linesTotal = (version?.lines ?? []).reduce((acc, l) => {
    const n = Number(l.pricingMethod === 'QTY_PRICE' ? Number(l.quantity) * Number(l.unitPrice) : l.amount);
    return acc + (Number.isFinite(n) ? n : 0);
  }, 0);

  const diffVsBase =
    raw?.baseVersion && version
      ? Number(version.totalAmount) - Number(raw.baseVersion.totalAmount)
      : null;

  return (
    <Drawer
      title={
        version ? (
          <Space>
            <span>{version.versionName}</span>
            <Tag color={TARGET_STATUS_COLORS[version.status]}>{TARGET_STATUS_LABELS[version.status]}</Tag>
            {version.isCurrent && <Tag color="green">当前适用</Tag>}
            {version.isAdjustment && <Tag color="purple">调整版本</Tag>}
          </Space>
        ) : (
          '目标版本'
        )
      }
      width={1080}
      open={!!versionId}
      onClose={onClose}
      loading={loading}
      extra={
        <Space>
          {editable && (
            <>
              <Button onClick={save} loading={saving}>
                保存草稿
              </Button>
              <Popconfirm title="提交后将不能直接编辑，需负责人批准" onConfirm={submit}>
                <Button type="primary" loading={saving}>
                  保存并提交
                </Button>
              </Popconfirm>
              <Popconfirm title="删除该草稿？" onConfirm={removeDraft}>
                <Button danger>删除草稿</Button>
              </Popconfirm>
            </>
          )}
          {isLead && version?.status === 'SUBMITTED' && (
            <>
              <Button type="primary" onClick={() => setApproveOpen(true)}>
                批准
              </Button>
              <Button danger onClick={() => setReturnOpen(true)}>
                退回
              </Button>
            </>
          )}
        </Space>
      }
    >
      {version && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {version.status === 'SUBMITTED' && (
            <Alert type="info" showIcon message="已提交待批准" description={`提交人：${version.submittedByName ?? '—'} · ${fmtDateTime(version.submittedAt)}；提交后不能直接编辑。`} />
          )}
          {version.status === 'RETURNED' && (
            <Alert type="warning" showIcon message="已退回" description={`${version.decidedByName ?? ''}：${version.decisionComment ?? ''}；可修改后重新提交。`} />
          )}
          {version.status === 'APPROVED' && (
            <Alert type="success" showIcon message="已批准" description="已批准目标金额不可直接编辑；如需变更请在工作台使用「调整目标」生成新版本并重新审批。" />
          )}
          {raw?.baseVersion && diffVsBase !== null && (
            <Alert
              type="info"
              showIcon
              message={`调整对比：原版本「${raw.baseVersion.versionName}」${fmtMoney(String(raw.baseVersion.totalAmount))} 元 → 本版本 ${fmtMoney(version.totalAmount)} 元，差异 ${diffVsBase >= 0 ? '+' : ''}${fmtMoney(diffVsBase.toFixed(2))} 元`}
              description={version.adjustReason ? `调整原因：${version.adjustReason}` : undefined}
            />
          )}

          <Form form={headForm} layout="inline" disabled={!editable} style={{ rowGap: 12 }}>
            <Form.Item name="versionName" label="版本名称" rules={[{ required: true }, { max: 60 }]}>
              <Input style={{ width: 220 }} />
            </Form.Item>
            <Form.Item name="effectiveDate" label="适用日期">
              <DatePicker />
            </Form.Item>
            <Form.Item name="description" label="编制说明" style={{ width: '100%' }}>
              <Input.TextArea rows={1} />
            </Form.Item>
            <Form.Item name="caliberText" label="核算口径" style={{ width: '100%' }}>
              <Input.TextArea rows={1} />
            </Form.Item>
          </Form>

          <div>
            <Space style={{ marginBottom: 8 }} wrap>
              <Typography.Text strong>目标明细（{version.lines.length} 行，合计预览 {fmtMoney(linesTotal.toFixed(2))} 元）</Typography.Text>
              {editable && (
                <>
                  <Button
                    size="small"
                    icon={<PlusOutlined />}
                    onClick={() =>
                      setVersion(
                        (v) =>
                          v && {
                            ...v,
                            lines: [
                              ...v.lines,
                              {
                                key: nextKey(),
                                summary: '',
                                pricingMethod: 'QTY_PRICE',
                                priceTaxIncl: true,
                                // 税率默认取上一条记住的值
                                taxRate: v.lines[v.lines.length - 1]?.taxRate ?? null,
                              },
                            ],
                          },
                      )
                    }
                  >
                    添加行
                  </Button>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    清单项请在「收入与收付款 → 合同清单」维护
                  </Typography.Text>
                </>
              )}
            </Space>
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={version.lines}
              scroll={{ x: 1520 }}
              locale={{ emptyText: '尚无明细行，请点击「添加行」' }}
              columns={[
                {
                  title: '关联清单项（可空）',
                  width: 210,
                  render: (_: unknown, line: EditLine) =>
                    editable ? (
                      <Select
                        size="small"
                        style={{ width: '100%' }}
                        placeholder="搜索选择，可清空"
                        showSearch
                        allowClear
                        optionFilterProp="label"
                        value={line.boqItemId ?? undefined}
                        onChange={(v) => {
                          const boq = boqItems.find((b) => b.id === v);
                          updateLine(line.key, {
                            boqItemId: v ?? null,
                            ...(boq?.unitProjectId ? { unitProjectId: boq.unitProjectId } : {}),
                          });
                        }}
                        options={boqOptions}
                      />
                    ) : (
                      raw?.lines.find((l) => l.id === line.key)?.boqItemName ?? '—'
                    ),
                },
                {
                  title: '单项工程（未关联清单项必选）',
                  width: 150,
                  render: (_: unknown, line: EditLine) =>
                    editable ? (
                      <Select
                        size="small"
                        style={{ width: '100%' }}
                        placeholder="选择"
                        allowClear
                        value={line.unitProjectId ?? undefined}
                        onChange={(v) => updateLine(line.key, { unitProjectId: v ?? null })}
                        options={unitProjects.map((u) => ({ value: u.id, label: u.name }))}
                        notFoundContent="请先在项目设置中维护"
                      />
                    ) : (
                      line.unitProjectId
                        ? unitProjects.find((u) => u.id === line.unitProjectId)?.name ??
                          raw?.lines.find((l) => l.id === line.key)?.unitProjectName ??
                          '—'
                        : '—'
                    ),
                },
                {
                  title: '费用类别（必选）',
                  width: 120,
                  render: (_: unknown, line: EditLine) =>
                    editable ? (
                      <Select
                        size="small"
                        style={{ width: '100%' }}
                        placeholder="必选"
                        value={line.category}
                        onChange={(v) => updateLine(line.key, { category: v as ExpenseCategory })}
                        options={categoryOptions}
                      />
                    ) : (
                      <Tag>{EXPENSE_CATEGORY_LABELS[line.category ?? (raw?.lines.find((l) => l.id === line.key)?.category ?? 'labor')]}</Tag>
                    ),
                },
                {
                  title: '摘要',
                  width: 150,
                  render: (_: unknown, line: EditLine) =>
                    editable ? (
                      <Input size="small" value={line.summary} onChange={(e) => updateLine(line.key, { summary: e.target.value })} />
                    ) : (
                      line.summary
                    ),
                },
                {
                  title: '计价方式',
                  width: 110,
                  render: (_: unknown, line: EditLine) =>
                    editable ? (
                      <Select
                        size="small"
                        value={line.pricingMethod}
                        onChange={(v) => updateLine(line.key, { pricingMethod: v })}
                        options={Object.entries(PRICING_METHOD_LABELS).map(([value, label]) => ({ value, label }))}
                      />
                    ) : (
                      PRICING_METHOD_LABELS[line.pricingMethod]
                    ),
                },
                {
                  title: '数量',
                  width: 100,
                  render: (_: unknown, line: EditLine) =>
                    line.pricingMethod === 'QTY_PRICE' ? (
                      editable ? (
                        <InputNumber size="small" style={{ width: '100%' }} min={0} precision={3} value={line.quantity ? Number(line.quantity) : null} onChange={(v) => updateLine(line.key, { quantity: v?.toString() ?? null })} />
                      ) : (
                        line.quantity
                      )
                    ) : (
                      '—'
                    ),
                },
                {
                  title: '单位',
                  width: 70,
                  render: (_: unknown, line: EditLine) =>
                    line.pricingMethod === 'QTY_PRICE' ? (
                      editable ? (
                        <Input size="small" value={line.unit ?? ''} onChange={(e) => updateLine(line.key, { unit: e.target.value })} />
                      ) : (
                        line.unit
                      )
                    ) : (
                      '—'
                    ),
                },
                {
                  title: '口径',
                  width: 100,
                  render: (_: unknown, line: EditLine) =>
                    editable ? (
                      <Select
                        size="small"
                        style={{ width: '100%' }}
                        value={line.priceTaxIncl === false ? 'excl' : 'incl'}
                        onChange={(v) => updateLine(line.key, { priceTaxIncl: v === 'incl' })}
                        options={[
                          { value: 'incl', label: '含税' },
                          { value: 'excl', label: '不含税' },
                        ]}
                      />
                    ) : line.priceTaxIncl === false ? (
                      '不含税'
                    ) : (
                      '含税'
                    ),
                },
                {
                  title: '税率（%）',
                  width: 90,
                  render: (_: unknown, line: EditLine) =>
                    editable ? (
                      <InputNumber
                        size="small"
                        style={{ width: '100%' }}
                        min={0}
                        max={100}
                        precision={2}
                        value={line.taxRate ? Number(line.taxRate) : null}
                        placeholder="如 9"
                        onChange={(v) => updateLine(line.key, { taxRate: v?.toString() ?? null })}
                      />
                    ) : (
                      line.taxRate ?? '—'
                    ),
                },
                {
                  title: '单价（2 位小数）',
                  width: 130,
                  render: (_: unknown, line: EditLine) =>
                    line.pricingMethod === 'QTY_PRICE' ? (
                      editable ? (
                        <div>
                          <InputNumber
                            size="small"
                            style={{ width: '100%' }}
                            min={0}
                            precision={2}
                            value={line.unitPrice ? Number(line.unitPrice) : null}
                            onChange={(v) => updateLine(line.key, { unitPrice: v?.toString() ?? null })}
                          />
                          {counterpartPrice(line) && (
                            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                              {line.priceTaxIncl === false ? '含税' : '不含税'} ¥{counterpartPrice(line)}
                            </Typography.Text>
                          )}
                        </div>
                      ) : (
                        line.unitPrice
                      )
                    ) : (
                      '—'
                    ),
                },
                {
                  title: '金额（元）',
                  width: 120,
                  render: (_: unknown, line: EditLine) =>
                    line.pricingMethod === 'LUMP_SUM' && editable ? (
                      <InputNumber size="small" style={{ width: '100%' }} min={0} precision={2} value={line.amount ? Number(line.amount) : null} onChange={(v) => updateLine(line.key, { amount: v?.toString() ?? null })} />
                    ) : (
                      previewAmount(line)
                    ),
                },
                {
                  title: '依据说明',
                  width: 140,
                  render: (_: unknown, line: EditLine) =>
                    editable ? (
                      <Input size="small" value={line.basisNote ?? ''} placeholder={line.pricingMethod === 'LUMP_SUM' ? '必填' : ''} onChange={(e) => updateLine(line.key, { basisNote: e.target.value })} />
                    ) : (
                      line.basisNote || '—'
                    ),
                },
                ...(editable
                  ? [
                      {
                        title: '',
                        width: 46,
                        render: (_: unknown, line: EditLine) => (
                          <Button
                            size="small"
                            type="text"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={() => setVersion((v) => v && { ...v, lines: v.lines.filter((l) => l.key !== line.key) })}
                          />
                        ),
                      },
                    ]
                  : []),
              ]}
            />
            {editable && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                金额为后端十进制计算：数量×单价四舍五入到 2 位；按总额登记必须填写依据说明；目标明细不接受负数。
              </Typography.Text>
            )}
          </div>

          {(raw?.records?.length ?? 0) > 0 && (
            <div>
              <Typography.Text strong>审批与操作记录</Typography.Text>
              <Timeline
                style={{ marginTop: 12 }}
                items={raw!.records.map((r) => ({
                  children: (
                    <span>
                      {AUDIT_ACTION_LABELS[r.action] ?? r.action} · {r.actorName ?? '系统'} · {fmtDateTime(r.createdAt)}
                      {r.reason ? ` · ${r.reason}` : ''}
                    </span>
                  ),
                }))}
              />
            </div>
          )}
        </Space>
      )}

      <Modal
        title="批准目标版本"
        open={approveOpen}
        onOk={() => decide('approve')}
        onCancel={() => setApproveOpen(false)}
        okText="确认批准"
        cancelText="取消"
        confirmLoading={saving}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert type="info" showIcon message="批准后该版本成为当前适用目标，原适用版本转入历史；汇总只引用当前适用版本。" />
          <Input.TextArea rows={2} placeholder="审批意见（可选）" value={decisionComment} onChange={(e) => setDecisionComment(e.target.value)} maxLength={300} />
        </Space>
      </Modal>
      <Modal
        title="退回目标版本"
        open={returnOpen}
        onOk={() => decide('return')}
        onCancel={() => setReturnOpen(false)}
        okText="确认退回"
        cancelText="取消"
        confirmLoading={saving}
      >
        <Input.TextArea rows={3} placeholder="退回意见（必填）" value={decisionComment} onChange={(e) => setDecisionComment(e.target.value)} maxLength={300} />
      </Modal>
    </Drawer>
  );
}
