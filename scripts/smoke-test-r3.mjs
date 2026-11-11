// 第三轮验收：遗留演示账号清理、系统角色权限、项目编码修改、项目删除规则。
// 用法：node scripts/smoke-test-r3.mjs [baseUrl]
// 凭据通过环境变量传入，不写死口令：
//   SMOKE_ADMIN_USER/PASS、SMOKE_COST_USER/PASS、SMOKE_LEAD_USER/PASS
// 测试只操作本脚本新建的 R3-* 项目，不删除任何已有示例项目。

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
}

class Client {
  constructor() {
    this.cookies = new Map();
    this.token = '';
  }
  storeCookies(response) {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const item of raw) {
      const [pair] = item.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '' || /Max-Age=0/i.test(item)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    this.token = this.cookies.get('zs_csrf') ?? '';
  }
  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async request(path, options = {}) {
    const response = await fetch(`${BASE}/api${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Cookie: this.cookieHeader(),
        'x-csrf-token': this.token,
        ...(options.headers ?? {}),
      },
      redirect: 'manual',
    });
    this.storeCookies(response);
    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
    return { status: response.status, payload };
  }
  login(username, password) {
    return this.request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  }
}

function creds(prefix, optional = false) {
  const username = process.env[`${prefix}_USER`];
  const password = process.env[`${prefix}_PASS`];
  if (!username || !password) {
    if (optional) return null;
    console.error(`缺少环境变量 ${prefix}_USER / ${prefix}_PASS`);
    process.exit(2);
  }
  return { username, password };
}

async function main() {
  const stamp = Date.now();

  const adminCreds = creds('SMOKE_ADMIN');
  const costCreds = creds('SMOKE_COST');
  const leadCreds = creds('SMOKE_LEAD');
  const managerCreds = creds('SMOKE_MANAGER', true);

  const admin = new Client();
  const cost = new Client();
  const lead = new Client();

  record('管理员登录', (await admin.login(adminCreds.username, adminCreds.password)).status === 200);
  record('造价员登录', (await cost.login(costCreds.username, costCreds.password)).status === 200);
  record('项目负责人登录', (await lead.login(leadCreds.username, leadCreds.password)).status === 200);

  // 1. 已删除的遗留演示账号：无法登录、不在账号列表
  if (managerCreds) {
    const legacy = new Client();
    const legacyLogin = await legacy.login(managerCreds.username, managerCreds.password);
    record('已删除的遗留演示账号无法登录', legacyLogin.status === 401, `status=${legacyLogin.status}`);
  }
  const users = await admin.request('/users');
  const hasLegacy = (users.payload?.data ?? []).some((u) => u.username === 'demo.manager');
  record('账号列表不再包含 demo.manager', users.status === 200 && !hasLegacy);

  // 2. 管理员改编码：创建测试项目 A（空项目）与 B（带成员）
  const codeA = `R3-A-${stamp}`;
  const codeB = `R3-B-${stamp}`;
  const createdA = await admin.request('/projects', {
    method: 'POST',
    body: JSON.stringify({ code: codeA, name: 'R3 删除测试项目', description: '删除规则验证' }),
  });
  record('管理员创建空测试项目', createdA.status === 201, `status=${createdA.status}`);
  const idA = createdA.payload?.data?.id;

  const createdB = await admin.request('/projects', {
    method: 'POST',
    body: JSON.stringify({ code: codeB, name: 'R3 编码修改测试项目', description: '编码修改与关联验证' }),
  });
  record('管理员创建编码测试项目', createdB.status === 201, `status=${createdB.status}`);
  const idB = createdB.payload?.data?.id;

  const members = await admin.request('/users');
  const costUser = (members.payload?.data ?? []).find((u) => u.username === costCreds.username);
  await admin.request(`/projects/${idB}/members`, {
    method: 'POST',
    body: JSON.stringify({ userId: costUser.id, roleCode: 'COST_ENGINEER' }),
  });

  // 3. 编码修改
  const newCodeB = `${codeB}-NEW`;
  const renamed = await admin.request(`/projects/${idB}`, {
    method: 'PATCH',
    body: JSON.stringify({ code: newCodeB.toLowerCase(), expectedCode: codeB }),
  });
  record(
    '管理员修改项目编码成功且统一为大写',
    renamed.status === 200 && renamed.payload?.data?.code === newCodeB,
    `code=${renamed.payload?.data?.code}`,
  );

  const emptyCode = await admin.request(`/projects/${idB}`, {
    method: 'PATCH',
    body: JSON.stringify({ code: '   ', expectedCode: newCodeB }),
  });
  record('空编码被拒绝', emptyCode.status === 400, `status=${emptyCode.status}`);

  const tooShort = await admin.request(`/projects/${idB}`, {
    method: 'PATCH',
    body: JSON.stringify({ code: 'X', expectedCode: newCodeB }),
  });
  record('过短编码被拒绝', tooShort.status === 400, `status=${tooShort.status}`);

  const dupCode = await admin.request(`/projects/${idA}`, {
    method: 'PATCH',
    body: JSON.stringify({ code: newCodeB.toLowerCase() }),
  });
  record('重复编码（大小写不同）被拒绝', dupCode.status === 409, `status=${dupCode.status}`);

  const stale = await admin.request(`/projects/${idB}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: '并发覆盖测试', expectedCode: codeB }),
  });
  record('并发冲突不静默覆盖', stale.status === 409, `status=${stale.status}`);

  const leadPatch = await lead.request(`/projects/${idB}`, {
    method: 'PATCH',
    body: JSON.stringify({ code: `${newCodeB}-X`, expectedCode: newCodeB }),
  });
  record('非管理员不能修改编码', leadPatch.status === 403, `status=${leadPatch.status}`);
  const costPatch = await cost.request(`/projects/${idB}`, {
    method: 'PATCH',
    body: JSON.stringify({ code: `${newCodeB}-Y` }),
  });
  record('造价员不能修改编码', costPatch.status === 403, `status=${costPatch.status}`);

  // 4. 修改编码后成员与管理数据仍在
  const membersAfter = await admin.request(`/projects/${idB}/members`);
  const keptMember = (membersAfter.payload?.data ?? []).some((m) => m.username === costCreds.username);
  record('修改编码后项目成员保持不变', membersAfter.status === 200 && keptMember);

  const detailAfter = await admin.request(`/projects/${idB}`);
  record(
    '修改编码后项目详情返回新编码',
    detailAfter.status === 200 && detailAfter.payload?.data?.code === newCodeB,
  );

  // 5. 删除项目
  const wrongCode = await admin.request(`/projects/${idA}`, {
    method: 'DELETE',
    body: JSON.stringify({ code: 'WRONG-CODE' }),
  });
  record('删除时编码不匹配被拒绝', wrongCode.status === 409, `status=${wrongCode.status}`);

  const missingCode = await admin.request(`/projects/${idA}`, { method: 'DELETE', body: JSON.stringify({}) });
  record('删除时未提供编码被拒绝', missingCode.status === 400, `status=${missingCode.status}`);

  const leadDelete = await lead.request(`/projects/${idA}`, {
    method: 'DELETE',
    body: JSON.stringify({ code: codeA }),
  });
  record('非管理员不能删除项目', leadDelete.status === 403, `status=${leadDelete.status}`);

  const deleted = await admin.request(`/projects/${idA}`, {
    method: 'DELETE',
    body: JSON.stringify({ code: codeA.toLowerCase() }),
  });
  record('管理员删除空测试项目成功', deleted.status === 200, `status=${deleted.status}`);

  const afterDelete = await admin.request(`/projects/${idA}`);
  record('删除后旧地址返回项目不存在', afterDelete.status === 404, `status=${afterDelete.status}`);

  const listAfter = await admin.request(`/projects?keyword=${encodeURIComponent(codeA)}`);
  record(
    '删除后项目列表不再包含该项目',
    listAfter.status === 200 && (listAfter.payload?.data ?? []).length === 0,
  );

  const bStillThere = await admin.request(`/projects/${idB}`);
  record('删除操作不影响其他项目', bStillThere.status === 200);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
  console.log(`测试项目 ID：A=${idA}（已删除） B=${idB}（保留待人工核对后可归档）`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('验收脚本异常：', error.message);
  process.exit(1);
});
