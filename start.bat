@echo off
setlocal
cd /d "%~dp0"
title Letackomat - start

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js neni nainstalovany. Stahni ho z https://nodejs.org ^(verze 22.13 nebo novejsi^).
  pause
  exit /b 1
)

if not exist node_modules (
  echo Instaluji zavislosti, chvili to potrva...
  call npm install
  if errorlevel 1 (
    echo Instalace selhala.
    pause
    exit /b 1
  )
)

node scripts\launcher.js start
if errorlevel 1 (
  pause
  exit /b 1
)
timeout /t 3 /nobreak >nul
