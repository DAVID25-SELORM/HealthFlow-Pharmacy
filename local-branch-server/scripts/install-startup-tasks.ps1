$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Split-Path -Parent $scriptDir
$envPath = Join-Path $serverDir '.env'
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$tasks = @(
  @{
    Name = 'HealthFlow Branch Server'
    Script = Join-Path $scriptDir 'run-branch-server.ps1'
    Description = 'Runs the HealthFlow local branch server and embedded sync worker at Windows sign-in.'
  }
)

$legacySyncTask = Get-ScheduledTask -TaskName 'HealthFlow Branch Sync Worker' -ErrorAction SilentlyContinue
if ($legacySyncTask) {
  Stop-ScheduledTask -TaskName 'HealthFlow Branch Sync Worker' -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName 'HealthFlow Branch Sync Worker' -Confirm:$false
  Write-Host 'Removed legacy task: HealthFlow Branch Sync Worker'
}

if (-not (Test-Path $envPath)) {
  Write-Warning "No .env file found at $envPath. Create it before relying on these startup tasks."
}

foreach ($task in $tasks) {
  $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$($task.Script)`""
  $action = New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments -WorkingDirectory $serverDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Days 0) `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

  Register-ScheduledTask `
    -TaskName $task.Name `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description $task.Description `
    -Force | Out-Null

  Start-ScheduledTask -TaskName $task.Name
  Write-Host "Installed and started task: $($task.Name)"
}

Write-Host ''
Write-Host 'HealthFlow offline startup task is installed.'
Write-Host "Logs will be written to: $(Join-Path $serverDir 'logs')"
