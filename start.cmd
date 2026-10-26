@echo off
setlocal
title Atmos dashboard
cd /d "%~dp0"
set "ATMOS_NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  set "ATMOS_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
echo.
echo Opening Atmos. An existing dashboard will be reused automatically.
echo.
"%ATMOS_NODE%" server.mjs --open
if errorlevel 1 (
  echo.
  echo Could not open Atmos. Check the message above. See README.md.
)
echo.
echo This launcher has finished. Any existing Atmos server stays running.
pause
