/**
 * 第八轮验收冒烟：清单成本测算大宽表
 * 覆盖：自动合并 / 展开子行、互斥录入、第 9/10 列联动、加权平均与差异标记、
 *      成本状态切换、默认税率维护、子表台账按类别过滤。
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
  const request = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(jar.get('zs_csrf') && !['GET', 'HEAD', 'OPTIONS'].includes(method)
          ? { 'x-csrf-token': jar.get('zs_csrf') }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
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

async function main() {
  const admin = makeClient(process.env.SMOKE_ADMIN_USERNAME, process.env.SMOKE_ADMIN_PASSWORD);
  const lead = makeClient(process.env.SMOKE_LEAD_USERNAME, process.env.SMOKE_LEAD_PASSWORD);
  const cost = makeClient(process.env.SMOKE_COST_USERNAME, process.env.SMOKE_COST_PASSWORD);
  for (const c of [admin, lead, cost]) await c.login();
  console.log('已登录：管理员 / 项目负责人 / 造价员');

  const users = (await admin('/api/users')).json.data;
  const uid = (name) => users.find((u) => u.username === name).id;
  const suffix = Date.now().toString().slice(-6);
  const created = await admin('/api/projects', {
    method: 'POST',
    body: { code: `R8-${suffix}`, name: `第八轮验收项目 ${suffix}`, description: '测算大宽表' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const pid = created.json.data.id;
  for (const [userId, roleCode] of [
    [uid(process.env.SMOKE_LEAD_USERNAME), 'PROJECT_LEAD'],
    [uid(process.env.SMOKE_COST_USERNAME), 'COST_ENGINEER'],
  ]) {
    assert.equal(
      (await admin(`/api/projects/${pid}/members`, { method: 'POST', body: { userId, roleCode } })).status,
      201,
    );
  }
  console.log(`验收项目：R8-${suffix}（${pid}）`);

  const u1 = (await lead(`/api/projects/${pid}/unit-projects`, { method: 'POST', body: { name: '1#楼' } })).json.data;
  const u2 = (await lead(`/api/projects/${pid}/unit-projects`, { method: 'POST', body: { name: '2#楼' } })).json.data;

  const mkBoq = (unitProjectId, quantity) =>
    lead(`/api/projects/${pid}/boq-items`, {
      method: 'POST',
      body: {
        projectCategory: 'divisional',
        unitProjectId,
        sectionName: '混凝土工程',
        itemName: '现浇混凝土矩形梁',
        itemFeature: 'C30 泵送',
        unit: 'm3',
        quantity,
        taxRate: '9',
        priceTaxIncl: false,
        unitPrice: '500',
        idempotencyKey: idem(),
      },
    });
  const b1 = (await mkBoq(u1.id, '100')).json.data;
  const b2 = (await mkBoq(u2.id, '50')).json.data;
  assert.ok(b1?.id && b2?.id, '清单项创建成功');

  // ---- 1. 自动合并：同名+特征+单位跨单项工程合并为一行 ----
  const cmp1 = (await cost(`/api/projects/${pid}/cost-comparison`)).json.data;
  assert.equal(cmp1.rows.length, 1, `相同清单应合并为 1 行，实际 ${cmp1.rows.length}`);
  const parent = cmp1.rows[0];
  assert.equal(parent.isMerged, true, '合并行应标记 isMerged');
  assert.equal(parent.children?.length, 2, '展开应有 2 个单项工程子行');
  assert.equal(parent.children[0].boqId, b1.id);
  assert.equal(parent.quantity, '150', '合并工程量为 150');
  note('自动合并：同名+特征+单位合并为一行，[+] 展开 2 个单项工程子行', true);

  // ---- 2. 互斥录入：人工单价 → 第 10/9 列联动 ----
  const save1 = await cost(`/api/projects/${pid}/cost-estimates`, {
    method: 'PUT',
    body: { boqItemId: b1.id, actualQuantity: '100', laborPrice: '30', materialPrice: '20', costStatus: 'PREDICTED' },
  });
  assert.equal(save1.status, 200, JSON.stringify(save1.json));
  let cmp = (await cost(`/api/projects/${pid}/cost-comparison`)).json.data;
  let child1 = cmp.rows[0].children.find((c) => c.boqId === b1.id);
  assert.equal(child1.unitCost, '50.00', '人工30+材料20=50');
  assert.equal(child1.cost, '5000.00', '100×50=5000');
  assert.equal(child1.costTaxIncl, '5350.00', '含税 = 100×30×1.03 + 100×20×1.13');
  note('人工/材料联动：实际单价=50、预测成本=5000、含税成本=5350', true, `含税 ${child1.costTaxIncl}`);

  // ---- 3. 互斥校验：分包与人工/材料不可同时录入 ----
  const conflict = await cost(`/api/projects/${pid}/cost-estimates`, {
    method: 'PUT',
    body: { boqItemId: b1.id, subcontractPrice: '80', laborPrice: '30' },
  });
  assert.equal(conflict.status, 400, '互斥冲突应返回 400');
  note('互斥校验：专业分包与人工/材料同时录入被拒绝', true, conflict.json?.error?.message ?? '');

  // ---- 4. 分包录入：第 10 列 = 分包单价 ----
  const save2 = await cost(`/api/projects/${pid}/cost-estimates`, {
    method: 'PUT',
    body: { boqItemId: b1.id, actualQuantity: '100', subcontractPrice: '80', laborPrice: null, materialPrice: null },
  });
  assert.equal(save2.status, 200, JSON.stringify(save2.json));
  cmp = (await cost(`/api/projects/${pid}/cost-comparison`)).json.data;
  child1 = cmp.rows[0].children.find((c) => c.boqId === b1.id);
  assert.equal(child1.unitCost, '80.00', '填分包时实际单价=分包单价');
  assert.equal(child1.cost, '8000.00');
  note('分包录入：实际单价=分包单价 80，预测成本=8000', true);

  // ---- 5. 子行差异化 + 父行加权平均 + 差异标记 ----
  await cost(`/api/projects/${pid}/cost-estimates`, {
    method: 'PUT',
    body: { boqItemId: b2.id, actualQuantity: '50', subcontractPrice: '60' },
  });
  cmp = (await cost(`/api/projects/${pid}/cost-comparison`)).json.data;
  const p2 = cmp.rows[0];
  // (80×100 + 60×50) / 150 = 73.3333… → 73.33
  assert.equal(p2.unitCost, '73.33', `父行加权平均应为 73.33，实际 ${p2.unitCost}`);
  assert.equal(p2.hasDiffPrice, true, '子行单价不一致应标记差异化');
  assert.equal(p2.cost, '11000.00', '父行成本 = 8000 + 3000');
  note('父行加权平均与差异标记：实际单价 73.33、成本 11000、已标记差异化', true);

  // ---- 6. 全空回退目标成本 ----
  await cost(`/api/projects/${pid}/cost-estimates`, {
    method: 'PUT',
    body: { boqItemId: b1.id, actualQuantity: '100', laborPrice: null, materialPrice: null, subcontractPrice: null },
  });
  cmp = (await cost(`/api/projects/${pid}/cost-comparison`)).json.data;
  child1 = cmp.rows[0].children.find((c) => c.boqId === b1.id);
  assert.equal(child1.unitCost, null, '全空时实际单价为空');
  assert.equal(child1.cost, child1.target, '全空时预测成本回退目标成本');
  note('全空回退：实际单价为空、预测成本回退目标成本', true, `目标 ${child1.target}`);

  // ---- 7. 成本状态：默认预测，可切已定标 ----
  assert.equal(child1.costStatus, 'PREDICTED', '默认预测');
  const fixed = await cost(`/api/projects/${pid}/cost-estimates`, {
    method: 'PUT',
    body: { boqItemId: b1.id, costStatus: 'FIXED' },
  });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.json));
  assert.equal(fixed.json.data.costStatus, 'FIXED');
  note('成本状态：默认 PREDICTED，可切换 FIXED（已定标）', true);

  // ---- 8. 默认不含税税率维护 ----
  const rates = await cost(`/api/projects/${pid}/default-tax-rates`, {
    method: 'PUT',
    body: { laborTaxRate: '3', materialTaxRate: '13', subcontractTaxRate: '9' },
  });
  assert.equal(rates.status, 200, JSON.stringify(rates.json));
  assert.equal(rates.json.data.labor, '3.00');
  assert.equal(rates.json.data.material, '13.00');
  assert.equal(rates.json.data.subcontract, '9.00');
  const cmpRates = (await cost(`/api/projects/${pid}/cost-comparison`)).json.data.defaultTaxRates;
  assert.equal(cmpRates.material, '13.00', '宽表返回默认税率');
  note('默认税率：人工 3% / 材料 13% / 分包 9% 可读写', true);

  // ---- 9. 子表 2-6 台账：按费用类别过滤 ----
  const entry = await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: {
      unitProjectId: u1.id,
      category: 'machine',
      period: '2026-11',
      description: '塔吊租赁',
      vendorName: '某机械租赁公司',
      pricingMethod: 'QTY_PRICE',
      quantity: '2',
      unit: '台班',
      unitPrice: '800',
      taxRate: '13',
      priceTaxIncl: false,
      idempotencyKey: idem(),
    },
  });
  assert.equal(entry.status, 201, JSON.stringify(entry.json));
  const machineList = (await cost(`/api/projects/${pid}/actual-entries?category=machine`)).json.data;
  const measureList = (await cost(`/api/projects/${pid}/actual-entries?category=measure`)).json.data;
  assert.equal(machineList.length, 1, '机械类别应返回 1 条');
  assert.equal(measureList.length, 0, '措施费类别应为空');
  note('子表 2-6：台账按费用类别过滤生效（机械 1 条 / 措施费 0 条）', true);

  // ---- 10. 第九轮：台账直接修改（含成本状态）与物理删除 ----
  const eid = entry.json.data.id;
  assert.equal(entry.json.data.costStatus, 'PREDICTED', '台账默认预测');
  assert.equal(entry.json.data.status, 'CONFIRMED', '台账录入即计入大盘');
  const patched = await cost(`/api/projects/${pid}/actual-entries/${eid}`, {
    method: 'PATCH',
    body: {
      unitProjectId: u1.id,
      category: 'machine',
      period: '2026-11',
      description: '塔吊租赁（改）',
      vendorName: '某机械租赁公司',
      pricingMethod: 'QTY_PRICE',
      quantity: '3',
      unit: '台班',
      unitPrice: '900',
      taxRate: '13',
      priceTaxIncl: false,
      costStatus: 'FIXED',
    },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  assert.equal(patched.json.data.description, '塔吊租赁（改）');
  assert.equal(patched.json.data.costStatus, 'FIXED');
  assert.equal(patched.json.data.amount, '2700.00');
  note('台账修改：描述/单价/数量直接覆盖，成本状态可切已定标', true, patched.json.data.amount);

  // ---- 11. 第十轮：过程成本统计时间语义（目标/预测不回溯，实际按成本周期） ----
  const pcNov = (await cost(`/api/projects/${pid}/process-costs?mode=period&period=2026-11&caliber=excl`)).json.data;
  const pcOct = (await cost(`/api/projects/${pid}/process-costs?mode=period&period=2026-10&caliber=excl`)).json.data;
  assert.equal(pcNov.totals.target, pcOct.totals.target, '目标成本不应随月份变化');
  assert.equal(pcNov.totals.predicted, pcOct.totals.predicted, '预测成本不应随月份变化');
  assert.equal(Number(pcNov.totals.actual) > 0, true, '本期实际应抓取成本周期等于所选月份的数据');
  assert.equal(Number(pcOct.totals.actual), 0, '其他月份本期实际应为 0');
  note(
    '过程统计：目标/预测不随月份变化，实际按成本周期筛选',
    true,
    `目标 ${pcNov.totals.target} / 预测 ${pcNov.totals.predicted} / 11月实际 ${pcNov.totals.actual} / 10月实际 ${pcOct.totals.actual}`,
  );

  // ---- 12. 第十二轮：项目公共（不选单项工程）+ 按总额登记 ----
  const lump = await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: {
      unitProjectId: null,
      category: 'site_overhead',
      period: '2026-11',
      description: '管理人员工资',
      pricingMethod: 'LUMP_SUM',
      amount: '8000',
      taxRate: '0',
      priceTaxIncl: true,
      costStatus: 'PREDICTED',
      idempotencyKey: idem(),
    },
  });
  assert.equal(lump.status, 201, JSON.stringify(lump.json));
  assert.equal(lump.json.data.unitProjectId, null, '允许项目公共（无单项工程）');
  assert.equal(lump.json.data.quantity, null, '按总额登记不产生数量');
  assert.equal(lump.json.data.amountTaxIncl, '8000.00');
  note('项目公共 + 按总额登记：单项工程可为空，金额完整保存', true, lump.json.data.amountTaxIncl);
  await cost(`/api/projects/${pid}/actual-entries/${lump.json.data.id}`, { method: 'DELETE' });

  // ---- 12b. 第十二轮：空字符串可选项必须按 null 处理，不得报 min(1) ----
  const blank = await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: {
      unitProjectId: '',
      boqItemId: '',
      vendorName: '',
      category: 'other',
      period: '2026-11',
      description: '空串兼容性测试',
      pricingMethod: 'LUMP_SUM',
      amount: '1200',
      taxRate: '0',
      priceTaxIncl: true,
      idempotencyKey: idem(),
    },
  });
  assert.equal(blank.status, 201, JSON.stringify(blank.json));
  assert.equal(blank.json.data.unitProjectId, null);
  assert.equal(blank.json.data.vendorName, null);
  note('空字符串选填项：自动按 null 保存，无 min(1) 报错', true, blank.json.data.amountTaxExcl);
  await cost(`/api/projects/${pid}/actual-entries/${blank.json.data.id}`, { method: 'DELETE' });

  // ---- 13. 第十三轮：总账台账无成本周期（计入累计、不计入本期） ----
  const noPeriod = await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: {
      unitProjectId: null,
      category: 'other',
      period: null,
      description: '无周期总账费用',
      pricingMethod: 'LUMP_SUM',
      amount: '500',
      taxRate: '0',
      priceTaxIncl: true,
      idempotencyKey: idem(),
    },
  });
  assert.equal(noPeriod.status, 201, JSON.stringify(noPeriod.json));
  assert.equal(noPeriod.json.data.period, null, '总账台账不保存成本周期');
  const cum = (await cost(`/api/projects/${pid}/process-costs?mode=cumulative&period=2026-11&caliber=excl`)).json.data;
  const cur = (await cost(`/api/projects/${pid}/process-costs?mode=period&period=2026-11&caliber=excl`)).json.data;
  assert.equal(
    Number(cum.totals.actualCumulative) - Number(cur.totals.actualPeriod),
    500,
    '无周期台账应计入累计、不计入本期',
  );
  note('总账台账无成本周期：计入累计、不计入本期', true, `累计 ${cum.totals.actualCumulative} / 本期 ${cur.totals.actualPeriod}`);
  await cost(`/api/projects/${pid}/actual-entries/${noPeriod.json.data.id}`, { method: 'DELETE' });

  const removed = await cost(`/api/projects/${pid}/actual-entries/${eid}`, { method: 'DELETE' });
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  const afterDelete = (await cost(`/api/projects/${pid}/actual-entries?category=machine`)).json.data;
  assert.equal(afterDelete.length, 0, '物理删除后应查不到');
  note('台账删除：二次确认后物理删除，列表与大盘同步消失', true);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n合计 ${results.length} 项，失败 ${failed} 项`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('❌ 冒烟失败：', e.message);
  process.exit(1);
});
