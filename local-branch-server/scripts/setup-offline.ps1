<#
  One-step setup of HealthFlow Offline on this Windows computer.

  Does everything in order, in one window:
    1. Takes the setup code (copied from Branch Sync Setup in HealthFlow Cloud) from the clipboard, or asks
       for it to be pasted, and checks it BEFORE changing anything on this computer.
    2. Installs the offline server (files, Windows service, shortcut, facility certificate).
    3. Saves the cloud connection, restarts the service and runs the health check.
    4. Opens the offline POS.

  Tokens and keys are never printed. Safe to run again: install repairs/updates in place and keeps data.

  -DryRun checks the setup code and shows the plan without installing or changing anything (no
  administrator rights needed). -BlockFile reads the setup code from a file instead of the clipboard.
  -WaitAtEnd keeps the window open until Enter is pressed.
#>
param(
  [string]$InstallRoot = 'C:\HealthFlowLocal',
  [string]$BlockFile = '',
  [string]$ServiceName = 'HealthFlowOfflineServer',
  [switch]$DryRun,
  [switch]$WaitAtEnd
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Exit-Script {
  param([int]$Code)
  if ($WaitAtEnd) {
    Write-Host ''
    [void](Read-Host 'Press Enter to close this window')
  }
  exit $Code
}

function Stop-WithMessage {
  param([string]$Message)
  Write-Host ''
  Write-Host $Message -ForegroundColor Red
  Exit-Script 1
}

function Write-Step {
  param([string]$Text)
  Write-Host ''
  Write-Host $Text -ForegroundColor Cyan
}

function Test-LooksLikeSetupBlock {
  param([string]$Text)
  return ($Text -match '(?m)^\s*ORGANIZATION_ID=') -and ($Text -match '(?m)^\s*BRANCH_SYNC_TOKEN=')
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceServerDir = Split-Path -Parent $scriptDir
$installScript = Join-Path $scriptDir 'install-windows-service.ps1'
$checkHelper = Join-Path $scriptDir 'connect-to-cloud.mjs'
$serverUrl = "https://$($env:COMPUTERNAME.ToLowerInvariant()):4780"

Write-Host ''
Write-Host 'HealthFlow Offline - one-step setup' -ForegroundColor Cyan
if ($DryRun) { Write-Host '(dry run: nothing will be installed or changed)' -ForegroundColor Yellow }

if (-not $DryRun) {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Stop-WithMessage 'This needs administrator rights. Double-click Set-Up-HealthFlow-Offline.cmd instead of running the script directly.'
  }
}

foreach ($required in @($installScript, $checkHelper)) {
  if (-not (Test-Path -LiteralPath $required)) {
    Stop-WithMessage "Part of the installer is missing: $required. Extract the whole ZIP again and retry."
  }
}

$nodeExe = Join-Path $sourceServerDir 'runtime\node\node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) {
  $found = Get-Command node -ErrorAction SilentlyContinue
  if (-not $found) { Stop-WithMessage 'The Node.js runtime that ships with this installer is missing. Extract the whole ZIP again and retry.' }
  $nodeExe = $found.Source
}

$alreadyInstalled = [bool](Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)

# --- Step 1: the setup code ---------------------------------------------------------------------------
Write-Step 'Step 1 of 4: setup code'
$block = ''
if ($BlockFile) {
  if (-not (Test-Path -LiteralPath $BlockFile)) { Stop-WithMessage "File not found: $BlockFile" }
  $block = Get-Content -LiteralPath $BlockFile -Raw
} else {
  try { $block = [string](Get-Clipboard -Raw) } catch { $block = '' }
}

$blockFromClipboard = (-not $BlockFile) -and (Test-LooksLikeSetupBlock $block)

if (-not (Test-LooksLikeSetupBlock $block)) {
  Write-Host 'No HealthFlow setup code found on the clipboard.'
  Write-Host 'In HealthFlow Cloud: Branch Sync Setup, register this computer, press Copy.'
  if ($alreadyInstalled) {
    Write-Host 'HealthFlow is already installed here. Paste a new setup code to reconnect it,'
    Write-Host 'or just press Enter to only check that it is working.'
  } else {
    Write-Host 'Paste it here now (right-click), then press Enter on an empty line:'
  }
  $lines = New-Object System.Collections.Generic.List[string]
  while ($true) {
    $line = Read-Host
    if ([string]::IsNullOrWhiteSpace($line)) { break }
    $lines.Add($line)
  }
  $block = ($lines -join "`n")
}

