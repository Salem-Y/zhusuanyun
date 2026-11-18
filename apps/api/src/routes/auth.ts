import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { prisma } from '../db';
import { writeAudit } from '../http/audit';
import { attachUser, requireAuth, requireCsrf } from '../http/auth';
import { ApiError } from '../http/errors';
import { verifyPassword } from '../security/password';
import { createSession, destroySession } from '../security/session';

const router = Router();

// 简单的登录失败限流：同一 IP 15 分钟内最多 10 次失败。
const attempts = new Map<string, { count: number; firstAt: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function checkRateLimit(ip: string) {
  const now = Date.now();
  const record = attempts.get(ip);
  if (!record || now - record.firstAt > WINDOW_MS) {
    attempts.set(ip, { count: 1, firstAt: now });
    return;
  }
  record.count += 1;
  if (record.count > MAX_ATTEMPTS) {
    throw new ApiError(429, 'E_RATE_LIMITED', '登录尝试过于频繁，请稍后再试');
  }
}

const loginSchema = z.object({
  username: z.string().trim().min(1, '请输入用户名').max(64),
  password: z.string().min(1, '请输入密码').max(200),
});

router.post('/login', async (req, res) => {
  const ip = req.ip ?? 'unknown';
  checkRateLimit(ip);

  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '登录信息不完整');
  }

  const { username, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { username } });

  if (!user || !user.isActive) {
    await writeAudit({
      req,
      action: 'LOGIN',
      objectType: 'User',
      objectId: user?.id ?? null,
      actorName: username,
      result: 'FAILED',
    });
    throw ApiError.unauthorized('用户名或密码不正确');
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    await writeAudit({
      req,
      action: 'LOGIN',
      objectType: 'User',
      objectId: user.id,
      actorName: username,
      result: 'FAILED',
    });
    throw ApiError.unauthorized('用户名或密码不正确');
  }

  await createSession(user.id, req, res);
  // 登录成功即清零该 IP 的失败计数，避免正常使用被误限流
  attempts.delete(ip);
  await writeAudit({
    req,
    actorId: user.id,
    actorName: user.username,
    action: 'LOGIN',
    objectType: 'User',
    objectId: user.id,
    result: 'SUCCESS',
  });

  res.json({
    data: {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        isDemo: user.isDemo,
      },
      appEnv: config.appEnv,
      isDemo: config.isDemo,
      demoBannerText: config.demoBannerText,
    },
  });
});

router.post('/logout', requireCsrf, async (req, res) => {
  if (req.user) {
    await writeAudit({ req, action: 'LOGOUT', objectType: 'User', objectId: req.user.id });
  }
  await destroySession(req, res);
  res.json({ data: { ok: true } });
});

router.get('/me', attachUser, requireAuth, async (req, res) => {
  const user = req.user!;
  res.json({
    data: {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        isDemo: user.isDemo,
      },
      appEnv: config.appEnv,
      isDemo: config.isDemo,
      demoBannerText: config.demoBannerText,
    },
  });
});

export default router;
