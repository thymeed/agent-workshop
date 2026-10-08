@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [live-bridge] Node.js not found on PATH.
  echo Install from https://nodejs.org/ then re-open this window.
  pause
  exit /b 1
)

echo Starting Cursor Agents Live bridge...
echo Dashboard: http://127.0.0.1:3847/
echo Leave this window open. Press Ctrl+C to stop.
echo.

node "%~dp0live-bridge.js" %*
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo [live-bridge] exited with code %EXITCODE%
  pause
)
exit /b %EXITCODE%
