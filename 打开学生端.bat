@echo off
rem ============================================================
rem  Student console launcher.
rem
rem  ASCII only on purpose: cmd.exe mis-parses non-ASCII .bat
rem  files (it walks the file byte by byte in the active code
rem  page and can split multi-byte characters).
rem
rem  WHAT YOU EDIT (near the bottom of this header):
rem    BASE_URL - address of the classroom system (ask your teacher).
rem               http://192.0.2.10:18730       LAN address of the teacher PC
rem               http://192.0.2.10:18799       through the teacher's LAN proxy
rem               http://127.0.0.1:18730       on the teacher PC itself
rem              Leave it EMPTY and the script reads teacher-url.txt next
rem              to it; if that file has no address yet, it asks once and
rem              saves it there.
rem    PAGE      - which page to open (default: course material)
rem
rem  WHAT IT DOES:
rem    1) works out the address (variable -> teacher-url.txt -> ask)
rem    2) checks the server answers /api/health
rem    3) finds a browser: our portable Chrome 109 first, then the
rem       installed Chrome, then Edge
rem    4) opens the student page in it (your own browser profile, so
rem       it just opens a new tab if Chrome is already running)
rem
rem  Test without launching anything:  set TS_BAT_DRYRUN=1  then run.
rem ============================================================
setlocal EnableExtensions
set "HERE=%~dp0"
set "CFG=%HERE%teacher-url.txt"

rem ---------- edit these two lines ----------
set "BASE_URL="
set "PAGE=/student/materials"
rem ----------------------------------

rem ---------- 1) target address ----------
rem     1) the variable above, if the student filled it in
rem     2) teacher-url.txt (a full URL first, then a bare host:port)
rem     3) ask once and remember it
set "ADDR="
if defined BASE_URL set "ADDR=%BASE_URL%"
if not defined ADDR if exist "%CFG%" for /f "usebackq delims=" %%L in (`findstr /r /i /c:"^[ ]*http" "%CFG%"`) do if not defined ADDR set "ADDR=%%L"
if not defined ADDR if exist "%CFG%" for /f "usebackq delims=" %%L in (`findstr /r /c:"^[ ]*[0-9][0-9.]*:[0-9]" "%CFG%"`) do if not defined ADDR set "ADDR=%%L"

if not defined ADDR (
  echo.
  echo   Ask your teacher for the classroom address, then type it here.
  echo   Examples:
  echo       http://192.0.2.10:18730
  echo.
  set /p "ADDR=  Server address: "
)
if not defined ADDR goto :no_addr

if not defined BASE_URL (
  >"%CFG%" echo rem Classroom server address - one line, full base URL.
  >>"%CFG%" echo %ADDR%
  echo.
  echo   Saved to teacher-url.txt
)

rem ---------- 2) tidy up the address ----------
rem     strip spaces / quotes / trailing slashes, add http:// when the
rem     student typed a bare host
set "ADDR=%ADDR: =%"
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
set "URL=%ADDR%%PAGE%"

rem ---------- 3) is the server alive? ----------
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

rem ---------- 4) find a browser ----------
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

:no_addr
echo.
echo   [ERROR] No server address.
echo           Type it in when asked, or put one line into teacher-url.txt
echo           next to this file, then run it again.
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
