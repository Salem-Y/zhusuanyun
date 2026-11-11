import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/security/password';

const prisma = new PrismaClient();

const DEMO_USERS = [
  { username: 'demo.admin', displayName: '演示 · 系统管理员', role: 'SYS_ADMIN' as const },
  { username: 'demo.lead', displayName: '演示 · 项目负责人', role: 'PROJECT_LEAD' as const },
  { username: 'demo.cost', displayName: '演示 · 造价员', role: 'COST_ENGINEER' as const },
  { username: 'demo.field', displayName: '演示 · 项目其他管理人员', role: 'FIELD_MANAGER' as const },
];

const DEMO_PROJECT = {
  code: 'DEMO-CANTEEN',
  name: '学校两层新建食堂（演示项目）',
  description:
    '用于演示平台的示例项目：两层新建食堂，仅作功能演示，不代表任何真实经营成果，也不包含真实合同与金额。',
};

function randomPassword(): string {
  return randomBytes(9).toString('base64url');
}

async function main() {
  const newCredentials: Array<{ username: string; password: string }> = [];

  for (const item of DEMO_USERS) {
    const existing = await prisma.user.findUnique({ where: { username: item.username } });
    if (existing) {
      console.log(`[seed] 已存在，跳过：${item.username}`);
      continue;
    }
    const password = randomPassword();
    await prisma.user.create({
      data: {
        username: item.username,
        displayName: item.displayName,
        role: item.role,
        passwordHash: await hashPassword(password),
        isDemo: true,
      },
    });
    newCredentials.push({ username: item.username, password });
    console.log(`[seed] 已创建演示账号：${item.username}（口令已写入本地凭据文件）`);
  }

  const project = await prisma.project.upsert({
    where: { code: DEMO_PROJECT.code },
    update: {},
    create: {
      code: DEMO_PROJECT.code,
      name: DEMO_PROJECT.name,
      description: DEMO_PROJECT.description,
      status: 'ACTIVE',
    },
  });

  const membershipMap: Array<[string, 'PROJECT_LEAD' | 'COST_ENGINEER' | 'FIELD_MANAGER']> = [
    ['demo.lead', 'PROJECT_LEAD'],
    ['demo.cost', 'COST_ENGINEER'],
    ['demo.field', 'FIELD_MANAGER'],
  ];

  for (const [username, roleCode] of membershipMap) {
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) continue;
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: project.id, userId: user.id } },
      update: { roleCode },
      create: { projectId: project.id, userId: user.id, roleCode },
    });
  }
  console.log(`[seed] 演示项目已就绪：${project.code} —— ${project.name}`);

  // 已取消的“公司管理层”演示账号（demo.manager）已在本轮清理中删除；初始化脚本不再创建该账号。
  // 统一历史账号显示名称：现场管理/其他管理人员 → 项目其他管理人员。
  await prisma.user.updateMany({
    where: { username: 'demo.field', displayName: { not: '演示 · 项目其他管理人员' } },
    data: { displayName: '演示 · 项目其他管理人员' },
  });

  if (newCredentials.length > 0) {
    const target = resolve(process.cwd(), '../../.secrets/demo-passwords.txt');
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) {
      writeFileSync(target, '', { flag: 'w' });
    }
    const lines = [
      '# 演示环境登录账号（本文件仅保存在本机，不要提交到版本库）',
      `# 生成时间：${new Date().toLocaleString('zh-CN')}`,
      '',
      ...newCredentials.map((c) => `${c.username}  ${c.password}`),
      '',
    ];
    writeFileSync(target, lines.join('\n'), 'utf8');
    console.log(`[seed] 登录凭据已写入：${target}`);
  }
}

main()
  .catch((error) => {
    console.error('[seed] 初始化失败：', (error as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
