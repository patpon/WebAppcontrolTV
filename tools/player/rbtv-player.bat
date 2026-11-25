@echo off
rem Opens the shop music player (small window) and keeps it running. Sound starts by itself.
rem "rbtv-player.bat full" opens it full screen. Running it again restarts the player.
rem Window size and the rest are set at the top of rbtv-watchdog.ps1.
rem conhost --headless keeps PowerShell windowless (on Windows 11, Windows Terminal ignores -WindowStyle Hidden).
set "MODE="
if /i "%~1"=="full" set "MODE=-Full"
set "PS=powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0rbtv-watchdog.ps1" %MODE%"
if exist "%SystemRoot%\System32\conhost.exe" (
  start "" "%SystemRoot%\System32\conhost.exe" --headless %PS%
) else (
  start "" %PS%
)
