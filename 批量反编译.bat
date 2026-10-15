@echo off
setlocal enabledelayedexpansion
rem Batch-decompile every function of a target in ONE Ghidra run.
rem
rem Usage: drag a binary onto this file, or pass the path as the first
rem argument. Output lands in <package>\analysis\<name>\.

cd /d "%~dp0"
set "PKG=%CD%"

set "TARGET=%~1"
if "%TARGET%"=="" set /p "TARGET=Full path to the binary: "
if not exist "%TARGET%" (
  echo ERROR: file not found: %TARGET%
  pause
  exit /b 1
)

rem --- engine discovery: identical rules to the launcher ------------
if not defined GHIDRA_INSTALL_DIR call :find_ghidra
if defined GHIDRA_INSTALL_DIR call :ensure_jdk

if not defined GHIDRA_INSTALL_DIR (
  echo ERROR: Ghidra 12.1.x not found. Set GHIDRA_INSTALL_DIR and retry.
  pause
  exit /b 1
)
if not defined JAVA_HOME (
  echo ERROR: JDK 21 not found. Set JAVA_HOME and retry.
  pause
  exit /b 1
)

for %%F in ("%TARGET%") do set "STEM=%%~nF"
set "OUT=%PKG%\analysis\%STEM%"
if not exist "%OUT%\local" mkdir "%OUT%\local"
if not exist "%OUT%\imported" mkdir "%OUT%\imported"

echo.
echo   Target : %TARGET%
echo   Engine : Ghidra %GHIDRA_INSTALL_DIR%
echo   JDK    : %JAVA_HOME%
echo   Output : %OUT%
echo.
echo   Two Ghidra passes run in sequence (local, then imported).
echo   Imported symbols are usually the larger pass and can take
echo   10+ minutes on a big binary. Keep this window open.
echo.

call :pass local    "%OUT%\local"
call :pass imported "%OUT%\imported"

echo.
echo   Done. Rebuild the indexes:
echo     runtime\node.exe tools\build-index.mjs --dir "%OUT%\local"
echo     runtime\node.exe tools\build-index.mjs --dir "%OUT%\imported"
pause
goto :eof

:pass
set "MODE=%~1"
set "DEST=%~2"
set "TSV=%TEMP%\rea-inv-%MODE%.tsv"
set "WORK=%TEMP%\rea-hl-%MODE%"
if exist "%TSV%" del /q "%TSV%"
if exist "%WORK%" rd /s /q "%WORK%"
mkdir "%WORK%"
echo   --- pass %MODE% ---
set "PATH=%JAVA_HOME%\bin;%PATH%"
call "%GHIDRA_INSTALL_DIR%\support\analyzeHeadless.bat" "%WORK%" proj ^
  -import "%TARGET%" ^
  -scriptPath "%PKG%\tools\ghidra" ^
  -postScript ReaDecompileAll.java "%TSV%" "%DEST%" %MODE% 0 ^
  -deleteProject
rd /s /q "%WORK%" 2>nul
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
