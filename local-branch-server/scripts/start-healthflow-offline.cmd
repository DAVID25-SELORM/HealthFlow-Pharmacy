@echo off
setlocal
cd /d "%~dp0.."
start "HealthFlow Branch Server" cmd /k "npm run start"
start "HealthFlow Branch Sync Worker" cmd /k "npm run sync"
