import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`缺少必要的环境变量：${name}（请参考 apps/api/.env.example 配置 apps/api/.env）`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '127.0.0.1',
  appEnv: process.env.APP_ENV ?? 'development',
  isDemo: (process.env.APP_ENV ?? 'development') === 'demo',
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 8),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  demoBannerText:
    process.env.DEMO_BANNER_TEXT ?? '演示环境 · 数据仅供演示与功能验证，不代表真实经营成果',
  databaseUrl: required('DATABASE_URL'),
};

export const SESSION_COOKIE = 'zs_session';
export const CSRF_COOKIE = 'zs_csrf';
