@echo off
REM LinkOK launcher. ASCII only: cmd.exe reads .cmd as the OEM codepage (GBK here),
REM so UTF-8 Chinese in comments corrupts the file and breaks parsing.
chcp 65001 >nul 2>&1
setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

if not defined LINKOK_DATA_DIR set "LINKOK_DATA_DIR=%ROOT%\.pc-data"

echo.
echo   LinkOK starting...
echo   Data dir: %LINKOK_DATA_DIR%
echo.

if not exist "%ROOT%\pc\src\main.js" (
  echo   [ERROR] pc\src\main.js not found.
  echo   Run this from the LinkOK folder.
  echo.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo   [ERROR] Node.js not found in PATH.
  echo   Install Node.js, or use LinkOK.exe if one is present.
  echo.
  pause
  exit /b 1
)

node "%ROOT%\pc\src\main.js" %*

echo.
echo   LinkOK stopped.
pause
