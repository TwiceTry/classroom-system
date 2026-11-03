@echo off
rem ============================================================
rem  Student console launcher.
rem
rem  ASCII only on purpose: cmd.exe mis-parses non-ASCII .bat files.
rem
rem  WHAT YOU EDIT (near the bottom of this header):
rem    BASE_URL - address of the classroom system:
rem               http://192.0.2.21:18730   LAN address of the teacher PC
rem               http://192.0.2.21:18799   through the teacher's LAN proxy
rem               http://localhost:18730       on the teacher PC itself
rem    PAGE      - which page to open (default: course material)
rem
rem  WHAT IT DOES:
rem    1) finds a browser: our portable Chrome 109 first, then the
rem       installed Chrome, then Edge
rem    2) checks the server answers /api/health
rem    3) opens the student page in it
rem
rem  Dry run (no browser, no window): set TS_BAT_DRYRUN=1 first.
rem ============================================================
setlocal EnableExtensions
set "HERE=%~dp0"

rem ---------- edit these two lines ----------
set "BASE_URL=http://192.0.2.21:18730"
set "PAGE=/student/materials"
rem ----------------------------------

rem strip a trailing slash from BASE_URL
if "%BASE_URL:~-1%"=="/" set "BASE_URL=%BASE_URL:~0,-1%"
set "URL=%BASE_URL%%PAGE%"

if "%BASE_URL%"=="" goto :no_url

rem ---------- 1) find a browser ----------
rem     portable Chrome first (our green Chrome 109 unpacks to
rem     <folder>\Chrome\App\Chrome.exe), then installed Chrome / Edge.
set "CHROME="
for /f "delims=" %%p in ('dir /b /s "%HERE%downloads\Chrome\App\Chrome.exe" 2^>nul') do if not defined CHROME set "CHROME=%%p"
if not defined CHROME for /f "delims=" %%p in ('dir /b /s "%HERE%..\*Chrome\App\Chrome.exe" 2^>nul') do if not defined CHROME set "CHROME=%%p"
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

echo.
echo   [OK] opening the student console
echo        url    : %URL%
echo        browser: %CHROME%
echo.
echo   Log in with your student number and name (the teacher told you the
echo   class). Keep this window open while you work.
echo.

if "%TS_BAT_DRYRUN%"=="1" (
  echo   [DRYRUN] nothing launched
  exit /b 0
)

rem     >nul 2>nul keeps Chrome from inheriting this window's stdout.
start "" "%CHROME%" "%URL%" >nul 2>nul
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
