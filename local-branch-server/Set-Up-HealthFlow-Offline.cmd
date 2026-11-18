@echo off
setlocal
rem One-step setup of HealthFlow Offline: install, connect to the cloud, check, open the POS.
rem First copy the setup code from Branch Sync Setup in HealthFlow Cloud (press Copy).
rem Works from the installer ZIP root and from inside the local-branch-server folder.
set "HF_SETUP_PS1=%~dp0scripts\setup-offline.ps1"
if not exist "%HF_SETUP_PS1%" set "HF_SETUP_PS1=%~dp0local-branch-server\scripts\setup-offline.ps1"
if not exist "%HF_SETUP_PS1%" goto missing

rem The script path goes through an environment variable so folders with spaces or apostrophes are safe.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$q=[char]34; Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-Sta','-ExecutionPolicy','Bypass','-File',($q+$env:HF_SETUP_PS1+$q),'-WaitAtEnd'"
if errorlevel 1 (
  echo.
  echo Setup could not start. If Windows asked for permission, choose Yes and try again.
  pause
  exit /b 1
)
exit /b 0

:missing
echo Could not find scripts\setup-offline.ps1 next to this file.
echo Extract the whole installer ZIP first, then run this again from the extracted folder.
pause
exit /b 1
