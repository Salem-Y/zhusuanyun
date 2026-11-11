/**
 * 第七轮验收冒烟测试：去财务化结算录入、含税/不含税口径联动、实际工程量、
 * 未分配成本池、过程统计趋势与供应商聚合，以及第六轮能力回归。
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
  const request = async (path, { method = 'GET', body, formData } = {}) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
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

async function main() {
  const admin = makeClient(process.env.SMOKE_ADMIN_USERNAME, process.env.SMOKE_ADMIN_PASSWORD);
  const lead = makeClient(process.env.SMOKE_LEAD_USERNAME, process.env.SMOKE_LEAD_PASSWORD);
  const cost = makeClient(process.env.SMOKE_COST_USERNAME, process.env.SMOKE_COST_PASSWORD);
  for (const c of [admin, lead, cost]) await c.login();
  console.log('已登录：管理员 / 项目负责人 / 造价员');

  const users = (await admin('/api/users')).json.data;
  const uid = (name) => users.find((u) => u.username === name).id;
  const suffix = Date.now().toString().slice(-6);
  const code = `R7-${suffix}`;
  const created = await admin('/api/projects', {
    method: 'POST',
    body: { code, name: `第七轮验收项目 ${suffix}`, description: '去财务化＋口径联动＋图表' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const pid = created.json.data.id;
  for (const [userId, roleCode] of [[uid(process.env.SMOKE_LEAD_USERNAME), 'PROJECT_LEAD'], [uid(process.env.SMOKE_COST_USERNAME), 'COST_ENGINEER']]) {
    assert.equal((await admin(`/api/projects/${pid}/members`, { method: 'POST', body: { userId, roleCode } })).status, 201);
  }
  console.log(`验收项目：${code}（${pid}）`);

  // ---- 第六轮能力回归：单项工程 + 三分类 + 税率反算 ----
  const unit = (await lead(`/api/projects/${pid}/unit-projects`, { method: 'POST', body: { name: '1#楼' } })).json.data;
  const boq = (await lead(`/api/projects/${pid}/boq-items`, {
    method: 'POST',
    body: {
      projectCategory: 'divisional', unitProjectId: unit.id, sectionName: '土石方工程',
      itemName: '挖一般土方', itemFeature: '三类土', unit: 'm3',
      quantity: '100', taxRate: '9', priceTaxIncl: true, unitPrice: '109',
      idempotencyKey: idem(),
    },
  })).json.data;
  assert.equal(boq.unitPriceTaxExcl, '100.00', 'R6 含税/不含税反算仍生效');
  assert.equal(boq.amountTaxIncl, '10900.00');
  assert.equal(boq.amountTaxExcl, '10000.00');
  assert.equal((await lead(`/api/projects/${pid}/boq-items?projectCategory=measure`)).json.data.items.length, 0);
  note('R6 回归：单项工程、三分类、税率反算与 3/2 位精度未被破坏', true);

  // ---- 1. 数据清洗：成本说明必填、旧财务字段被忽略 ----
  const noDesc = await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: {
      boqItemId: boq.id, category: 'material', period: '2026-11',
      pricingMethod: 'QTY_PRICE', quantity: '1', unit: 'm3', unitPrice: '109', taxRate: '9',
      idempotencyKey: idem(),
    },
  });
  assert.equal(noDesc.status, 400, '缺少成本说明应被拒');

  const target = (await cost(`/api/projects/${pid}/target-versions`, {
    method: 'POST', body: { versionName: 'V1 目标', effectiveDate: '2026-11-01', idempotencyKey: idem() },
  })).json.data;
  const lines = await cost(`/api/projects/${pid}/target-versions/${target.id}/lines`, {
    method: 'PUT',
    body: {
      lines: [
        {
          boqItemId: boq.id, category: 'material', summary: '土方目标', pricingMethod: 'LUMP_SUM',
          amount: '3000', taxRate: '9', priceTaxIncl: false, unitProjectId: unit.id,
          basisNote: '按合同暂列',
        },
      ],
    },
  });
  assert.equal(lines.status, 200, JSON.stringify(lines.json));
  assert.equal(lines.json.data.totalAmount, '3000.00', '目标按不含税口径：3000');
  await cost(`/api/projects/${pid}/target-versions/${target.id}/submit`, { method: 'POST', body: {} });
  assert.equal((await lead(`/api/projects/${pid}/target-versions/${target.id}/approve`, { method: 'POST', body: { comment: '同意' } })).status, 200);

  // ---- 2. 极简录入 + 确认结算（本人可确认，不走复核流）----
  const e1Res = await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: {
      boqItemId: boq.id, category: 'material', period: '2026-11',
      description: '11 月土方结算', vendorName: '福州某某土方队',
      pricingMethod: 'QTY_PRICE', quantity: '12.5', unit: 'm3',
      unitPrice: '109', taxRate: '9', priceTaxIncl: true,
      // 旧财务字段即使被前端误传也不应落库
      sourceType: 'INVOICE', sourceRef: 'FA-001', counterparty: '旧交易对象',
      idempotencyKey: idem(),
    },
  });
  assert.equal(e1Res.status, 201, JSON.stringify(e1Res.json));
  const e1 = e1Res.json.data;
  assert.equal(e1.status, 'DRAFT', '默认保存为草稿');
  assert.equal(e1.description, '11 月土方结算');
  assert.equal(e1.vendorName, '福州某某土方队');
  assert.equal(e1.period, '2026-11');
  assert.equal(e1.unitProjectId, unit.id, '选清单项自动带出单项工程');
  assert.equal(e1.amountTaxIncl, '1362.50', `12.5×109=1362.5，实际 ${e1.amountTaxIncl}`);
  assert.equal(e1.amountTaxExcl, '1250.00');
  assert.equal(Object.prototype.hasOwnProperty.call(e1, 'sourceType'), false, '返回体不再包含来源类型');
  assert.equal(Object.prototype.hasOwnProperty.call(e1, 'summary'), false, '返回体不再包含摘要');
  const selfConfirm = await cost(`/api/projects/${pid}/actual-entries/${e1.id}/confirm`, {
    method: 'POST', body: {},
  });
  assert.equal(selfConfirm.status, 200, '确认结算允许本人操作（已废除复核流）');
  const detail = (await cost(`/api/projects/${pid}/actual-entries/${e1.id}`)).json.data;
  assert.equal(detail.status, 'CONFIRMED');
  assert.ok(detail.reviewedById, '确认人已记录');
  note('1/2：录入仅含说明/供应商/周期/量价；旧财务字段被忽略；确认结算一步计入实际成本', true);

  // 未分配成本（机械费无法对应清单）
  const e2Res = await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: {
      unitProjectId: unit.id, category: 'machine', period: '2026-11',
      description: '11 月挖掘机租赁', vendorName: '某机械租赁公司',
      pricingMethod: 'LUMP_SUM', amount: '500', taxRate: '9', priceTaxIncl: true,
      basisNote: '按月租赁结算',
      idempotencyKey: idem(),
    },
  });
  assert.equal(e2Res.status, 201, JSON.stringify(e2Res.json));
  const e2 = e2Res.json.data;
  assert.equal((await cost(`/api/projects/${pid}/actual-entries/${e2.id}/confirm`, { method: 'POST', body: {} })).status, 200);
  assert.equal(e2.amountTaxExcl, '458.72', `500/1.09=458.72，实际 ${e2.amountTaxExcl}`);

  // ---- 3. 口径联动：含税 / 不含税 ----
  const excl = (await lead(`/api/projects/${pid}/cost-comparison?caliber=excl`)).json.data;
  const incl = (await lead(`/api/projects/${pid}/cost-comparison?caliber=incl`)).json.data;
  assert.equal(excl.caliber, 'excl');
  assert.equal(incl.caliber, 'incl');
  const rowExcl = excl.rows.find((r) => r.boqIds.includes(boq.id));
  const rowIncl = incl.rows.find((r) => r.boqIds.includes(boq.id));
  assert.equal(rowExcl.income, '10000.00');
  assert.equal(rowIncl.income, '10900.00');
  assert.equal(rowExcl.target, '3000.00');
  assert.equal(rowIncl.target, '3270.00', `3000×1.09=3270，实际 ${rowIncl.target}`);
  assert.equal(rowExcl.actual, '1250.00');
  assert.equal(rowIncl.actual, '1362.50');
  assert.equal(rowExcl.actualQuantity, '12.5', `实际工程量 12.5，实际 ${rowExcl.actualQuantity}`);
  assert.equal(rowExcl.diff, '8750.00', `10000-1250，实际 ${rowExcl.diff}`);
  assert.equal(rowIncl.diff, '9537.50', `10900-1362.5，实际 ${rowIncl.diff}`);
  assert.equal(rowExcl.material, '1250.00', '8 类明细列随口径变化');
  assert.equal(rowIncl.material, '1362.50');
  assert.equal(excl.totals.actualQuantity, '12.5');
  note('3：口径切换下 收入/目标/实际/差额/8 类明细/实际工程量 全部实时重算', true);

  // ---- 4. 未分配成本池（只读接口）----
  const unlinked = (await lead(`/api/projects/${pid}/cost-comparison/unlinked`)).json.data;
  assert.equal(unlinked.entries.length, 1, '1 条未分配实际成本');
  assert.equal(unlinked.entries[0].description, '11 月挖掘机租赁');
  assert.equal(unlinked.entries[0].vendorName, '某机械租赁公司');
  assert.equal(unlinked.targetLines.length, 0, '目标明细均已关联清单项');
  note('4：未分配成本池按说明/供应商只读返回，可独立录入机械费等支出', true);

  // ---- 5. 过程统计：趋势 + 口径 + 类别下钻（供应商聚合数据源）----
  const procExcl = (await lead(`/api/projects/${pid}/process-costs?mode=cumulative&until=2026-11-30&caliber=excl`)).json.data;
  assert.equal(procExcl.caliber, 'excl');
  assert.equal(procExcl.rows.length, 9, '8 大类 + 合计');
  assert.equal(procExcl.totals.actual, '1708.72', `1250+458.72，实际 ${procExcl.totals.actual}`);
  assert.equal(procExcl.totals.budgetRevenue, '10000.00');
  assert.equal(procExcl.trend.length, 1, '按月份聚合出 1 个点');
  assert.equal(procExcl.trend[0].month, '2026-11');
  assert.equal(procExcl.trend[0].actual, '1708.72');

  const procIncl = (await lead(`/api/projects/${pid}/process-costs?mode=cumulative&until=2026-11-30&caliber=incl`)).json.data;
  assert.equal(procIncl.totals.actual, '1862.50', `1362.5+500，实际 ${procIncl.totals.actual}`);
  assert.equal(procIncl.totals.budgetRevenue, '10900.00');
  assert.equal(procIncl.trend[0].actual, '1862.50');

  const period = (await lead(`/api/projects/${pid}/process-costs?mode=period&period=2026-11&until=2026-11-30&caliber=excl`)).json.data;
  assert.equal(period.mode, 'period');
  assert.equal(period.totals.actual, '1708.72');

  const drill = (await lead(`/api/projects/${pid}/process-costs/drilldown?category=machine&mode=cumulative&until=2026-11-30`)).json.data;
  assert.equal(drill.entries.length, 1);
  assert.equal(drill.entries[0].vendorName, '某机械租赁公司', '供应商聚合数据源齐备');
  note('5：过程统计趋势按结算月份聚合、三种视图与口径联动、类别下钻含供应商', true);

  // ---- 6. 冲销仍可用（API 级），净额回零 ----
  const rr = (await cost(`/api/projects/${pid}/actual-entries/${e1.id}/reversal-requests`, {
    method: 'POST', body: { reason: '结算金额有误', idempotencyKey: idem() },
  })).json.data;
  assert.equal((await lead(`/api/projects/${pid}/reversal-requests/${rr.id}/approve`, { method: 'POST', body: {} })).status, 200);
  const afterReversal = (await lead(`/api/projects/${pid}/cost-comparison?caliber=excl`)).json.data;
  const rowAfter = afterReversal.rows.find((r) => r.boqIds.includes(boq.id));
  assert.equal(rowAfter.actual, '0.00', '冲销后净额归零');
  assert.equal(rowAfter.actualQuantity, '0', '冲销后工程量净额归零');
  note('6：冲销链路仍可用，负向记录计入净额且不重复累加工程量', true);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length} 项通过，${failed.length} 项失败`);
  console.log(`验收项目保留：${code}（${pid}）`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error('脚本执行失败：', e);
  process.exit(1);
});
