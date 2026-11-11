import { useEffect, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import {
  api,
  type ActualEntry,
  type ActualEntryInput,
  type BoqItem,
  type ExpenseCategory,
  type UnitProject,
} from '../../api';
import { useProject } from '../../project/ProjectContext';
import {
  ACTUAL_STATUS_COLORS,
  ACTUAL_STATUS_LABELS,
  EXPENSE_CATEGORY_LABELS,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  fmtQty,
  newIdempotencyKey,
} from './labels';

const LAST_TAX_RATE_KEY = 'zs.lastTaxRate';

/** 记住上一条录入的税率，作为下一条的默认值。 */
function readLastTaxRate(): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_TAX_RATE_KEY);
    if (!raw) return null;
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
  } catch {
    return null;
  }
}

function rememberTaxRate(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return;
  try {
    window.localStorage.setItem(LAST_TAX_RATE_KEY, String(value));
  } catch {
    // 忽略隐私模式下的写入失败
  }
}

/** 前端仅用于即时联动展示，最终数值以后端十进制计算为准。 */
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

interface EntryFormValues {
  boqItemId?: string;
  unitProjectId?: string;
  category: ExpenseCategory;
  description: string;
  vendorName?: string;
  period: Dayjs;
  pricingMethod: 'QTY_PRICE' | 'LUMP_SUM';
  quantity?: number | null;
  unit?: string;
  priceMode: 'incl' | 'excl';
  taxRate?: number | null;
  unitPriceTaxIncl?: number | null;
  unitPriceTaxExcl?: number | null;
  amount?: number | null;
}

/**
 * 极简结算录入：只保留 成本说明 / 供应商 / 结算周期 / 费用类别 / 量价。
 * 底部两个动作：保存草稿、确认结算（确认后立即计入实际成本）。
 */
