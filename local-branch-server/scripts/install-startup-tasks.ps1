$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Split-Path -Parent $scriptDir
$envPath = Join-Path $serverDir '.env'
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$tasks = @(
  @{
    Name = 'HealthFlow Branch Server'
    Script = Join-Path $scriptDir 'run-branch-server.ps1'
    Description = 'Runs the HealthFlow local branch server at Windows sign-in.'
  },
  @{
    Name = 'HealthFlow Branch Sync Worker'
    Script = Join-Path $scriptDir 'run-sync-worker.ps1'
    Description = 'Runs the HealthFlow branch sync worker at Windows sign-in.'
  }
)

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
Write-Host 'HealthFlow offline startup tasks are installed.'
Write-Host "Logs will be written to: $(Join-Path $serverDir 'logs')"

