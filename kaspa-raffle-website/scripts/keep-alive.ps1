# Restarts kaspad and backend if they stop (run via scheduled task every 5 min)
$AppDir = "C:\Users\smoot\OneDrive\Desktop\Kaspa Raffle Website\kaspa-raffle-website"
$Kaspad = "C:\Users\smoot\OneDrive\Desktop\Kaspa\rusty-kaspa-v2.0.0-win64\kaspad.exe"
$Node = "C:\Program Files\nodejs\node.exe"

# kaspa-ng conflicts with kaspad on the same datadir
Get-Process kaspa-ng -ErrorAction SilentlyContinue | Stop-Process -Force

if (-not (Get-Process kaspad -ErrorAction SilentlyContinue)) {
    if (Test-Path $Kaspad) {
        $args = @("--yes", "--utxoindex", "--disable-upnp", "--rpclisten-borsh=127.0.0.1:17110", "--rpclisten-json=127.0.0.1:18110")
        Start-Process -FilePath $Kaspad -ArgumentList $args -WindowStyle Hidden
    }
}

$backendUp = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if (-not $backendUp -and (Test-Path (Join-Path $AppDir ".env"))) {
    Start-Process -FilePath $Node -ArgumentList "backend\server.js" -WorkingDirectory $AppDir -WindowStyle Hidden
}