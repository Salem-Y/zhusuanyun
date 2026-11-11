import type { Request } from 'express';
import { prisma } from '../db';

export interface AuditInput {
  req?: Request;
  actorId?: string | null;
  actorName?: string | null;
  action: string;
  objectType: string;
  objectId?: string | null;
  projectId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  result?: 'SUCCESS' | 'DENIED' | 'FAILED';
}

/**
 * 审计只记录业务字段与操作结果，不写入密码、会话令牌或请求体中的敏感内容。
 */
export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? input.req?.user?.id ?? null,
        actorName: input.actorName ?? input.req?.user?.username ?? null,
        action: input.action,
        objectType: input.objectType,
        objectId: input.objectId ?? null,
        projectId: input.projectId ?? null,
        beforeJson: (input.before ?? null) as never,
        afterJson: (input.after ?? null) as never,
        reason: input.reason ?? null,
        result: input.result ?? 'SUCCESS',
        ip: input.req?.ip?.slice(0, 60) ?? null,
      },
    });
  } catch {
    // 审计失败不阻断主流程，但不能静默吞掉异常信息到日志明细
    console.warn('[audit] 写入失败');
  }
}
