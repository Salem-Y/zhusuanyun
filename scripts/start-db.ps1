$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$pgHome = 'C:\Users\Salem\.local\lib\zhusuanyun-pg'
$pgData = 'C:\Users\Salem\.local\lib\zhusuanyun-pgdata'

if (-not (Test-Path "$pgData\PG_VERSION")) {
  Write-Host "[db] 数据目录尚未初始化，请先运行 scripts/setup.ps1"
  exit 1
}

& "$pgHome\bin\pg_ctl.exe" -D $pgData status *> $null
if ($LASTEXITCODE -eq 0) {
  Write-Host "[db] 数据库已在运行 (127.0.0.1:5432)"
  exit 0
}

Write-Host "[db] 正在启动 PostgreSQL..."
& "$pgHome\bin\pg_ctl.exe" -D $pgData -l "$pgData\server.log" -o "-p 5432" start | Out-Host
Start-Sleep -Seconds 3
& "$pgHome\bin\pg_isready.exe" -h 127.0.0.1 -p 5432
if ($LASTEXITCODE -eq 0) {
  Write-Host "[db] 启动成功"
} else {
  Write-Host "[db] 启动失败，请查看 $pgData\server.log"
  exit 1
}
