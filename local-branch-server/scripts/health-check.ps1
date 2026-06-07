param(
  [string]$BaseUrl = 'http://localhost:4780',
  [string]$InstallRoot = 'C:\HealthFlowPharmacy',
  [string]$BranchToken = ''
)

$ErrorActionPreference = 'Continue'

$serverDir = Join-Path $InstallRoot 'local-branch-server'
$logsDir = Join-Path $InstallRoot 'logs'
$dataDir = Join-Path $InstallRoot 'data'
$envPath = Join-Path $serverDir '.env'
$serviceNames = @('HealthFlowOfflineServer')
$failed = $false

function Write-Check {
  param(
    [string]$Name,
    [bool]$Passed,
    [string]$Detail = ''
  )

  $status = if ($Passed) { 'PASS' } else { 'FAIL' }
  $line = "[$status] $Name"
  if ($Detail) { $line = "$line - $Detail" }
  Write-Host $line
  if (-not $Passed) { $script:failed = $true }
}

function Get-EnvValue {
  param([string]$Name)

  if (-not (Test-Path -LiteralPath $envPath)) { return '' }

  $match = Get-Content -LiteralPath $envPath |
    Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } |
    Select-Object -First 1

  if (-not $match) { return '' }
  return ($match -split '=', 2)[1].Trim()
}

if (-not $BranchToken) {
  $BranchToken = Get-EnvValue -Name 'BRANCH_SERVER_TOKEN'
}

Write-Host 'HealthFlow Offline Branch Server Health Check'
Write-Host "Base URL: $BaseUrl"
Write-Host ''

foreach ($serviceName in $serviceNames) {
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  Write-Check `
    -Name "Windows service $serviceName" `
    -Passed ($null -ne $service -and $service.Status -eq 'Running') `
    -Detail ($(if ($service) { "status=$($service.Status)" } else { 'not installed' }))
}

Write-Check -Name 'Install folder exists' -Passed (Test-Path -LiteralPath $serverDir) -Detail $serverDir
Write-Check -Name '.env exists' -Passed (Test-Path -LiteralPath $envPath) -Detail $envPath
Write-Check -Name 'Logs folder exists' -Passed (Test-Path -LiteralPath $logsDir) -Detail $logsDir
Write-Check -Name 'Data folder exists' -Passed (Test-Path -LiteralPath $dataDir) -Detail $dataDir

$expectedLogs = @('offline-server.log')
foreach ($logName in $expectedLogs) {
  $logPath = Join-Path $logsDir $logName
  Write-Check -Name "Log file $logName" -Passed (Test-Path -LiteralPath $logPath) -Detail $logPath
}

try {
  if (-not $BranchToken) {
    throw 'BRANCH_SERVER_TOKEN not provided or not found in .env'
  }

  $headers = @{ 'x-branch-token' = $BranchToken }
  $health = Invoke-WebRequest -Uri "$BaseUrl/health" -Headers $headers -UseBasicParsing -TimeoutSec 10
  Write-Check -Name 'Protected health endpoint' -Passed ($health.StatusCode -eq 200) -Detail "status=$($health.StatusCode)"
} catch {
  Write-Check -Name 'Protected health endpoint' -Passed $false -Detail $_.Exception.Message
}

if ($BranchToken) {
  try {
    $headers = @{ 'x-branch-token' = $BranchToken }
    $sync = Invoke-WebRequest -Uri "$BaseUrl/api/sync/status" -Headers $headers -UseBasicParsing -TimeoutSec 10
    Write-Check -Name 'Protected sync status endpoint' -Passed ($sync.StatusCode -eq 200) -Detail "status=$($sync.StatusCode)"
  } catch {
    Write-Check -Name 'Protected sync status endpoint' -Passed $false -Detail $_.Exception.Message
  }
} else {
  Write-Check -Name 'Protected sync status endpoint' -Passed $false -Detail 'BRANCH_SERVER_TOKEN not provided or not found in .env'
}

Write-Host ''
if ($failed) {
  Write-Host 'Health check failed.'
  exit 1
}

Write-Host 'Health check passed.'
exit 0
