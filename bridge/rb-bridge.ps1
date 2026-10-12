<#
  Rabiang Bua TV bridge - runs on the shop's central PC.

  Reads data/config.json (published by the admin panel) and switches each room's
  Android box between the karaoke app and the promo app (Fully Kiosk) over ADB on the LAN.

    mode = karaoke  -> bring the karaoke app to the front (once, when the mode changes)
    mode = auto     -> karaoke app idle for N minutes (no remote input, no audio) -> promo app
                       any remote button pressed while promo is showing          -> karaoke app
    other modes     -> bring the promo app to the front (once, when the mode changes)

  Usage:
    .\rb-bridge.ps1            run forever
    .\rb-bridge.ps1 -Status    print each box's state once (use it to find the karaoke app package)
#>
param(
  [switch]$Status,
  [int]$Interval = 5
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$settingsPath = Join-Path $here 'boxes.json'
if (-not (Test-Path $settingsPath)) {
  Write-Host "boxes.json not found. Copy boxes.example.json to boxes.json and fill in each room's box IP." -ForegroundColor Red
  exit 1
}
$settings = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json

$adb = $settings.adbPath
if (-not $adb) { $adb = Join-Path $here 'platform-tools\adb.exe' }
if (-not (Test-Path $adb)) {
  $found = Get-Command adb -ErrorAction SilentlyContinue
  if ($found) { $adb = $found.Source } else {
    Write-Host "adb.exe not found. Unzip Android platform-tools into $here\platform-tools" -ForegroundColor Red
    exit 1
  }
}

function Log($msg, $color = 'Gray') {
  Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $msg) -ForegroundColor $color
}

# ---------- ADB helpers ----------
$lastConnect = @{}
function Invoke-Adb([string]$ip, [string[]]$cmd) {
  $out = & $adb -s "${ip}:5555" @cmd 2>&1 | Out-String
  return $out
}

function Connect-Box([string]$ip) {
  $now = Get-Date
  if ($lastConnect.ContainsKey($ip) -and ($now - $lastConnect[$ip]).TotalSeconds -lt 60) { return }
  $lastConnect[$ip] = $now
  $out = & $adb connect "${ip}:5555" 2>&1 | Out-String
  if ($out -notmatch 'connected to') { Log "connect $ip -> $($out.Trim())" 'Yellow' }
}

function Get-BoxState([string]$ip) {
  $out = Invoke-Adb $ip @('shell', 'dumpsys window | grep -E "mCurrentFocus|mFocusedApp"; echo ---; dumpsys power | grep mLastUserActivityTime=; cat /proc/uptime')
  if ($out -match '(?m)^error:|device .* not found|device offline|unauthorized') {
    $lastConnect.Remove($ip) | Out-Null
    throw "adb: $($out.Trim())"
  }
  $fg = ''
  if ($out -match 'mCurrentFocus=Window\{[^}]*\s([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)/') { $fg = $Matches[1] }
  elseif ($out -match '\s([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)/') { $fg = $Matches[1] }

  # Seconds since the last remote/touch input. Android 10+ prints "(N ms ago)"; older versions print raw uptime ms.
  $idle = -1
  if ($out -match 'mLastUserActivityTime=\d+ \((\d+) ms ago\)') { $idle = [int]([long]$Matches[1] / 1000) }
  elseif ($out -match 'mLastUserActivityTime=(\d+)') {
    $last = [long]$Matches[1]
    if ($out -match '(?m)^(\d+)\.\d+ ') { $idle = [int](([double]$Matches[1] * 1000 - $last) / 1000) }
  }
  return @{ Foreground = $fg; IdleSec = $idle }
}

function Test-AudioPlaying([string]$ip) {
  $out = Invoke-Adb $ip @('shell', 'dumpsys audio | grep -c "state:started"')
  $n = 0
  [int]::TryParse(($out.Trim() -split "`n")[-1].Trim(), [ref]$n) | Out-Null
  return $n -gt 0
}

$componentCache = @{}
function Start-BoxApp([string]$ip, [string]$pkg) {
  if (-not $pkg) { Log "no package configured - set it in admin > settings" 'Yellow'; return }
  $key = "$ip|$pkg"
  if (-not $componentCache.ContainsKey($key)) {
    $comp = ''
    foreach ($cat in @('android.intent.category.LEANBACK_LAUNCHER', 'android.intent.category.LAUNCHER')) {
      $out = Invoke-Adb $ip @('shell', "cmd package resolve-activity --brief -c $cat $pkg")
      $line = ($out.Trim() -split "`n" | Where-Object { $_ -match '/' } | Select-Object -Last 1)
      if ($line) { $comp = $line.Trim(); break }
    }
    $componentCache[$key] = $comp
  }
  $comp = $componentCache[$key]
  if ($comp) { Invoke-Adb $ip @('shell', "am start -n $comp") | Out-Null }
  else { Invoke-Adb $ip @('shell', "monkey -p $pkg -c android.intent.category.LAUNCHER 1") | Out-Null }
}

