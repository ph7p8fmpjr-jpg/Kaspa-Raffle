# Keeps kaspad and the raffle backend running. Run in background or via scheduled task.
$AppDir = "C:\Users\smoot\OneDrive\Desktop\Kaspa Raffle Website\kaspa-raffle-website"
$Kaspad = "C:\Users\smoot\OneDrive\Desktop\Kaspa\rusty-kaspa-v2.0.0-win64\kaspad.exe"
$Node = "C:\Program Files\nodejs\node.exe"

function Ensure-Kaspad {
    if (Get-Process kaspad -ErrorAction SilentlyContinue) { return }
    if (-not (Test-Path $Kaspad)) {
        Write-Host "[watchdog] kaspad.exe not found"
        return
    }
    $args = @("--yes", "--utxoindex", "--disable-upnp", "--rpclisten-borsh=127.0.0.1:17110", "--rpclisten-json=127.0.0.1:18110")
    Start-Process -FilePath $Kaspad -ArgumentList $args -WindowStyle Hidden
    Write-Host "[watchdog] Started kaspad $(Get-Date -Format 'HH:mm:ss')"
}

function Ensure-Backend {
    $port = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    if ($port) { return }
    if (-not (Test-Path "$AppDir\.env")) {
        Write-Host "[watchdog] .env missing"
        return
    }
    Start-Process -FilePath $Node -ArgumentList "backend\server.js" -WorkingDirectory $AppDir -WindowStyle Hidden
    Write-Host "[watchdog] Started backend $(Get-Date -Format 'HH:mm:ss')"
}

Write-Host "[watchdog] Running - checks every 60s"
while ($true) {
    Stop-Process -Name kaspa-ng -Force -ErrorAction SilentlyContinue
    Ensure-Kaspad
    Ensure-Backend
    Start-Sleep -Seconds 60
}