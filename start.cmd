@echo off
setlocal
title Atmos dashboard
cd /d "%~dp0" || exit /b 1
where /q node.exe
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or later, then run this launcher again.
  pause
  exit /b 1
)
echo.
echo Opening Atmos. An existing dashboard will be reused automatically.
echo.
node.exe server.mjs --open
set "ATMOS_EXIT_CODE=%ERRORLEVEL%"
if not "%ATMOS_EXIT_CODE%"=="0" (
  echo.
  echo Could not open Atmos. Check the message above. See README.md.
)
echo.
echo This launcher has finished. Any existing Atmos server stays running.
pause
exit /b %ATMOS_EXIT_CODE%
