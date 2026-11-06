@echo off
rem ============================================================
rem  Dev launcher: backend (18730) + vite dev server (5173), two windows.
rem
rem  ASCII only on purpose: cmd.exe mis-parses non-ASCII .bat files.
rem
rem  What it does:
rem    1) checks Node.js
rem    2) installs web dependencies on first run (web\node_modules missing)
rem    3) opens one window for the backend, one for vite (HMR), then the browser
rem    4) if a port is already listening, that half is skipped (no EADDRINUSE noise)
rem
rem  Stop = close the two windows. Build a deployable copy with:
rem      cd web && npm run build
rem ============================================================
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js not found. Install Node 20+ and run this again.
  echo.
  pause
  exit /b 1
)

set "NODE_VER="
for /f "tokens=*" %%v in ('node -v') do set "NODE_VER=%%v"
echo   node %NODE_VER%

if not exist "web\node_modules" (
  echo   web\node_modules not found - installing ^(first run only, may take a minute^)
  pushd web
  call npm install
  popd
  if errorlevel 1 (
    echo.
    echo   [ERROR] npm install failed. Run it by hand:  cd web ^&^& npm install
    echo.
    pause
    exit /b 1
  )
)

rem ---------- backend ----------
rem backend entry is api\src\server.js (the old server\index.js was removed)
netstat -ano | findstr /r /c:":18730 .*LISTENING" >nul
if errorlevel 1 (
  echo   starting backend on http://127.0.0.1:18730
  start "classroom-backend" cmd /k "node api\src\server.js"
) else (
  echo   port 18730 already listening - backend window skipped
)

rem ---------- frontend ----------
netstat -ano | findstr /r /c:":5173 .*LISTENING" >nul
if errorlevel 1 (
  echo   starting vite on http://127.0.0.1:5173
  pushd web
  start "classroom-web" cmd /k "npm run dev"
  popd
) else (
  echo   port 5173 already listening - vite window skipped
)

echo.
echo   backend  http://127.0.0.1:18730
echo   frontend http://127.0.0.1:5173    (HMR: edit web\src, save, refresh-free)
echo.
echo   Note: dev mode is for editing. To publish, run  cd web ^&^& npm run build
echo.

rem give the servers a moment, then open the dev page
ping -n 4 127.0.0.1 >nul
start "" http://127.0.0.1:5173/

echo   Browser opened. Close the two server windows to stop.
ping -n 5 127.0.0.1 >nul
exit /b 0
