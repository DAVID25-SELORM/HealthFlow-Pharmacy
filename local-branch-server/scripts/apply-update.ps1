#Requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$PackagePath,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [string]$ServiceName = 'HealthFlowOfflineServer',
  [string]$DatabasePath = '',
  # Normally found from the Windows service itself; only set this to point the updater at a specific Node.js.
  [string]$NodePath = '',
  [int]$HealthTimeoutSeconds = 60
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

# Files can stay locked for a moment after a process ends, so removals are retried.
function Remove-InstallItem {
  param([string]$Path)
  for ($attempt = 1; $attempt -le 6; $attempt++) {
    try {
      Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
      return
    } catch {
      if ($attempt -eq 6) { throw }
      Start-Sleep -Seconds 2
    }
  }
}

# Names that stay in the install folder untouched (set once the update has decided what it keeps). Anything listed
# here is neither removed by the update nor part of the backup, so a restore must not remove it either.
$script:keepNames = @('.env', 'updates')
# Only true once the backup is complete. A restore before that point would delete the install and put nothing back.
$script:backupComplete = $false

function Restore-Backup {
  if (-not $script:backupComplete -or -not (Test-Path -LiteralPath $backupDir)) { return }
  Get-ChildItem -LiteralPath $installPath -Force |
    Where-Object { $_.Name -notin $script:keepNames } |
    ForEach-Object { Remove-InstallItem -Path $_.FullName }
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

# The Node.js the Windows service actually runs. Installs made by the one-button installer use a bundled Node.js
# (with its own npm) and may have no Node.js on the PC at all, so dependencies must be installed with this one:
# the SQLite native module has to match the Node.js that loads it.
function Get-ServiceNodePath {
  if ($NodePath) {
    if (Test-Path -LiteralPath $NodePath -PathType Leaf) { return (Resolve-Path -LiteralPath $NodePath).Path }
    throw "The Node.js path given to the updater does not exist: $NodePath"
  }
  $parameters = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters"
  $application = (Get-ItemProperty -LiteralPath $parameters -ErrorAction SilentlyContinue).Application
  if ($application -and (Test-Path -LiteralPath $application -PathType Leaf)) { return $application }
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return ''
}

# A fingerprint of the dependency list. package-lock.json starts with the package's own version (twice), which changes
# with every release, so those two are ignored; line endings are normalised so a checkout setting cannot change it.
function Get-DependencyFingerprint {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  $text = [System.IO.File]::ReadAllText($Path).Replace("`r`n", "`n")
  $ownVersion = New-Object System.Text.RegularExpressions.Regex('"version"\s*:\s*"[^"]*"')
  $normalized = $ownVersion.Replace($text, '"version": "0"', 2)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($normalized))).Replace('-', '')
  } finally {
    $sha.Dispose()
  }
}

