$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\env.ps1"
& "$PSScriptRoot\start-db.ps1"

Set-Location $Root

if (-not (Test-Path "$Root\node_modules")) {
  Write-Host "[setup] 未检测到依赖，正在安装..."
  & pnpm install
}

Write-Host "[dev] 启动前后端（Ctrl+C 可停止）"
Write-Host "[dev] 前端 http://127.0.0.1:5173   后端 http://127.0.0.1:3000/api/health"
& pnpm dev
