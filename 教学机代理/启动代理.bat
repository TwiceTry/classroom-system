@echo off
chcp 65001 >nul
title LAN proxy for the classroom system
cd /d "%~dp0"

rem ==============================================================
rem  LAN -> public proxy for the classroom system (Python).
rem
rem  1) python: uses runtime\python\python.exe (embedded 3.8, works
rem     on Windows 7) when present; otherwise the system python.
rem  2) config: copy proxy.example.conf to proxy.conf (same folder)
rem     and fill in the addresses.
rem  3) double-click this file to start; Ctrl+C to stop.
rem
rem  ASCII only on purpose: cmd.exe mis-parses non-ASCII .bat files
rem  (it walks the file byte by byte in the active code page).
rem ==============================================================

set "CONF=%~dp0proxy.conf"

rem ---------- 1) find python ----------
set "PYEXE="
set "PYARGS="

if exist "%~dp0runtime\python\python.exe" (
  set "PYEXE=%~dp0runtime\python\python.exe"
  goto :have_python
)

where py >nul 2>nul
if not errorlevel 1 (
  set "PYEXE=py"
  set "PYARGS=-3"
  goto :have_python
)

where python >nul 2>nul
if not errorlevel 1 (
  set "PYEXE=python"
  goto :have_python
)

echo.
echo   [ERROR] python not found.
echo.
echo   Put an embedded Python into this folder:
echo       runtime\python\python.exe
echo   (Python 3.8 is the last version that runs on Windows 7;
echo    the embedded build is ~8 MB, no installation needed)
echo.
echo   Or install Python and add it to PATH:
echo       https://www.python.org/downloads/release/python-3810/
echo.
pause
exit /b 1

:have_python

rem ---------- 2) config ----------
if not exist "%CONF%" (
  echo.
  echo   [ERROR] Config file not found:
  echo           %CONF%
  echo.
  echo   Copy proxy.example.conf to proxy.conf (same folder), then fill
  echo   in the addresses (at least "target").
  echo.
  pause
  exit /b 1
)

rem ---------- 3) run ----------
echo.
echo   Starting the proxy with: %CONF%
echo.
"%PYEXE%" %PYARGS% "%~dp0lan-proxy.py" --config "%CONF%"
echo.
echo   (proxy exited)
pause