function Install-ProductionDependencies {
  param([string]$NodeExe)
  Push-Location $installPath
  try {
    $npmCli = ''
    if ($NodeExe) {
      $candidate = Join-Path (Split-Path -Parent $NodeExe) 'node_modules\npm\bin\npm-cli.js'
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { $npmCli = $candidate }
    }
    if ($npmCli) {
      $previousPath = $env:Path
      $env:Path = "$(Split-Path -Parent $NodeExe);$env:Path"
      try {
        & $NodeExe $npmCli ci --omit=dev
      } finally {
        $env:Path = $previousPath
      }
    } else {
      $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
      if (-not $npm) {
        throw 'The dependencies changed in this update, but neither the bundled Node.js npm nor a system npm was found to install them.'
      }
      & $npm.Source ci --omit=dev
    }
    if ($LASTEXITCODE -ne 0) {
      throw "npm ci failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
}

# The server answers HTTPS only once its facility certificate is set up, and its certificate names the PC, not
# 127.0.0.1. This check is a loopback request to our own server, so certificate names are not checked.
function Test-HealthFlowHealthy {
  param([string]$NodeExe, [string]$Token, [string]$Port, [bool]$Tls)
  $scheme = if ($Tls) { 'https' } else { 'http' }
  $url = "${scheme}://127.0.0.1:$Port/health"
  if ($NodeExe) {
    $checkScript = Join-Path $workDir 'health-check.cjs'
    New-Item -ItemType Directory -Force -Path $workDir | Out-Null
    @'
const url = process.env.HEALTHFLOW_CHECK_URL
const token = process.env.HEALTHFLOW_CHECK_TOKEN
const transport = url.startsWith('https') ? require('https') : require('http')
const request = transport.get(url, { headers: { 'x-branch-token': token }, rejectUnauthorized: false, timeout: 8000 }, (response) => {
  let body = ''
  response.on('data', (chunk) => { body += chunk })
  response.on('end', () => {
    try {
      const health = JSON.parse(body)
      process.exit(response.statusCode === 200 && health.ok && health.database && health.database.integrity === 'ok' ? 0 : 2)
    } catch (error) { process.exit(3) }
  })
})
request.on('timeout', () => { request.destroy(); process.exit(5) })
request.on('error', () => process.exit(4))
'@ | Set-Content -LiteralPath $checkScript -Encoding ASCII
    $env:HEALTHFLOW_CHECK_URL = $url
    $env:HEALTHFLOW_CHECK_TOKEN = $Token
    try {
      & $NodeExe $checkScript | Out-Null
      return ($LASTEXITCODE -eq 0)
    } finally {
      Remove-Item Env:\HEALTHFLOW_CHECK_URL, Env:\HEALTHFLOW_CHECK_TOKEN -ErrorAction SilentlyContinue
    }
  }
  if ($Tls) { return $false }
  try {
    $health = Invoke-RestMethod -Uri $url -Headers @{ 'x-branch-token' = $Token } -TimeoutSec 10
    return [bool]($health.ok -and $health.database.integrity -eq 'ok')
  } catch {
    return $false
  }
}

function Wait-HealthFlowReady {
  param([string]$NodeExe)
  $token = Get-EnvValue -Name 'BRANCH_SERVER_TOKEN'
  $port = Get-EnvValue -Name 'PORT'
  if (-not $port) { $port = '4780' }
  if (-not $token) { throw 'BRANCH_SERVER_TOKEN is missing after restart.' }
  $pfxPath = Get-EnvValue -Name 'HEALTHFLOW_TLS_PFX_PATH'
  $certPath = Get-EnvValue -Name 'HEALTHFLOW_TLS_CERT_PATH'
  $tls = [bool](($pfxPath -and (Test-Path -LiteralPath $pfxPath)) -or ($certPath -and (Test-Path -LiteralPath $certPath)))

  $deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
  do {
    if (Test-HealthFlowHealthy -NodeExe $NodeExe -Token $token -Port $port -Tls $tls) { return }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)

  $scheme = if ($tls) { 'https' } else { 'http' }
  throw "HealthFlow did not report a healthy server at ${scheme}://127.0.0.1:$port after restart."
}

Start-Sleep -Seconds 3

try {
  Write-UpdateStatus -State 'stopping_service' -Message "Stopping $ServiceName and preparing the update."
  $serviceNode = Get-ServiceNodePath
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

  # Things that stay exactly as they are: the settings, the update status, and the Node.js the service runs when
  # it lives inside this folder. Dependencies stay too unless the update changes the dependency list.
  $keepNames = @('.env', 'updates')
  if ($serviceNode) {
    $nodeFull = [System.IO.Path]::GetFullPath($serviceNode)
    $prefix = $installPath.TrimEnd('\') + '\'
    if ($nodeFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      $keepNames += ($nodeFull.Substring($prefix.Length) -split '\\')[0]
    }
  }
  $installedLock = Get-DependencyFingerprint -Path (Join-Path $installPath 'package-lock.json')
  $payloadLock = Get-DependencyFingerprint -Path (Join-Path $payloadDir 'package-lock.json')
  $installedModulesOk = Test-Path -LiteralPath (Join-Path $installPath 'node_modules\better-sqlite3')
  $dependenciesChanged = [bool]($payloadLock -and ((-not $installedLock) -or ($payloadLock -ne $installedLock) -or (-not $installedModulesOk)))
  if (-not $dependenciesChanged -and $installedModulesOk) { $keepNames += 'node_modules' }
  $script:keepNames = $keepNames

  # Items that stay untouched are not copied: only what the update replaces needs a backup.
  Write-UpdateStatus -State 'backing_up' -Message 'Backing up the application and local database.'
  Get-ChildItem -LiteralPath $installPath -Force |
    Where-Object { $_.Name -notin $keepNames } |
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
  $script:backupComplete = $true

  Write-UpdateStatus -State 'installing_files' -Message 'Installing verified application files.'
  Get-ChildItem -LiteralPath $installPath -Force |
    Where-Object { $_.Name -notin $keepNames } |
    ForEach-Object { Remove-InstallItem -Path $_.FullName }
  Get-ChildItem -LiteralPath $payloadDir -Force |
    Where-Object { $_.Name -notin ($keepNames + @('data', 'logs', 'node_modules')) } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $installPath -Recurse -Force }

  if ($dependenciesChanged) {
    Write-UpdateStatus -State 'installing_dependencies' -Message 'Installing production dependencies.'
    Install-ProductionDependencies -NodeExe $serviceNode
  } else {
    Write-UpdateStatus -State 'installing_dependencies' -Message 'Dependencies are unchanged; keeping the installed ones.'
  }

  Write-UpdateStatus -State 'restarting' -Message "Restarting $ServiceName."
  Start-HealthFlowService
  Start-Sleep -Seconds 3
  $service = Get-Service -Name $ServiceName
  if ($service.Status -ne 'Running') {
    throw "$ServiceName did not remain running after the update."
  }
  Write-UpdateStatus -State 'verifying' -Message 'Verifying the API and local database after restart.'
  Wait-HealthFlowReady -NodeExe $serviceNode

  Write-UpdateStatus -State 'installed' -Message "HealthFlow $ExpectedVersion installed successfully."
  # Each backup holds a copy of the database, so only the newest two are kept.
  Get-ChildItem -LiteralPath $parentDir -Directory -Filter 'backup-*' -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    Select-Object -Skip 2 |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
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
