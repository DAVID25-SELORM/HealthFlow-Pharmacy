#Requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$PackagePath,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [string]$ServiceName = 'HealthFlowOfflineServer',
  [string]$DatabasePath = ''
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
$databaseBackupDir = Join-Path $backupDir 'database'
$databaseBackupPath = if ($DatabasePath) {
  Join-Path $databaseBackupDir ([System.IO.Path]::GetFileName($DatabasePath))
} else {
  ''
}

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
    Where-Object { $_.Name -ne 'database' } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $installPath -Recurse -Force }
  if ($DatabasePath -and (Test-Path -LiteralPath $databaseBackupPath)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $DatabasePath) | Out-Null
    foreach ($suffix in @('', '-wal', '-shm')) {
      $target = "$DatabasePath$suffix"
      $source = "$databaseBackupPath$suffix"
      Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $source) {
        Copy-Item -LiteralPath $source -Destination $target -Force
      }
    }
  }
}

function Get-EnvValue {
  param([string]$Name)
  $envPath = Join-Path $installPath '.env'
  if (-not (Test-Path -LiteralPath $envPath)) { return '' }
  $match = Get-Content -LiteralPath $envPath |
    Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } |
    Select-Object -First 1
  if (-not $match) { return '' }
  return ($match -split '=', 2)[1].Trim()
}

function Wait-HealthFlowReady {
  $token = Get-EnvValue -Name 'BRANCH_SERVER_TOKEN'
  $port = Get-EnvValue -Name 'PORT'
  if (-not $port) { $port = '4780' }
  if (-not $token) { throw 'BRANCH_SERVER_TOKEN is missing after restart.' }

  $deadline = (Get-Date).AddSeconds(60)
  $lastError = ''
  do {
    try {
      $health = Invoke-RestMethod `
        -Uri "http://127.0.0.1:$port/health" `
        -Headers @{ 'x-branch-token' = $token } `
        -TimeoutSec 10
      if ($health.ok -and $health.database.integrity -eq 'ok') {
        return
      }
      $lastError = 'Health endpoint did not report a healthy database.'
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)

  throw "HealthFlow did not become ready after restart: $lastError"
}

Start-Sleep -Seconds 3

try {
  Write-UpdateStatus -State 'stopping_service' -Message "Stopping $ServiceName and preparing the update."
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

  Write-UpdateStatus -State 'backing_up' -Message 'Backing up the application and local database.'
  Get-ChildItem -LiteralPath $installPath -Force |
    Where-Object { $_.Name -notin @('.env', 'updates') } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $backupDir -Recurse -Force }
  if ($DatabasePath -and (Test-Path -LiteralPath $DatabasePath)) {
    New-Item -ItemType Directory -Force -Path $databaseBackupDir | Out-Null
    foreach ($suffix in @('', '-wal', '-shm')) {
      $source = "$DatabasePath$suffix"
      if (Test-Path -LiteralPath $source) {
        Copy-Item -LiteralPath $source -Destination "$databaseBackupPath$suffix" -Force
      }
    }
  }

  Write-UpdateStatus -State 'installing_files' -Message 'Installing verified application files.'
  Get-ChildItem -LiteralPath $installPath -Force |
    Where-Object { $_.Name -notin @('.env', 'updates') } |
    Remove-Item -Recurse -Force
  Get-ChildItem -LiteralPath $payloadDir -Force |
    Where-Object { $_.Name -notin @('.env', 'data', 'logs', 'updates', 'node_modules') } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $installPath -Recurse -Force }

  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  Write-UpdateStatus -State 'installing_dependencies' -Message 'Installing production dependencies.'
  Push-Location $installPath
  try {
    & $npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) {
      throw "npm ci failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }

  Write-UpdateStatus -State 'restarting' -Message "Restarting $ServiceName."
  Start-HealthFlowService
  Start-Sleep -Seconds 3
  $service = Get-Service -Name $ServiceName
  if ($service.Status -ne 'Running') {
    throw "$ServiceName did not remain running after the update."
  }
  Write-UpdateStatus -State 'verifying' -Message 'Verifying the API and local database after restart.'
  Wait-HealthFlowReady

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
