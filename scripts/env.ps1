# 载入本地免安装工具链。点号执行：. .\scripts\env.ps1
$Root = Split-Path -Parent $PSScriptRoot
$env:ZH_ROOT = $Root

# Node / Git 位于仓库内 .tools
$env:PATH = "$Root\.tools\node;$Root\.tools\git\cmd;" + $env:PATH

# PostgreSQL 官方 Windows 版本无法在含中文的路径下初始化，因此放在纯英文路径
$pgHome = 'C:\Users\Salem\.local\lib\zhusuanyun-pg'
$pgData = 'C:\Users\Salem\.local\lib\zhusuanyun-pgdata'
$env:ZH_PG_HOME = $pgHome
$env:ZH_PGDATA = $pgData
if (Test-Path "$pgHome\bin") {
  $env:PATH = "$pgHome\bin;" + $env:PATH
}

# 数据库连接串只在本进程内存中拼接，不写入任何配置文件
$secretFile = "$Root\.secrets\db_password.txt"
if (Test-Path $secretFile) {
  $dbSecret = (Get-Content $secretFile -Raw).Trim()
  if ($dbSecret -match '^postgres(ql)?://') {
    # 口令文件内已是完整连接串（如云端数据库），直接使用
    $env:DATABASE_URL = $dbSecret
  } else {
    $env:DATABASE_URL = "postgresql://zsadmin:$dbSecret@127.0.0.1:5432/zhuan_demo?schema=public"
  }
}

Write-Host "[env] 工具链已载入"
