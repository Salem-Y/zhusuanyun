# 筑算云 · AI工程项目经营与成本分析平台

聚焦单项目的成本控制与经营分析：目标成本、实际成本、剩余预计成本与预测完工成本。
当前已交付：登录与权限、项目列表与项目空间导航、项目基础信息管理（系统管理员）、项目成员与权限管理、项目总览与成本工作台布局（成本业务数据尚未开放）。

## 1. 本地环境（免安装版，未改动系统）

本机没有 Node/Git/PostgreSQL，且当前会话无管理员权限，因此统一使用官方免安装版本，全部放在仓库内 `.tools/`，不写系统 PATH、不注册服务、不覆盖已有软件。

| 组件 | 版本 | 位置（免安装） | 来源 |
|---|---|---|---|
| Node.js | 24.22.2 LTS | `.tools/node` | nodejs.org 官方 zip（已校验 SHA256） |
| pnpm | 12.16.1 | `.tools/node/pnpm.cmd` | npm 官方仓库 |
| Git | 2.56.0 (MinGit) | `.tools/git` | git-for-windows 官方 release |
| PostgreSQL | 17.8 | `C:\Users\Salem\.local\lib\zhusuanyun-pg` | EnterpriseDB 官方 Windows binaries |

数据库数据目录：`C:\Users\Salem\.local\lib\zhusuanyun-pgdata`，仅监听 `127.0.0.1:5432`，使用 SCRAM 口令认证。

> 注意：PostgreSQL 官方 Windows 版本无法在含中文字符的路径下初始化，因此安装目录与数据目录都必须放在纯英文路径（本机放在 `C:\Users\Salem\.local\lib\` 下）。
数据库口令保存在本机 `.secrets/db_password.txt`，**不要提交到版本库，也不要贴到聊天中**。

## 2. 首次初始化

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

脚本会：加载工具链 → 启动数据库（如未启动）→ 安装依赖 → 生成 Prisma 客户端 → 执行迁移 → 初始化演示数据。
演示账号口令写入 `.secrets/demo-passwords.txt`（仅在首次创建账号时生成）。

> 若依赖安装在别的机器上出现 `ERR_PNPM_IGNORED_BUILDS`，执行 `pnpm approve-builds --all` 放行 Prisma、esbuild 的构建脚本（本项目已在 `pnpm-workspace.yaml` 的 `allowBuilds` 中登记）。

## 3. 启动 / 停止

```powershell
# 启动（先拉起数据库，再启动前后端）
powershell -ExecutionPolicy Bypass -File scripts/start-dev.ps1

# 停止前端与后端：在启动窗口按 Ctrl+C
# 停止数据库
powershell -ExecutionPolicy Bypass -File scripts/stop-db.ps1
```

访问地址：<http://127.0.0.1:5173>（前端），后端健康检查 <http://127.0.0.1:3000/api/health>。

## 4. 目录结构

```
apps/api     Express + TypeScript + Prisma（后端，127.0.0.1:3000）
apps/web     React + TypeScript + Vite + Ant Design（前端，127.0.0.1:5173）
scripts      环境、启动、停止脚本
.tools      免安装工具链与数据库数据目录（不进版本库）
.secrets    本机口令文件（不进版本库）
```

## 5. 环境变量

复制 `apps/api/.env.example` 为 `apps/api/.env` 并填写本机实际值。仓库中不提交任何真实口令或密钥。

## 6. 角色与权限

系统角色（账号层面）与项目角色（项目内职责）相互独立：

| 系统角色 | 职责 |
|---|---|
| 系统管理员 | 创建/编辑/归档项目、管理账号、维护项目成员与权限；不因此自动获得项目经营数据权限 |
| 项目负责人 | 查看授权项目，负责经营管理与审批（后续阶段） |
| 造价员 | 编制目标、登记实际成本、更新剩余预计、开展分析（后续阶段） |
| 项目其他管理人员 | 提交费用、投入、完成情况与事项（后续阶段） |

说明：原「公司管理层」业务角色已取消，其演示账号 demo.manager 已删除（会话、项目授权一并清理）；
历史审计保留操作人文字快照，不受账号删除影响。

## 7. 开发记录（原「建设进度」）

| 模块 | 状态 | 说明 |
|---|---|---|
| 平台基础（登录、会话、项目列表、项目空间导航） | 已上线 | 第一阶段交付 |
| 项目管理与成员权限（管理员维护） | 已上线 | 第二阶段交付 |
| 项目总览、成本工作台布局 | 已上线 | 真实空状态，无占位数据 |
| 目标成本（版本与审批） | 未开放 | 下一阶段 |
| 实际成本台账（提交、复核、调整冲销） | 未开放 | 下一阶段 |
| 剩余预计与预测完工成本（冻结快照） | 未开放 | 后续阶段 |
| 收入与收付款、价格资料、事项与审批、报告中心 | 未开放 | 后续阶段 |
| 方案测算 | 未开放 | 位于成本工作台内，后续阶段 |
| AI 分析 | 未开放 | 需先确认供应商与数据外发范围 |

未开放模块在导航中标注「未开放」并禁用，不提供假操作入口或虚构数据。

## 8. 数据

- 业务数据全部存储于 PostgreSQL，刷新页面、退出登录、重启服务后仍然保留。
- 演示环境与将来的正式环境使用独立数据库、独立附件目录与独立配置（本阶段仅启用演示库）。
- 示例项目「学校两层新建食堂（演示项目）」为演示数据，不代表真实经营成果。
