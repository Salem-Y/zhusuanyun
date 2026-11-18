$ErrorActionPreference = 'Stop'

# 一键预览：已在运行则直接开浏览器，否则先拉起开发服务再打开
$isUp = {
  param([int]$port)
  [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

if (-not (& $isUp 5173)) {
  Write-Host '[launch] 开发服务未运行，正在后台启动...'
  Start-Process powershell -ArgumentList @(
    '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "$PSScriptRoot\start-dev.ps1"
  )
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if (& $isUp 5173) { break }
  }
}

if (& $isUp 5173) {
  Write-Host '[launch] 前端已就绪：http://127.0.0.1:5173'
} else {
  Write-Host '[launch] 前端启动较慢，请稍候在浏览器刷新 http://127.0.0.1:5173'
}

Start-Process 'http://127.0.0.1:5173'
