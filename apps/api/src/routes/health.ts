import { Router } from 'express';
import { config } from '../config';
import { checkDatabase } from '../db';

const router = Router();

/**
 * 健康检查：返回服务状态与数据库连通性。
 * 不返回任何连接串、口令或密钥信息。
 */
router.get('/', async (_req, res) => {
  const db = await checkDatabase();
  res.status(db.ok ? 200 : 503).json({
    data: {
      service: 'zhuan-api',
      status: db.ok ? 'ok' : 'degraded',
      database: db.ok ? 'connected' : 'unavailable',
      databaseMessage: db.message,
      appEnv: config.appEnv,
      isDemo: config.isDemo,
      time: new Date().toISOString(),
    },
  });
});

export default router;
