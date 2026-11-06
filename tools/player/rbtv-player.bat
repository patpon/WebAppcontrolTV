@echo off
rem Opens the shop music player in its own Chrome window. Sound starts by itself, no click needed.
rem Uses a separate Chrome profile so the flags work even when normal Chrome is already open.
set "URL=https://rbtv.ajpatpon.com/music.html"
set "B=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not exist "%B%" set "B=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%B%" set "B=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%B%" set "B=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%B%" (
  echo Chrome not found
  pause
  exit /b 1
)
start "" "%B%" --user-data-dir="%LOCALAPPDATA%\rbtv-player" --autoplay-policy=no-user-gesture-required --app=%URL% --start-fullscreen --no-first-run --no-default-browser-check
