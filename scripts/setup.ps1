# Kaspa Raffle - one-time setup (run in PowerShell)
$AppDir = "C:\Users\smoot\OneDrive\Desktop\Kaspa Raffle Website\kaspa-raffle-website"
Set-Location $AppDir

Write-Host "=== Kaspa Raffle Setup ===" -ForegroundColor Cyan

if (-not (Test-Path "node_modules\express")) {
    Write-Host "Installing npm packages..."
    npm install
}

$envPath = Join-Path $AppDir ".env"
if (-not (Test-Path $envPath)) {
    $cronSecret = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
    $envContent = @"
PORT=3000
ADMIN_PASSWORD=CHANGE_ME_NOW
RAFFLE_ADDRESS=kaspa:qzfcyspged7wkzzmlkud7vsxc3uexlgyu9qxdcuaudsr7phuxmkrc3xwfnexv
POLL_MS=15000
DRAW_ENABLED=true
KASPA_NETWORK=mainnet
KASPA_RPC_URL=127.0.0.1
WALLET_PRIVATE_KEY=
OPS_ADDRESS=
CRON_SECRET=$cronSecret
"@
    Set-Content -Path $envPath -Value $envContent -Encoding UTF8
    Write-Host "Created .env - edit ADMIN_PASSWORD and WALLET_PRIVATE_KEY" -ForegroundColor Yellow
} else {
    Write-Host ".env already exists - skipping"
}

$taskKaspad = "Kaspa Raffle Node"
$taskBackend = "Kaspa Raffle Backend"
$kaspadScript = Join-Path $AppDir "scripts\start-kaspad.ps1"
$backendScript = Join-Path $AppDir "scripts\start-backend.ps1"

$kaspadAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$kaspadScript`""
$backendAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$backendScript`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $taskKaspad -Action $kaspadAction -Trigger $trigger -Settings $settings -Description "Kaspa node for raffle payouts" -Force | Out-Null
Register-ScheduledTask -TaskName $taskBackend -Action $backendAction -Trigger $trigger -Settings $settings -Description "Kaspa Raffle API and auto draw" -Force | Out-Null

$oldTask = Get-ScheduledTask -TaskName "Run Kaspa Node" -ErrorAction SilentlyContinue
if ($oldTask) {
    Unregister-ScheduledTask -TaskName "Run Kaspa Node" -Confirm:$false
    Write-Host "Removed old broken Run Kaspa Node task"
}

Write-Host ""
Write-Host "Scheduled tasks registered:" -ForegroundColor Green
Write-Host "  - $taskKaspad"
Write-Host "  - $taskBackend"
Write-Host ""
Write-Host "NEXT STEPS:" -ForegroundColor Cyan
Write-Host '  1. Edit .env - set ADMIN_PASSWORD and WALLET_PRIVATE_KEY'
Write-Host '  2. Run: .\scripts\start-kaspad.ps1'
Write-Host '  3. Wait for node sync, then: .\scripts\start-backend.ps1'
Write-Host '  4. On Render set DRAW_ENABLED=false'
Write-Host ""