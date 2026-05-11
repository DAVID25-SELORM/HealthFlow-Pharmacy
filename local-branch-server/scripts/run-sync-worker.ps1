$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Split-Path -Parent $scriptDir
$logsDir = Join-Path $serverDir 'logs'

New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
Set-Location $serverDir

$logPath = Join-Path $logsDir 'sync-worker.log'

Write-Output "[$(Get-Date -Format o)] Starting HealthFlow sync worker..." | Out-File -FilePath $logPath -Append -Encoding utf8
npm.cmd run sync *>> $logPath

