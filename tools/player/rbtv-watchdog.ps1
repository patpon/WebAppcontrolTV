# Opens the shop music player in its own Chrome window and keeps it alive.
# - waits for the internet before opening (right after Windows starts it is often not up yet)
# - Chrome flags stop the window from being slowed down when it is small, covered or minimized
# - if the player stops checking in with the server for 2 minutes while the internet works
#   (frozen window, crashed tab), Chrome is closed and opened again; at most 3 times per 30 minutes
# - running it again while the player is open restarts the player
# - closing the player window ends the watching
param([switch]$Full)

$Url = 'https://rbtv.ajpatpon.com/music.html'
$Api = 'https://rbtv.ajpatpon.com/api/jukebox.php?action=state'
$W = 720; $H = 450; $X = 40; $Y = 40
$Profile = Join-Path $env:LOCALAPPDATA 'rbtv-player'

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Browser = @(
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $Browser) { exit 1 }

$Win = if ($Full) { '--start-fullscreen' } else { "--window-size=$W,$H --window-position=$X,$Y" }
$ChromeArgs = "--user-data-dir=`"$Profile`" --app=$Url $Win --autoplay-policy=no-user-gesture-required " +
  '--no-first-run --no-default-browser-check --hide-crash-restore-bubble ' +
  '--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding ' +
  '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,Translate'

function Get-Player {
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*rbtv-player*' }
}
function Stop-Player { Get-Player | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
function Start-Player { Start-Process -FilePath $Browser -ArgumentList $ChromeArgs }
function Get-Status {
  try {
    $s = Invoke-RestMethod -Uri ($Api + '&_=' + (Get-Random)) -TimeoutSec 10 -UseBasicParsing
    return @{ Net = $true; Online = [bool]$s.player.online }
  } catch { return @{ Net = $false; Online = $false } }
}

# one watcher at a time; a second start restarts the player and takes over
$Mutex = New-Object System.Threading.Mutex($false, 'Local\rbtv-player-watchdog')
$Mine = $false
try { $Mine = $Mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $Mine = $true }
if (-not $Mine) {
  Stop-Player   # the old watcher sees the player gone and quits
  try { $Mine = $Mutex.WaitOne(30000) } catch [System.Threading.AbandonedMutexException] { $Mine = $true }
  if (-not $Mine) { exit 1 }
}

for ($i = 0; $i -lt 36; $i++) { if ((Get-Status).Net) { break }; Start-Sleep -Seconds 5 }
if (-not (Get-Player)) { Start-Player }
Start-Sleep -Seconds 20

$Off = 0; $Restarts = @(); $Step = 0
while ($true) {
  Start-Sleep -Seconds 5
  if (-not (Get-Player)) { break }          # staff closed the player
  $Step++
  if ($Step % 3) { continue }               # check the server every 15 s
  $st = Get-Status
  if (-not $st.Net -or $st.Online) { $Off = 0; continue }   # no internet: the player uses local songs by itself
  $Off += 15
  if ($Off -lt 120) { continue }
  $Off = 0
  $Restarts = @($Restarts | Where-Object { $_ -gt (Get-Date).AddMinutes(-30) })
  if ($Restarts.Count -ge 3) { continue }   # e.g. waiting at the login screen: restarting will not help
  Stop-Player
  Start-Sleep -Seconds 3
  Start-Player
  $Restarts += Get-Date
  Start-Sleep -Seconds 20
}
$Mutex.ReleaseMutex()
