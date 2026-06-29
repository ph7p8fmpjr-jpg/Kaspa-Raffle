# Kaspa Raffle - one-time setup (run in PowerShell as Administrator for boot startup)
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
RAFFLE_ADDRESS=winraffle.kas
RAFFLE_DISPLAY_ADDRESS=winraffle.kas
RAFFLE_ONCHAIN_FALLBACK=kaspa:qr3rxmae6r5h9kkt7q5my7rajy492da7cxpy0kkzr99tk3xcydc2uwa3a7u6r
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

$taskName = "Kaspa Raffle Auto Start"
$startAllScript = Join-Path $AppDir "scripts\start-all.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startAllScript`""

$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 2)

try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $logonTrigger -Settings $settings -Description "Starts kaspad + raffle backend at login" -Force | Out-Null
} catch {
    Write-Host "Could not register task - try running install-boot-startup.ps1 as Administrator" -ForegroundColor Yellow
}

# Remove old separate tasks if they exist
foreach ($old in @("Kaspa Raffle Node", "Kaspa Raffle Backend")) {
    $t = Get-ScheduledTask -TaskName $old -ErrorAction SilentlyContinue
    if ($t) {
        Unregister-ScheduledTask -TaskName $old -Confirm:$false -ErrorAction SilentlyContinue
    }
}

Write-Host ""
Write-Host "Scheduled task registered:" -ForegroundColor Green
Write-Host "  - $taskName (runs at login; for boot too run install-boot-startup.ps1 as Admin)"
Write-Host ""
Write-Host "Note: You do NOT need kaspa-wallet GUI open." -ForegroundColor Cyan
Write-Host "Your key in .env powers payouts automatically via kaspad."
Write-Host ""
Write-Host "NEXT STEPS:" -ForegroundColor Cyan
Write-Host '  1. Ensure WALLET_PRIVATE_KEY is set in .env'
Write-Host '  2. Run: .\scripts\start-all.ps1'
Write-Host '  3. On Render set DRAW_ENABLED=false'
Write-Host ""