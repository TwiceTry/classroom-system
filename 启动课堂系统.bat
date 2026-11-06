@echo off
rem ============================================================
rem  Teaching System launcher (ASCII only on purpose: cmd.exe
rem  mangles non-ASCII .bat content on some Windows setups).
rem ============================================================
setlocal
cd /d "%~dp0"

set "PORT=%TS_PORT%"
if "%PORT%"=="" set "PORT=18730"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found in PATH.
  echo         Install Node 20 LTS or newer ^(the server runs it; browsers do
  echo         not need Node at all^).
  echo         Node 13 / Win7 support was dropped - see README.
  echo.
  pause
  exit /b 1
)

if not exist "web\dist\index.html" (
  echo.
  echo [!] web\dist\index.html not found - the API works but pages cannot open.
  echo     Build once on a dev machine, then copy this folder over:
  echo         cd web
  echo         npm install
  echo         npm run build
  echo.
)

echo Starting teaching system on port %PORT% ...
echo.
echo This window is the server: keep it open, close it to stop.
echo It does NOT open a browser. For the teacher console use the
echo teacher launcher in this folder - it starts Chrome with the
echo switch that screen capture requires. A plain browser can open
echo http://localhost:%PORT%/ for everything except casting.
echo.

rem backend entry is api/src/server.js (the old server/index.js was removed)
node api/src/server.js
if errorlevel 1 (
  echo.
  echo [ERROR] the backend exited unexpectedly.
  pause
)
