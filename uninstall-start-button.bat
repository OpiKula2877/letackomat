@echo off
title Letackomat - zruseni tlacitka Spustit server
reg delete "HKCU\Software\Classes\letackomat" /f >nul 2>nul
echo Hotovo. Adresa letackomat://start je odstranena.
pause
