# Builds, signs and CHECKS a branch-server update, then places it in the website's update feed folder
# (public\branch-updates). It never publishes anything: the result is files in the repository that you review and
# merge like any other change.
#
#   -Feed beta    (default) writes public\branch-updates\beta\manifest.json. Only PCs whose .env points at
#                 .../branch-updates/beta/manifest.json see it, so it is the safe way to try an update on one PC.
#   -Feed stable  writes public\branch-updates\manifest.json, which every installed PC checks.
#
# The private signing key stays outside the repository: pass its path with -PrivateKeyPath.
param(
  [Parameter(Mandatory = $true)][string]$PrivateKeyPath,
  [Parameter(Mandatory = $true)][string]$ReleaseNotes,
  [ValidateSet('beta', 'stable')][string]$Feed = 'beta',
  [string]$PackageBaseUrl = 'https://healthflowcloud.com/branch-updates',
  [switch]$SkipFrontendBuild
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Split-Path -Parent $scriptDir
$repoDir = Split-Path -Parent $serverDir
$feedDir = Join-Path $repoDir 'public\branch-updates'
$packageJson = Get-Content -LiteralPath (Join-Path $serverDir 'package.json') -Raw | ConvertFrom-Json
$version = [string]$packageJson.version
$zipName = "healthflow-branch-$version.zip"
$stableManifestPath = Join-Path $feedDir 'manifest.json'

if (-not (Test-Path -LiteralPath $PrivateKeyPath -PathType Leaf)) {
  throw "Private key not found: $PrivateKeyPath"
}
if ((Resolve-Path -LiteralPath $PrivateKeyPath).Path.StartsWith($repoDir, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Keep the private signing key outside the repository.'
}
if (Test-Path -LiteralPath (Join-Path $feedDir $zipName)) {
  throw "$zipName is already in the feed. Published packages are never replaced: raise the version in local-branch-server\package.json."
}
$stableVersion = ''
if (Test-Path -LiteralPath $stableManifestPath) {
  $stableVersion = [string]((Get-Content -LiteralPath $stableManifestPath -Raw | ConvertFrom-Json).version)
}

if (-not $SkipFrontendBuild) {
  Write-Host 'Building the offline web app...'
  Push-Location $repoDir
  try {
    npm.cmd run build:offline
    if ($LASTEXITCODE -ne 0) { throw "npm run build:offline failed with exit code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
}

$workDir = Join-Path $env:TEMP ('healthflow-release-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $workDir | Out-Null
try {
  Write-Host "Building and signing update $version..."
  & (Join-Path $scriptDir 'build-update-package.ps1') `
    -PackageBaseUrl $PackageBaseUrl `
    -PrivateKeyPath $PrivateKeyPath `
    -ReleaseNotes $ReleaseNotes `
    -OutputDir $workDir
  if (-not $?) { throw 'The update package could not be built.' }

  Write-Host 'Checking the result...'
  $verifyArguments = @(
    (Join-Path $scriptDir 'verify-update-release.mjs'),
    '--manifest', (Join-Path $workDir 'manifest.json'),
    '--package', (Join-Path $workDir $zipName),
    '--env-file', (Join-Path $serverDir '.env.example')
  )
  if ($stableVersion) { $verifyArguments += @('--newer-than', $stableVersion) }
  & node @verifyArguments
  if ($LASTEXITCODE -ne 0) { throw 'The update did not pass its checks and was not added to the feed.' }

  New-Item -ItemType Directory -Force -Path $feedDir | Out-Null
  Copy-Item -LiteralPath (Join-Path $workDir $zipName) -Destination (Join-Path $feedDir $zipName)
  if ($Feed -eq 'beta') {
    $betaDir = Join-Path $feedDir 'beta'
    New-Item -ItemType Directory -Force -Path $betaDir | Out-Null
    Copy-Item -LiteralPath (Join-Path $workDir 'manifest.json') -Destination (Join-Path $betaDir 'manifest.json') -Force
    $feedUrl = ($PackageBaseUrl.TrimEnd('/') + '/beta/manifest.json')
  } else {
    Copy-Item -LiteralPath (Join-Path $workDir 'manifest.json') -Destination $stableManifestPath -Force
    $feedUrl = ($PackageBaseUrl.TrimEnd('/') + '/manifest.json')
  }

  Write-Host ''
  Write-Host "Update $version added to the $Feed feed in $feedDir"
  Write-Host "Feed address: $feedUrl"
  Write-Host 'Nothing is live until you commit these files and merge them.'
  if ($Feed -eq 'beta') {
    Write-Host 'To try it on one PC: set HEALTHFLOW_UPDATE_MANIFEST_URL to the feed address in that PC''s .env, restart the service, then use Check for updates.'
    Write-Host 'To release it to everyone afterwards: run promote-update-feed.ps1.'
  }
} finally {
  Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
