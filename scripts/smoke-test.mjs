// 阶段一验收脚本：登录、创建项目、编辑项目、越权拦截、会话失效
// 用法：node scripts/smoke-test.mjs [baseUrl]
// 需要后端已启动，且已执行演示数据初始化。

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
    return this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  }
}

async function main() {
  const health = await fetch(`${BASE}/api/health`).then(async (r) => ({ status: r.status, body: await r.json() }));
  record('后端健康检查', health.status === 200, `status=${health.status}`);

  // 第二轮起：项目的创建与编辑仅系统管理员可执行，因此主账号改用管理员。
  const lead = new Client('系统管理员');
  const field = new Client('项目其他管理人员');

  const leadCreds = { username: process.env.SMOKE_USER, password: process.env.SMOKE_PASS };
  if (!leadCreds.username || !leadCreds.password) {
    console.error('请通过环境变量 SMOKE_USER / SMOKE_PASS 提供系统管理员演示账号');
    process.exit(2);
  }

  const loginRes = await lead.login(leadCreds.username, leadCreds.password);
  record('登录成功', loginRes.status === 200, `status=${loginRes.status}`);
  if (loginRes.status !== 200) {
    console.log(JSON.stringify(loginRes.payload));
    process.exit(1);
  }

  const me = await lead.request('/auth/me');
  record('会话有效（可获取当前用户）', me.status === 200, me.payload?.data?.user?.username ?? '');

  const code = `SMOKE-${Date.now()}`;
  const created = await lead.request('/projects', {
    method: 'POST',
    body: JSON.stringify({ code, name: '验收测试项目', description: '自动化验收创建' }),
  });
  record('创建项目成功', created.status === 201, `status=${created.status}`);
  const projectId = created.payload?.data?.id;
  if (!projectId) {
    console.log(JSON.stringify(created.payload));
    process.exit(1);
  }

  const updated = await lead.request(`/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: '验收测试项目（已编辑）' }),
  });
  record('编辑项目成功', updated.status === 200 && updated.payload?.data?.name === '验收测试项目（已编辑）');

  const detail = await lead.request(`/projects/${projectId}`);
  record(
    '读取项目详情（数据已落库）',
    detail.status === 200 && detail.payload?.data?.name === '验收测试项目（已编辑）',
  );

  const duplicate = await lead.request('/projects', {
    method: 'POST',
    body: JSON.stringify({ code, name: '重复编码测试' }),
  });
  record('重复项目编码被拒绝', duplicate.status === 409, `status=${duplicate.status}`);

  // 未登录访问受保护接口
  const anonymous = new Client('未登录');
  const anonList = await anonymous.request('/projects');
  record('未登录不能访问项目接口', anonList.status === 401, `status=${anonList.status}`);

  // 未授权项目访问：用未加入该项目的演示账号
  const fieldCreds = { username: process.env.SMOKE_FIELD_USER, password: process.env.SMOKE_FIELD_PASS };
  if (fieldCreds.username && fieldCreds.password) {
    const fLogin = await field.login(fieldCreds.username, fieldCreds.password);
    record('第二账号登录成功', fLogin.status === 200, `status=${fLogin.status}`);
    const forbidden = await field.request(`/projects/${projectId}`);
    record('无授权用户不能访问该项目', forbidden.status === 403, `status=${forbidden.status}`);
  }

  // 退出后会话失效
  const logout = await lead.request('/auth/logout', { method: 'POST' });
  record('退出登录成功', logout.status === 200, `status=${logout.status}`);
  const afterLogout = await lead.request('/auth/me');
  record('退出后会话失效', afterLogout.status === 401, `status=${afterLogout.status}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('验收脚本异常：', error.message);
  process.exit(1);
});
