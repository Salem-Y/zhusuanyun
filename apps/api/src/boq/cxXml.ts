import { ApiError } from '../http/errors';

/** 晨曦/福建计价 XML（导则 2017，VER 2.x）解析结果。 */

export interface CxXmlItem {
  /** 清单编码（XMBM） */
  code: string;
  /** 清单名称（XMMC） */
  name: string;
  /** 项目特征（XMTZ） */
  feature: string | null;
  /** 单位（JLDW） */
  unit: string | null;
  /** 工程量（GCSL），原始字符串 */
  quantity: string;
  /** 综合单价（ZHDJ，含税），原始字符串 */
  unitPrice: string;
  /** 合价（HJ，含税），原始字符串 */
  amount: string;
}

export interface CxXmlSection {
  name: string;
  /** 分部合价（FBGCFHJ / CSFBGC@FBGCFHJ），原始字符串 */
  total: string;
  items: CxXmlItem[];
}

export interface CxXmlProject {
  name: string;
  profession: string;
  bidType: string;
  priceMethod: string;
  ruleName: string;
  version: string;
  area: string;
}

export interface CxXmlResult {
  project: CxXmlProject;
  /** 文件中的单项工程名称（DWGC@DWGCMC）；可能为空或多个 */
  unitProjectNames: string[];
  /** 分部分项工程费：FBFX > FBGC > QDXM */
  divisional: CxXmlSection[];
  /** 措施项目费：CSXM > CSFBGC > DJCS > QDXM */
  measure: CxXmlSection[];
  /** 其他项目费：QTXM > QTXMFHZ > QTXMFZC */
  other: CxXmlSection[];
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) {
      const n = Number.parseInt(code.slice(2), 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    if (code.startsWith('#')) {
      const n = Number.parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code] ?? whole;
  });
}

/** 读取标签属性值（自动实体解码并去除首尾空白）。 */
function readAttr(attrs: string, key: string): string {
  const match = new RegExp(`\\b${key}="([^"]*)"`).exec(attrs);
  return match ? decodeXml(match[1]).trim() : '';
}

/** 取父节点内部文本（同名标签不嵌套，取第一个闭合标签）。 */
function innerBlock(text: string, tag: string): string {
  const open = new RegExp(`<${tag}(?:\\s[^>]*)?>`).exec(text);
  if (!open) return '';
  const start = open.index + open[0].length;
  const end = text.indexOf(`</${tag}>`, start);
  return text.slice(start, end < 0 ? undefined : end);
}

/** 逐个提取同名子块（要求有闭合标签，用于 FBGC / CSFBGC）。 */
function eachBlock(text: string, tag: string): Array<{ attrs: string; body: string }> {
  const re = new RegExp(`<${tag}\\s([^>]*)>([\\s\\S]*?)</${tag}>`, 'g');
  const out: Array<{ attrs: string; body: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) out.push({ attrs: match[1], body: match[2] });
  return out;
}

/** 提取块内所有清单项（QDXM），过滤掉无编码或无名称的小计行。 */
function collectItems(block: string): CxXmlItem[] {
  const re = /<QDXM\s([^>]*)>/g;
  const out: CxXmlItem[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(block))) {
    const attrs = match[1];
    const code = readAttr(attrs, 'XMBM');
    const name = readAttr(attrs, 'XMMC');
    if (!code || !name) continue;
    out.push({
      code,
      name,
      feature: readAttr(attrs, 'XMTZ') || null,
      unit: readAttr(attrs, 'JLDW') || null,
      quantity: readAttr(attrs, 'GCSL') || '0',
      unitPrice: readAttr(attrs, 'ZHDJ') || '0',
      amount: readAttr(attrs, 'HJ') || '0',
    });
  }
  return out;
}

function parseSections(block: string, tag: string, nameKey: string, totalKey: string): CxXmlSection[] {
  return eachBlock(block, tag)
    .map((section) => ({
      name: readAttr(section.attrs, nameKey) || '未命名分部',
      total: readAttr(section.attrs, totalKey) || '0',
      items: collectItems(section.body),
    }))
    .filter((section) => section.items.length > 0);
}

