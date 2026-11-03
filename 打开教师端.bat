@echo off
rem ============================================================
rem  Teacher console launcher.
rem
rem  ASCII only on purpose: cmd.exe mis-parses non-ASCII .bat
rem  files (it walks the file byte by byte in the active code
rem  page and can split multi-byte characters).
rem
rem  WHAT YOU EDIT (near the bottom of this header):
rem    BASE_URL - address of the classroom system:
rem               http://localhost:18730          this machine
rem               http://192.0.2.21:18730     LAN address
rem               http://192.0.2.21:18799     through the LAN proxy
rem    PAGE      - which page to open (default: the lecture console)
rem
rem  WHAT IT DOES:
rem    1) finds a browser: our portable Chrome 109 first, then the
rem       installed Chrome, then Edge
rem    2) checks the server answers /api/health
rem    3) opens the teacher page in a dedicated Chrome profile with
rem       the "insecure origin is secure" switch, so screen
rem       casting (getDisplayMedia) is allowed over plain http
rem
rem  Dry run (no browser, no window): set TS_BAT_DRYRUN=1 first.
rem ============================================================
setlocal EnableExtensions
set "HERE=%~dp0"

rem ---------- edit these two lines ----------
set "BASE_URL=http://localhost:18730"
set "PAGE=/teacher/lecture"
rem ----------------------------------

rem strip a trailing slash from BASE_URL
if "%BASE_URL:~-1%"=="/" set "BASE_URL=%BASE_URL:~0,-1%"
set "URL=%BASE_URL%%PAGE%"

if "%BASE_URL%"=="" goto :no_url

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

rem ---------- 2) is the server alive? ----------
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; [Net.ServicePointManager]::ServerCertificateValidationCallback={$true}; $r=[Net.HttpWebRequest]::Create('%BASE_URL%/api/health'); $r.Timeout=3000; $r.Method='GET'; $resp=$r.GetResponse(); $resp.Close(); exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo.
  echo   [WARN] %BASE_URL% did not answer /api/health.
  echo          Wrong address, server down, or firewall - the browser will
  echo          probably show a dead page. Opening anyway in 5 seconds,
  echo          press Ctrl+C to stop.
  echo.
  ping -n 6 127.0.0.1 >nul
)

rem ---------- 3) origin for the cast whitelist ----------
rem     for /f skips empty tokens, so http://host:port splits into
rem     %%a=http:  %%b=host:port  ->  %%a//%%b is the origin.
for /f "tokens=1,2 delims=/" %%a in ("%BASE_URL%") do set "ORIGIN=%%a//%%b"
if not defined ORIGIN set "ORIGIN=%BASE_URL%"

set "PROFILE=%LOCALAPPDATA%\ts-teacher-chrome"

echo.
echo   [OK] opening the teacher console
echo        url     : %URL%
echo        browser : %CHROME%
echo        profile : %PROFILE%
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
echo           Edit this file (near the top) and put the server address there.
echo.
pause
exit /b 1

:no_browser
echo.
echo   [ERROR] No browser found.
echo           Install Chrome (109 works on Win7), or unpack our green
echo           Chrome: run  downloads\Chrome-109.*-Win7.exe once, it
echo           unpacks to  downloads\Chrome\App\Chrome.exe
echo.
pause
exit /b 1
