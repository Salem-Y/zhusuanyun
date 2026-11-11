import { Prisma } from '@prisma/client';
import { ApiError } from './errors';

const Decimal = Prisma.Decimal;
export type Money = Prisma.Decimal;

/** 十进制四舍五入到 2 位（正式金额口径）。 */
export function roundMoney(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * 解析数量：必须为非负十进制数，最多 3 位小数（第六轮全局精度）。
 */
export function parseQuantity(input: unknown, fieldLabel: string): Prisma.Decimal {
  if (input === null || input === undefined || input === '') {
    throw ApiError.badRequest(`${fieldLabel}不能为空`);
  }
  const text = String(input).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw ApiError.badRequest(`${fieldLabel}必须是非负数字`);
  }
  const dec = new Decimal(text);
  if (dec.decimalPlaces() > 3) {
    throw ApiError.badRequest(`${fieldLabel}最多 3 位小数`);
  }
  return dec;
}

/** 解析单价：必须为非负十进制数，最多 2 位小数（第六轮全局精度）。 */
export function parsePrice(input: unknown, fieldLabel: string): Prisma.Decimal {
  if (input === null || input === undefined || input === '') {
    throw ApiError.badRequest(`${fieldLabel}不能为空`);
  }
  const text = String(input).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw ApiError.badRequest(`${fieldLabel}必须是非负数字`);
  }
  const dec = new Decimal(text);
  if (dec.decimalPlaces() > 2) {
    throw ApiError.badRequest(`${fieldLabel}最多 2 位小数`);
  }
  return dec;
}

/** 解析税率（%）：0-100，最多 2 位小数。 */
export function parseTaxRate(input: unknown, fieldLabel = '税率'): Prisma.Decimal {
  if (input === null || input === undefined || input === '') {
    throw ApiError.badRequest(`${fieldLabel}不能为空`);
  }
  const text = String(input).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw ApiError.badRequest(`${fieldLabel}必须是非负数字，最多 2 位小数`);
  }
  const dec = new Decimal(text);
  if (dec.greaterThan(100)) throw ApiError.badRequest(`${fieldLabel}不能超过 100`);
  return dec;
}

/**
 * 含税/不含税换算：rate 为百分数（如 9 表示 9%）。
 * 未提供税率时视为 0，含税与不含税相等。
 */
export function taxPair(
  value: Prisma.Decimal,
  taxRate: Prisma.Decimal | null,
  taxIncl: boolean,
): { incl: Prisma.Decimal; excl: Prisma.Decimal } {
  if (!taxRate || taxRate.isZero()) {
    return { incl: roundMoney(value), excl: roundMoney(value) };
  }
  const factor = taxRate.div(100).add(1);
  return taxIncl
    ? { incl: roundMoney(value), excl: roundMoney(value.div(factor)) }
    : { excl: roundMoney(value), incl: roundMoney(value.mul(factor)) };
}

/** 兼容旧调用：数量/单价合并校验（最多 6 位小数），第六轮新代码请用 parseQuantity / parsePrice。 */
export function parseQuantityOrPrice(input: unknown, fieldLabel: string): Prisma.Decimal {
  if (input === null || input === undefined || input === '') {
    throw ApiError.badRequest(`${fieldLabel}不能为空`);
  }
  const text = String(input).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw ApiError.badRequest(`${fieldLabel}必须是非负数字`);
  }
  const dec = new Decimal(text);
  if (dec.decimalPlaces() > 6) {
    throw ApiError.badRequest(`${fieldLabel}最多 6 位小数`);
  }
  return dec;
}

/** 解析按总额登记的金额：非负，最多 2 位小数。 */
export function parseMoneyInput(input: unknown, fieldLabel: string): Prisma.Decimal {
  if (input === null || input === undefined || input === '') {
    throw ApiError.badRequest(`${fieldLabel}不能为空`);
  }
  const text = String(input).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw ApiError.badRequest(`${fieldLabel}必须是非负金额，最多 2 位小数`);
  }
  return new Decimal(text);
}

/**
 * 行金额计算：
 * - 数量×单价：后端按十进制计算并四舍五入到 2 位；
 * - 按总额登记：直接采用登记金额（必须提供依据说明，由调用方校验）。
 */
export function computeLineAmount(input: {
  pricingMethod: 'QTY_PRICE' | 'LUMP_SUM';
  quantity?: Prisma.Decimal | null;
  unitPrice?: Prisma.Decimal | null;
  amount?: Prisma.Decimal | null;
}): Prisma.Decimal {
  if (input.pricingMethod === 'QTY_PRICE') {
    if (!input.quantity || !input.unitPrice) {
      throw ApiError.badRequest('数量×单价计价方式必须填写数量和单价');
    }
    return roundMoney(input.quantity.mul(input.unitPrice));
  }
  if (!input.amount) {
    throw ApiError.badRequest('按总额登记必须填写金额');
  }
  return roundMoney(input.amount);
}

/** 合计：先确定行金额再求和（全部已是 2 位小数）。 */
export function sumMoney(values: Prisma.Decimal[]): Prisma.Decimal {
  return values.reduce((acc, v) => acc.add(v), new Decimal(0)).toDecimalPlaces(2);
}

/**
 * 金额输出：统一序列化为 2 位小数字符串（如 "1205.00"）。
 * 既保证 API 传输不丢精度，又让接口契约与「正式金额 2 位小数」口径一致。
 */
export function outMoney(value: Prisma.Decimal | string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return new Decimal(value).toFixed(2);
}

/** 数量/单价输出：保留原始精度字符串（最多 6 位小数，尾零按十进制原样输出）。 */
export function outQty(value: Prisma.Decimal | string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return new Decimal(value).toString();
}
