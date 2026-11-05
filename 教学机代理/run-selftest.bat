@echo off
rem ==============================================================
rem  LAN proxy self-test (classroom-system)
rem
rem  Runs selftest.py with the bundled Python (or the system one).
rem  Usage:  run-selftest.bat            (default port from proxy.conf)
rem          run-selftest.bat --port 18799
rem          run-selftest.bat --n 40
rem          run-selftest.bat --only cache,cast
rem
rem  ASCII only on purpose: cmd.exe mis-parses non-ASCII .bat.
rem ==============================================================
cd /d "%~dp0"

set "PY="
if exist "runtime\python\python.exe" set "PY=runtime\python\python.exe"
if not defined PY (
  where py >nul 2>nul
  if not errorlevel 1 set "PY=py -3"
)
if not defined PY (
  where python >nul 2>nul
  if not errorlevel 1 set "PY=python"
)
if not defined PY (
  echo.
  echo   [ERROR] No Python found.
  echo.
  echo   Put the embedded Python here:
  echo       runtime\python\python.exe
  echo   Or install Python 3.8 and add it to PATH.
  echo.
  pause
  exit /b 1
)

%PY% "%~dp0selftest.py" %*
echo.
pause
