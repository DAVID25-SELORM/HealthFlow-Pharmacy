#Requires -RunAsAdministrator
param(
  [string]$InstallRoot = 'C:\HealthFlowLocal',
  [string]$NssmPath = '',
  [switch]$RemoveFiles
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$uninstaller = Join-Path $scriptDir 'uninstall-service.ps1'

if (-not (Test-Path -LiteralPath $uninstaller)) {
  throw "Uninstaller not found: $uninstaller"
}

$arguments = @(
  '-ExecutionPolicy', 'Bypass',
  '-File', $uninstaller,
  '-InstallRoot', $InstallRoot
)

if ($NssmPath) {
  $arguments += @('-NssmPath', $NssmPath)
}

if ($RemoveFiles) {
  $arguments += '-RemoveFiles'
}

Write-Host "Uninstalling HealthFlow Offline Server Windows service..."
& powershell @arguments
if ($LASTEXITCODE -ne 0) {
  throw "uninstall-service.ps1 failed with exit code $LASTEXITCODE."
}
