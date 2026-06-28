#Requires -RunAsAdministrator
param(
  [string]$InstallRoot = 'C:\HealthFlowLocal',
  [string]$NssmPath = '',
  [string]$NodePath = '',
  [switch]$InstallDependencies,
  [switch]$SkipCopy
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceServerDir = Split-Path -Parent $scriptDir
$sourceRepoRoot = Split-Path -Parent $sourceServerDir
$installServerDir = Join-Path $InstallRoot 'local-branch-server'
$logsDir = Join-Path $InstallRoot 'logs'
$dataDir = Join-Path $InstallRoot 'data'
$nssmInstallDir = Join-Path $InstallRoot 'nssm'
$shortcutPath = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'HealthFlow Offline POS.url'

$services = @(
  @{
    Name = 'HealthFlowOfflineServer'
    DisplayName = 'HealthFlow Offline Server'
    Description = 'Runs the HealthFlow Offline POS, local API, SQLite store, and sync worker.'
    Script = 'src/server.js'
    Stdout = 'offline-server.log'
    Stderr = 'offline-server-error.log'
  }
)

function Resolve-CommandPath {
  param(
    [string]$CommandName,
    [string]$ProvidedPath,
    [string[]]$CandidatePaths = @()
  )

  if ($ProvidedPath) {
    $resolved = Resolve-Path -LiteralPath $ProvidedPath -ErrorAction SilentlyContinue
    if ($resolved) { return $resolved.Path }
    throw "$CommandName was not found at: $ProvidedPath"
  }

  $command = Get-Command $CommandName -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  foreach ($candidate in $CandidatePaths) {
    $resolved = Resolve-Path -LiteralPath $candidate -ErrorAction SilentlyContinue
    if ($resolved) { return $resolved.Path }
  }

  throw "$CommandName was not found. Install it or pass its full path to this script."
}

function Ensure-Nssm {
  $candidatePaths = @(
    (Join-Path $sourceServerDir 'deployment\windows\nssm\win64\nssm.exe'),
    (Join-Path $sourceServerDir 'deployment\windows\nssm\nssm.exe'),
    (Join-Path $nssmInstallDir 'nssm.exe'),
    (Join-Path $scriptDir 'nssm.exe'),
    (Join-Path $sourceRepoRoot 'tools\nssm\nssm.exe'),
    (Join-Path $sourceRepoRoot 'tools\nssm\win64\nssm.exe'),
    'C:\nssm\win64\nssm.exe',
    'C:\nssm\nssm.exe',
    'C:\Program Files\nssm\nssm.exe',
    'C:\ProgramData\chocolatey\bin\nssm.exe'
  )

  try {
    $resolved = Resolve-CommandPath -CommandName 'nssm.exe' -ProvidedPath $NssmPath -CandidatePaths $candidatePaths
    New-Item -ItemType Directory -Force -Path $nssmInstallDir | Out-Null
    Copy-Item -LiteralPath $resolved -Destination (Join-Path $nssmInstallDir 'nssm.exe') -Force
    return (Join-Path $nssmInstallDir 'nssm.exe')
  } catch {
    Write-Warning 'Bundled NSSM was not found. Downloading NSSM 2.24...'
    New-Item -ItemType Directory -Force -Path $nssmInstallDir | Out-Null
    $zipPath = Join-Path $env:TEMP 'nssm-2.24.zip'
    $extractPath = Join-Path $env:TEMP 'nssm-2.24'
    Invoke-WebRequest -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $zipPath -UseBasicParsing
    if (Test-Path -LiteralPath $extractPath) {
      Remove-Item -LiteralPath $extractPath -Recurse -Force
    }
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force
    $downloadedNssm = Join-Path $extractPath 'nssm-2.24\win64\nssm.exe'
    if (-not (Test-Path -LiteralPath $downloadedNssm)) {
      throw 'NSSM download completed, but win64\nssm.exe was not found in the archive.'
    }
    Copy-Item -LiteralPath $downloadedNssm -Destination (Join-Path $nssmInstallDir 'nssm.exe') -Force
    return (Join-Path $nssmInstallDir 'nssm.exe')
  }
}

function Copy-BranchServer {
  $ensureEnv = {
    $targetEnv = Join-Path $installServerDir '.env'
    if (-not (Test-Path -LiteralPath $targetEnv)) {
      $sourceEnv = Join-Path $sourceServerDir '.env'
      $sourceEnvExample = Join-Path $sourceServerDir '.env.example'
      if (Test-Path -LiteralPath $sourceEnv) {
        Copy-Item -LiteralPath $sourceEnv -Destination $targetEnv -Force
        Write-Host 'Copied .env from source folder.'
      } elseif (Test-Path -LiteralPath $sourceEnvExample) {
        Copy-Item -LiteralPath $sourceEnvExample -Destination $targetEnv -Force
        Write-Warning 'Created .env from .env.example. Edit it before relying on this server.'
      }
    } else {
      Write-Host 'Existing .env preserved.'
    }
  }

  if ($SkipCopy) {
    Write-Host "Skipping file copy. Using existing install folder: $installServerDir"
    & $ensureEnv
    return
  }

  $sourceResolved = (Resolve-Path -LiteralPath $sourceServerDir).Path.TrimEnd('\')
  $targetResolved = $installServerDir.TrimEnd('\')

  New-Item -ItemType Directory -Force -Path $installServerDir | Out-Null

  if ($sourceResolved -ieq $targetResolved) {
    Write-Host "Source already matches install folder: $installServerDir"
    & $ensureEnv
    return
  }

  $excluded = @('data', 'logs', 'node_modules', '.env')
  Get-ChildItem -LiteralPath $sourceServerDir -Force |
    Where-Object { $_.Name -notin $excluded } |
    ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $installServerDir -Recurse -Force
    }

  & $ensureEnv
}

function Install-DependenciesIfNeeded {
  $nodeModules = Join-Path $installServerDir 'node_modules'
  if ((Test-Path -LiteralPath $nodeModules) -and -not $InstallDependencies) {
    Write-Host 'node_modules already exists. Skipping npm install.'
    return
  }

  $npmPath = Resolve-CommandPath -CommandName 'npm.cmd' -ProvidedPath ''
  Push-Location $installServerDir
  try {
    Write-Host 'Installing local branch server dependencies...'
    & $npmPath install --omit=dev
    if ($LASTEXITCODE -ne 0) {
      throw "npm install failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
}

function Get-EnvValue {
  param([string]$Name)
  $envPath = Join-Path $installServerDir '.env'
  if (-not (Test-Path -LiteralPath $envPath)) { return '' }
  $match = Get-Content -LiteralPath $envPath |
    Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } |
    Select-Object -First 1
  if (-not $match) { return '' }
  return ($match -split '=', 2)[1].Trim()
}

function Assert-ProductionConfiguration {
  $required = @(
    'BRANCH_SERVER_TOKEN',
    'ORGANIZATION_ID',
    'BRANCH_ID',
    'BRANCH_SYNC_TOKEN',
    'SUPABASE_URL',
    'SUPABASE_SYNC_KEY',
    'HEALTHFLOW_UPDATE_MANIFEST_URL',
    'HEALTHFLOW_UPDATE_PUBLIC_KEY'
  )
  $missing = @()
  foreach ($name in $required) {
    $value = Get-EnvValue -Name $name
    if (-not $value -or $value -match 'change[-_ ]?me|placeholder|your[-_ ]') {
      $missing += $name
    }
  }
  if ($missing.Count -gt 0) {
    throw "Production .env is incomplete. Configure: $($missing -join ', ')."
  }
}

function Assert-NodeVersion {
  param([string]$Node)
  $rawVersion = (& $Node --version)
  if ($LASTEXITCODE -ne 0 -or $rawVersion -notmatch '^v(\d+)\.') {
    throw 'Unable to determine the installed Node.js version.'
  }
  if ([int]$Matches[1] -lt 20) {
    throw "HealthFlow requires Node.js 20 or newer. Found $rawVersion."
  }
  Write-Host "Node.js runtime: $rawVersion"
}

function Remove-OldStartupTasks {
  $taskNames = @('HealthFlow Branch Server', 'HealthFlow Branch Sync Worker')
  foreach ($taskName in $taskNames) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
      Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
      Write-Host "Removed old scheduled task: $taskName"
    }
  }
}

function Remove-NssmServiceIfExists {
  param([string]$ServiceName, [string]$Nssm)

  $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if (-not $existing) { return }

  Write-Host "Removing existing service: $ServiceName"
  & $Nssm stop $ServiceName | Out-Null
  Start-Sleep -Seconds 2
  & $Nssm remove $ServiceName confirm | Out-Null
}

function Remove-LegacyServices {
  param([string]$Nssm)

  foreach ($serviceName in @('HealthFlowBranchServer', 'HealthFlowBranchSyncWorker')) {
    Remove-NssmServiceIfExists -ServiceName $serviceName -Nssm $Nssm
  }
}

function Install-NssmService {
  param(
    [hashtable]$Service,
    [string]$Nssm,
    [string]$Node
  )

  $stdoutPath = Join-Path $logsDir $Service.Stdout
  $stderrPath = Join-Path $logsDir $Service.Stderr
  $sqlitePath = Join-Path $dataDir 'healthflow-branch.sqlite'

  Remove-NssmServiceIfExists -ServiceName $Service.Name -Nssm $Nssm

  Write-Host "Installing service: $($Service.DisplayName)"
  & $Nssm install $Service.Name $Node $Service.Script | Out-Null
  & $Nssm set $Service.Name DisplayName $Service.DisplayName | Out-Null
  & $Nssm set $Service.Name Description $Service.Description | Out-Null
  & $Nssm set $Service.Name AppDirectory $installServerDir | Out-Null
  # ✅ SQLITE CORRUPTION FIX START
  & $Nssm set $Service.Name AppEnvironmentExtra NODE_ENV=production "HEALTHFLOW_DB_PATH=$sqlitePath" "SQLITE_PATH=$sqlitePath" | Out-Null
  # ✅ SQLITE CORRUPTION FIX END
  & $Nssm set $Service.Name AppStdout $stdoutPath | Out-Null
  & $Nssm set $Service.Name AppStderr $stderrPath | Out-Null
  & $Nssm set $Service.Name AppRotateFiles 1 | Out-Null
  & $Nssm set $Service.Name AppRotateOnline 1 | Out-Null
  & $Nssm set $Service.Name AppRotateSeconds 86400 | Out-Null
  & $Nssm set $Service.Name AppRotateBytes 10485760 | Out-Null
  & $Nssm set $Service.Name AppExit Default Restart | Out-Null
  & $Nssm set $Service.Name AppThrottle 1500 | Out-Null
  & $Nssm set $Service.Name Start SERVICE_AUTO_START | Out-Null
  & sc.exe failure $Service.Name reset= 86400 actions= restart/60000/restart/60000/restart/60000 | Out-Null
  & sc.exe failureflag $Service.Name 1 | Out-Null
  & $Nssm start $Service.Name | Out-Null
}

function Create-DesktopShortcut {
  $shortcutContent = @"
[InternetShortcut]
URL=http://localhost:4780
IconFile=%SystemRoot%\System32\SHELL32.dll
IconIndex=220
"@
  Set-Content -LiteralPath $shortcutPath -Value $shortcutContent -Encoding ASCII
  Write-Host "Created desktop shortcut: $shortcutPath"
}

$nssm = Ensure-Nssm
$node = Resolve-CommandPath -CommandName 'node.exe' -ProvidedPath $NodePath
Assert-NodeVersion -Node $node

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

Copy-BranchServer
Assert-ProductionConfiguration
Install-DependenciesIfNeeded

$frontendIndex = Join-Path $installServerDir 'public\index.html'
if (-not (Test-Path -LiteralPath $frontendIndex)) {
  Write-Warning "Offline POS bundle not found at $frontendIndex. Run npm.cmd run build:offline from the repo root before handover."
}

Remove-OldStartupTasks
Remove-LegacyServices -Nssm $nssm

foreach ($service in $services) {
  Install-NssmService -Service $service -Nssm $nssm -Node $node
}

Create-DesktopShortcut

$healthScript = Join-Path $installServerDir 'scripts\health-check.ps1'
Write-Host 'Waiting for the installed service to become healthy...'
$healthPassed = $false
for ($attempt = 1; $attempt -le 15; $attempt += 1) {
  Start-Sleep -Seconds 2
  & powershell -NoProfile -ExecutionPolicy Bypass -File $healthScript -InstallRoot $InstallRoot
  if ($LASTEXITCODE -eq 0) {
    $healthPassed = $true
    break
  }
}
if (-not $healthPassed) {
  throw 'HealthFlow service installation completed, but production health checks did not pass.'
}

Write-Host ''
Write-Host 'HealthFlow Offline Branch Server service installed.'
Write-Host "Install folder: $installServerDir"
Write-Host "Logs folder:    $logsDir"
Write-Host "Data folder:    $dataDir"
Write-Host "NSSM path:      $nssm"
Write-Host 'Desktop link:   HealthFlow Offline POS'
Write-Host ''
Write-Host 'Production health checks passed.'
