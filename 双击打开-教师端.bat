@echo off
rem ============================================================
rem  Teacher entry launcher (server deployment).
rem
rem  ASCII only on purpose: cmd.exe mis-parses non-ASCII .bat files
rem  (it walks the file byte by byte in the active code page and can
rem  split multi-byte characters, which shreds the script).
rem  Chinese instructions live in teacher-url.txt instead.
rem
rem  What it does:
rem    1) reads the classroom server address from teacher-url.txt
rem       (asks once and saves it if the file has no address yet)
rem    2) pings the server's /api/health so the teacher sees
rem       "server not reachable" here instead of a dead page later
rem    3) starts Chrome with a dedicated profile and the
rem       "insecure origin is secure" switch, so screen casting
rem       (getDisplayMedia) is allowed even over plain http:// on the LAN
rem
rem  Why the switch: Chrome only exposes screen capture in a secure
rem  context - https, localhost, or an origin whitelisted by this
rem  command-line flag. The dedicated profile is required, otherwise
rem  Chrome joins the running instance and drops the flag.
rem
rem  Test without launching anything:  set TS_BAT_DRYRUN=1  then run.
rem ============================================================
setlocal EnableExtensions
set "HERE=%~dp0"
set "CFG=%HERE%teacher-url.txt"
set "PROFILE=%LOCALAPPDATA%\ts-teacher-chrome"

rem ---------- 1) target address ----------
set "ADDR="
rem     accept a full URL first, then a bare host:port on its own line
if exist "%CFG%" for /f "usebackq delims=" %%L in (`findstr /r /i /c:"^[ ]*http" "%CFG%"`) do if not defined ADDR set "ADDR=%%L"
if not defined ADDR if exist "%CFG%" for /f "usebackq delims=" %%L in (`findstr /r /c:"^[ ]*[0-9][0-9.]*:[0-9]" "%CFG%"`) do if not defined ADDR set "ADDR=%%L"

if defined ADDR goto :have_addr
echo.
echo   Point this launcher at your classroom server.
echo   Examples:
echo       https://classroom.example.edu
echo       http://192.0.2.10:18730
echo.
set /p "ADDR=  Server address: "
if not defined ADDR goto :no_addr
rem save it, so next time a double-click is all the teacher needs
>"%CFG%" echo rem Classroom server address - one line, full base URL.
>>"%CFG%" echo rem Edit this file when the server moves. Examples:
>>"%CFG%" echo rem   https://classroom.example.edu
>>"%CFG%" echo rem   http://192.0.2.10:18730
>>"%CFG%" echo %ADDR%
echo.
echo   Saved to teacher-url.txt
:have_addr

rem ---------- 2) tidy up the address ----------
rem     strip spaces / quotes / trailing slashes, add http:// when the
rem     teacher typed a bare host (no port is added: write the port
rem     yourself when the server is not behind a reverse proxy).
if defined ADDR set "ADDR=%ADDR: =%"
if defined ADDR set "ADDR=%ADDR:"=%"
:trim_slash
if not defined ADDR goto :no_addr
if "%ADDR:~-1%"=="/" set "ADDR=%ADDR:~0,-1%" & goto :trim_slash
echo %ADDR%|findstr /r /i /c:"^http://" /c:"^https://" >nul
if not errorlevel 1 goto :scheme_ok
set "ADDR=http://%ADDR%"
:scheme_ok

rem ---------- 3) origin (scheme://host[:port]) for the whitelist ----------
rem     for /f skips empty tokens, so http://host:port splits into
rem     %%a=http:  %%b=host:port  (the empty piece between the slashes
rem     is dropped) - that is exactly the origin we want.
for /f "tokens=1,2 delims=/" %%a in ("%ADDR%") do set "ORIGIN=%%a//%%b"
if not defined ORIGIN goto :bad_addr

rem ---------- 4) page url ----------
set "URL=%ADDR%/teacher/lecture"
echo %ADDR%|findstr /r /i /c:"^[a-z]*://.*/" >nul
if not errorlevel 1 set "URL=%ADDR%"
rem (a path after the host is respected; otherwise open the lecture page)

if "%TS_BAT_DRYRUN%"=="1" goto :dryrun

rem ---------- 5) is the server alive? ----------
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

echo.
echo   [OK] opening the teacher console
echo        page      : %URL%
echo        browser   : %CHROME%
echo        whitelist : %ORIGIN%
echo.
echo   Log in with the teacher password, then click "Start casting" and pick
echo   "Entire screen". Keep this browser window visible while casting.
echo.

rem     >nul 2>nul keeps Chrome from inheriting this window's stdout - otherwise
rem     cmd stays alive until the browser closes (visible when the launcher is
rem     started from a script / scheduled task instead of a double-click).
start "" "%CHROME%" --user-data-dir="%PROFILE%" --unsafely-treat-insecure-origin-as-secure="%ORIGIN%" "%URL%" >nul 2>nul
echo   Browser launched. This window closes in 5 seconds.
ping -n 6 127.0.0.1 >nul
exit /b 0

:dryrun
echo.
echo   [DRYRUN] nothing launched
echo        address   : %ADDR%
echo        origin    : %ORIGIN%
echo        page      : %URL%
echo        config    : %CFG%
echo        profile   : %PROFILE%
echo.
exit /b 0

:no_addr
echo.
echo   [ERROR] No server address.
echo           Put one line like  https://classroom.example.edu  into
echo           teacher-url.txt next to this file, then run it again.
echo.
pause
exit /b 1

:bad_addr
echo.
echo   [ERROR] Could not read a host out of "%ADDR%".
echo           Use a full base URL, e.g. http://192.0.2.10:18730
echo.
pause
exit /b 1

:no_browser
echo.
echo   [ERROR] No browser found.
echo           Install Chrome (109 works on Win7), then run this file again.
echo.
pause
exit /b 1
