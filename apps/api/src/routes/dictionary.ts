import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { writeAudit } from '../http/audit';
import {
  assertProjectActive,
  assertProjectMembership,
  requireAuth,
  requireCsrf,
  requireProjectRoles,
} from '../http/auth';
import { ApiError } from '../http/errors';

// 第五轮：工作包/成本编码字典接口已废弃（表保留、不再允许新增和关联），
// 本路由仅保留「核算口径说明」维护。
const router = Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireCsrf);

const caliberSchema = z.object({
  note: z.string().trim().max(1000, '核算口径说明最多 1000 字').nullable(),
});

router.put('/:id/cost-caliber', async (req, res) => {
  const { project, membership } = await assertProjectMembership(req, req.params.id);
  requireProjectRoles(membership, ['PROJECT_LEAD'], '核算口径说明由项目负责人维护');
  assertProjectActive(project);

  const parsed = caliberSchema.safeParse(req.body);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '内容不完整');

  const updated = await prisma.project.update({
    where: { id: project.id },
    data: { costCaliberNote: parsed.data.note || null },
  });
  await writeAudit({
    req,
    action: 'COST_CALIBER_UPDATE',
    objectType: 'Project',
    objectId: project.id,
    projectId: project.id,
    before: { costCaliberNote: project.costCaliberNote },
    after: { costCaliberNote: updated.costCaliberNote },
  });
  res.json({ data: { caliberNote: updated.costCaliberNote ?? '' } });
});

export default router;
