import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import { attachUser } from './http/auth';
import { ApiError } from './http/errors';
import authRoutes from './routes/auth';
import boqItemRoutes from './routes/boqItems';
import costSummaryRoutes from './routes/costSummary';
import actualCostRoutes from './routes/actualCosts';
import dictionaryRoutes from './routes/dictionary';
import healthRoutes from './routes/health';
import projectRoutes from './routes/projects';
import targetCostRoutes from './routes/targetCosts';
import unitProjectRoutes from './routes/unitProjects';
import userRoutes from './routes/users';

export function createApp() {
  const app = express();
  app.set('trust proxy', false);
  app.disable('x-powered-by');

  // 基础安全响应头（本阶段不引入额外依赖）
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  // 统一解析会话，失败不报错；需要登录的接口自行调用 requireAuth
  app.use(attachUser);

  app.use('/api/health', healthRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/projects', projectRoutes);
  app.use('/api/projects', boqItemRoutes);
  app.use('/api/projects', unitProjectRoutes);
  app.use('/api/projects', dictionaryRoutes);
  app.use('/api/projects', targetCostRoutes);
  app.use('/api/projects', actualCostRoutes);
  app.use('/api/projects', costSummaryRoutes);
  app.use('/api/users', userRoutes);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'E_NOT_FOUND', message: '接口不存在' } });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    // 避免把内部堆栈、SQL 细节或连接串返回给前端，也不写入日志明细
    console.error('[api] 未处理异常:', (err as Error)?.message);
    res.status(500).json({ error: { code: 'E_INTERNAL', message: '服务器处理失败，请稍后重试' } });
  });

  return app;
}
