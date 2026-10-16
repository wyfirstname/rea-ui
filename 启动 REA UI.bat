@echo off
setlocal enabledelayedexpansion
rem ============================================================
rem  REA UI launcher (green / portable)
rem  Uses the bundled Node runtime: no system Node, no npm.
rem
rem  Static analysis (JavaScript / Electron / .NET / SQLite /
rem  Go / Rust) works with no engine installed. Native binary
rem  analysis additionally needs Ghidra 12.1.x and JDK 21.
rem ============================================================

cd /d "%~dp0"

if not exist "runtime\node.exe" (
  echo ERROR: runtime\node.exe not found. Package looks incomplete.
  pause
  exit /b 1
)

rem --- locate an analysis engine -----------------------------------
if not defined GHIDRA_INSTALL_DIR call :find_ghidra
if defined GHIDRA_INSTALL_DIR call :ensure_jdk

set "ENGSTAT="
if defined GHIDRA_INSTALL_DIR (
  if defined JAVA_HOME (
    set "ENGSTAT=Engine: Ghidra %GHIDRA_INSTALL_DIR%  ^|  JDK %JAVA_HOME%"
  ) else (
    set "ENGSTAT=WARN: Ghidra found but no JDK 21. Native analysis will fail."
  )
) else (
  set "ENGSTAT=No Ghidra engine. Static analysis works; native binaries need Ghidra 12.1.x + JDK 21."
)

rem --- is a previous REA UI instance still up? ---------------------
rem Only reuse the default port when the listener really is our own
rem node.exe. A foreign app parked on 7823 must not be mistaken for a
rem running instance: that used to send the browser to a stranger's page.
call :probe_port 7823
if not defined LISTEN_PID goto :pick_port
set "OWNER="
for /f "tokens=1 delims=," %%N in ('tasklist /fi "PID eq %LISTEN_PID%" /nh /fo csv 2^>nul') do set "OWNER=%%~N"
if /i not "%OWNER%"=="node.exe" goto :pick_port

echo.
echo   An REA UI instance is already running on port 7823.
echo   Opening it in your browser: http://127.0.0.1:7823
echo   ^(To run a second instance, set REA_UI_PORT to a free port.^)
echo.
start "" "http://127.0.0.1:7823"
echo   Press any key to close this window.
pause >nul
exit /b 0

rem --- pick a free port so repeat launches do not collide ---------
rem findstr is used on purpose: `find` treats ".*" literally and never
rem matches, which made every launch believe 7823 was free.
:pick_port
set "PORT=%REA_UI_PORT%"
if "%PORT%"=="" set "PORT=7823"
:retry
call :probe_port %PORT%
if not defined LISTEN_PID goto :free
set /a PORT+=1
if !PORT! GTR 7853 (
  echo ERROR: No free port between 7823-7853.
  pause
  exit /b 1
)
goto :retry
:free

echo.
echo   REA UI - Reverse Engineer Anything, graphical front-end
echo   ---------------------------------------------------
echo   URL: http://127.0.0.1:%PORT%
echo   %ENGSTAT%
echo   Browser opens automatically once the server is ready
echo   ^(first launch after boot may take ~10 seconds^).
echo   Close this window to stop the server.
echo.

rem The browser must open only after the server is actually listening.
rem A cold start (antivirus scanning the bundled runtime) can take 10s+,
rem so we let server.mjs open the page from its listen callback instead
rem of racing it here. REA_UI_OPEN=1 enables exactly that.
set "REA_UI_OPEN=1"

set "REA_UI_PORT=%PORT%"
"runtime\node.exe" "server.mjs"
set "EXITCODE=%ERRORLEVEL%"

rem Never let the window vanish silently: if the server failed, keep the
rem console open so the error above stays readable.
if not "%EXITCODE%"=="0" (
  echo.
  echo   REA UI exited with code %EXITCODE%. See the message above.
  echo.
  pause
)
goto :eof

rem --- subroutines -----------------------------------------------

rem :probe_port <port>
rem Sets LISTEN_PID to the PID listening on <port>, or clears it when the
rem port is free. findstr /r is required: `find` has no regex support, so
rem ":%PORT%.*LISTENING" was compared literally and never matched.
:probe_port
set "LISTEN_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%~1 .*LISTENING"') do set "LISTEN_PID=%%P"
goto :eof

:find_ghidra
for %%D in (
  "%GHIDRA_HOME%"
  "D:\rea\ghidra"
  "C:\ghidra"
  "C:\tools\ghidra"
  "D:\ghidra"
  "D:\tools\ghidra"
  "%USERPROFILE%\ghidra"
  "%ProgramFiles%\ghidra"
) do (
  if exist "%%~D\support\analyzeHeadless.bat" (
    set "GHIDRA_INSTALL_DIR=%%~D"
    goto :eof
  )
)
goto :eof

rem An inherited JAVA_HOME is often an old JRE such as Java 8, which the
rem Ghidra provider rejects. Keep it only when javac exists and the version
rem starts with 21 or 25; otherwise fall back to auto-detection.
:ensure_jdk
if not defined JAVA_HOME (
  call :find_jdk
  goto :eof
)
if not exist "%JAVA_HOME%\bin\javac.exe" (
  set "JAVA_HOME="
  call :find_jdk
  goto :eof
)
rem %%~V strips the quotes java wraps the version in ("21.0.5"). Without it
rem the substring test below compares against `"2` and always fails, which
rem silently discarded a perfectly good JAVA_HOME.
set "JVER="
for /f "tokens=3" %%V in ('"%JAVA_HOME%\bin\java.exe" -version 2^>^&1 ^| findstr /i version') do set "JVER=%%~V"
if not defined JVER (
  set "JAVA_HOME="
  call :find_jdk
  goto :eof
)
if "!JVER:~0,2!"=="21" goto :eof
if "!JVER:~0,2!"=="25" goto :eof
set "JAVA_HOME="
call :find_jdk
goto :eof

:find_jdk
for %%J in (
  "%JDK_HOME%"
  "D:\rea\jdk"
  "C:\Program Files\Java\jdk-21"
  "C:\Program Files\Java\jdk-25"
  "C:\Program Files\Eclipse Adoptium\jdk-21"
  "%USERPROFILE%\.jdks"
) do (
  if exist "%%~J\bin\javac.exe" (
    set "JAVA_HOME=%%~J"
    goto :eof
  )
)
goto :eof
