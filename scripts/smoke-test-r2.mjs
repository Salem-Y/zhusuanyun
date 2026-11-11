// 第二轮验收：角色权限收紧、项目成员管理、撤权即时失效、历史数据保留。
// 用法：node scripts/smoke-test-r2.mjs [baseUrl]
// 凭据通过环境变量传入（不要写死口令）：
//   SMOKE_ADMIN_USER/PASS  系统管理员
//   SMOKE_LEAD_USER/PASS   项目负责人
//   SMOKE_FIELD_USER/PASS  项目其他管理人员
//   SMOKE_MANAGER_USER/PASS 已停用的公司管理层（验证无法登录）

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
}

class Client {
  constructor(label) {
    this.label = label;
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

function creds(prefix) {
  const username = process.env[`${prefix}_USER`];
  const password = process.env[`${prefix}_PASS`];
  if (!username || !password) {
    console.error(`缺少环境变量 ${prefix}_USER / ${prefix}_PASS`);
    process.exit(2);
  }
  return { username, password };
}

async function main() {
  const health = await fetch(`${BASE}/api/health`).then(async (r) => ({ status: r.status }));
  record('后端健康检查', health.status === 200, `status=${health.status}`);

  const admin = new Client('系统管理员');
  const lead = new Client('项目负责人');
  const field = new Client('项目其他管理人员');

  const [a, l, f] = [creds('SMOKE_ADMIN'), creds('SMOKE_LEAD'), creds('SMOKE_FIELD')];
  record('管理员登录', (await admin.login(a.username, a.password)).status === 200);
  record('项目负责人登录', (await lead.login(l.username, l.password)).status === 200);
  record('其他管理人员登录', (await field.login(f.username, f.password)).status === 200);

  // 1. 已停用的公司管理层账号不能登录
  const managerCreds = { username: process.env.SMOKE_MANAGER_USER, password: process.env.SMOKE_MANAGER_PASS };
  if (managerCreds.username && managerCreds.password) {
    const mgr = new Client('公司管理层');
    const mgrLogin = await mgr.login(managerCreds.username, managerCreds.password);
    record('已停用的公司管理层账号无法登录', mgrLogin.status === 401, `status=${mgrLogin.status}`);
  }

  // 2. 管理员创建项目
  const code = `R2-${Date.now()}`;
  const created = await admin.request('/projects', {
    method: 'POST',
    body: JSON.stringify({ code, name: '第二轮验收项目', description: '角色与成员管理验收' }),
  });
  record('管理员创建项目成功', created.status === 201, `status=${created.status}`);
  const pid = created.payload?.data?.id;
  if (!pid) {
    console.log(JSON.stringify(created.payload));
    process.exit(1);
  }

  // 3. 项目负责人不能创建/编辑项目（接口层面）
  const leadCreate = await lead.request('/projects', {
    method: 'POST',
    body: JSON.stringify({ code: `X-${Date.now()}`, name: '越权创建测试' }),
  });
  record('项目负责人不能创建项目', leadCreate.status === 403, `status=${leadCreate.status}`);
  const leadPatch = await lead.request(`/projects/${pid}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: '越权改名' }),
  });
  record('项目负责人不能编辑项目基础信息', leadPatch.status === 403, `status=${leadPatch.status}`);

  // 4. 管理员编辑、归档并恢复项目
  const renamed = await admin.request(`/projects/${pid}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: '第二轮验收项目（已编辑）' }),
  });
  record('管理员编辑项目成功', renamed.status === 200 && renamed.payload?.data?.name === '第二轮验收项目（已编辑）');
  const archived = await admin.request(`/projects/${pid}`, { method: 'PATCH', body: JSON.stringify({ status: 'ARCHIVED' }) });
  record('管理员归档项目成功', archived.status === 200 && archived.payload?.data?.status === 'ARCHIVED');
  await admin.request(`/projects/${pid}`, { method: 'PATCH', body: JSON.stringify({ status: 'ACTIVE' }) });

  // 5. 未授权用户不能读取项目；管理员添加成员后可读
  const leadGetBefore = await lead.request(`/projects/${pid}`);
  record('未授权用户不能读取项目', leadGetBefore.status === 403, `status=${leadGetBefore.status}`);

  const leadUser = (await lead.request('/auth/me')).payload?.data?.user;
  const fieldUser = (await field.request('/auth/me')).payload?.data?.user;

  const addLead = await admin.request(`/projects/${pid}/members`, {
    method: 'POST',
    body: JSON.stringify({ userId: leadUser.id, roleCode: 'PROJECT_LEAD' }),
  });
  record('管理员添加成员成功', addLead.status === 201, `status=${addLead.status}`);
  const leadGetAfter = await lead.request(`/projects/${pid}`);
  record('授权后项目负责人可读取项目', leadGetAfter.status === 200, `status=${leadGetAfter.status}`);

  // 6. 不重复添加相同成员
  const dup = await admin.request(`/projects/${pid}/members`, {
    method: 'POST',
    body: JSON.stringify({ userId: leadUser.id, roleCode: 'COST_ENGINEER' }),
  });
  record('重复添加成员被拒绝', dup.status === 409, `status=${dup.status}`);

  // 7. 项目角色不能授予系统管理员身份
  const badRole = await admin.request(`/projects/${pid}/members`, {
    method: 'POST',
    body: JSON.stringify({ userId: fieldUser.id, roleCode: 'SYS_ADMIN' }),
  });
  record('项目角色不能授予系统管理员身份', badRole.status === 400, `status=${badRole.status}`);

  // 8. 非管理员不能管理成员（不能提升自己或他人权限）
  const leadAdd = await lead.request(`/projects/${pid}/members`, {
    method: 'POST',
    body: JSON.stringify({ userId: fieldUser.id, roleCode: 'FIELD_MANAGER' }),
  });
  record('非管理员不能添加成员', leadAdd.status === 403, `status=${leadAdd.status}`);
  const leadSelfPatch = await lead.request(`/projects/${pid}/members/${leadUser.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ roleCode: 'PROJECT_LEAD' }),
  });
  record('非管理员不能修改成员角色（含自己）', leadSelfPatch.status === 403, `status=${leadSelfPatch.status}`);

  // 9. 管理员修改成员角色
  await admin.request(`/projects/${pid}/members`, {
    method: 'POST',
    body: JSON.stringify({ userId: fieldUser.id, roleCode: 'FIELD_MANAGER' }),
  });
  const patchRole = await admin.request(`/projects/${pid}/members/${fieldUser.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ roleCode: 'COST_ENGINEER' }),
  });
  record('管理员修改成员项目角色成功', patchRole.status === 200 && patchRole.payload?.data?.roleCode === 'COST_ENGINEER');

  // 10. 撤权后立即无法读取该项目
  const fieldGet = await field.request(`/projects/${pid}`);
  record('成员被授权后可读取项目', fieldGet.status === 200, `status=${fieldGet.status}`);
  const removed = await admin.request(`/projects/${pid}/members/${fieldUser.id}`, { method: 'DELETE' });
  record('管理员移出成员成功', removed.status === 200, `status=${removed.status}`);
  const fieldGetAfter = await field.request(`/projects/${pid}`);
  record('撤权后无法继续读取该项目', fieldGetAfter.status === 403, `status=${fieldGetAfter.status}`);

  // 11. 账号列表接口仅管理员可用
  const leadUsers = await lead.request('/users');
  record('非管理员不能查看账号列表', leadUsers.status === 403, `status=${leadUsers.status}`);
  const adminUsers = await admin.request('/users');
  record('管理员可查看账号列表', adminUsers.status === 200, `count=${adminUsers.payload?.data?.length}`);

  // 12. 原有演示项目及历史数据保留
  const demoList = await admin.request('/projects?keyword=DEMO-CANTEEN');
  record('原有演示项目保留', demoList.status === 200 && (demoList.payload?.data?.length ?? 0) >= 1);

  // 13. 退出后会话失效
  const logout = await admin.request('/auth/logout', { method: 'POST' });
  const afterLogout = await admin.request('/auth/me');
  record('退出后会话失效', logout.status === 200 && afterLogout.status === 401);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('验收脚本异常：', error.message);
  process.exit(1);
});
