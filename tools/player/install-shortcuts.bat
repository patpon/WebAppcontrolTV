@echo off
rem Puts "Music Player" shortcuts on the desktop and in Startup (opens by itself when Windows starts).
rem Run "install-shortcuts.bat remove" to take them away again.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$t = Join-Path '%~dp0' 'rbtv-player.bat';" ^
  "$places = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Startup'));" ^
  "foreach ($p in $places) { $f = Join-Path $p 'RBTV Music Player.lnk';" ^
  "  if ('%1' -eq 'remove') { if (Test-Path $f) { Remove-Item $f; Write-Host ('removed ' + $f) } ; continue }" ^
  "  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($f); $s.TargetPath = $t; $s.WorkingDirectory = '%~dp0';" ^
  "  $s.WindowStyle = 7; $s.IconLocation = \"$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe,0\"; $s.Save(); Write-Host ('created ' + $f) }"
pause
