$Kaspad = "C:\Users\smoot\OneDrive\Desktop\Kaspa\rusty-kaspa-v2.0.0-win64\kaspad.exe"
$AppDir = "C:\Users\smoot\OneDrive\Desktop\Kaspa Raffle Website\kaspa-raffle-website"
$LogFile = Join-Path $AppDir "logs\kaspad.log"

if (-not (Test-Path $Kaspad)) {
    Write-Error "kaspad not found at $Kaspad"
    exit 1
}

New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null

$existing = Get-Process -Name "kaspad" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "kaspad already running (PID $($existing.Id))"
    exit 0
}

$args = @(
    "--yes",
    "--utxoindex",
    "--rpclisten-borsh=127.0.0.1:17110",
    "--rpclisten-json=127.0.0.1:18110"
)

Start-Process -FilePath $Kaspad -ArgumentList $args -WindowStyle Hidden -RedirectStandardOutput $LogFile -RedirectStandardError "${LogFile}.err"
Write-Host "kaspad started - wRPC Borsh on 127.0.0.1:17110"