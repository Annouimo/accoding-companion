@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" %*
set "launch_status=%ERRORLEVEL%"
if not "%launch_status%"=="0" pause
exit /b %launch_status%
