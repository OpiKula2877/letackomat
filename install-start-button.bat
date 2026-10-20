@echo off
setlocal
title Letackomat - povoleni tlacitka Spustit server

rem Jednorazove zaregistruje adresu letackomat://start pro aktualniho uzivatele (bez admin prav).
rem Diky tomu umi tlacitko "Spustit server" v aplikaci zapnout server, kdyz nebezi.

set "VBS=%~dp0scripts\start-hidden.vbs"
if not exist "%VBS%" (
  echo Chybi soubor %VBS%
  pause
  exit /b 1
)

reg add "HKCU\Software\Classes\letackomat" /ve /d "URL:Letackomat" /f >nul
reg add "HKCU\Software\Classes\letackomat" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\letackomat\shell\open\command" /ve /d "wscript.exe \"%VBS%\"" /f >nul
if errorlevel 1 (
  echo Registrace se nepovedla.
  pause
  exit /b 1
)

echo Hotovo. Tlacitko "Spustit server" v aplikaci ted zapne server.
echo Pri prvnim kliknuti se prohlizec zepta, jestli ma otevrit Letackomat. Potvrd a zaskrtni "vzdy povolit".
echo Zrusit to jde pres uninstall-start-button.bat.
pause
