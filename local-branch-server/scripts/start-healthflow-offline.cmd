@echo off
setlocal
cd /d "%~dp0.."
echo HealthFlow Offline manual backup launcher
echo.
echo Production machines should normally run the NSSM Windows service:
echo   HealthFlowOfflineServer
echo.
echo Use this launcher only for technician recovery or testing.
echo.
start "HealthFlow Offline Server - Backup" cmd /k "npm run start"
