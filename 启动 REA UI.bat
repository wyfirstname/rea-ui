@echo off
setlocal
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

rem --- pick a free port so repeat launches do not collide ---------
set "PORT=%REA_UI_PORT%"
if "%PORT%"=="" set "PORT=7823"
:retry
netstat -ano | find ":%PORT%.*LISTENING" >nul 2>&1
if errorlevel 1 goto :free
set /a PORT+=1
if %PORT% GTR 7853 (
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
echo   Close this window to stop the server.
echo.

start "" "http://127.0.0.1:%PORT%"

set "REA_UI_PORT=%PORT%"
"runtime\node.exe" "server.mjs"
goto :eof

rem --- subroutines -----------------------------------------------

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
set "JVER="
for /f "tokens=3" %%V in ('"%JAVA_HOME%\bin\java.exe" -version 2^>^&1 ^| findstr /i version') do set "JVER=%%V"
if not defined JVER (
  set "JAVA_HOME="
  call :find_jdk
  goto :eof
)
if "%JVER:~0,2%"=="21" goto :eof
if "%JVER:~0,2%"=="25" goto :eof
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
