@echo off
rem Opens the shop music player (small window) and keeps it running. Sound starts by itself.
rem "rbtv-player.bat full" opens it full screen. Running it again restarts the player.
rem Window size and the rest are set at the top of rbtv-watchdog.ps1.
set "MODE="
if /i "%~1"=="full" set "MODE=-Full"
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0rbtv-watchdog.ps1" %MODE%
