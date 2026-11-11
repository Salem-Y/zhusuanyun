import { config } from './config';
import { checkDatabase } from './db';
import { createApp } from './app';

async function main() {
  const db = await checkDatabase();
  if (!db.ok) {
    console.error('[api] 数据库连接失败，服务不会启动。请检查 PostgreSQL 是否已启动以及 DATABASE_URL 配置。');
    console.error(`[api] 原因：${db.message}`);
    process.exit(1);
  }

  const app = createApp();
  app.listen(config.port, config.host, () => {
    console.log(`[api] 服务已启动：http://${config.host}:${config.port}  (APP_ENV=${config.appEnv})`);
  });
}

main().catch((error) => {
  console.error('[api] 启动失败：', (error as Error).message);
  process.exit(1);
});
