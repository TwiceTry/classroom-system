@echo off
rem ============================================================
rem  Teacher console launcher  (classroom-system)
rem
rem  ASCII only on purpose: cmd.exe mis-parses non-ASCII .bat
rem  files (it walks the file byte by byte in the active code
rem  page and can split multi-byte characters).
rem
rem  ==========================================================
rem   1) FILL IN THE ADDRESS  <- the only thing you normally touch
rem  ==========================================================
rem  Put it in the two lines marked "EDIT HERE" below.
rem  Common addresses:
rem      http://127.0.0.1:18730        this machine
rem      http://192.0.2.10:18730       the teacher PC on the LAN
rem      http://192.0.2.10:18799       through the LAN proxy
rem      https://classroom.example.edu public domain (behind a reverse proxy)
rem
rem  Which page to open (you rarely need to change it):
rem      /teacher/lecture   lectures + live coding (default)
rem      /teacher/           teacher home
rem
rem  WHAT IT DOES:
rem    1) pings /api/health on that address and warns if it is down
rem    2) finds a browser: our portable Chrome 109 first, then the
rem       installed Chrome, then Edge
rem    3) starts it with a dedicated profile and puts that address in
rem       the screen-capture whitelist (needed for casting over http)
rem    4) opens the teacher page
rem
rem  This script creates NO files. Nothing is written anywhere.
rem
rem  To see what it would do without opening a browser:
rem      set TS_BAT_DRYRUN=1
rem      then run this file
rem ============================================================
setlocal EnableExtensions
set "HERE=%~dp0"

rem ################ EDIT HERE ################
rem  1) the classroom server address:
set "BASE_URL=http://127.0.0.1:18730"
rem  2) which page to open:
set "PAGE=/teacher/lecture"
rem ############################################

if "%BASE_URL%"=="" goto :no_url

rem ---------- tidy up the address ----------
rem     strip spaces / quotes / trailing slashes, add http:// when the
rem     address was typed as a bare host
set "ADDR=%BASE_URL: =%"
set "ADDR=%ADDR:"=%"
:trim_slash
if "%ADDR:~-1%"=="/" (
  set "ADDR=%ADDR:~0,-1%"
  goto :trim_slash
)
echo %ADDR%|findstr /r /i /c:"^http://" /c:"^https://" >nul
if not errorlevel 1 goto :scheme_ok
set "ADDR=http://%ADDR%"
:scheme_ok

rem ---------- which url ----------
rem     a path inside the address is respected; otherwise open PAGE
set "URL=%ADDR%%PAGE%"
echo %ADDR%|findstr /r /i /c:"^[a-z]*://.*/" >nul
if not errorlevel 1 set "URL=%ADDR%"

rem ---------- is the server alive? ----------
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; [Net.ServicePointManager]::ServerCertificateValidationCallback={$true}; $r=[Net.HttpWebRequest]::Create('%ADDR%/api/health'); $r.Timeout=3000; $r.Method='GET'; $resp=$r.GetResponse(); $resp.Close(); exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo.
  echo   [WARN] %ADDR% did not answer /api/health.
  echo          Wrong address, server down, or firewall - the browser will
  echo          probably show a dead page. Opening anyway in 5 seconds,
  echo          press Ctrl+C to stop.
  echo.
  ping -n 6 127.0.0.1 >nul
)

rem ---------- find a browser ----------
rem     Portable (green) Chrome first: it unpacks to <folder>\Chrome\App\Chrome.exe.
rem     We check the likely spots with literal paths, then every folder next to
rem     this one. (dir cannot expand a wildcard inside a path, so the older
rem     "dir /b /s ..\*Chrome\App\Chrome.exe" never matched anything.)
set "CHROME="
if not defined CHROME if exist "%HERE%downloads\Chrome\App\Chrome.exe" set "CHROME=%HERE%downloads\Chrome\App\Chrome.exe"
if not defined CHROME if exist "%HERE%..\Chrome\App\Chrome.exe" set "CHROME=%HERE%..\Chrome\App\Chrome.exe"
if not defined CHROME if exist "%HERE%..\..\Chrome\App\Chrome.exe" set "CHROME=%HERE%..\..\Chrome\App\Chrome.exe"
if not defined CHROME for /f "delims=" %%d in ('dir /b /ad "%HERE%.." 2^>nul') do if not defined CHROME if exist "%HERE%\..\%%d\Chrome\App\Chrome.exe" set "CHROME=%HERE%\..\%%d\Chrome\App\Chrome.exe"
if not defined CHROME if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "CHROME=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "CHROME=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined CHROME goto :no_browser

rem ---------- origin for the cast whitelist ----------
rem     for /f skips empty tokens, so http://host:port splits into
rem     %%a=http:  %%b=host:port  ->  %%a//%%b is the origin.
for /f "tokens=1,2 delims=/" %%a in ("%ADDR%") do set "ORIGIN=%%a//%%b"
if not defined ORIGIN set "ORIGIN=%ADDR%"

set "PROFILE=%LOCALAPPDATA%\ts-teacher-chrome"

echo.
echo   [OK] opening the teacher console
echo        address  : %ADDR%
echo        url      : %URL%
echo        browser  : %CHROME%
echo        profile  : %PROFILE%
echo        whitelist: %ORIGIN%
echo.
echo   Log in with the teacher password, then click "Start casting" and
echo   pick "Entire screen". Keep this browser window visible while casting.
echo.

if "%TS_BAT_DRYRUN%"=="1" (
  echo   [DRYRUN] nothing launched
  exit /b 0
)

rem     >nul 2>nul keeps Chrome from inheriting this window's stdout,
rem     otherwise cmd stays alive until the browser closes.
start "" "%CHROME%" --user-data-dir="%PROFILE%" --unsafely-treat-insecure-origin-as-secure="%ORIGIN%" "%URL%" >nul 2>nul
echo   Browser launched. This window closes in 5 seconds.
ping -n 6 127.0.0.1 >nul
exit /b 0

:no_url
echo.
echo   [ERROR] BASE_URL is empty.
echo           Open this file in a text editor and fill in the line
echo           marked "EDIT HERE":
echo.
echo               set "BASE_URL=http://127.0.0.1:18730"
echo.
echo           Example for a classroom PC on the LAN:
echo               set "BASE_URL=http://192.0.2.10:18730"
echo.
pause
exit /b 1

:no_browser
echo.
echo   [ERROR] No browser found.
echo           Install Chrome - version 109 works on Win7 - or unpack our
echo           Chrome: run  downloads\Chrome-109.*-Win7.exe once, it
echo           unpacks to  downloads\Chrome\App\Chrome.exe
echo.
pause
exit /b 1
