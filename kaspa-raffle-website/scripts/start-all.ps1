# Starts kaspad, waits for RPC, then starts raffle backend
$AppDir = "C:\Users\smoot\OneDrive\Desktop\Kaspa Raffle Website\kaspa-raffle-website"
Set-Location $AppDir

& "$AppDir\scripts\start-kaspad.ps1"

$maxWait = 120
$waited = 0
while ($waited -lt $maxWait) {
    $kaspad = Get-Process kaspad -ErrorAction SilentlyContinue
    $port = Get-NetTCPConnection -LocalPort 17110 -State Listen -ErrorAction SilentlyContinue
    if ($kaspad -and $port) {
        Write-Host "kaspad ready on port 17110"
        break
    }
    Start-Sleep -Seconds 5
    $waited += 5
}

if ($waited -ge $maxWait) {
    Write-Host "Warning: kaspad may still be syncing - starting backend anyway"
}

& "$AppDir\scripts\start-backend.ps1"