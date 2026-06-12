param(
  [switch]$NoBrowser
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$serverDir = Join-Path $root "forceteki"
$clientDir = Join-Path $root "forceteki-client"
$dataServerDir = Join-Path $root "server"

Write-Host "=== SWU Local Dev Setup ===" -ForegroundColor Cyan

# Clone / pull repos ---------------------------------
if (-not (Test-Path $serverDir)) {
  Write-Host "Cloning server (forceteki)..." -ForegroundColor Yellow
  git clone https://github.com/SWU-Karabast/forceteki.git $serverDir
} else {
  Write-Host "Server repo exists" -ForegroundColor Gray
}

if (-not (Test-Path $clientDir)) {
  Write-Host "Cloning client (forceteki-client)..." -ForegroundColor Yellow
  git clone https://github.com/SWU-Karabast/forceteki-client.git $clientDir
} else {
  Write-Host "Client repo exists" -ForegroundColor Gray
}

# Install dependencies --------------------------------
Write-Host "`nInstalling server dependencies..." -ForegroundColor Cyan
Push-Location $serverDir
npm install
if ($?) { npm run get-cards }
Pop-Location

Write-Host "Installing client dependencies..." -ForegroundColor Cyan
Push-Location $clientDir
npm install
Pop-Location

Write-Host "Installing data server dependencies..." -ForegroundColor Cyan
Push-Location $dataServerDir
npm install
Pop-Location

# Launch processes ------------------------------------
Write-Host "`nStarting server (port 9500)..." -ForegroundColor Green
$serverJob = Start-Job -ScriptBlock {
  param($d) Push-Location $d; npm run dev; Pop-Location
} -ArgumentList $serverDir

Write-Host "Starting client (port 3000)..." -ForegroundColor Green
$clientJob = Start-Job -ScriptBlock {
  param($d) Push-Location $d; npm run dev; Pop-Location
} -ArgumentList $clientDir

Write-Host "Starting data server (port 3456)..." -ForegroundColor Green
$dataServerJob = Start-Job -ScriptBlock {
  param($d) Push-Location $d; npm start; Pop-Location
} -ArgumentList $dataServerDir

# Wait for ports to be open ---------------------------
function Wait-Port($port, $label, $timeoutSec = 120) {
  Write-Host "  Waiting for $label on port $port..." -ForegroundColor Cyan
  for ($i = 0; $i -lt $timeoutSec; $i++) {
    try {
      $tcp = [System.Net.Sockets.TcpClient]::new()
      $tcp.ConnectAsync("127.0.0.1", $port).Wait(1000) | Out-Null
      if ($tcp.Connected) { $tcp.Close(); return $true }
      $tcp.Dispose()
    } catch {}
    Start-Sleep -Seconds 1
  }
  return $false
}

$serverReady = Wait-Port 9500 "game server"
$clientReady = Wait-Port 3000 "client"
$dataServerReady = Wait-Port 3456 "data server"

# Open browser if both are up -------------------------
if ($serverReady -and $clientReady -and -not $NoBrowser) {
  Start-Process "http://localhost:3000"
  Start-Process "http://localhost:3456"
}

# Print status -----------------------------------------
Write-Host "`n========================================" -ForegroundColor Cyan
if ($serverReady) { Write-Host "  Game Server:   RUNNING (port 9500)" -ForegroundColor Green }
  else { Write-Host "  Game Server:   TIMEOUT - check job output" -ForegroundColor Red }
if ($clientReady) { Write-Host "  Client:        RUNNING (port 3000)" -ForegroundColor Green }
  else { Write-Host "  Client:        TIMEOUT - check job output" -ForegroundColor Red }
if ($dataServerReady) { Write-Host "  Data Server:   RUNNING (port 3456)" -ForegroundColor Green }
  else { Write-Host "  Data Server:   TIMEOUT - check job output" -ForegroundColor Red }
Write-Host "========================================" -ForegroundColor Cyan

Write-Host "`nCommands to stop:" -ForegroundColor Gray
Write-Host "  Get-Job | Stop-Job; Get-Job | Remove-Job" -ForegroundColor Gray
Write-Host "`nCommands to check output:" -ForegroundColor Gray
Write-Host "  Receive-Job -Id $($serverJob.Id)" -ForegroundColor Gray
Write-Host "  Receive-Job -Id $($clientJob.Id)" -ForegroundColor Gray
