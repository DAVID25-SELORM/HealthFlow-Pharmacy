@echo off
setlocal
cd /d "%~dp0.."
title HealthFlow Branch Sync Worker
npm run sync
pause
