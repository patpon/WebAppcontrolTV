@echo off
title Rabiang Bua TV bridge
cd /d "%~dp0"
:loop
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0rb-bridge.ps1"
echo Bridge stopped - restarting in 10 seconds...
timeout /t 10 /nobreak >nul
goto loop
