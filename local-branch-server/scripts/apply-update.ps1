#Requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$PackagePath,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [string]$ServiceName = 'HealthFlowOfflineServer'
)

$ErrorActionPreference = 'Stop'
$installPath = (Resolve-Path -LiteralPath $InstallDir).Path
$packageFile = (Resolve-Path -LiteralPath $PackagePath).Path
$parentDir = Split-Path -Parent $installPath
$updatesDir = Join-Path $installPath 'updates'
$statusPath = Join-Path $updatesDir 'status.json'
$workDir = Join-Path $parentDir ('update-work-' + [Guid]::NewGuid().ToString('N'))
$backupDir = Join-Path $parentDir ('backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$logDir = Join-Path $parentDir 'logs'
$logPath = Join-Path $logDir 'update.log'

New-Item -ItemType Directory -Force -Path $updatesDir, $logDir | Out-Null

function Write-UpdateStatus {
  param([string]$State, [string]$Message)
  @{
    state = $State
    message = $Message
    latestVersion = $ExpectedVersion
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  } | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8
  "[$(Get-Date -Format o)] $State - $Message" | Out-File -LiteralPath $logPath -Append -Encoding UTF8
}

function Stop-HealthFlowService {
  $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if (-not $service) {
    throw "Windows service not found: $ServiceName"
  }
  if ($service.Status -ne 'Stopped') {
    Stop-Service -Name $ServiceName -Force
    $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(45))
  }
}

function Start-HealthFlowService {
  Start-Service -Name $ServiceName
  $service = Get-Service -Name $ServiceName
  $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(45))
}

function Restore-Backup {
  if (-not (Test-Path -LiteralPath $backupDir)) { return }
  Get-ChildItem -LiteralPath $installPath -Force |
    Where-Object { $_.Name -notin @('.env', 'updates') } |
    Remove-Item -Recurse -Force
  Get-ChildItem -LiteralPath $backupDir -Force |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $installPath -Recurse -Force }
}

Start-Sleep -Seconds 3

try {
  Write-UpdateStatus -State 'installing' -Message "Stopping $ServiceName and preparing the update."
  Stop-HealthFlowService

  New-Item -ItemType Directory -Force -Path $workDir, $backupDir | Out-Null
  Expand-Archive -LiteralPath $packageFile -DestinationPath $workDir -Force

  $payloadDir = $workDir
  if (-not (Test-Path -LiteralPath (Join-Path $payloadDir 'package.json'))) {
    $children = @(Get-ChildItem -LiteralPath $workDir -Directory)
    if ($children.Count -eq 1 -and (Test-Path -LiteralPath (Join-Path $children[0].FullName 'package.json'))) {
      $payloadDir = $children[0].FullName
    }
  }

  $payloadPackageJson = Join-Path $payloadDir 'package.json'
  if (-not (Test-Path -LiteralPath $payloadPackageJson)) {
    throw 'The update archive does not contain a branch-server package.json.'
  }
  $payloadVersion = (Get-Content -LiteralPath $payloadPackageJson -Raw | ConvertFrom-Json).version
  if ([string]$payloadVersion -ne $ExpectedVersion) {
    throw "Update archive version $payloadVersion does not match expected version $ExpectedVersion."
  }

  Get-ChildItem -LiteralPath $installPath -Force |
    Where-Object { $_.Name -notin @('.env', 'updates') } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $backupDir -Recurse -Force }

  Get-ChildItem -LiteralPath $installPath -Force |
    Where-Object { $_.Name -notin @('.env', 'updates') } |
    Remove-Item -Recurse -Force
  Get-ChildItem -LiteralPath $payloadDir -Force |
    Where-Object { $_.Name -notin @('.env', 'data', 'logs', 'updates', 'node_modules') } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $installPath -Recurse -Force }

  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  Push-Location $installPath
  try {
    & $npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) {
      throw "npm ci failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }

  Start-HealthFlowService
  Start-Sleep -Seconds 5
  $service = Get-Service -Name $ServiceName
  if ($service.Status -ne 'Running') {
    throw "$ServiceName did not remain running after the update."
  }

  Write-UpdateStatus -State 'installed' -Message "HealthFlow $ExpectedVersion installed successfully."
} catch {
  $failure = $_.Exception.Message
  try {
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Restore-Backup
    Start-HealthFlowService
    Write-UpdateStatus -State 'rolled_back' -Message "Update failed and the previous version was restored: $failure"
  } catch {
    Write-UpdateStatus -State 'failed' -Message "Update and rollback failed. Manual support is required: $failure; rollback: $($_.Exception.Message)"
  }
} finally {
  Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $packageFile -Force -ErrorAction SilentlyContinue
}
