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
  echo         Teacher PC: install Node 13.6.0 ^(runs on Win7 x64; the offline
  echo         package ships its own copy^),
  echo         or any newer LTS on Win10+.
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

node server/index.js
if errorlevel 1 (
  echo.
  echo [ERROR] server exited unexpectedly.
  pause
)
