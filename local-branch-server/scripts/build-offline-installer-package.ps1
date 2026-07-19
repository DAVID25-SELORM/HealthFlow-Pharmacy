param(
  [string]$OutputDir = '',
  [string]$NodeRuntimeZipPath = '',
  [string]$NodeRuntimeChannel = 'latest-v22.x',
  [switch]$DownloadNodeRuntime,
  [switch]$SkipFrontendBuild
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Split-Path -Parent $scriptDir
$repoRoot = Split-Path -Parent $serverDir

if (-not $OutputDir) {
  $OutputDir = Join-Path $repoRoot 'release\installers'
}

function Get-PackageVersion {
  $packageJson = Get-Content -LiteralPath (Join-Path $serverDir 'package.json') -Raw | ConvertFrom-Json
  return $packageJson.version
}

function Copy-DirectoryContents {
  param(
    [string]$Source,
    [string]$Destination,
    [string[]]$ExcludeNames = @()
  )

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $Source -Force |
    Where-Object { $_.Name -notin $ExcludeNames } |
    ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
    }
}

function Resolve-NodeRuntimeZip {
  if ($NodeRuntimeZipPath) {
    $resolved = Resolve-Path -LiteralPath $NodeRuntimeZipPath -ErrorAction SilentlyContinue
    if (-not $resolved) {
      throw "Node runtime ZIP not found: $NodeRuntimeZipPath"
    }
    return $resolved.Path
  }

  if (-not $DownloadNodeRuntime) {
    throw 'Node runtime ZIP is required. Pass -NodeRuntimeZipPath or use -DownloadNodeRuntime while building the installer.'
  }

  $nodeIndexUrl = "https://nodejs.org/dist/$NodeRuntimeChannel/"
  $downloadDir = Join-Path $OutputDir '_downloads'
  New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null

  Write-Host "Resolving Node.js runtime from $nodeIndexUrl ..."
  $index = Invoke-WebRequest -Uri $nodeIndexUrl -UseBasicParsing
  $link = $index.Links |
    Where-Object { $_.href -match 'node-v[^/]+-win-x64\.zip$' } |
    Select-Object -First 1
  if (-not $link) {
    $match = [regex]::Match($index.Content, 'href=[''"]([^''"]*node-v[^''"]+-win-x64\.zip)[''"]')
    if ($match.Success) {
      $fileHref = $match.Groups[1].Value
    }
  } else {
    $fileHref = $link.href
  }
  if (-not $fileHref) {
    throw "Could not find a Windows x64 Node.js runtime ZIP at $nodeIndexUrl"
  }

  $fileName = Split-Path -Leaf $fileHref
  $downloadPath = Join-Path $downloadDir $fileName
  if (-not (Test-Path -LiteralPath $downloadPath -PathType Leaf)) {
    Write-Host "Downloading Node.js runtime: $fileName"
    $downloadUrl = if ($fileHref -match '^https?://') {
      $fileHref
    } elseif ($fileHref.StartsWith('/')) {
      "https://nodejs.org$fileHref"
    } else {
      "$nodeIndexUrl$fileHref"
    }
    Invoke-WebRequest -Uri $downloadUrl -OutFile $downloadPath -UseBasicParsing
  }
  return $downloadPath
}

