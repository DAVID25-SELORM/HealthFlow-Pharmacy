$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Split-Path -Parent $scriptDir
$startupDir = [Environment]::GetFolderPath('Startup')
$targetScript = Join-Path $scriptDir 'start-healthflow-offline.cmd'
$shortcutPath = Join-Path $startupDir 'HealthFlow Offline Branch.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetScript
$shortcut.WorkingDirectory = $serverDir
$shortcut.Description = 'Start HealthFlow local branch server and sync worker'
$shortcut.Save()

Write-Host "Created startup shortcut:"
Write-Host $shortcutPath
