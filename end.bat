@echo off
setlocal
cd /d "%~dp0"
title Letackomat - konec

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js neni nainstalovany.
  pause
  exit /b 1
)

node scripts\launcher.js stop
timeout /t 3 /nobreak >nul
