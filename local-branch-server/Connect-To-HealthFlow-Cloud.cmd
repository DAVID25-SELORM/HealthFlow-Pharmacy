@echo off
setlocal
rem Connects this computer to HealthFlow Cloud. First copy the setup block from Branch Sync Setup in HealthFlow Cloud.
set "SCRIPT_DIR=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile -Sta -ExecutionPolicy Bypass -File ""%SCRIPT_DIR%scripts\connect-to-cloud.ps1""'"
echo.
pause