# ---------- config ----------
$cfg = $null
$lastFetch = [datetime]::MinValue
function Update-Config {
  if ($script:cfg -and ((Get-Date) - $script:lastFetch).TotalSeconds -lt 15) { return }
  try {
    $url = "$($settings.configUrl)?t=$([DateTime]::UtcNow.Ticks)"
    $script:cfg = Invoke-RestMethod -Uri $url -TimeoutSec 15 -Headers @{ 'Cache-Control' = 'no-cache' }
    $script:lastFetch = Get-Date
  } catch {
    Log "cannot load config: $($_.Exception.Message)" 'Yellow'
  }
}

function Get-RoomIp($roomId) {
  $p = $settings.boxes.PSObject.Properties[[string]$roomId]
  if ($p) { return [string]$p.Value } else { return '' }
}

# ---------- status mode ----------
if ($Status) {
  Update-Config
  foreach ($r in $cfg.rooms) {
    $ip = Get-RoomIp $r.id
    if (-not $ip) { continue }
    try {
      Connect-Box $ip
      $s = Get-BoxState $ip
      $audio = Test-AudioPlaying $ip
      Write-Host ("{0,-10} {1,-16} mode={2,-9} foreground={3,-40} idle={4}s audio={5}" -f $r.id, $ip, $r.mode, $s.Foreground, $s.IdleSec, $audio)
    } catch {
      Write-Host ("{0,-10} {1,-16} ERROR {2}" -f $r.id, $ip, $_.Exception.Message) -ForegroundColor Red
    }
  }
  exit 0
}

# ---------- main loop ----------
$rooms = @{}   # roomId -> @{ Mode; SwitchedAt }
Log "bridge started (adb: $adb)" 'Green'
while ($true) {
  Update-Config
  if ($cfg) {
    $karaoke = [string]$cfg.settings.karaokeApp
    $promo = [string]$cfg.settings.promoApp
    if (-not $promo) { $promo = 'de.ozerov.fully' }
    $idleLimit = [int]$cfg.settings.idleMinutes * 60
    if ($idleLimit -le 0) { $idleLimit = 600 }

    foreach ($r in $cfg.rooms) {
      $ip = Get-RoomIp $r.id
      if (-not $ip) { continue }
      $id = [string]$r.id
      if (-not $rooms.ContainsKey($id)) { $rooms[$id] = @{ Mode = ''; SwitchedAt = Get-Date } }
      $st = $rooms[$id]
      try {
        Connect-Box $ip
        if ($r.mode -ne $st.Mode) {
          $st.Mode = $r.mode
          $st.SwitchedAt = Get-Date
          if ($r.mode -eq 'karaoke') { Start-BoxApp $ip $karaoke; Log "room $id -> karaoke (admin)" 'Cyan' }
          elseif ($r.mode -ne 'auto') { Start-BoxApp $ip $promo; Log "room $id -> promo [$($r.mode)] (admin)" 'Cyan' }
          continue
        }
        if ($r.mode -ne 'auto' -or -not $karaoke) { continue }

        $s = Get-BoxState $ip
        if ($s.IdleSec -lt 0) { continue }
        $since = ((Get-Date) - $st.SwitchedAt).TotalSeconds
        if ($s.Foreground -eq $karaoke) {
          if ($s.IdleSec -ge $idleLimit -and ($cfg.settings.idleIgnoreAudio -or -not (Test-AudioPlaying $ip))) {
            Start-BoxApp $ip $promo
            $st.SwitchedAt = Get-Date
            Log "room $id -> promo (idle $([int]($s.IdleSec / 60)) min)" 'Green'
          }
        } elseif ($s.Foreground -eq $promo) {
          # remote pressed after we showed the promo -> back to singing
          if ($s.IdleSec -lt ($since - 3) -and $s.IdleSec -le ($Interval + 5)) {
            Start-BoxApp $ip $karaoke
            $st.SwitchedAt = Get-Date
            Log "room $id -> karaoke (remote pressed)" 'Green'
          }
        }
      } catch {
        Log "room $id ($ip): $($_.Exception.Message)" 'Red'
      }
    }
  }
  Start-Sleep -Seconds $Interval
}
