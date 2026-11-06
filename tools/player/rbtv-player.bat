@echo off
rem Opens the shop music player in its own Chrome window. Sound starts by itself, no click needed.
rem Uses a separate Chrome profile so the flags work even when normal Chrome is already open.
rem Window: small by default (change W/H/X/Y below). Run "rbtv-player.bat full" for full screen.
set "URL=https://rbtv.ajpatpon.com/music.html"
set "W=720"
set "H=450"
set "X=40"
set "Y=40"
set "B=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not exist "%B%" set "B=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%B%" set "B=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%B%" set "B=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%B%" (
  echo Chrome not found
  pause
  exit /b 1
)
set "WIN=--window-size=%W%,%H% --window-position=%X%,%Y%"
if /i "%~1"=="full" set "WIN=--start-fullscreen"
start "" "%B%" --user-data-dir="%LOCALAPPDATA%\rbtv-player" --autoplay-policy=no-user-gesture-required --app=%URL% %WIN% --no-first-run --no-default-browser-check
