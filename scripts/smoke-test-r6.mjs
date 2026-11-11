/**
 * 第六轮验收冒烟测试：单项工程/收入税率、清单三分法+含税口径、精度、成本工作台双模块。
 * 覆盖验收 6 条：
 *  1) 项目设置维护单项工程与收入建安税率
 *  2) 合同清单三分类切换、含税/不含税口径、合并展开、已关联标记与作废保护
 *  3) 清单录入含税/不含税联动反算、默认税率、3 位数量 / 2 位单价精度
 *  4) 清单成本对比：单项工程筛选、8 类费用列（含"其他"）、未分配成本池
 *  5) 过程成本统计：本期/累计/预测切换、8 大类 + 合计行、行下钻
 *  6) 第五轮导入映射模板保留；第四轮目标→批准→实际→确认→冲销闭环不破坏
 * 凭据从环境变量注入，不硬编码、不打印。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const API = process.env.SMOKE_API ?? 'http://127.0.0.1:3000';

const results = [];
const note = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
};

const makeClient = (username, password) => {
  const jar = new Map();
  const storeCookies = (res) => {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const pair = c.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  };
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const request = async (path, { method = 'GET', body, formData } = {}) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(jar.size ? { Cookie: cookieHeader() } : {}),
        ...(jar.get('zs_csrf') && !['GET', 'HEAD', 'OPTIONS'].includes(method)
          ? { 'x-csrf-token': jar.get('zs_csrf') }
          : {}),
      },
      body: formData ?? (body ? JSON.stringify(body) : undefined),
    });
    storeCookies(res);
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };
  request.login = async () => {
    const res = await request('/api/auth/login', { method: 'POST', body: { username, password } });
    assert.equal(res.status, 200, `${username} 登录失败：${JSON.stringify(res.json)}`);
  };
  return request;
};

const idem = () => crypto.randomUUID();
const CATS = ['labor', 'material', 'machine', 'subcontract', 'turnover', 'measure', 'site_overhead', 'other'];

async function main() {
  const admin = makeClient(process.env.SMOKE_ADMIN_USERNAME, process.env.SMOKE_ADMIN_PASSWORD);
  const lead = makeClient(process.env.SMOKE_LEAD_USERNAME, process.env.SMOKE_LEAD_PASSWORD);
  const cost = makeClient(process.env.SMOKE_COST_USERNAME, process.env.SMOKE_COST_PASSWORD);
  const field = makeClient(process.env.SMOKE_FIELD_USERNAME, process.env.SMOKE_FIELD_PASSWORD);
  for (const client of [admin, lead, cost, field]) await client.login();
  console.log('已登录：管理员 / 项目负责人 / 造价员 / 其他管理人员');

  const users = (await admin('/api/users')).json.data;
  const uid = (name) => users.find((u) => u.username === name).id;
  const leadId = uid(process.env.SMOKE_LEAD_USERNAME);
  const costId = uid(process.env.SMOKE_COST_USERNAME);

  const suffix = Date.now().toString().slice(-6);
  const code = `R6-${suffix}`;
  const created = await admin('/api/projects', {
    method: 'POST',
    body: { code, name: `第六轮功能验收项目 ${suffix}`, description: '单项工程＋含税口径＋双工作台' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const pid = created.json.data.id;
  for (const [userId, roleCode] of [[leadId, 'PROJECT_LEAD'], [costId, 'COST_ENGINEER']]) {
    assert.equal((await admin(`/api/projects/${pid}/members`, { method: 'POST', body: { userId, roleCode } })).status, 201);
  }
  console.log(`验收项目已建立：${code}（${pid}）`);

  // ===== 1. 项目设置：单项工程 + 收入建安税率 =====
  const unitsRes = await lead(`/api/projects/${pid}/unit-projects`);
  assert.equal(unitsRes.status, 200);
  assert.equal(unitsRes.json.meta.revenueTaxRate, '9.00', '默认收入建安税率应为 9.00');
  const u1 = (await lead(`/api/projects/${pid}/unit-projects`, { method: 'POST', body: { name: '1#楼' } })).json.data;
  const u2 = (await lead(`/api/projects/${pid}/unit-projects`, { method: 'POST', body: { name: '2#楼' } })).json.data;
  const u3 = (await lead(`/api/projects/${pid}/unit-projects`, { method: 'POST', body: { name: '地下室' } })).json.data;
  assert.ok(u1?.id && u2?.id && u3?.id, '单项工程新增失败');
  assert.equal((await lead(`/api/projects/${pid}/unit-projects`, { method: 'POST', body: { name: '1#楼' } })).status, 409, '重名应 409');
  assert.equal((await field(`/api/projects/${pid}/unit-projects`, { method: 'POST', body: { name: 'X' } })).status, 403, '非负责人/造价员不可维护');

  const taxSet = await lead(`/api/projects/${pid}/revenue-tax-rate`, { method: 'PUT', body: { revenueTaxRate: '13' } });
  assert.equal(taxSet.status, 200, JSON.stringify(taxSet.json));
  assert.equal(taxSet.json.data.revenueTaxRate, '13.00');
  assert.equal((await lead(`/api/projects/${pid}/revenue-tax-rate`, { method: 'PUT', body: { revenueTaxRate: '101' } })).status, 400, '税率越界应 400');
  // 停用/启用与删除保护
  assert.equal((await lead(`/api/projects/${pid}/unit-projects/${u3.id}`, { method: 'PATCH', body: { isActive: false } })).status, 200);
  assert.equal((await lead(`/api/projects/${pid}/unit-projects/${u3.id}`, { method: 'PATCH', body: { isActive: true } })).status, 200);
  note('1：单项工程维护（新增/重名409/越权403/停用启用）与收入建安税率 9.00→13.00 正常', true);

  // ===== 2/3. 合同清单：三分法 + 单项工程必选 + 含税反算 + 精度 =====
  const noUnit = await lead(`/api/projects/${pid}/boq-items`, {
    method: 'POST',
    body: { itemName: '缺单项工程', unit: 'm3', quantity: '1', unitPrice: '1', idempotencyKey: idem() },
  });
  assert.equal(noUnit.status, 400, '未填单项工程应被拒');

  const itemA = (await lead(`/api/projects/${pid}/boq-items`, {
    method: 'POST',
    body: {
      projectCategory: 'divisional', unitProjectId: u1.id,
      sectionCode: '0101', sectionName: '土石方工程',
      itemName: '挖一般土方', itemFeature: '三类土', unit: 'm3',
      quantity: '1000.123', taxRate: '13', priceTaxIncl: true, unitPrice: '45.2',
      idempotencyKey: idem(),
    },
  })).json.data;
  assert.ok(itemA?.id, JSON.stringify(itemA));
  assert.equal(itemA.unitPriceTaxIncl, '45.20', `含税单价 2 位，实际 ${itemA.unitPriceTaxIncl}`);
  assert.equal(itemA.unitPriceTaxExcl, '40.00', `45.20/1.13=40.00，实际 ${itemA.unitPriceTaxExcl}`);
  assert.equal(itemA.amountTaxIncl, '45205.56', `1000.123×45.20=45205.5596→45205.56，实际 ${itemA.amountTaxIncl}`);
  assert.equal(itemA.amountTaxExcl, '40004.92', `1000.123×40.00=40004.92，实际 ${itemA.amountTaxExcl}`);
  assert.equal(itemA.quantity, '1000.123', '工程量保留 3 位小数');
  assert.equal(itemA.taxRate, '13.00');

  // 精度拒绝
  const badQty = await lead(`/api/projects/${pid}/boq-items`, {
    method: 'POST',
    body: { projectCategory: 'divisional', unitProjectId: u1.id, itemName: '精度测试', unit: 'm3', quantity: '1.2345', unitPrice: '10', idempotencyKey: idem() },
  });
  assert.equal(badQty.status, 400, '工程量 4 位小数应被拒');
  const badPrice = await lead(`/api/projects/${pid}/boq-items`, {
    method: 'POST',
    body: { projectCategory: 'divisional', unitProjectId: u1.id, itemName: '精度测试', unit: 'm3', quantity: '1', unitPrice: '10.005', idempotencyKey: idem() },
  });
  assert.equal(badPrice.status, 400, '单价 3 位小数应被拒');

  // 未填税率时继承项目收入建安税率（13%）；不含税录入反算含税
  const itemB = (await cost(`/api/projects/${pid}/boq-items`, {
    method: 'POST',
    body: {
      projectCategory: 'measure', unitProjectId: u2.id, sectionName: '措施项目',
      itemName: '模板工程', unit: 'm2', quantity: '50', priceTaxIncl: false, unitPrice: '100',
      idempotencyKey: idem(),
    },
  })).json.data;
  assert.equal(itemB.taxRate, '13.00', '未填税率应继承项目收入建安税率');
  assert.equal(itemB.unitPriceTaxExcl, '100.00');
  assert.equal(itemB.unitPriceTaxIncl, '113.00', `不含税 100 × 1.13=113.00，实际 ${itemB.unitPriceTaxIncl}`);
  note('2/3：清单三分法、单项工程必选、含税/不含税反算、数量 3 位与单价 2 位精度校验均生效', true);

  const itemC = (await lead(`/api/projects/${pid}/boq-items`, {
    method: 'POST',
    body: {
      projectCategory: 'other', unitProjectId: u1.id, sectionName: '其他项目',
      itemName: '安全文明施工费', unit: '项', quantity: '1', taxRate: '9', priceTaxIncl: true, unitPrice: '2000',
      idempotencyKey: idem(),
    },
  })).json.data;
  // 同名同特征同单位、不同单项工程：可合并
  const itemA2 = (await lead(`/api/projects/${pid}/boq-items`, {
    method: 'POST',
    body: {
      projectCategory: 'divisional', unitProjectId: u2.id, sectionName: '土石方工程',
      itemName: '挖一般土方', itemFeature: '三类土', unit: 'm3',
      quantity: '200', taxRate: '13', priceTaxIncl: true, unitPrice: '45.2',
      idempotencyKey: idem(),
    },
  })).json.data;

  // 三分类筛选
  const divList = (await lead(`/api/projects/${pid}/boq-items?projectCategory=divisional`)).json.data;
  assert.equal(divList.items.length, 2, '分部分项应有 2 条');
  const measureList = (await lead(`/api/projects/${pid}/boq-items?projectCategory=measure`)).json.data;
  assert.equal(measureList.items.length, 1);
  const otherList = (await lead(`/api/projects/${pid}/boq-items?projectCategory=other`)).json.data;
  assert.equal(otherList.items.length, 1);
  assert.ok(divList.byCategory.some((c) => c.projectCategory === 'divisional' && Number(c.count) === 2), 'byCategory 返回各分类统计');

  // 跨分类合并应被拒
  const crossCat = await lead(`/api/projects/${pid}/boq-items/merge`, {
    method: 'POST', body: { itemIds: [itemA.id, itemC.id], primaryId: itemA.id },
  });
  assert.equal(crossCat.status, 400, '不同分类/不同名称不可合并');

  // 同分类跨单项工程合并
  const merged = (await lead(`/api/projects/${pid}/boq-items/merge`, {
    method: 'POST', body: { itemIds: [itemA.id, itemA2.id], primaryId: itemA.id },
  })).json.data;
  assert.equal(Number(merged.quantity), 1200.123, `合并工程量 1000.123+200，实际 ${merged.quantity}`);
  assert.equal(merged.amountTaxIncl, '54245.56', `1200.123×45.20=54245.5596→54245.56，实际 ${merged.amountTaxIncl}`);
  assert.equal(merged.unitProjectId, u1.id, '主记录保留原单项工程');

  // 合并展开：主记录返回被合并明细（含单项工程）
  const afterMerge = (await lead(`/api/projects/${pid}/boq-items`)).json.data;
  const primary = afterMerge.items.find((i) => i.id === itemA.id);
  assert.equal(primary.mergedCount, 1, '主记录应带合并条数');
  assert.equal(primary.mergedItems.length, 1, '可展开被合并明细');
  assert.equal(primary.mergedItems[0].unitProject.name, '2#楼', '被合并明细带单项工程');
  note('3：跨单项工程合并汇总正确（1200.123 → 54245.56），合并明细可展开且带单项工程', true);

  // ===== 4. 目标版本（含税/不含税双口径 + 单项工程）=====
  const v1 = (await cost(`/api/projects/${pid}/target-versions`, {
    method: 'POST', body: { versionName: 'V1 目标', effectiveDate: '2026-11-01', idempotencyKey: idem() },
  })).json.data;
  const saveLines = await cost(`/api/projects/${pid}/target-versions/${v1.id}/lines`, {
    method: 'PUT',
    body: {
      lines: [
        {
          boqItemId: itemA.id, category: 'material', summary: '土方开挖', pricingMethod: 'QTY_PRICE',
          quantity: '80', unit: 'm3', unitPrice: '450', taxRate: '9', priceTaxIncl: true,
        },
        {
          category: 'other', summary: '不可预见费', pricingMethod: 'LUMP_SUM',
          amount: '2000', taxRate: '9', priceTaxIncl: true, unitProjectId: u3.id, basisNote: '按费率暂列',
        },
      ],
    },
  });
  assert.equal(saveLines.status, 200, JSON.stringify(saveLines.json));
  const line1 = saveLines.json.data.lines.find((l) => l.boqItemId === itemA.id);
  assert.equal(line1.unitProjectId, u1.id, '选了清单项应自动带出单项工程');
  assert.equal(line1.amountTaxIncl, '36000.00', `80×450=36000，实际 ${line1.amountTaxIncl}`);
  assert.equal(line1.amountTaxExcl, '33027.20', `80×412.84（450/1.09）=33027.20，实际 ${line1.amountTaxExcl}`);
  assert.equal(saveLines.json.data.totalAmount, '34862.06', `33027.20+1834.86，实际 ${saveLines.json.data.totalAmount}`);
  // 未关联清单项且未选单项工程 → 400
  const noUnitLine = await cost(`/api/projects/${pid}/target-versions/${v1.id}/lines`, {
    method: 'PUT',
    body: { lines: [{ category: 'labor', summary: 'x', pricingMethod: 'LUMP_SUM', amount: '1', basisNote: 'b' }] },
  });
  assert.equal(noUnitLine.status, 400, '未关联清单项必须选单项工程');
  // 恢复正式明细
  await cost(`/api/projects/${pid}/target-versions/${v1.id}/lines`, {
    method: 'PUT',
    body: {
      lines: [
        { boqItemId: itemA.id, category: 'material', summary: '土方开挖', pricingMethod: 'QTY_PRICE', quantity: '80', unit: 'm3', unitPrice: '450', taxRate: '9', priceTaxIncl: true },
        { category: 'other', summary: '不可预见费', pricingMethod: 'LUMP_SUM', amount: '2000', taxRate: '9', priceTaxIncl: true, unitProjectId: u3.id, basisNote: '按费率暂列' },
      ],
    },
  });
  await cost(`/api/projects/${pid}/target-versions/${v1.id}/submit`, { method: 'POST', body: {} });
  assert.equal((await lead(`/api/projects/${pid}/target-versions/${v1.id}/approve`, { method: 'POST', body: { comment: '同意' } })).status, 200);

  // ===== 5. 实际成本（含税双口径 + 单项工程 + 确认）=====
  const e1 = (await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: {
      boqItemId: itemA.id, category: 'material', businessDate: '2026-11-05', period: '2026-11',
      summary: '土方结算一批', pricingMethod: 'QTY_PRICE', quantity: '40', unit: 'm3',
      unitPrice: '460', taxRate: '9', priceTaxIncl: true,
      counterparty: '土方班组A', sourceType: 'SETTLEMENT', sourceRef: 'JS-R6-001',
      idempotencyKey: idem(), submit: true,
    },
  })).json.data;
  assert.equal(e1.unitProjectId, u1.id, '实际单据应自动带出单项工程');
  assert.equal(e1.amountTaxIncl, '18400.00', `40×460=18400，实际 ${e1.amountTaxIncl}`);
  assert.equal(e1.amountTaxExcl, '16880.80', `40×422.02（460/1.09）=16880.80，实际 ${e1.amountTaxExcl}`);
  assert.equal(e1.amount, '16880.80', '正式金额口径为不含税');

  const selfConfirm = await cost(`/api/projects/${pid}/actual-entries/${e1.id}/confirm`, { method: 'POST', body: {} });
  assert.equal(selfConfirm.status, 403, '本人确认本人应 403');
  assert.equal((await lead(`/api/projects/${pid}/actual-entries/${e1.id}/confirm`, { method: 'POST', body: {} })).status, 200);
  note('4/5：目标与实际双口径金额正确（36000.00/33027.20、18400.00/16880.80），本人确认本人被拒', true);

  // ===== 6. 清单成本对比 =====
  const cmp = (await lead(`/api/projects/${pid}/cost-comparison`)).json.data;
  assert.equal(cmp.rows.length, 3, `3 条有效清单（合并后），实际 ${cmp.rows.length}`);
  for (const key of CATS) {
    assert.ok(Object.prototype.hasOwnProperty.call(cmp.rows[0], key), `行内缺少费用类别列 ${key}`);
    assert.ok(Object.prototype.hasOwnProperty.call(cmp.totals.byCategory, key), `合计缺少费用类别 ${key}`);
  }
  const rowA = cmp.rows.find((r) => r.itemName === '挖一般土方');
  assert.equal(rowA.unitProjectName, null, '不筛选单项工程时按名称跨工程汇总（前端显示为“全部”）');
  assert.equal(rowA.incomeTaxIncl, '54245.56');
  assert.equal(rowA.target, '33027.20');
  assert.equal(rowA.actual, '16880.80');
  assert.equal(rowA.material, '16880.80', '材料列取实际成本');
  assert.equal(rowA.diff, '31124.12', `48004.92-16880.80，实际 ${rowA.diff}`);
  assert.equal(cmp.unlinkedTargetCount, 1, '1 条目标明细未关联清单项');
  assert.equal(cmp.unitProjects.length, 3);

  const cmpU1 = (await lead(`/api/projects/${pid}/cost-comparison?unitProjectId=${u1.id}`)).json.data;
  assert.equal(cmpU1.rows.length, 2, `1#楼 应有 2 条清单，实际 ${cmpU1.rows.length}`);
  assert.ok(cmpU1.rows.every((r) => r.unitProjectName === '1#楼'), '筛选后按单项工程分行');

  const unlinked = (await lead(`/api/projects/${pid}/cost-comparison/unlinked`)).json.data;
  assert.equal(unlinked.targetLines.length, 1, '未分配成本池含 1 条目标明细');
  assert.equal(unlinked.targetLines[0].unitProjectName, '地下室');
  note('6：清单成本对比 8 类列齐备（含其他）、未分配成本池 1 条、单项工程筛选分行正确', true);

  // ===== 7. 过程成本统计 =====
  const cum = (await lead(`/api/projects/${pid}/process-costs?mode=cumulative&until=2026-11-30`)).json.data;
  assert.equal(cum.rows.length, 9, '8 大类 + 合计 = 9 行');
  assert.deepEqual(cum.rows.slice(0, 8).map((r) => r.key), CATS, '固定 8 大类顺序');
  assert.equal(cum.rows[8].key, 'total');
  assert.equal(cum.totals.target, '34862.06');
  assert.equal(cum.totals.budgetRevenue, '54839.78');
  assert.equal(cum.totals.actual, '16880.80');
  assert.equal(cum.totals.unallocatedRevenue, '6834.86', `预算收入未分摊部分，实际 ${cum.totals.unallocatedRevenue}`);
  const matRow = cum.rows.find((r) => r.key === 'material');
  assert.equal(matRow.target, '33027.20');
  assert.equal(matRow.actual, '16880.80');
  assert.equal(matRow.budgetRevenue, '48004.92', '材料类别预算收入按清单不含税合价分摊');

  const per = (await lead(`/api/projects/${pid}/process-costs?mode=period&period=2026-11&until=2026-11-30`)).json.data;
  assert.equal(per.mode, 'period');
  assert.equal(per.rows.length, 9);
  assert.equal(per.rows[8].diff, '37958.98', `54839.78-16880.80，实际 ${per.rows[8].diff}`);

  const fore = (await lead(`/api/projects/${pid}/process-costs?mode=forecast&until=2026-11-30`)).json.data;
  assert.equal(fore.mode, 'forecast');
  assert.equal(fore.totals.target, '34862.06');

  const drill = (await lead(`/api/projects/${pid}/process-costs/drilldown?category=material&mode=cumulative&until=2026-11-30`)).json.data;
  assert.equal(drill.targetLines.length, 1);
  assert.equal(drill.entries.length, 1);
  assert.equal((await lead(`/api/projects/${pid}/process-costs/drilldown?category=nope&mode=cumulative`)).status, 400, '非法类别 400');
  note('7：过程成本统计 本期/累计/预测 三视图与 8 类+合计行、类别下钻均正确', true);

  // ===== 8. 作废保护 + 已关联标记 =====
  const listNow = (await lead(`/api/projects/${pid}/boq-items`)).json.data;
  const linked = listNow.items.find((i) => i.id === itemA.id);
  assert.equal(linked.hasCost, true, '被成本关联的清单项应标记');
  assert.equal((await lead(`/api/projects/${pid}/boq-items/${itemA.id}/void`, { method: 'POST', body: {} })).status, 409, '被关联清单项禁止作废');
  const itemD = (await lead(`/api/projects/${pid}/boq-items`, {
    method: 'POST',
    body: { projectCategory: 'measure', unitProjectId: u2.id, itemName: '临时设施', unit: '项', quantity: '1', taxRate: '9', priceTaxIncl: true, unitPrice: '3000', idempotencyKey: idem() },
  })).json.data;
  assert.equal((await lead(`/api/projects/${pid}/boq-items/${itemD.id}/void`, { method: 'POST', body: {} })).status, 200, '未关联可作废');
  note('8：已关联成本标记与作废保护生效（被引用 409、未引用作废成功）', true);

  // ===== 9. 第五轮导入框架保留（映射模板可保存）=====
  const csv = '\ufeff分部名称,项目名称,单位,工程量,含税单价,备注列\n土石方工程,挖一般土方,m3,100,45.2,忽略我\n';
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from(csv, 'utf8')], { type: 'text/csv' }), 'boq-r6.csv');
  const preview = await cost(`/api/projects/${pid}/boq-imports/preview`, { method: 'POST', formData: fd });
  assert.equal(preview.status, 201, JSON.stringify(preview.json));
  const logId = preview.json.data.logId;
  const mapping = { 分部名称: 'sectionName', 项目名称: 'itemName', 单位: 'unit', 工程量: 'quantity', 含税单价: 'unitPrice', 备注列: 'ignore' };
  const saveMap = await cost(`/api/projects/${pid}/boq-imports/${logId}/mapping`, {
    method: 'POST', body: { mapping, templateName: 'R6 标准清单模板' },
  });
  assert.equal(saveMap.status, 200, JSON.stringify(saveMap.json));
  assert.ok(saveMap.json.data.templateId, '命名后应生成模板');
  const confirm = await cost(`/api/projects/${pid}/boq-imports/${logId}/confirm`, { method: 'POST', body: {} });
  assert.equal(confirm.status, 200);
  assert.match(confirm.json.meta?.message ?? '', /解析逻辑待模板确认后开放/);
  const templates = (await lead(`/api/projects/${pid}/boq-imports/templates`)).json.data;
  assert.ok(templates.some((t) => t.name === 'R6 标准清单模板'), '映射模板持久保存');
  note('9：第五轮导入框架保留，表头映射与命名模板保存正常', true);

  // ===== 10. 第四轮闭环（冲销净额）不被破坏 =====
  const rev = (await cost(`/api/projects/${pid}/actual-entries/${e1.id}/reversal-requests`, {
    method: 'POST', body: { reason: '结算金额有误', idempotencyKey: idem() },
  })).json.data;
  assert.equal((await lead(`/api/projects/${pid}/reversal-requests/${rev.id}/approve`, { method: 'POST', body: {} })).status, 200);
  const cmpAfter = (await lead(`/api/projects/${pid}/cost-comparison`)).json.data;
  assert.equal(cmpAfter.totals.actual, '0.00', '冲销后净额归零');
  const dup = await cost(`/api/projects/${pid}/actual-entries/${e1.id}/reversal-requests`, {
    method: 'POST', body: { reason: '重复冲销', idempotencyKey: idem() },
  });
  assert.equal(dup.status, 409, '禁止重复全额冲销');
  const del = await admin(`/api/projects/${pid}`, { method: 'DELETE', body: { code } });
  assert.equal(del.status, 409, '有正式业务的项目不得删除');
  note('10：第四轮目标→批准→实际→确认→冲销闭环完整，净额归零，重复冲销 409，删除保护生效', true);

  // ===== 11. 重登持久 =====
  const lead2 = makeClient(process.env.SMOKE_LEAD_USERNAME, process.env.SMOKE_LEAD_PASSWORD);
  await lead2.login();
  const relogin = (await lead2(`/api/projects/${pid}/unit-projects`)).json.data;
  assert.ok(relogin.some((u) => u.name === '1#楼'), '单项工程持久');
  const cmpRelogin = (await lead2(`/api/projects/${pid}/cost-comparison`)).json.data;
  assert.equal(cmpRelogin.rows.length, 3, '重登后清单成本对比数据一致');
  note('11：重新登录后单项工程、清单、成本数据持久保留', true);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length} 项通过，${failed.length} 项失败`);
  console.log(`验收项目保留供人工复核：${code}（${pid}）`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error('脚本执行失败：', e);
  process.exit(1);
});