/**
 * 总价措施项目费（安全文明施工费等）不走 QDXM，而是 DWGCF 费用树里的 FYXM 节点；
 * 单独提取为「总价措施项目费」分部，保证措施项目费合计与招标文件一致。
 */
function parseTotalPriceMeasures(text: string): CxXmlSection | null {
  const block = /<FYXM\s([^>]*XMMC="总价措施项目费"[^>]*)>([\s\S]*?)<\/FYXM>/.exec(text);
  if (!block) return null;
  const body = block[2];
  const items: CxXmlItem[] = [];
  const push = (attrs: string) => {
    const name = readAttr(attrs, 'XMMC');
    if (!name) return;
    const amount = readAttr(attrs, 'JE') || '0';
    items.push({ code: '', name, feature: null, unit: '项', quantity: '1', unitPrice: amount, amount });
  };
  for (const match of body.matchAll(/<FYXMZC\s([^>]*?)\/>/g)) push(match[1]);
  if (items.length === 0) {
    for (const match of body.matchAll(/<FYXM\s([^>]*?)>/g)) push(match[1]);
  }
  if (items.length === 0) return null;
  const total = items.reduce((sum, item) => sum + Number(item.amount || 0), 0).toFixed(2);
  return { name: '总价措施项目费', total, items };
}

/**
 * 解析晨曦/福建计价导出的 XML 工程量清单。
 * 只识别结构，不做金额换算（含税/不含税在写库时按项目税率统一计算）。
 */
export function parseCxXml(raw: string): CxXmlResult {
  const text = raw.replace(/^\uFEFF/, '');
  const root = /<GCZJWJ([^>]*)>/.exec(text);
  if (!root) {
    throw ApiError.badRequest('未识别到晨曦/福建计价工程文件根节点，请确认导出的是「导则 2017」XML 文件');
  }
  const head = root[1];

  const unitProjectNames = [...text.matchAll(/<DWGC\s([^>]*)>/g)]
    .map((m) => readAttr(m[1], 'DWGCMC'))
    .filter((name) => name.length > 0);

  const divisional = parseSections(innerBlock(text, 'FBFX'), 'FBGC', 'FBGCMC', 'FBGCFHJ');
  const measure = parseSections(innerBlock(text, 'CSXM'), 'CSFBGC', 'FBGCMC', 'FBGCFHJ');
  const totalPriceMeasure = parseTotalPriceMeasures(text);
  if (totalPriceMeasure && !measure.some((section) => section.name === totalPriceMeasure.name)) {
    measure.push(totalPriceMeasure);
  }

  const otherBlock = innerBlock(text, 'QTXM');
  const otherItems: CxXmlItem[] = [];
  const otherRe = /<QTXMFZC\s([^>]*?)\/>/g;
  let match: RegExpExecArray | null;
  while ((match = otherRe.exec(otherBlock))) {
    const name = readAttr(match[1], 'XMMC');
    if (!name) continue;
    const amount = readAttr(match[1], 'JE') || '0';
    otherItems.push({
      code: '',
      name,
      feature: null,
      unit: '项',
      quantity: '1',
      unitPrice: amount,
      amount,
    });
  }
  const other: CxXmlSection[] = otherItems.length
    ? [{ name: '其他项目', total: otherItems.reduce((sum, it) => sum + Number(it.amount || 0), 0).toFixed(2), items: otherItems }]
    : [];

  if (divisional.length === 0 && measure.length === 0 && other.length === 0) {
    throw ApiError.badRequest('未在文件中识别到工程量清单，请确认该 XML 来自晨曦/福建计价并包含分部分项或措施项目');
  }

  return {
    project: {
      name: readAttr(head, 'GCMC'),
      profession: readAttr(head, 'ZYLB'),
      bidType: readAttr(head, 'BZLB'),
      priceMethod: readAttr(head, 'JJLX'),
      ruleName: readAttr(head, 'ZXBZMC'),
      version: readAttr(head, 'VER'),
      area: readAttr(head, 'JZMJ'),
    },
    unitProjectNames,
    divisional,
    measure,
    other,
  };
}
