$ErrorActionPreference = 'Stop'

$taskNames = @(
  'HealthFlow Branch Server',
  'HealthFlow Branch Sync Worker'
)

foreach ($taskName in $taskNames) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed task: $taskName"
  } else {
    Write-Host "Task not found: $taskName"
  }
}