function Expand-NodeRuntime {
  param(
    [string]$ZipPath,
    [string]$Destination
  )

  $destinationParent = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
  $extractRoot = Join-Path $destinationParent '_node_extract'
  if (Test-Path -LiteralPath $extractRoot) {
    Remove-Item -LiteralPath $extractRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $extractRoot -Force

  $nodeExe = Get-ChildItem -LiteralPath $extractRoot -Recurse -Filter 'node.exe' |
    Select-Object -First 1
  if (-not $nodeExe) {
    throw "node.exe was not found inside $ZipPath"
  }

  $runtimeRoot = Split-Path -Parent $nodeExe.FullName
  if (Test-Path -LiteralPath $Destination) {
    Remove-Item -LiteralPath $Destination -Recurse -Force
  }
  Copy-Item -LiteralPath $runtimeRoot -Destination $Destination -Recurse -Force
  Remove-Item -LiteralPath $extractRoot -Recurse -Force
}

function Write-InstallerReadme {
  param(
    [string]$Destination,
    [string]$Version
  )

  $content = @"
HealthFlow Offline Installer $Version

Purpose
- Installs the HealthFlow local branch server, offline app, SQLite database, Windows service, desktop shortcut, facility TLS certificate, and workstation enrollment tools.
- Designed for pharmacy/hospital first-time offline setup after the administrator permits/registers the facility machine.
- Does not require internet during installation when this package was built with bundled Node.js, bundled NSSM, and bundled production dependencies.

How to install
1. Extract this ZIP on the target Windows computer.
2. Right-click Install-HealthFlow.cmd and choose Run as administrator.
3. Wait for production health checks to pass.
4. Open the HealthFlow Offline POS desktop shortcut.
5. Use Branch Sync Setup/Offline Setup Wizard while internet is available to register and sync the facility data. After setup and sync, supported operations can continue offline.

Included
- local-branch-server application files
- offline browser app in local-branch-server/public
- production node_modules
- portable Node.js runtime in local-branch-server/runtime/node
- bundled NSSM service helper
- one-click elevated installer

Important
- Do not expose port 4780 to the public internet.
- Keep the generated branch tokens private.
- Facility data is stored under C:\HealthFlowLocal\data after installation and is preserved during updates.
"@

  Set-Content -LiteralPath (Join-Path $Destination 'README-FIRST.txt') -Value $content -Encoding UTF8
}

$version = Get-PackageVersion
$packageName = "HealthFlow-Offline-Installer-$version"
$stagingRoot = Join-Path $OutputDir $packageName
$stagingServerDir = Join-Path $stagingRoot 'local-branch-server'
$zipPath = Join-Path $OutputDir "$packageName.zip"

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
if (Test-Path -LiteralPath $stagingRoot) {
  Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

if (-not $SkipFrontendBuild) {
  Push-Location $repoRoot
  try {
    Write-Host 'Building offline browser app...'
    npm.cmd run build:offline
    if ($LASTEXITCODE -ne 0) {
      throw "npm run build:offline failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
}

Write-Host 'Creating installer staging folder...'
Copy-DirectoryContents `
  -Source $serverDir `
  -Destination $stagingServerDir `
  -ExcludeNames @('data', 'logs', '.env', 'node_modules', 'branch-server.err.log', 'branch-server.out.log', 'runtime.err.log', 'runtime.out.log')

$nodeZip = Resolve-NodeRuntimeZip
$runtimeDir = Join-Path $stagingServerDir 'runtime\node'
Write-Host 'Bundling portable Node.js runtime...'
Expand-NodeRuntime -ZipPath $nodeZip -Destination $runtimeDir

$nodeExe = Join-Path $runtimeDir 'node.exe'
$npmCliPath = Join-Path $runtimeDir 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
  throw "Bundled node.exe was not found: $nodeExe"
}
if (-not (Test-Path -LiteralPath $npmCliPath -PathType Leaf)) {
  throw "Bundled npm CLI was not found: $npmCliPath"
}

Push-Location $stagingServerDir
try {
  Write-Host 'Installing production dependencies with the bundled Node.js runtime...'
  $previousPath = $env:PATH
  $env:PATH = "$runtimeDir;$previousPath"
  & $nodeExe $npmCliPath ci --omit=dev
  if ($LASTEXITCODE -ne 0) {
    throw "npm ci --omit=dev failed with exit code $LASTEXITCODE."
  }
} finally {
  if ($previousPath) {
    $env:PATH = $previousPath
  }
  Pop-Location
}

$nssmPath = Join-Path $stagingServerDir 'deployment\windows\nssm\win64\nssm.exe'
if (-not (Test-Path -LiteralPath $nssmPath -PathType Leaf)) {
  throw "Bundled NSSM is missing: $nssmPath"
}

$offlineIndex = Join-Path $stagingServerDir 'public\index.html'
if (-not (Test-Path -LiteralPath $offlineIndex -PathType Leaf)) {
  throw "Offline browser app was not found: $offlineIndex"
}

Write-InstallerReadme -Destination $stagingRoot -Version $version

Write-Host 'Creating installer ZIP...'
Compress-Archive -Path (Join-Path $stagingRoot '*') -DestinationPath $zipPath -Force

$hash = Get-FileHash -LiteralPath $zipPath -Algorithm SHA256
Set-Content -LiteralPath "$zipPath.sha256.txt" -Value "$($hash.Hash)  $(Split-Path -Leaf $zipPath)" -Encoding ASCII

Write-Host ''
Write-Host 'HealthFlow offline installer package created.'
Write-Host "ZIP:    $zipPath"
Write-Host "SHA256: $($hash.Hash)"
Write-Host ''
Write-Host 'Publish this ZIP to your approved HTTPS download location, then set:'
Write-Host "VITE_HEALTHFLOW_INSTALLER_URL=https://healthflowcloud.com/downloads/$(Split-Path -Leaf $zipPath)"
