import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { config, CSRF_COOKIE, SESSION_COOKIE } from '../config';
import { prisma } from '../db';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cookieBase() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.cookieSecure,
    path: '/',
  };
}

/** 创建服务端会话；会话令牌仅以哈希形式落库，令牌本身只存在于浏览器 Cookie。 */
export async function createSession(userId: string, req: Request, res: Response): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      ip: req.ip,
      userAgent: req.get('user-agent')?.slice(0, 200),
    },
  });

  res.cookie(SESSION_COOKIE, token, { ...cookieBase(), maxAge: config.sessionTtlHours * 3600 * 1000 });
  // CSRF 令牌需要被前端读取后放入请求头，因此该 Cookie 不能是 httpOnly。
  res.cookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: config.sessionTtlHours * 3600 * 1000,
  });
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (token) {
    await prisma.session.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  res.clearCookie(SESSION_COOKIE, cookieBase());
  res.clearCookie(CSRF_COOKIE, { ...cookieBase(), httpOnly: false });
}

export interface SessionUser {
  sessionId: string;
  id: string;
  username: string;
  displayName: string;
  role: string;
  isDemo: boolean;
}

/** 校验会话：过期、已撤销、账号停用一律视为无效。 */
export async function resolveSession(req: Request): Promise<SessionUser | null> {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  if (!session.user.isActive) return null;

  return {
    sessionId: session.id,
    id: session.user.id,
    username: session.user.username,
    displayName: session.user.displayName,
    role: session.user.role,
    isDemo: session.user.isDemo,
  };
}

export function validateCsrf(req: Request): boolean {
  const cookieToken = req.cookies?.[CSRF_COOKIE] as string | undefined;
  const headerToken = req.get('x-csrf-token');
  if (!cookieToken || !headerToken) return false;
  if (cookieToken.length !== headerToken.length) return false;
  return cookieToken === headerToken;
}
