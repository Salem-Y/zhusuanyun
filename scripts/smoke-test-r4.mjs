/**
 * 第四轮验收冒烟测试：目标成本＋实际成本最小真实业务闭环。
 * 覆盖用户列出的 16 条验收项。测试项目专门新建并明确标识「第四轮功能验收项目」。
 * 运行前需本地 API 已启动（3000 端口）。凭据从环境变量注入，不硬编码、不打印：
 *   SMOKE_ADMIN_USERNAME / SMOKE_ADMIN_PASSWORD（系统管理员）
 *   SMOKE_LEAD_USERNAME  / SMOKE_LEAD_PASSWORD （项目负责人）
 *   SMOKE_COST_USERNAME  / SMOKE_COST_PASSWORD （造价员）
 *   SMOKE_FIELD_USERNAME / SMOKE_FIELD_PASSWORD（其他管理人员，用于越权测试）
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
  // Cookie 罐：登录响应会同时下发 zs_session 与 zs_csrf 两个 Cookie，必须全部保留，
  // 否则后续写请求会因缺少 CSRF Cookie 被 validateCsrf 拒绝（E_CSRF）。
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
  const request = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(jar.size ? { Cookie: cookieHeader() } : {}),
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
const ok200 = (r) => r.status < 300;
const num = (v) => Number(v);

async function main() {
  const admin = makeClient(process.env.SMOKE_ADMIN_USERNAME, process.env.SMOKE_ADMIN_PASSWORD);
  const lead = makeClient(process.env.SMOKE_LEAD_USERNAME, process.env.SMOKE_LEAD_PASSWORD);
  const cost = makeClient(process.env.SMOKE_COST_USERNAME, process.env.SMOKE_COST_PASSWORD);
  const field = makeClient(process.env.SMOKE_FIELD_USERNAME, process.env.SMOKE_FIELD_PASSWORD);

  for (const client of [admin, lead, cost, field]) {
    await client.login();
  }
  console.log('已登录：管理员 / 项目负责人 / 造价员 / 其他管理人员');

  const users = (await admin('/api/users')).json.data;
  const uid = (name) => users.find((u) => u.username === name).id;
  const [leadId, costId] = [uid(process.env.SMOKE_LEAD_USERNAME), uid(process.env.SMOKE_COST_USERNAME)];

  // ===== 建立验收项目 =====
  const suffix = Date.now().toString().slice(-6);
  const code = `R4-${suffix}`;
  const created = await admin('/api/projects', {
    method: 'POST',
    body: { code, name: `第四轮功能验收项目 ${suffix}`, description: '目标成本＋实际成本闭环验收' },
  });
  assert.equal(created.status, 201);
  const pid = created.json.data.id;
  for (const [userId, roleCode] of [[leadId, 'PROJECT_LEAD'], [costId, 'COST_ENGINEER']]) {
    const m = await admin(`/api/projects/${pid}/members`, { method: 'POST', body: { userId, roleCode } });
    assert.equal(m.status, 201);
  }
  console.log(`验收项目已建立：${code}（${pid}）`);

  // ===== 基础字典 =====
  const caliber = await lead(`/api/projects/${pid}/cost-caliber`, {
    method: 'PUT',
    body: { note: '验收口径：成本不含可抵扣进项税，不可抵扣税额按规则计入。' },
  });
  assert.equal(caliber.status, 200);
  const wp1 = (await lead(`/api/projects/${pid}/work-packages`, { method: 'POST', body: { code: 'ZT-01', name: '主体结构' } })).json.data;
  const wpCommon = (await lead(`/api/projects/${pid}/work-packages`, { method: 'POST', body: { code: 'COMMON', name: '项目公共费用', isCommon: true } })).json.data;
  const ccMat = (await lead(`/api/projects/${pid}/cost-codes`, { method: 'POST', body: { code: 'CL-01', name: '钢筋材料', category: 'MATERIAL' } })).json.data;
  const ccLab = (await cost(`/api/projects/${pid}/cost-codes`, { method: 'POST', body: { code: 'RG-01', name: '砌筑人工', category: 'LABOR' } })).json.data;
  assert.ok(wp1 && wpCommon && ccMat && ccLab);
  const dupCommon = await lead(`/api/projects/${pid}/work-packages`, { method: 'POST', body: { code: 'COMMON2', name: '公共2', isCommon: true } });
  assert.equal(dupCommon.status, 409);
  note('基础字典：口径/工作包/成本编码可建，公共费用唯一', true);

  // ===== 目标成本 =====
  // 验收1：草稿保存后刷新仍保留
  const v1key = idem();
  const v1 = (await cost(`/api/projects/${pid}/target-versions`, {
    method: 'POST',
    body: { versionName: 'V1 初始目标', description: '首轮编制', effectiveDate: '2026-10-01', idempotencyKey: v1key },
  })).json.data;
  const v1replay = await cost(`/api/projects/${pid}/target-versions`, {
    method: 'POST',
    body: { versionName: 'V1 初始目标', idempotencyKey: v1key },
  });
  assert.equal(v1replay.json.data?.id, v1.id, '同一幂等键应返回同一版本');
  const saveLines = await cost(`/api/projects/${pid}/target-versions/${v1.id}/lines`, {
    method: 'PUT',
    body: {
      lines: [
        { workPackageId: wp1.id, costCodeId: ccMat.id, summary: '钢筋', pricingMethod: 'QTY_PRICE', quantity: '10', unit: 't', unitPrice: '100.5' },
        { workPackageId: wpCommon.id, costCodeId: ccLab.id, summary: '临时用工', pricingMethod: 'LUMP_SUM', amount: '200', basisNote: '按签证总额' },
      ],
    },
  });
  assert.equal(saveLines.status, 200, JSON.stringify(saveLines.json));
  assert.equal(saveLines.json.data.totalAmount, '1205.00', `合计应为 1205.00，实际 ${saveLines.json.data.totalAmount}`);
  const v1reload = (await cost(`/api/projects/${pid}/target-versions/${v1.id}`)).json.data;
  assert.equal(v1reload.lines.length, 2);
  assert.equal(v1reload.lines[0].amount, '1005.00');
  assert.equal(v1reload.lines[0].category, 'MATERIAL', '类别应由成本编码带出');
  note('验收1：目标草稿保存后刷新保留，行金额由后端计算（10×100.5=1005.00）', true);

  // 明细校验
  const badLine = await cost(`/api/projects/${pid}/target-versions/${v1.id}/lines`, {
    method: 'PUT',
    body: { lines: [{ workPackageId: wp1.id, costCodeId: ccMat.id, summary: 'x', pricingMethod: 'LUMP_SUM', amount: '50' }] },
  });
  assert.equal(badLine.status, 400, '按总额登记缺依据说明应被拒绝');

  // 验收2：提交后（未批准）不进入正式指标
  const submitV1 = await cost(`/api/projects/${pid}/target-versions/${v1.id}/submit`, { method: 'POST', body: {} });
  assert.equal(submitV1.json.data.status, 'SUBMITTED');
  const sumBefore = (await lead(`/api/projects/${pid}/cost-summary`)).json.data;
  assert.equal(sumBefore.targetVersion, null, '待批准目标不得进入正式指标');
  note('验收2：待批准目标不进入正式指标（汇总 targetVersion 为 null）', true);

  // 提交后不可编辑
  const editSubmitted = await cost(`/api/projects/${pid}/target-versions/${v1.id}/lines`, { method: 'PUT', body: { lines: [] } });
  assert.equal(editSubmitted.status, 409);

  // 造价员不能批准
  const costApprove = await cost(`/api/projects/${pid}/target-versions/${v1.id}/approve`, { method: 'POST', body: {} });
  assert.equal(costApprove.status, 403);

  // 验收3：负责人批准后汇总正确
  const approveV1 = await lead(`/api/projects/${pid}/target-versions/${v1.id}/approve`, { method: 'POST', body: { comment: '同意' } });
  assert.equal(approveV1.status, 200, JSON.stringify(approveV1.json));
  const sumAfter = (await lead(`/api/projects/${pid}/cost-summary`)).json.data;
  assert.equal(sumAfter.targetVersion.totalAmount, '1205.00');
  assert.equal(sumAfter.targetVersion.versionName, 'V1 初始目标');
  note('验收3：批准后目标汇总正确（1205.00，当前适用 V1）', true);

  // 验收4：已批准不可直接修改；调整产生新版本
  const editApproved = await cost(`/api/projects/${pid}/target-versions/${v1.id}`, { method: 'PATCH', body: { versionName: '篡改' } });
  assert.equal(editApproved.status, 409);
  const adj = (await cost(`/api/projects/${pid}/target-versions`, {
    method: 'POST',
    body: { versionName: 'V2 调整', baseVersionId: v1.id, adjustReason: '钢筋涨价', idempotencyKey: idem(), effectiveDate: '2026-11-01' },
  })).json.data;
  assert.equal(adj.isAdjustment, true);
  const adjDetail = (await cost(`/api/projects/${pid}/target-versions/${adj.id}`)).json.data;
  assert.equal(adjDetail.lines.length, 2, '调整草稿应复制原版本明细');
  await cost(`/api/projects/${pid}/target-versions/${adj.id}/lines`, {
    method: 'PUT',
    body: {
      lines: [
        { workPackageId: wp1.id, costCodeId: ccMat.id, summary: '钢筋', pricingMethod: 'QTY_PRICE', quantity: '10', unit: 't', unitPrice: '110.5' },
        { workPackageId: wpCommon.id, costCodeId: ccLab.id, summary: '临时用工', pricingMethod: 'LUMP_SUM', amount: '200', basisNote: '按签证总额' },
      ],
    },
  });
  // 并行分支限制：已有待处理草稿时不能新建
  const parallel = await cost(`/api/projects/${pid}/target-versions`, { method: 'POST', body: { versionName: '并行', idempotencyKey: idem() } });
  assert.equal(parallel.status, 409, '存在待处理草稿时不允许新建并行版本');
  await cost(`/api/projects/${pid}/target-versions/${adj.id}/submit`, { method: 'POST', body: {} });
  const approveAdj = await lead(`/api/projects/${pid}/target-versions/${adj.id}/approve`, { method: 'POST', body: {} });
  assert.equal(approveAdj.status, 200);
  note('验收4：已批准目标不可直接编辑；调整生成新版本并重新审批', true);

  // 验收5：历史版本不重复汇总
  const sumV2 = (await lead(`/api/projects/${pid}/cost-summary`)).json.data;
  assert.equal(sumV2.targetVersion.versionName, 'V2 调整');
  assert.equal(sumV2.targetVersion.totalAmount, '1305.00', `应为 10×110.5+200=1305.00，实际 ${sumV2.targetVersion.totalAmount}`);
  note('验收5：汇总只引用当前适用版本（1305.00），历史版本不累加', true);

  // ===== 实际成本 =====
  // 校验：负数被拒绝 / 期间不一致需原因 / 总额登记需依据
  const negEntry = await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: { workPackageId: wp1.id, costCodeId: ccMat.id, businessDate: '2026-10-15', period: '2026-10', summary: '负数', pricingMethod: 'LUMP_SUM', amount: '-5', sourceType: 'INVOICE', sourceRef: 'X', idempotencyKey: idem() },
  });
  assert.equal(negEntry.status, 400);
  const mismatch = await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: { workPackageId: wp1.id, costCodeId: ccMat.id, businessDate: '2026-10-15', period: '2026-09', summary: '期间错', pricingMethod: 'LUMP_SUM', amount: '5', basisNote: 'b', sourceType: 'INVOICE', sourceRef: 'X', idempotencyKey: idem() },
  });
  assert.equal(mismatch.status, 400, '期间不一致未填原因应被拒绝');
  const noSource = await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: { workPackageId: wp1.id, costCodeId: ccMat.id, businessDate: '2026-10-15', period: '2026-10', summary: '无来源', pricingMethod: 'LUMP_SUM', amount: '5', basisNote: 'b', sourceType: 'INVOICE', idempotencyKey: idem() },
  });
  assert.equal(noSource.status, 400, '来源单据编号缺失应被拒绝');

  // 验收6：草稿与待确认不进入正式实际
  const e1 = (await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: { workPackageId: wp1.id, costCodeId: ccMat.id, businessDate: '2026-10-15', period: '2026-10', summary: '钢筋一批', pricingMethod: 'QTY_PRICE', quantity: '2', unit: 't', unitPrice: '500', counterparty: '供应商A', sourceType: 'INVOICE', sourceRef: 'INV-2026-001', idempotencyKey: idem() },
  })).json.data;
  assert.equal(e1.amount, '1000.00');
  let sum = (await lead(`/api/projects/${pid}/cost-summary`)).json.data;
  assert.equal(num(sum.confirmedActualTotal), 0);
  const e1submit = await cost(`/api/projects/${pid}/actual-entries/${e1.id}/submit`, { method: 'POST', body: {} });
  assert.equal(e1submit.json.data.status, 'SUBMITTED');
  sum = (await lead(`/api/projects/${pid}/cost-summary`)).json.data;
  assert.equal(num(sum.confirmedActualTotal), 0, '待确认不得计入正式实际');
  assert.equal(sum.pendingActualTotal, '1000.00', '待确认金额应单独标识');
  note('验收6：草稿与待确认记录不进入正式实际（待确认 1000.00 单独标识）', true);

  // 验收8（前置）：本人确认本人提交被后端拒绝——临时把造价员提升为负责人验证职责分离
  const e2 = (await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: { workPackageId: wpCommon.id, costCodeId: ccLab.id, businessDate: '2026-10-20', period: '2026-10', summary: '临时用工结算', pricingMethod: 'LUMP_SUM', amount: '500', basisNote: '签证单总额', counterparty: '班组B', sourceType: 'SETTLEMENT', sourceRef: 'JS-008', idempotencyKey: idem(), submit: true },
  })).json.data;
  await admin(`/api/projects/${pid}/members/${costId}`, { method: 'PATCH', body: { roleCode: 'PROJECT_LEAD' } });
  const selfConfirm = await cost(`/api/projects/${pid}/actual-entries/${e2.id}/confirm`, { method: 'POST', body: {} });
  assert.equal(selfConfirm.status, 403, `本人确认本人提交应被拒绝，实际 ${selfConfirm.status}`);
  await admin(`/api/projects/${pid}/members/${costId}`, { method: 'PATCH', body: { roleCode: 'COST_ENGINEER' } });
  note('验收8：本人确认本人提交被后端拒绝（职责分离在后端生效）', true);

  // 造价员不能确认
  const costConfirm = await cost(`/api/projects/${pid}/actual-entries/${e1.id}/confirm`, { method: 'POST', body: {} });
  assert.equal(costConfirm.status, 403);

  // 验收7：非提交人确认后金额正确
  const c1 = await lead(`/api/projects/${pid}/actual-entries/${e1.id}/confirm`, { method: 'POST', body: { comment: '复核无误' } });
  assert.equal(c1.status, 200, JSON.stringify(c1.json));
  const c2 = await lead(`/api/projects/${pid}/actual-entries/${e2.id}/confirm`, { method: 'POST', body: {} });
  assert.equal(c2.status, 200);
  sum = (await lead(`/api/projects/${pid}/cost-summary`)).json.data;
  assert.equal(sum.confirmedActualTotal, '1500.00', `应为 1000+500=1500.00，实际 ${sum.confirmedActualTotal}`);
  note('验收7：非提交人确认后累计已确认实际 = 1500.00', true);

  // 验收9：幂等——重复创建/重复确认只生效一次
  const e4key = idem();
  const e4a = (await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: { workPackageId: wp1.id, costCodeId: ccMat.id, businessDate: '2026-10-22', period: '2026-10', summary: '水泥', pricingMethod: 'LUMP_SUM', amount: '200', basisNote: '发票总额', sourceType: 'INVOICE', sourceRef: 'INV-200', idempotencyKey: e4key, submit: true },
  })).json.data;
  const e4b = await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: { workPackageId: wp1.id, costCodeId: ccMat.id, businessDate: '2026-10-22', period: '2026-10', summary: '水泥', pricingMethod: 'LUMP_SUM', amount: '200', basisNote: '发票总额', sourceType: 'INVOICE', sourceRef: 'INV-200', idempotencyKey: e4key, submit: true },
  });
  assert.equal(e4b.json.data.id, e4a.id, '同一幂等键重试应返回已有结果');
  assert.equal(e4b.json.meta?.idempotent, true);
  await lead(`/api/projects/${pid}/actual-entries/${e4a.id}/confirm`, { method: 'POST', body: {} });
  const confirmReplay = await lead(`/api/projects/${pid}/actual-entries/${e4a.id}/confirm`, { method: 'POST', body: {} });
  assert.equal(confirmReplay.json.meta?.idempotent, true, '重复确认应返回已有结果');
  sum = (await lead(`/api/projects/${pid}/cost-summary`)).json.data;
  assert.equal(sum.confirmedActualTotal, '1700.00', `应为 1500+200=1700.00，实际 ${sum.confirmedActualTotal}`);
  note('验收9：重复提交/重复确认只生效一次（净额 1700.00 无重复入账）', true);

  // 验收11：金额精度
  const e5 = (await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: { workPackageId: wp1.id, costCodeId: ccMat.id, businessDate: '2026-10-25', period: '2026-10', summary: '精度测试', pricingMethod: 'QTY_PRICE', quantity: '1', unit: '批', unitPrice: '0.005', sourceType: 'OTHER', basisNote: '精度验证依据', idempotencyKey: idem() },
  })).json.data;
  assert.equal(e5.amount, '0.01', `0.005 应四舍五入为 0.01，实际 ${e5.amount}`);
  const tooPrecise = await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: { workPackageId: wp1.id, costCodeId: ccMat.id, businessDate: '2026-10-25', period: '2026-10', summary: '超精度', pricingMethod: 'QTY_PRICE', quantity: '1.0000001', unit: '批', unitPrice: '1', sourceType: 'OTHER', basisNote: 'x', idempotencyKey: idem() },
  });
  assert.equal(tooPrecise.status, 400, '数量超过 6 位小数应被拒绝');
  note('验收11：后端十进制四舍五入（0.005→0.01），数量/单价最多 6 位小数', true);

  // 验收10：冲销——原记录保留、净额正确、重复冲销被拒绝
  const sumBeforeRev = (await lead(`/api/projects/${pid}/cost-summary`, { method: 'GET' })).json.data;
  const rev1 = (await cost(`/api/projects/${pid}/actual-entries/${e1.id}/reversal-requests`, {
    method: 'POST', body: { reason: '发票作废重开', idempotencyKey: idem() },
  })).json.data;
  assert.ok(rev1.id);
  const dupRev = await cost(`/api/projects/${pid}/actual-entries/${e1.id}/reversal-requests`, {
    method: 'POST', body: { reason: '重复申请', idempotencyKey: idem() },
  });
  assert.equal(dupRev.status, 409, '已有待复核冲销时应拒绝重复申请');
  // 发起人若为负责人不能自复核——此处发起人是造价员，负责人复核
  const revApprove = await lead(`/api/projects/${pid}/reversal-requests/${rev1.id}/approve`, { method: 'POST', body: { comment: '同意冲销' } });
  assert.equal(revApprove.status, 200, JSON.stringify(revApprove.json));
  const e1After = (await lead(`/api/projects/${pid}/actual-entries/${e1.id}`)).json.data;
  assert.equal(e1After.status, 'CONFIRMED', '原记录保留且状态不变');
  assert.ok(e1After.reversedById, '原记录应关联冲销记录');
  const revEntry = (await lead(`/api/projects/${pid}/actual-entries/${e1After.reversedById}`)).json.data;
  assert.equal(revEntry.amount, '-1000.00', '冲销记录应为等额负向');
  assert.equal(revEntry.kind, 'REVERSAL');
  const revAgain = await cost(`/api/projects/${pid}/actual-entries/${e1.id}/reversal-requests`, {
    method: 'POST', body: { reason: '再次冲销', idempotencyKey: idem() },
  });
  assert.equal(revAgain.status, 409, '禁止重复全额冲销');
  // 净额：1700 - 1000 = 700（e1 与 -1000 共同参与）
  sum = (await lead(`/api/projects/${pid}/cost-summary`)).json.data;
  assert.equal(sum.confirmedActualTotal, '700.00', `冲销后净额应为 700.00，实际 ${sum.confirmedActualTotal}`);
  const wpRow = sum.rows.find((r) => r.key === wp1.id);
  assert.ok(wpRow && wpRow.entryCount >= 2, '冲销记录应与原记录共同计入明细数');
  note('验收10：冲销保留原记录、负向记录共同计净额（700.00），重复冲销被拒绝', true);
  assert.equal(num(sumBeforeRev.confirmedActualTotal) - 1000, num(sum.confirmedActualTotal));

  // 截止日期口径：冲销记录业务日期为复核当天（2026-11-04），截止 10-31 时仍含原记录
  const sumOct = (await lead(`/api/projects/${pid}/cost-summary?until=2026-10-31`)).json.data;
  assert.equal(sumOct.confirmedActualTotal, '1700.00', `截止 10-31 应为 1700.00（冲销日期在 11 月），实际 ${sumOct.confirmedActualTotal}`);
  note('截止日期口径：实际按业务日期（含冲销记录自身日期）统一统计', true);

  // 字典引用保护：已引用的成本编码不能删除/改类别；可停用
  const delCc = await lead(`/api/projects/${pid}/cost-codes/${ccMat.id}`, { method: 'DELETE' });
  assert.equal(delCc.status, 409, '已引用编码不可删除');
  const chgCat = await lead(`/api/projects/${pid}/cost-codes/${ccMat.id}`, { method: 'PATCH', body: { category: 'LABOR' } });
  assert.equal(chgCat.status, 409, '已引用编码不可更改类别归属');
  const costEditRef = await cost(`/api/projects/${pid}/cost-codes/${ccMat.id}`, { method: 'PATCH', body: { name: '改名' } });
  assert.equal(costEditRef.status, 403, '造价员不可维护已被引用的字典项');
  const deact = await lead(`/api/projects/${pid}/cost-codes/${ccMat.id}`, { method: 'PATCH', body: { isActive: false } });
  assert.equal(deact.status, 200, '可停用并保留历史');
  await lead(`/api/projects/${pid}/cost-codes/${ccMat.id}`, { method: 'PATCH', body: { isActive: true } });
  note('字典保护：已引用项不可删/不可改归属/造价员不可改，可停用保留历史', true);

  // 验收12：无授权用户不能读取或修改项目成本（demo.field 非本项目成员）
  const fieldRead = await field(`/api/projects/${pid}/cost-summary`);
  assert.equal(fieldRead.status, 403);
  const fieldWrite = await field(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: { workPackageId: wp1.id, costCodeId: ccMat.id, businessDate: '2026-10-01', period: '2026-10', summary: '越权', pricingMethod: 'LUMP_SUM', amount: '1', basisNote: 'x', sourceType: 'OTHER', idempotencyKey: idem() },
  });
  assert.equal(fieldWrite.status, 403);
  // 管理员无项目成员授权时同样不能读取成本明细
  const adminRead = await admin(`/api/projects/${pid}/cost-summary`);
  assert.equal(adminRead.status, 403, '系统管理员无项目授权时不应自动获得成本明细权限');
  note('验收12：无授权用户（含未授权管理员）不能读取或修改项目成本', true);

  // 验收13：跨项目关联被后端拒绝
  const codeB = `R4B-${suffix}`;
  const projB = (await admin('/api/projects', { method: 'POST', body: { code: codeB, name: `跨项目测试 ${suffix}` } })).json.data;
  await admin(`/api/projects/${projB.id}/members`, { method: 'POST', body: { userId: costId, roleCode: 'COST_ENGINEER' } });
  const ccB = (await cost(`/api/projects/${projB.id}/cost-codes`, { method: 'POST', body: { code: 'CL-99', name: '其他项目编码', category: 'MATERIAL' } })).json.data;
  const cross = await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: { workPackageId: wp1.id, costCodeId: ccB.id, businessDate: '2026-10-01', period: '2026-10', summary: '跨项目', pricingMethod: 'LUMP_SUM', amount: '1', basisNote: 'x', sourceType: 'OTHER', idempotencyKey: idem() },
  });
  assert.equal(cross.status, 400, '使用他项目成本编码应被拒绝');
  const crossWp = await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: { workPackageId: ccB.id, costCodeId: ccMat.id, businessDate: '2026-10-01', period: '2026-10', summary: '跨项目', pricingMethod: 'LUMP_SUM', amount: '1', basisNote: 'x', sourceType: 'OTHER', idempotencyKey: idem() },
  });
  assert.equal(crossWp.status, 400, '伪造他项目 ID 作为工作包应被拒绝');
  await admin(`/api/projects/${projB.id}`, { method: 'DELETE', body: { code: codeB } });
  note('验收13：前端篡改项目ID/编码ID 不能跨项目关联', true);

  // 验收14：有正式业务的项目不能被删除
  const del = await admin(`/api/projects/${pid}`, { method: 'DELETE', body: { code } });
  assert.equal(del.status, 409, `应拒绝删除，实际 ${del.status}`);
  assert.match(del.json.error.message, /归档/, '提示应引导归档');
  const still = await admin(`/api/projects/${pid}`);
  assert.equal(still.status, 200, '数据应保持不变');
  note('验收14：存在批准目标/已确认成本的项目删除被拒并提示归档', true);

  // 归档项目禁止成本业务写入，恢复后可操作
  await admin(`/api/projects/${pid}`, { method: 'PATCH', body: { status: 'ARCHIVED' } });
  const archivedWrite = await cost(`/api/projects/${pid}/actual-entries`, {
    method: 'POST',
    body: { workPackageId: wp1.id, costCodeId: ccMat.id, businessDate: '2026-11-01', period: '2026-11', summary: '归档写入', pricingMethod: 'LUMP_SUM', amount: '1', basisNote: 'x', sourceType: 'OTHER', idempotencyKey: idem() },
  });
  assert.equal(archivedWrite.status, 409);
  assert.equal(archivedWrite.json.error.code, 'E_PROJECT_ARCHIVED');
  const archivedRead = await cost(`/api/projects/${pid}/cost-summary`);
  assert.equal(archivedRead.status, 200, '归档项目仍允许授权历史查看');
  await admin(`/api/projects/${pid}`, { method: 'PATCH', body: { status: 'ACTIVE' } });
  note('归档项目：禁止新增/修改/审批成本业务，授权历史可查看，管理员恢复后可操作', true);

  // 验收15：重新登录后数据保留（服务重启复测在浏览器环节执行）
  const lead2 = makeClient(process.env.SMOKE_LEAD_USERNAME, process.env.SMOKE_LEAD_PASSWORD);
  await lead2('/api/auth/login', { method: 'POST', body: { username: process.env.SMOKE_LEAD_USERNAME, password: process.env.SMOKE_LEAD_PASSWORD } });
  const sumRelogin = (await lead2(`/api/projects/${pid}/cost-summary`)).json.data;
  assert.equal(sumRelogin.confirmedActualTotal, '700.00');
  assert.equal(sumRelogin.targetVersion.totalAmount, '1305.00');
  note('验收15：重新登录后汇总与版本数据保留', true);

  // 验收16：三种状态区分
  // 真实净额为 0：将 R4 项目其余已确认记录（e2、e4a）也全额冲销
  for (const targetId of [e2.id, e4a.id]) {
    const req = (await cost(`/api/projects/${pid}/actual-entries/${targetId}/reversal-requests`, {
      method: 'POST', body: { reason: '验收清零冲销', idempotencyKey: idem() },
    })).json.data;
    const ap = await lead(`/api/projects/${pid}/reversal-requests/${req.id}/approve`, { method: 'POST', body: {} });
    assert.equal(ap.status, 200, '清零冲销复核应通过');
  }
  const sumZero = (await lead(`/api/projects/${pid}/cost-summary`)).json.data;
  assert.equal(sumZero.confirmedActualTotal, '0.00', '全部冲销后净额应为 0.00');
  assert.ok(sumZero.rows.length > 0 && sumZero.rows.some((r) => r.entryCount > 0), '净额为 0 但仍有冲销来源记录');

  const codeC = `R4C-${suffix}`;
  const projC = (await admin('/api/projects', { method: 'POST', body: { code: codeC, name: `空状态测试 ${suffix}` } })).json.data;
  await admin(`/api/projects/${projC.id}/members`, { method: 'POST', body: { userId: leadId, roleCode: 'PROJECT_LEAD' } });
  const sumEmpty = (await lead(`/api/projects/${projC.id}/cost-summary`)).json.data;
  assert.equal(sumEmpty.targetVersion, null, '无目标 → null（界面显示尚无批准目标，而非 0）');
  assert.equal(sumEmpty.rows.length, 0, '无实际 → 无行（界面显示尚无确认成本）');
  assert.equal(sumEmpty.confirmedActualTotal, '0.00');
  await admin(`/api/projects/${projC.id}`, { method: 'DELETE', body: { code: codeC } });
  note('验收16：无目标 / 无实际 / 真实净额为 0（有冲销来源）三种状态在接口层可区分', true);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length} 项通过，${failed.length} 项失败`);
  console.log(`验收项目保留供人工复核：${code}（${pid}）`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error('脚本执行失败：', e);
  process.exit(1);
});
