/**
 * 第五轮验收冒烟测试：清单项基础 + 成本明细（清单项可空 + 费用类别必选）+ 导入框架。
 * 覆盖验收 7 条：清单CRUD/合并/作废、导入框架（预览→映射→确认，不写数据）、
 * 目标编制（类别+清单项）→批准→汇总、实际登记→他人确认、本人确认本人拒绝、幂等、
 * 冲销净额、类别视图 7 行、清单项视图未关联计数、项目删除阻止、无授权 403、重登持久。
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
const num = (v) => Number(v);

async function main() {
  const admin = makeClient(process.env.SMOKE_ADMIN_USERNAME, process.env.SMOKE_ADMIN_PASSWORD);
  const lead = makeClient(process.env.SMOKE_LEAD_USERNAME, process.env.SMOKE_LEAD_PASSWORD);
  const cost = makeClient(process.env.SMOKE_COST_USERNAME, process.env.SMOKE_COST_PASSWORD);
  const field = makeClient(process.env.SMOKE_FIELD_USERNAME, process.env.SMOKE_FIELD_PASSWORD);
  for (const client of [admin, lead, cost, field]) await client.login();
  console.log('已登录：管理员 / 项目负责人 / 造价员 / 其他管理人员');

  const users = (await admin('/api/users')).json.data;
  const uid = (name) => users.find((u) => u.username === name).id;
  const [leadId, costId] = [uid(process.env.SMOKE_LEAD_USERNAME), uid(process.env.SMOKE_COST_USERNAME)];

  // ===== 建立验收项目 =====
  const suffix = Date.now().toString().slice(-6);
  const code = `R5-${suffix}`;
  const created = await admin('/api/projects', {
    method: 'POST',
    body: { code, name: `第五轮功能验收项目 ${suffix}`, description: '清单项基础＋费用类别验收' },
  });
  assert.equal(created.status, 201);
  const pid = created.json.data.id;
  for (const [userId, roleCode] of [[leadId, 'PROJECT_LEAD'], [costId, 'COST_ENGINEER']]) {
    const m = await admin(`/api/projects/${pid}/members`, { method: 'POST', body: { userId, roleCode } });
    assert.equal(m.status, 201);
  }
  console.log(`验收项目已建立：${code}（${pid}）`);

  // ===== 1. 清单项 CRUD =====
  const itemA = (await lead(`/api/projects/${pid}/boq-items`, {
    method: 'POST',
    body: { sectionCode: '01', sectionName: '土石方工程', itemName: '挖一般土方', itemFeature: '三类土', unit: 'm3', quantity: '1000.5', unitPriceTaxIncl: '45.20', unitPriceTaxExcl: '41.47', idempotencyKey: idem() },
  })).json.data;
  assert.ok(itemA?.id, JSON.stringify(itemA));
  assert.equal(itemA.amountTaxIncl, '45222.60', `1000.5×45.20=45222.60，实际 ${itemA.amountTaxIncl}`);
  assert.equal(itemA.amountTaxExcl, '41490.74', `1000.5×41.47=41490.735→41490.74，实际 ${itemA.amountTaxExcl}`);
  // 幂等重放
  const createKey = idem();
  const itemB = (await cost(`/api/projects/${pid}/boq-items`, {
    method: 'POST',
    body: { sectionName: '土石方工程', itemName: '挖一般土方', itemFeature: '三类土', unit: 'm3', quantity: '500', unitPriceTaxIncl: '45.20', unitPriceTaxExcl: '41.47', idempotencyKey: createKey },
  })).json.data;
  const itemBreplay = await cost(`/api/projects/${pid}/boq-items`, {
    method: 'POST',
    body: { sectionName: '土石方工程', itemName: '挖一般土方', itemFeature: '三类土', unit: 'm3', quantity: '500', unitPriceTaxIncl: '45.20', unitPriceTaxExcl: '41.47', idempotencyKey: createKey },
  });
  assert.equal(itemBreplay.json.data?.id, itemB.id, '同幂等键应返回同一清单项');
  const itemC = (await lead(`/api/projects/${pid}/boq-items`, {
    method: 'POST',
    body: { sectionName: '砌筑工程', itemName: '砖基础', itemFeature: 'M5砂浆', unit: 'm3', quantity: '120', unitPriceTaxIncl: '480', unitPriceTaxExcl: '440.37', idempotencyKey: idem() },
  })).json.data;
  // 编辑：合价后端重算
  const itemBupd = (await lead(`/api/projects/${pid}/boq-items/${itemB.id}`, {
    method: 'PATCH',
    body: { itemName: '挖一般土方', itemFeature: '三类土', unit: 'm3', quantity: '600', unitPriceTaxIncl: '45.20', unitPriceTaxExcl: '41.47' },
  })).json.data;
  assert.equal(itemBupd.amountTaxIncl, '27120.00', `600×45.20=27120.00，实际 ${itemBupd.amountTaxIncl}`);
  // 越权：其他管理人员（非成员）读 403；成员只读场景由 field 非成员覆盖
  const fieldList = await field(`/api/projects/${pid}/boq-items`);
  assert.equal(fieldList.status, 403, '非成员不得读取清单');
  // 列表汇总（仅 active）
  let list = (await lead(`/api/projects/${pid}/boq-items`)).json.data;
  assert.equal(list.items.length, 3);
  assert.equal(list.totals.amountTaxIncl, String((45222.60 + 27120.00 + 57600).toFixed(2)), '含税总合价');
  note('1a：清单项手动新增/编辑/幂等/汇总正确，非成员读取被拒', true);

  // ===== 2. 合并 =====
  // 条件不符：itemA（1000.5）与 itemC（砖基础，名称不同）不可合并
  const badMerge = await lead(`/api/projects/${pid}/boq-items/merge`, {
    method: 'POST', body: { itemIds: [itemA.id, itemC.id], primaryId: itemA.id },
  });
  assert.equal(badMerge.status, 400, '名称/特征/单位不一致应拒绝合并');
  // 成功：itemA + itemB（同名称/特征/单位）→ 工程量 1600.5，合价按 itemA 单价重算
  const merged = (await lead(`/api/projects/${pid}/boq-items/merge`, {
    method: 'POST', body: { itemIds: [itemA.id, itemB.id], primaryId: itemA.id },
  })).json.data;
  assert.equal(num(merged.quantity), 1600.5, `工程量应汇总 1000.5+600=1600.5，实际 ${merged.quantity}`);
  assert.equal(merged.amountTaxIncl, '72342.60', `1600.5×45.20=72342.60，实际 ${merged.amountTaxIncl}`);
  // 合并幂等
  const mergeReplay = await lead(`/api/projects/${pid}/boq-items/merge`, {
    method: 'POST', body: { itemIds: [itemA.id, itemB.id], primaryId: itemA.id },
  });
  assert.equal(mergeReplay.json.meta?.idempotent, true, '重复合并应幂等返回');
  list = (await lead(`/api/projects/${pid}/boq-items`)).json.data;
  assert.equal(list.items.length, 2, '主列表只显示 active（itemA 合并后 + itemC）');
  const mergedList = (await lead(`/api/projects/${pid}/boq-items?status=merged`)).json.data;
  assert.equal(mergedList.items.length, 1, '已合并记录可追溯');
  assert.equal(mergedList.items[0].mergedIntoId, itemA.id);
  note('2：同类合并工程量/合价汇总正确（1600.5 → 72342.60），条件不符拒绝，重复合并幂等', true);

  // ===== 3. 作废 =====
  // 先建一条将被成本引用的清单项
  const itemD = (await lead(`/api/projects/${pid}/boq-items`, {
    method: 'POST',
    body: { sectionName: '混凝土工程', itemName: 'C30 矩形柱', unit: 'm3', quantity: '80', unitPriceTaxIncl: '520', unitPriceTaxExcl: '477.06', idempotencyKey: idem() },
  })).json.data;
  // 未关联的可作废
  const itemE = (await lead(`/api/projects/${pid}/boq-items`, {
    method: 'POST', body: { itemName: '临时设施', unit: '项', quantity: '1', unitPriceTaxIncl: '3000', unitPriceTaxExcl: '2752.29', idempotencyKey: idem() },
  })).json.data;
  const voidE = await lead(`/api/projects/${pid}/boq-items/${itemE.id}/void`, { method: 'POST', body: {} });
  assert.equal(voidE.status, 200);
  assert.equal(voidE.json.data.status, 'void');
  list = (await lead(`/api/projects/${pid}/boq-items`)).json.data;
  assert.ok(!list.items.some((i) => i.id === itemE.id), '作废后不参与主列表');

  // ===== 4. 目标成本（清单项 + 费用类别）=====
  const v1 = (await cost(`/api/projects/${pid}/target-versions`, {
    method: 'POST',
    body: { versionName: 'V1 目标', effectiveDate: '2026-11-01', idempotencyKey: idem() },
  })).json.data;
  const saveLines = await cost(`/api/projects/${pid}/target-versions/${v1.id}/lines`, {
    method: 'PUT',
    body: {
      lines: [
        { boqItemId: itemD.id, category: 'material', summary: 'C30 商品砼', pricingMethod: 'QTY_PRICE', quantity: '80', unit: 'm3', unitPrice: '450' },
        { category: 'labor', summary: '砌筑人工', pricingMethod: 'LUMP_SUM', amount: '5000', basisNote: '班组包干' },
        { category: 'site_overhead', summary: '现场经费', pricingMethod: 'LUMP_SUM', amount: '2000', basisNote: '按取费标准' },
      ],
    },
  });
  assert.equal(saveLines.status, 200, JSON.stringify(saveLines.json));
  assert.equal(saveLines.json.data.totalAmount, '43000.00', `80×450+5000+2000=43000，实际 ${saveLines.json.data.totalAmount}`);
  // 缺类别应被拒
  const noCat = await cost(`/api/projects/${pid}/target-versions/${v1.id}/lines`, {
    method: 'PUT', body: { lines: [{ summary: 'x', pricingMethod: 'LUMP_SUM', amount: '1', basisNote: 'b' }] },
  });
  assert.equal(noCat.status, 400, '费用类别必填');
  // 伪造他项目清单项应被拒（用已作废 itemE 也验证非 active 拒绝）
  const voidRef = await cost(`/api/projects/${pid}/target-versions/${v1.id}/lines`, {
    method: 'PUT', body: { lines: [{ boqItemId: itemE.id, category: 'labor', summary: 'x', pricingMethod: 'LUMP_SUM', amount: '1', basisNote: 'b' }] },
  });
  assert.equal(voidRef.status, 400, '已作废清单项不得关联');

  await cost(`/api/projects/${pid}/target-versions/${v1.id}/submit`, { method: 'POST', body: {} });
  const approve = await lead(`/api/projects/${pid}/target-versions/${v1.id}/approve`, { method: 'POST', body: { comment: '同意' } });
  assert.equal(approve.status, 200);
  const sumT = (await lead(`/api/projects/${pid}/cost-summary`)).json.data;
  assert.equal(sumT.targetVersion.totalAmount, '43000.00');
  note('4：目标编制（清单项+费用类别）→提交→负责人批准→汇总 43000.00 正确', true);

  // ===== 5. 实际成本 + 职责分离 + 幂等 + 冲销 =====
  const e1 = (await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: { boqItemId: itemD.id, category: 'material', businessDate: '2026-11-05', period: '2026-11', summary: '砼进场一批', pricingMethod: 'QTY_PRICE', quantity: '40', unit: 'm3', unitPrice: '460', counterparty: '搅拌站A', sourceType: 'INVOICE', sourceRef: 'INV-001', idempotencyKey: idem(), submit: true },
  })).json.data;
  assert.equal(e1.amount, '18400.00');
  const eKey = idem();
  const e2 = (await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: { category: 'labor', businessDate: '2026-11-06', period: '2026-11', summary: '砌筑人工费', pricingMethod: 'LUMP_SUM', amount: '3000', basisNote: '进度结算', counterparty: '班组B', sourceType: 'SETTLEMENT', sourceRef: 'JS-002', idempotencyKey: eKey, submit: true },
  })).json.data;
  const e2replay = await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: { category: 'labor', businessDate: '2026-11-06', period: '2026-11', summary: '砌筑人工费', pricingMethod: 'LUMP_SUM', amount: '3000', basisNote: '进度结算', sourceType: 'SETTLEMENT', sourceRef: 'JS-002', idempotencyKey: eKey, submit: true },
  });
  assert.equal(e2replay.json.data.id, e2.id, '实际单据幂等重放');

  // 待确认不计入
  let sum = (await lead(`/api/projects/${pid}/cost-summary`)).json.data;
  assert.equal(sum.confirmedActualTotal, '0.00');
  assert.equal(sum.pendingActualTotal, '21400.00');

  // 本人确认本人被拒
  await admin(`/api/projects/${pid}/members/${costId}`, { method: 'PATCH', body: { roleCode: 'PROJECT_LEAD' } });
  const selfConfirm = await cost(`/api/projects/${pid}/actual-entries/${e1.id}/confirm`, { method: 'POST', body: {} });
  assert.equal(selfConfirm.status, 403);
  await admin(`/api/projects/${pid}/members/${costId}`, { method: 'PATCH', body: { roleCode: 'COST_ENGINEER' } });

  // 他人确认
  assert.equal((await lead(`/api/projects/${pid}/actual-entries/${e1.id}/confirm`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await lead(`/api/projects/${pid}/actual-entries/${e2.id}/confirm`, { method: 'POST', body: {} })).status, 200);
  sum = (await lead(`/api/projects/${pid}/cost-summary`)).json.data;
  assert.equal(sum.confirmedActualTotal, '21400.00');
  note('5：实际登记→非提交人确认→累计 21400.00；待确认不计入；本人确认本人 403；幂等重放有效', true);

  // 冲销：净额 + 重复拒绝
  const rev = (await cost(`/api/projects/${pid}/actual-entries/${e2.id}/reversal-requests`, {
    method: 'POST', body: { reason: '结算金额有误', idempotencyKey: idem() },
  })).json.data;
  assert.equal((await lead(`/api/projects/${pid}/reversal-requests/${rev.id}/approve`, { method: 'POST', body: {} })).status, 200);
  const dupRev = await cost(`/api/projects/${pid}/actual-entries/${e2.id}/reversal-requests`, {
    method: 'POST', body: { reason: '重复冲销', idempotencyKey: idem() },
  });
  assert.equal(dupRev.status, 409, '禁止重复全额冲销');
  sum = (await lead(`/api/projects/${pid}/cost-summary`)).json.data;
  assert.equal(sum.confirmedActualTotal, '18400.00', `21400-3000=18400，实际 ${sum.confirmedActualTotal}`);
  note('6：冲销全流程保留原记录，净额 18400.00 正确，重复冲销 409', true);

  // ===== 6. 两类汇总视图 =====
  // 类别视图：7 行全列，差额 = 目标 − 实际
  const cat = (await lead(`/api/projects/${pid}/cost-summary?view=category`)).json.data;
  assert.equal(cat.rows.length, 7, '类别视图必须 7 行');
  const mat = cat.rows.find((r) => r.key === 'material');
  assert.equal(mat.target, '36000.00');
  assert.equal(mat.actual, '18400.00');
  assert.equal(mat.diff, '17600.00', `36000-18400=17600，实际 ${mat.diff}`);
  const lab = cat.rows.find((r) => r.key === 'labor');
  assert.equal(lab.target, '5000.00');
  assert.equal(lab.actual, '0.00', '人工已全额冲销，净额 0');
  assert.equal(lab.entryCount, 2, '原记录+冲销记录共同计入条数');
  // 清单项视图：只有已关联的 itemD 一行 + 未关联计数
  const boq = (await lead(`/api/projects/${pid}/cost-summary?view=boqItem`)).json.data;
  assert.equal(boq.rows.length, 1, `仅 itemD 一行（目标2条未关联+实际1条未关联），实际 ${boq.rows.length}`);
  const rowD = boq.rows[0];
  assert.equal(rowD.itemName, 'C30 矩形柱');
  assert.equal(rowD.incomeTaxIncl, '41600.00', `清单收入合价 80×520=41600，实际 ${rowD.incomeTaxIncl}`);
  assert.equal(rowD.target, '36000.00');
  assert.equal(rowD.actual, '18400.00');
  assert.equal(rowD.diff, '17600.00');
  assert.equal(boq.unlinkedTargetCount, 2, '2 条目标明细未关联清单项');
  assert.equal(boq.unlinkedActualCount, 2, '2 条实际明细（人工原+冲销）未关联清单项');
  // 下钻
  const drill = (await lead(`/api/projects/${pid}/cost-summary/drilldown?view=boqItem&key=${itemD.id}&side=actual`)).json.data;
  assert.equal(drill.entries.length, 1);
  assert.equal(drill.entries[0].boqItemName, 'C30 矩形柱');
  note('7：类别视图 7 行差额正确；清单项视图仅已关联 1 行+收入合价 41600.00；未关联计数正确', true);

  // ===== 被引用的清单项禁止作废 =====
  const voidD = await lead(`/api/projects/${pid}/boq-items/${itemD.id}/void`, { method: 'POST', body: {} });
  assert.equal(voidD.status, 409, '已被成本明细关联的清单项禁止作废');
  note('8：作废保护生效（被引用 409；未引用 itemE 已作废成功）', true);

  // ===== 9. 导入框架 =====
  // 用 CSV 构造上传内容（服务端 XLSX.read 兼容 CSV，文件名校验允许 .csv；BOM 保中文）
  const csv = '﻿分部名称,项目名称,单位,工程量,含税单价,备注列\n土石方工程,挖一般土方,m3,100,45.2,忽略我\n';
  const buf = Buffer.from(csv, 'utf8');
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'text/csv' }), 'boq-test.csv');
  const preview = await cost(`/api/projects/${pid}/boq-imports/preview`, { method: 'POST', formData: fd });
  assert.equal(preview.status, 201, JSON.stringify(preview.json));
  const logId = preview.json.data.logId;
  assert.deepEqual(preview.json.data.headers, ['分部名称', '项目名称', '单位', '工程量', '含税单价', '备注列']);
  // 保存映射（命名模板）
  const mapping = { '分部名称': 'sectionName', '项目名称': 'itemName', '单位': 'unit', '工程量': 'quantity', '含税单价': 'unitPriceTaxIncl', '备注列': 'ignore' };
  const saveMap = await cost(`/api/projects/${pid}/boq-imports/${logId}/mapping`, {
    method: 'POST', body: { mapping, templateName: '标准清单模板' },
  });
  assert.equal(saveMap.status, 200, JSON.stringify(saveMap.json));
  assert.ok(saveMap.json.data.templateId, '命名后应生成模板');
  // 缺项目名称映射应被拒
  const fd2 = new FormData();
  fd2.append('file', new Blob([buf], { type: 'text/csv' }), 'boq-test2.csv');
  const preview2 = await cost(`/api/projects/${pid}/boq-imports/preview`, { method: 'POST', formData: fd2 });
  const logId2 = preview2.json.data.logId;
  const badMap = await cost(`/api/projects/${pid}/boq-imports/${logId2}/mapping`, {
    method: 'POST', body: { mapping: { ...mapping, '项目名称': 'ignore' } },
  });
  assert.equal(badMap.status, 400, '未映射项目名称应被拒');
  // 确认导入：不写数据
  const confirm = await cost(`/api/projects/${pid}/boq-imports/${logId}/confirm`, { method: 'POST', body: {} });
  assert.equal(confirm.status, 200);
  assert.match(confirm.json.meta?.message ?? '', /解析逻辑待模板确认后开放/);
  list = (await lead(`/api/projects/${pid}/boq-items`)).json.data;
  assert.equal(list.items.length, 3, '确认导入不得写入清单数据（仍为 itemA合并后/itemC/itemD）');
  // 模板与日志持久
  const templates = (await lead(`/api/projects/${pid}/boq-imports/templates`)).json.data;
  assert.ok(templates.some((t) => t.name === '标准清单模板'), '映射模板持久保存');
  const logs = (await lead(`/api/projects/${pid}/boq-imports`)).json.data;
  assert.ok(logs.length >= 2 && logs[0].fileName.endsWith('.csv'), '导入日志记录文件名/状态/时间');
  note('9：导入框架 上传→表头→映射→命名模板→确认（提示待解析，未写入数据），模板与日志持久', true);

  // ===== 10. 项目删除保护 + 无授权 =====
  const del = await admin(`/api/projects/${pid}`, { method: 'DELETE', body: { code } });
  assert.equal(del.status, 409, '存在正式业务（批准目标/确认成本/清单项）不得删除');
  assert.match(del.json.error.message, /归档/);
  const adminRead = await admin(`/api/projects/${pid}/cost-summary`);
  assert.equal(adminRead.status, 403, '未授权管理员不得读取成本');
  note('10：有正式业务的项目删除被拒（提示归档），未授权读取 403', true);

  // ===== 11. 重新登录数据保留 =====
  const lead2 = makeClient(process.env.SMOKE_LEAD_USERNAME, process.env.SMOKE_LEAD_PASSWORD);
  await lead2.login();
  const sumRelogin = (await lead2(`/api/projects/${pid}/cost-summary?view=boqItem`)).json.data;
  assert.equal(sumRelogin.rows[0]?.target, '36000.00');
  assert.equal(sumRelogin.confirmedActualTotal, '18400.00');
  const tplRelogin = (await lead2(`/api/projects/${pid}/boq-imports/templates`)).json.data;
  assert.ok(tplRelogin.some((t) => t.name === '标准清单模板'), '重登后映射模板仍在');
  note('11：重新登录后清单/汇总/映射模板持久保留', true);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length} 项通过，${failed.length} 项失败`);
  console.log(`验收项目保留供人工复核：${code}（${pid}）`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error('脚本执行失败：', e);
  process.exit(1);
});
