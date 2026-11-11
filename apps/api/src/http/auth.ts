import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../db';
import { ApiError } from '../http/errors';
import { resolveSession, validateCsrf } from '../security/session';

/** 解析当前会话用户（未登录不报错，仅置空）。 */
export async function attachUser(req: Request, _res: Response, next: NextFunction) {
  try {
    req.user = (await resolveSession(req)) ?? undefined;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(ApiError.unauthorized());
  next();
}

/** 有状态变更的请求必须携带与 Cookie 一致的 CSRF 令牌。 */
export function requireCsrf(req: Request, _res: Response, next: NextFunction) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !validateCsrf(req)) {
    return next(new ApiError(403, 'E_CSRF', '请求校验失败，请刷新页面后重试'));
  }
  next();
}

/**
 * 项目级授权：
 * - 读取：系统管理员可直接访问；其他角色必须拥有该项目的成员授权（撤权后立即失效）；
 * - 修改项目基础信息：仅系统管理员。项目负责人、造价员、项目其他管理人员均不能修改。
 * 注意：系统角色（User.role）与项目角色（ProjectMember.roleCode）相互独立，
 * 项目角色不能用于授予系统管理员身份，也不能放大到未授权项目。
 */
export async function assertProjectAccess(req: Request, projectId: string, mode: 'read' | 'write') {
  const user = req.user;
  if (!user) throw ApiError.unauthorized();

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw ApiError.notFound('项目不存在');

  if (user.role === 'SYS_ADMIN') return project;

  if (mode === 'write') {
    throw ApiError.forbidden('只有系统管理员可以管理项目基础信息');
  }

  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: user.id } },
  });

  if (!membership) {
    throw ApiError.forbidden('你未被授权访问该项目');
  }

  return project;
}

/** 仅系统管理员可执行的操作（账号管理、成员管理、项目创建等）。 */
export function requireSysAdmin(req: Request) {
  const user = req.user;
  if (!user) throw ApiError.unauthorized();
  if (user.role !== 'SYS_ADMIN') {
    throw ApiError.forbidden('该操作仅系统管理员可执行');
  }
  return user;
}

/**
 * 成本业务授权：必须是项目成员才允许读写成本业务。
 * 系统管理员不因为是管理员而自动获得成本明细权限——没有项目授权同样被拒绝。
 */
export async function assertProjectMembership(req: Request, projectId: string) {
  const user = req.user;
  if (!user) throw ApiError.unauthorized();

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw ApiError.notFound('项目不存在');

  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: user.id } },
  });
  if (!membership) {
    throw ApiError.forbidden('你未被授权访问该项目的成本业务');
  }
  return { project, membership };
}

/** 在项目成员身份之上校验项目内角色（如仅项目负责人可审批）。 */
export function requireProjectRoles(
  membership: { roleCode: string },
  roles: string[],
  message: string,
) {
  if (!roles.includes(membership.roleCode)) {
    throw ApiError.forbidden(message);
  }
}

/** 已归档项目允许授权历史查看，禁止新增、修改及审批成本业务。 */
export function assertProjectActive(project: { status: string }) {
  if (project.status !== 'ACTIVE') {
    throw ApiError.conflict('项目已归档，禁止新增、修改及审批成本业务；如需继续操作请先由管理员恢复项目状态', 'E_PROJECT_ARCHIVED');
  }
}
