@echo off
setlocal
rem Regenerate the command catalog from the installed rea-agents.
rem Run this after upgrading REA inside this package.
cd /d "%~dp0"
"runtime\node.exe" "tools\build-catalog.mjs"
pause
endlocal
