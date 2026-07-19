@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File ""%SCRIPT_DIR%scripts\install-windows-service.ps1"" -OfflineOnly'"
if errorlevel 1 (
  echo HealthFlow installation did not complete successfully.
  pause
  exit /b 1
)
echo.
echo HealthFlow Local Branch Server installation completed.
pause
