param(
  [Parameter(Mandatory = $true)][string]$PackageBaseUrl,
  [Parameter(Mandatory = $true)][string]$PrivateKeyPath,
  [string]$Channel = 'stable',
  [string]$ReleaseNotes = '',
  [string]$OutputDir = ''
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Split-Path -Parent $scriptDir
$repoDir = Split-Path -Parent $serverDir
$package = Get-Content -LiteralPath (Join-Path $serverDir 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version

if (-not $OutputDir) {
  $OutputDir = Join-Path $repoDir 'release\branch-updates'
}

$outputPath = [System.IO.Path]::GetFullPath($OutputDir)
$stagePath = Join-Path $env:TEMP ('healthflow-update-' + [Guid]::NewGuid().ToString('N'))
$payloadPath = Join-Path $stagePath 'local-branch-server'
$zipName = "healthflow-branch-$version.zip"
$zipPath = Join-Path $outputPath $zipName
$manifestPath = Join-Path $outputPath 'manifest.json'

New-Item -ItemType Directory -Force -Path $outputPath, $payloadPath | Out-Null

try {
  Get-ChildItem -LiteralPath $serverDir -Force |
    Where-Object {
      $_.Name -notin @('.env', 'data', 'logs', 'node_modules', 'updates') -and
      $_.Extension -ne '.log'
    } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $payloadPath -Recurse -Force }
  Remove-Item -LiteralPath (Join-Path $payloadPath 'public\branch-updates') -Recurse -Force -ErrorAction SilentlyContinue

  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::Open(
    $zipPath,
    [System.IO.Compression.ZipArchiveMode]::Create
  )
  try {
    $pathMarker = '\local-branch-server\'
    Get-ChildItem -LiteralPath $payloadPath -File -Recurse | ForEach-Object {
      $markerIndex = $_.FullName.LastIndexOf(
        $pathMarker,
        [System.StringComparison]::OrdinalIgnoreCase
      )
      if ($markerIndex -lt 0) {
        throw "Unable to calculate archive path for $($_.FullName)."
      }
      $relativePath = $_.FullName.Substring($markerIndex + $pathMarker.Length)
      $entryName = ('local-branch-server/' + $relativePath).Replace('\', '/')
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive,
        $_.FullName,
        $entryName,
        [System.IO.Compression.CompressionLevel]::Optimal
      ) | Out-Null
    }
  } finally {
    $archive.Dispose()
  }
  $sha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $packageUrl = $PackageBaseUrl.TrimEnd('/') + '/' + $zipName

  @{
    version = $version
    channel = $Channel.ToLowerInvariant()
    packageUrl = $packageUrl
    sha256 = $sha256
    publishedAt = (Get-Date).ToUniversalTime().ToString('o')
    releaseNotes = $ReleaseNotes
  } | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding UTF8

  & node (Join-Path $scriptDir 'sign-update-manifest.mjs') $manifestPath $PrivateKeyPath
  if ($LASTEXITCODE -ne 0) {
    throw "Manifest signing failed with exit code $LASTEXITCODE."
  }

  Write-Host "Update package: $zipPath"
  Write-Host "Signed manifest: $manifestPath"
  Write-Host "SHA-256: $sha256"
} finally {
  Remove-Item -LiteralPath $stagePath -Recurse -Force -ErrorAction SilentlyContinue
}
