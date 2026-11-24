# Releases the update that has been tried on the beta feed to every PC, by copying
# public\branch-updates\beta\manifest.json over public\branch-updates\manifest.json after re-checking it.
# Nothing is live until the changed files are committed and merged.
param(
  [string]$PackageBaseUrl = 'https://healthflowcloud.com/branch-updates'
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Split-Path -Parent $scriptDir
$repoDir = Split-Path -Parent $serverDir
$feedDir = Join-Path $repoDir 'public\branch-updates'
$betaManifestPath = Join-Path $feedDir 'beta\manifest.json'
$stableManifestPath = Join-Path $feedDir 'manifest.json'

if (-not (Test-Path -LiteralPath $betaManifestPath)) {
  throw "There is no beta manifest to promote: $betaManifestPath"
}
$beta = Get-Content -LiteralPath $betaManifestPath -Raw | ConvertFrom-Json
$zipPath = Join-Path $feedDir ("healthflow-branch-$($beta.version).zip")
if (-not (Test-Path -LiteralPath $zipPath)) {
  throw "The beta update package is missing from the feed: $zipPath"
}
$stableVersion = ''
if (Test-Path -LiteralPath $stableManifestPath) {
  $stableVersion = [string]((Get-Content -LiteralPath $stableManifestPath -Raw | ConvertFrom-Json).version)
}

$verifyArguments = @(
  (Join-Path $scriptDir 'verify-update-release.mjs'),
  '--manifest', $betaManifestPath,
  '--package', $zipPath,
  '--env-file', (Join-Path $serverDir '.env.example')
)
if ($stableVersion) { $verifyArguments += @('--newer-than', $stableVersion) }
& node @verifyArguments
if ($LASTEXITCODE -ne 0) { throw 'The beta update did not pass its checks, so it was not promoted.' }

Copy-Item -LiteralPath $betaManifestPath -Destination $stableManifestPath -Force
Write-Host "Update $($beta.version) is now the stable update ($($PackageBaseUrl.TrimEnd('/'))/manifest.json) once merged."
