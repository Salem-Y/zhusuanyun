$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\env.ps1"

if (-not $env:DATABASE_URL) {
  Write-Host "[setup] 未找到数据库口令文件 .secrets/db_password.txt"
  exit 1
}

& "$PSScriptRoot\start-db.ps1"

Set-Location $Root

Write-Host "[setup] 安装依赖..."
& pnpm install
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "[setup] 生成数据库客户端..."
& pnpm --filter @zhuan/api db:generate
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "[setup] 执行数据库迁移..."
& pnpm --filter @zhuan/api exec prisma migrate deploy
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "[setup] 初始化演示数据..."
& pnpm --filter @zhuan/api db:seed:demo
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "[setup] 完成。启动命令：scripts\start-dev.ps1"
