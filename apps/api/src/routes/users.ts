import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth, requireCsrf, requireSysAdmin } from '../http/auth';

const router = Router();
router.use(requireAuth);
router.use(requireCsrf);

// 账号列表仅系统管理员可见，用于项目成员挑选与账号核对；不返回任何口令或会话信息。
router.get('/', async (req, res) => {
  requireSysAdmin(req);
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      isActive: true,
      isDemo: true,
      createdAt: true,
      _count: { select: { memberships: true } },
    },
  });
  res.json({
    data: users.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      isActive: u.isActive,
      isDemo: u.isDemo,
      projectCount: u._count.memberships,
      createdAt: u.createdAt,
    })),
  });
});

export default router;
