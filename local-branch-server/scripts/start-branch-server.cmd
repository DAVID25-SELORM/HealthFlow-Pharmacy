@echo off
setlocal
cd /d "%~dp0.."
title HealthFlow Branch Server
npm run start
pause
