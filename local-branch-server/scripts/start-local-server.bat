@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "SERVER_DIR=%SCRIPT_DIR%.."
set "HEALTHFLOW_DB_PATH=C:\HealthFlowLocal\data\healthflow-branch.sqlite"

if not exist "C:\HealthFlowLocal\data" (
  mkdir "C:\HealthFlowLocal\data"
)

cd /d "%SERVER_DIR%"
echo Starting HealthFlow local branch server...
echo Database: %HEALTHFLOW_DB_PATH%
npm run start