$haveBlock = Test-LooksLikeSetupBlock $block
if (-not $haveBlock -and -not $alreadyInstalled) {
  Stop-WithMessage 'No setup code was given, so nothing was installed. Copy it from Branch Sync Setup in HealthFlow Cloud and run this again.'
}

if ($haveBlock) {
  # Same checks the real save runs, against a throwaway file: a bad code is caught before anything is installed.
  $block | & $nodeExe $checkHelper --check
  if ($LASTEXITCODE -ne 0) {
    Stop-WithMessage 'The setup code is not usable, so nothing was installed. Copy the whole block again from Branch Sync Setup and run this again.'
  }
}

if ($DryRun) {
  Write-Step 'Dry run: this is what would happen next'
  if ($haveBlock) {
    Write-Host "  2. Install HealthFlow Offline into $InstallRoot (Windows service $ServiceName)"
    Write-Host '  3. Save the cloud connection, restart the service, run the health check'
    Write-Host "  4. Open $serverUrl"
  } else {
    Write-Host '  2. Run the health check on the existing install'
    Write-Host "  3. Open $serverUrl"
  }
  Write-Host ''
  Write-Host 'Dry run finished. Nothing was changed.' -ForegroundColor Green
  Exit-Script 0
}

# --- Step 2: install ----------------------------------------------------------------------------------
if ($haveBlock) {
  Write-Step 'Step 2 of 4: installing HealthFlow Offline (a few minutes)'
  try {
    & $installScript -InstallRoot $InstallRoot -OfflineOnly -NoBrowser
  } catch {
    Stop-WithMessage "The installation did not finish: $($_.Exception.Message)"
  }
  if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
    Stop-WithMessage "The installation did not finish: the $ServiceName service was not created. See the messages above."
  }
} else {
  Write-Step 'Step 2 of 4: already installed, skipping the install'
}

# --- Step 3: connect to the cloud, restart, health check -------------------------------------------------
$connected = $true
if ($haveBlock) {
  Write-Step 'Step 3 of 4: connecting to HealthFlow Cloud'
  $connectScript = Join-Path $InstallRoot 'local-branch-server\scripts\connect-to-cloud.ps1'
  if (-not (Test-Path -LiteralPath $connectScript)) {
    Stop-WithMessage "The installed connection helper is missing: $connectScript."
  }
  & $connectScript -InstallRoot $InstallRoot -ServiceName $ServiceName -Block $block
  $connected = ($LASTEXITCODE -eq 0)
  $block = $null
} else {
  Write-Step 'Step 3 of 4: checking the existing install'
  & (Join-Path $InstallRoot 'local-branch-server\scripts\health-check.ps1') -InstallRoot $InstallRoot
  $connected = ($LASTEXITCODE -eq 0)
}

if (-not $connected) {
  Write-Host ''
  if ($haveBlock) {
    Write-Host 'HealthFlow is installed, but the cloud connection step did not finish (see the messages above).' -ForegroundColor Yellow
    Write-Host 'Fix the problem shown, then double-click Set-Up-HealthFlow-Offline.cmd again. Your data is kept.' -ForegroundColor Yellow
  } else {
    Write-Host 'The health check reported a problem (see the FAIL lines above).' -ForegroundColor Yellow
  }
  Exit-Script 1
}

# The setup code holds a sync token; do not leave it sitting on the clipboard.
if ($blockFromClipboard) {
  try {
    if (Test-LooksLikeSetupBlock ([string](Get-Clipboard -Raw))) { Set-Clipboard -Value $null }
  } catch {
    # Clearing the clipboard is a courtesy; setup itself already succeeded.
  }
}

# --- Step 4: open the POS ---------------------------------------------------------------------------
Write-Step 'Step 4 of 4: opening HealthFlow Offline'
try {
  Start-Process $serverUrl | Out-Null
  Write-Host "Opened $serverUrl in your browser."
} catch {
  Write-Host "Open $serverUrl, or use the 'HealthFlow Offline POS' desktop shortcut." -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'All done. Sign in to HealthFlow Offline; the first sync starts on its own.' -ForegroundColor Green
Exit-Script 0
