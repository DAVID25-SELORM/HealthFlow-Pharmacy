<#
  One-step setup of HealthFlow Offline on this Windows computer.

  Does everything in order, in one window:
    1. Takes the setup code and checks it BEFORE changing anything on this computer. It uses, in order: the
       HealthFlow-Setup-*.txt file downloaded by the "Set up offline on a computer" button in HealthFlow
       Cloud (found next to the installer or in Downloads, deleted after a successful setup), the code
       copied from Branch Sync Setup on the clipboard, or a code pasted into the window.
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
  # Extra folders to look in for the downloaded HealthFlow-Setup-*.txt (the usual places are searched anyway).
  [string[]]$SetupFolders = @(),
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

# A setup code that has not been used within this long stops working (the cloud expires it after 48 hours).
$setupFileMaxAgeHours = 48

# Finds the setup file downloaded by the cloud button: next to the installer (the extracted folder, the
# folder above it where the ZIP was extracted from, the ZIP's own folder) and in this user's Downloads.
function Find-SetupFile {
  $folders = New-Object System.Collections.Generic.List[string]
  foreach ($extra in $SetupFolders) { if ($extra) { $folders.Add($extra) } }
  $cursor = $sourceServerDir
  for ($i = 0; $i -lt 3 -and $cursor; $i++) {
    $folders.Add($cursor)
    $cursor = Split-Path -Parent $cursor
  }
  if ($env:USERPROFILE) { $folders.Add((Join-Path $env:USERPROFILE 'Downloads')) }

  $now = Get-Date
  $usable = New-Object System.Collections.Generic.List[object]
  foreach ($folder in ($folders | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $folder -PathType Container)) { continue }
    foreach ($file in (Get-ChildItem -LiteralPath $folder -Filter 'HealthFlow-Setup-*.txt' -File -ErrorAction SilentlyContinue)) {
      # Prefer the expiry written into the file; otherwise assume the file's age.
      $expires = $file.LastWriteTime.AddHours($setupFileMaxAgeHours)
      $head = Get-Content -LiteralPath $file.FullName -TotalCount 12 -ErrorAction SilentlyContinue
      $marker = $head | Where-Object { $_ -match '^\s*#\s*HEALTHFLOW_SETUP_EXPIRES=(.+)$' } | Select-Object -First 1
      if ($marker -match '=(.+)$') {
        $parsed = [DateTimeOffset]::MinValue
        if ([DateTimeOffset]::TryParse($Matches[1].Trim(), [ref]$parsed)) { $expires = $parsed.LocalDateTime }
      }
      if ($expires -lt $now) {
        Write-Host "Ignoring $($file.Name): it expired on $($expires.ToString('yyyy-MM-dd HH:mm')). Download a new one from HealthFlow Cloud." -ForegroundColor Yellow
        continue
      }
      $usable.Add($file)
    }
  }
  return ($usable | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
}
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
$setupFileUsed = ''
if ($BlockFile) {
  if (-not (Test-Path -LiteralPath $BlockFile)) { Stop-WithMessage "File not found: $BlockFile" }
  $block = Get-Content -LiteralPath $BlockFile -Raw
} else {
  # The "Set up offline on a computer" button in HealthFlow Cloud downloads HealthFlow-Setup-*.txt next to
  # the installer. Use the newest one that has not expired; otherwise fall back to the clipboard.
  $setupFile = Find-SetupFile
  if ($setupFile) {
    $block = Get-Content -LiteralPath $setupFile.FullName -Raw
    if (Test-LooksLikeSetupBlock $block) {
      $setupFileUsed = $setupFile.FullName
      Write-Host "Using the setup file $($setupFile.Name) (downloaded $($setupFile.LastWriteTime.ToString('yyyy-MM-dd HH:mm')))."
    } else {
      Write-Host "The file $($setupFile.Name) is not a HealthFlow setup file; ignoring it." -ForegroundColor Yellow
      $block = ''
    }
  }
  if (-not $setupFileUsed) {
    try { $block = [string](Get-Clipboard -Raw) } catch { $block = '' }
  }
}

$blockFromClipboard = (-not $BlockFile) -and (-not $setupFileUsed) -and (Test-LooksLikeSetupBlock $block)

if (-not (Test-LooksLikeSetupBlock $block)) {
  Write-Host 'No HealthFlow setup file (HealthFlow-Setup-*.txt) or setup code on the clipboard was found.'
  Write-Host 'In HealthFlow Cloud: Offline Sync, Branch Sync Setup, press "Set up offline on a computer" (or register this computer and press Copy).'
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
  # It also asks whether an existing install on this computer holds another pharmacy's records.
  $block | & $nodeExe $checkHelper --check --installed-root $InstallRoot
  if ($LASTEXITCODE -ne 0) {
    Stop-WithMessage 'Setup stopped and nothing was installed. The reason is above. If the setup code is the problem, copy the whole block again from Branch Sync Setup and run this again.'
  }
}

if ($DryRun) {
  Write-Step 'Dry run: this is what would happen next'
  if ($setupFileUsed) {
    Write-Host "  (setup file in use: $(Split-Path -Leaf $setupFileUsed); it would be deleted after a successful setup)"
  }
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

# The setup file holds a sync token; do not leave it sitting in Downloads once it has been used.
if ($setupFileUsed) {
  try {
    [System.IO.File]::WriteAllText($setupFileUsed, '')
    Remove-Item -LiteralPath $setupFileUsed -Force -ErrorAction Stop
    Write-Host 'Deleted the setup file now that it has been used.'
  } catch {
    Write-Host "Delete the setup file yourself: $setupFileUsed" -ForegroundColor Yellow
  }
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
# The desktop shortcut registers the browser it opens in. The plain address would open a browser that is not connected.
$posShortcut = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'HealthFlow Offline POS.url'
$launchTarget = if (Test-Path -LiteralPath $posShortcut) { $posShortcut } else { $serverUrl }
try {
  Start-Process $launchTarget | Out-Null
  Write-Host 'Opened HealthFlow Offline in your browser.'
} catch {
  Write-Host "Open $serverUrl, or use the 'HealthFlow Offline POS' desktop shortcut." -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'All done. Sign in to HealthFlow Offline; the first sync starts on its own.' -ForegroundColor Green
Exit-Script 0
