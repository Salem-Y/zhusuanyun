$Root = Split-Path -Parent $PSScriptRoot
$pgHome = 'C:\Users\Salem\.local\lib\zhusuanyun-pg'
$pgData = 'C:\Users\Salem\.local\lib\zhusuanyun-pgdata'

& "$pgHome\bin\pg_ctl.exe" -D $pgData status *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "[db] 数据库未在运行"
  exit 0
}

Write-Host "[db] 正在停止 PostgreSQL..."
& "$pgHome\bin\pg_ctl.exe" -D $pgData stop -m fast | Out-Host