export function ActualEntryFormModal({
  open,
  entryId,
  presetBoqItemId,
  onClose,
  onSaved,
}: {
  open: boolean;
  entryId: string | null;
  presetBoqItemId?: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { project } = useProject();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<EntryFormValues>();
  const [boqItems, setBoqItems] = useState<BoqItem[]>([]);
  const [unitProjects, setUnitProjects] = useState<UnitProject[]>([]);
  const [saving, setSaving] = useState<'draft' | 'confirm' | null>(null);

  const pricingMethod: 'QTY_PRICE' | 'LUMP_SUM' = Form.useWatch('pricingMethod', form) ?? 'QTY_PRICE';
  const priceMode: 'incl' | 'excl' = Form.useWatch('priceMode', form) ?? 'incl';
  const quantity = Form.useWatch('quantity', form);
  const inclPrice = Form.useWatch('unitPriceTaxIncl', form);
  const exclPrice = Form.useWatch('unitPriceTaxExcl', form);

  useEffect(() => {
    if (!open) return;
    void api
      .listBoqItems(project.id)
      .then((d) => setBoqItems(d.items))
      .catch(() => undefined);
    void api
      .listUnitProjects(project.id)
      .then((d) => setUnitProjects(d.units.filter((u) => u.isActive)))
      .catch(() => undefined);

    if (entryId) {
      void api.getActualEntry(project.id, entryId).then((e) => {
        form.setFieldsValue({
          boqItemId: e.boqItemId ?? undefined,
          unitProjectId: e.unitProjectId ?? undefined,
          category: e.category,
          description: e.description,
          vendorName: e.vendorName ?? '',
          period: dayjs(`${e.period}-01`),
          pricingMethod: e.pricingMethod,
          quantity: e.quantity ? Number(e.quantity) : null,
          unit: e.unit ?? '',
          priceMode: 'incl',
          taxRate: e.taxRate != null ? Number(e.taxRate) : readLastTaxRate(),
          unitPriceTaxIncl: e.unitPriceTaxIncl != null ? Number(e.unitPriceTaxIncl) : null,
          unitPriceTaxExcl: e.unitPriceTaxExcl != null ? Number(e.unitPriceTaxExcl) : null,
          amount: e.amount ? Number(e.amount) : null,
        });
      });
      return;
    }

    form.resetFields();
    const preset = presetBoqItemId ? boqItems.find((b) => b.id === presetBoqItemId) : null;
    form.setFieldsValue({
      boqItemId: presetBoqItemId ?? undefined,
      unitProjectId: preset?.unitProjectId ?? undefined,
      pricingMethod: 'QTY_PRICE',
      priceMode: 'incl',
      period: dayjs(),
      taxRate: readLastTaxRate(),
    });
  }, [open, entryId, presetBoqItemId, project.id, form]);

  const onBoqChange = (boqId: string | undefined) => {
    if (!boqId) return;
    const boq = boqItems.find((b) => b.id === boqId);
    if (boq?.unitProjectId) form.setFieldValue('unitProjectId', boq.unitProjectId);
  };

  const syncPrice = (rate?: number | null, mode?: 'incl' | 'excl') => {
    const useMode = mode ?? priceMode;
    const useRate = rate ?? (form.getFieldValue('taxRate') as number | null);
    if (useMode === 'incl') {
      form.setFieldValue(
        'unitPriceTaxExcl',
        calcCounterpart(form.getFieldValue('unitPriceTaxIncl') as number | null, useRate, true),
      );
    } else {
      form.setFieldValue(
        'unitPriceTaxIncl',
        calcCounterpart(form.getFieldValue('unitPriceTaxExcl') as number | null, useRate, false),
      );
    }
  };

  const activePrice = priceMode === 'excl' ? exclPrice : inclPrice;
  const previewAmount =
    pricingMethod === 'QTY_PRICE' && quantity != null && activePrice != null
      ? fmtMoney((Math.round(Number(quantity) * Number(activePrice) * 100) / 100).toFixed(2))
      : null;

  const buildPayload = (): ActualEntryInput => {
    const v = form.getFieldsValue(true) as EntryFormValues;
    const enteredPrice = v.priceMode === 'excl' ? v.unitPriceTaxExcl : v.unitPriceTaxIncl;
    rememberTaxRate(v.taxRate);
    const period = (v.period ?? dayjs()).format('YYYY-MM');
    return {
      boqItemId: v.boqItemId ?? null,
      unitProjectId: v.unitProjectId ?? null,
      category: v.category,
      // 业务日期取结算周期首日，保证月度趋势与结算周期一致
      businessDate: `${period}-01`,
      period,
      description: v.description.trim(),
      vendorName: v.vendorName?.trim() || null,
      pricingMethod: v.pricingMethod,
      quantity:
        v.pricingMethod === 'QTY_PRICE' && v.quantity != null ? String(v.quantity) : undefined,
      unit: v.pricingMethod === 'QTY_PRICE' ? v.unit?.trim() : undefined,
      unitPrice:
        v.pricingMethod === 'QTY_PRICE' && enteredPrice != null ? String(enteredPrice) : undefined,
      amount: v.pricingMethod === 'LUMP_SUM' && v.amount != null ? String(v.amount) : undefined,
      taxRate: v.taxRate != null ? String(v.taxRate) : undefined,
      priceTaxIncl: v.priceMode !== 'excl',
    };
  };

  const submit = async (mode: 'draft' | 'confirm') => {
    const values = await form.validateFields();
    void values;
    setSaving(mode);
    try {
      const payload = buildPayload();
      let savedId = entryId;
      if (entryId) {
        await api.updateActualEntry(project.id, entryId, payload);
      } else {
        const created = await api.createActualEntry(project.id, {
          ...payload,
          idempotencyKey: newIdempotencyKey(),
        });
        savedId = created.id;
      }
      if (mode === 'confirm' && savedId) {
        await api.confirmActualEntry(project.id, savedId);
      }
      message.success(mode === 'confirm' ? '结算已确认，已计入实际成本' : '草稿已保存');
      onClose();
      onSaved();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <Modal
      title={entryId ? '编辑结算草稿' : '录入结算'}
      open={open}
      onCancel={onClose}
      width={720}
      destroyOnHidden
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button loading={saving === 'draft'} onClick={() => void submit('draft')}>
            保存草稿
          </Button>
          <Button type="primary" loading={saving === 'confirm'} onClick={() => void submit('confirm')}>
            确认结算
          </Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical">
        <Space size={12} wrap style={{ width: '100%' }}>
          <Form.Item
            name="boqItemId"
            label="关联清单项（可空）"
            style={{ width: 300 }}
          >
            <Select
              placeholder="机械费/管理费等可直接留空"
              showSearch
              allowClear
              optionFilterProp="label"
              onChange={(v) => onBoqChange(v)}
              options={boqItems.map((b) => ({
                value: b.id,
                label: `${b.sectionName ? `[${b.sectionName}] ` : ''}${b.itemName}${b.unit ? `（${b.unit}）` : ''}`,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="unitProjectId"
            label="单项工程（未关联清单项时必选）"
            style={{ width: 230 }}
            rules={[
              ({ getFieldValue }) => ({
                validator: (_, value) =>
                  value || getFieldValue('boqItemId')
                    ? Promise.resolve()
                    : Promise.reject(new Error('请选择单项工程')),
              }),
            ]}
          >
            <Select
              placeholder="选择单项工程"
              allowClear
              options={unitProjects.map((u) => ({ value: u.id, label: u.name }))}
              notFoundContent="请先在「项目设置 - 单项工程」中维护"
            />
          </Form.Item>
          <Form.Item
            name="category"
            label="费用类别（必选）"
            rules={[{ required: true, message: '请选择费用类别' }]}
            style={{ width: 160 }}
          >
            <Select
              placeholder="选择"
              options={Object.entries(EXPENSE_CATEGORY_LABELS).map(([value, label]) => ({ value, label }))}
            />
          </Form.Item>
        </Space>

        <Space size={12} wrap style={{ width: '100%' }}>
          <Form.Item
            name="description"
            label="成本说明"
            rules={[{ required: true, message: '请填写成本说明' }, { max: 200 }]}
            style={{ width: 380 }}
          >
            <Input placeholder="如：9 月土方结算" />
          </Form.Item>
          <Form.Item name="vendorName" label="供应商 / 分包商" style={{ width: 240 }} rules={[{ max: 80 }]}>
            <Input placeholder="如：福州某某土方队" />
          </Form.Item>
          <Form.Item
            name="period"
            label="结算周期"
            rules={[{ required: true, message: '请选择结算周期' }]}
            style={{ width: 160 }}
          >
            <DatePicker picker="month" style={{ width: '100%' }} />
          </Form.Item>
        </Space>

        <Space size={12} wrap style={{ width: '100%' }}>
          <Form.Item name="pricingMethod" label="计价方式" style={{ width: 140 }}>
            <Select
              options={[
                { value: 'QTY_PRICE', label: '数量×单价' },
                { value: 'LUMP_SUM', label: '按总额' },
              ]}
            />
          </Form.Item>
          <Form.Item name="priceMode" label="录入方式">
            <Radio.Group
              optionType="button"
              buttonStyle="solid"
              options={[
                { value: 'incl', label: '含税录入' },
                { value: 'excl', label: '不含税录入' },
              ]}
              onChange={(e) => syncPrice(form.getFieldValue('taxRate'), e.target.value as 'incl' | 'excl')}
            />
          </Form.Item>
          <Form.Item name="taxRate" label="税率（%）" style={{ width: 110 }}>
            <InputNumber
              min={0}
              max={100}
              precision={2}
              style={{ width: '100%' }}
              onChange={(v) => syncPrice(v as number | null)}
            />
          </Form.Item>
        </Space>

        {pricingMethod === 'QTY_PRICE' ? (
          <Space size={12} wrap style={{ width: '100%' }}>
            <Form.Item
              name="quantity"
              label="数量（最多 3 位小数）"
              rules={[{ required: true, message: '请填写数量' }]}
            >
              <InputNumber min={0} precision={3} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item
              name="unit"
              label="单位"
              rules={[{ required: true, message: '请填写单位' }, { max: 20 }]}
            >
              <Input style={{ width: 90 }} />
            </Form.Item>
            <Form.Item
              name="unitPriceTaxIncl"
              label="含税单价（2 位小数）"
              rules={[{ required: priceMode === 'incl', message: '请填写单价' }]}
            >
              <InputNumber
                min={0}
                precision={2}
                style={{ width: 170 }}
                disabled={priceMode === 'excl'}
                onChange={(v) => {
                  if (priceMode !== 'incl') return;
                  form.setFieldValue(
                    'unitPriceTaxExcl',
                    calcCounterpart(v as number | null, form.getFieldValue('taxRate') as number | null, true),
                  );
                }}
              />
            </Form.Item>
            <Form.Item
              name="unitPriceTaxExcl"
              label="不含税单价（2 位小数）"
              rules={[{ required: priceMode === 'excl', message: '请填写单价' }]}
            >
              <InputNumber
                min={0}
                precision={2}
                style={{ width: 170 }}
                disabled={priceMode === 'incl'}
                onChange={(v) => {
                  if (priceMode !== 'excl') return;
                  form.setFieldValue(
                    'unitPriceTaxIncl',
                    calcCounterpart(v as number | null, form.getFieldValue('taxRate') as number | null, false),
                  );
                }}
              />
            </Form.Item>
            <Form.Item label="金额（后端计算）">
              <Typography.Text strong>{previewAmount ?? '—'} 元</Typography.Text>
            </Form.Item>
          </Space>
        ) : (
          <Form.Item
            name="amount"
            label={`金额（元，${priceMode === 'incl' ? '含税' : '不含税'}）`}
            rules={[{ required: true, message: '请填写金额' }]}
          >
            <InputNumber min={0} precision={2} style={{ width: 220 }} />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}

/** 结算详情：只读展示，不做任何自动弹窗或流程跳转。 */
export function EntryDetailDrawer({
  entryId,
  onClose,
  onChanged,
}: {
  entryId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { project } = useProject();
  const { message } = AntApp.useApp();
  const [entry, setEntry] = useState<ActualEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);

  useEffect(() => {
    if (!entryId) {
      setEntry(null);
      return;
    }
    setLoading(true);
    api
      .getActualEntry(project.id, entryId)
      .then((e) => setEntry(e))
      .catch((e) => message.error((e as Error).message))
      .finally(() => setLoading(false));
  }, [entryId, project.id, message]);

  const confirm = async () => {
    if (!entry) return;
    setActing(true);
    try {
      await api.confirmActualEntry(project.id, entry.id);
      message.success('结算已确认，已计入实际成本');
      onClose();
      onChanged();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setActing(false);
    }
  };

  return (
    <Drawer
      title="结算详情"
      width={620}
      open={!!entryId}
      onClose={onClose}
      loading={loading}
      extra={
        entry && entry.kind === 'NORMAL' && entry.status !== 'CONFIRMED' ? (
          <Button type="primary" loading={acting} onClick={() => void confirm()}>
            确认结算
          </Button>
        ) : null
      }
    >
      {entry && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {entry.kind === 'REVERSAL' && (
            <Alert
              type="warning"
              showIcon
              message={`本记录为冲销记录，原记录：${entry.reversalOf?.description ?? '——'}`}
            />
          )}
          <Descriptions column={2} size="small" bordered>
            <Descriptions.Item label="成本说明" span={2}>
              {entry.description}
            </Descriptions.Item>
            <Descriptions.Item label="供应商 / 分包商">{entry.vendorName || '—'}</Descriptions.Item>
            <Descriptions.Item label="费用类别">
              {EXPENSE_CATEGORY_LABELS[entry.category]}
            </Descriptions.Item>
            <Descriptions.Item label="结算周期">{entry.period}</Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag color={ACTUAL_STATUS_COLORS[entry.status]}>{ACTUAL_STATUS_LABELS[entry.status]}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="单项工程">{entry.unitProjectName || '—'}</Descriptions.Item>
            <Descriptions.Item label="关联清单项">{entry.boqItemName || '未关联'}</Descriptions.Item>
            <Descriptions.Item label="数量">{fmtQty(entry.quantity)}</Descriptions.Item>
            <Descriptions.Item label="单价（含税）">{fmtMoney(entry.unitPriceTaxIncl)}</Descriptions.Item>
            <Descriptions.Item label="单价（不含税）">{fmtMoney(entry.unitPriceTaxExcl)}</Descriptions.Item>
            <Descriptions.Item label="税率">
              {entry.taxRate != null ? `${entry.taxRate}%` : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="金额（含税）">{fmtMoney(entry.amountTaxIncl)}</Descriptions.Item>
            <Descriptions.Item label="金额（不含税）">{fmtMoney(entry.amountTaxExcl)}</Descriptions.Item>
            <Descriptions.Item label="确认人">{entry.reviewedByName || '—'}</Descriptions.Item>
            <Descriptions.Item label="确认时间">
              {entry.reviewedAt ? fmtDateTime(entry.reviewedAt) : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="业务日期">{fmtDate(entry.businessDate)}</Descriptions.Item>
            <Descriptions.Item label="登记人">{entry.createdByName || '—'}</Descriptions.Item>
          </Descriptions>
        </Space>
      )}
    </Drawer>
  );
}
