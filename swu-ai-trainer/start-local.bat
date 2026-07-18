@echo off
setlocal
set "ROOT=%~dp0"
set "SERVER_DIR=%ROOT%forceteki"
set "CLIENT_DIR=%ROOT%forceteki-client"
set "DATA_SERVER_DIR=%ROOT%server"

echo === SWU Local Dev Setup ===

if not exist "%SERVER_DIR%" (
  echo Cloning server (forceteki)...
  git clone https://github.com/SWU-Karabast/forceteki.git "%SERVER_DIR%"
) else (
  echo Server repo exists
)

if not exist "%CLIENT_DIR%" (
  echo Cloning client (forceteki-client)...
  git clone https://github.com/SWU-Karabast/forceteki-client.git "%CLIENT_DIR%"
) else (
  echo Client repo exists
)

echo.
echo Installing server dependencies...
cd /d "%SERVER_DIR%"
call npm install
if %errorlevel% equ 0 call npm run get-cards

echo.
echo Installing client dependencies...
cd /d "%CLIENT_DIR%"
call npm install

echo.
echo Installing data server dependencies...
cd /d "%DATA_SERVER_DIR%"
call npm install

echo.
echo Starting server on port 9500...
start "SWU Server" cmd /c "cd /d "%SERVER_DIR%" && npm run dev"

echo Starting client on port 3000...
start "SWU Client" cmd /c "cd /d "%CLIENT_DIR%" && npm run dev"

echo Starting data server on port 3456...
start "SWU Data Server" cmd /c "cd /d "%DATA_SERVER_DIR%" && npm start"

echo.
echo Waiting for ports...
powershell -Command "$t=0; while($t -lt 120){try{$c=[System.Net.Sockets.TcpClient]::new();$c.ConnectAsync('127.0.0.1',9500).Wait(1000);if($c.Connected){Write-Host 'Server ready!' -ForegroundColor Green;break}}catch{};$t++;Start-Sleep 1}"
powershell -Command "$t=0; while($t -lt 120){try{$c=[System.Net.Sockets.TcpClient]::new();$c.ConnectAsync('127.0.0.1',3000).Wait(1000);if($c.Connected){Write-Host 'Client ready!' -ForegroundColor Green;break}}catch{};$t++;Start-Sleep 1}"

echo.
echo === Running ===
echo   Game Server: http://localhost:9500
echo   Client:      http://localhost:3000
echo   Data Server: http://localhost:3456
echo.
start http://localhost:3000
start http://localhost:3456
