@echo off
chcp 65001 >nul
title LAN proxy for the classroom system
cd /d "%~dp0"

rem ==============================================================
rem  LAN -> public proxy for the classroom system.
rem
rem  1) needs Node.js (12.22 LTS is the last one that runs on Win7).
rem     Install it, or drop a portable node.exe into this folder.
rem  2) needs a config file: copy proxy.example.conf to proxy.conf
rem     (same folder) and fill in the addresses.
rem  3) double-click this file to start; Ctrl+C to stop.
rem
rem  ASCII only on purpose: cmd.exe mis-parses non-ASCII .bat files
rem  (it walks the file byte by byte in the active code page).
rem ==============================================================

set "CONF=%~dp0proxy.conf"

rem ---------- 1) node ----------
set "NODEEXE="
where node >nul 2>nul
if not errorlevel 1 set "NODEEXE=node"
if not defined NODEEXE if exist "%~dp0node.exe" set "NODEEXE=%~dp0node.exe"

if not defined NODEEXE (
  echo.
  echo   [ERROR] node.exe not found.
  echo.
  echo   Install Node.js first. On Windows 7 use the last version that
  echo   still supports it:
  echo       https://nodejs.org/dist/v12.22.12/node-v12.22.12-win-x64.zip
  echo   Unpack it (e.g. to C:\node12), add that folder to PATH, or copy
  echo   node.exe into this folder.
  echo.
  pause
  exit /b 1
)

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
"%NODEEXE%" "%~dp0lan-proxy.js" --config "%CONF%"
echo.
echo   (proxy exited)
pause
