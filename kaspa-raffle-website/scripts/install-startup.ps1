# Registers kaspad + raffle backend to start at Windows login and stay running.
# Run once in PowerShell (Administrator recommended for boot-at-startup trigger).

param(
    [switch]$IncludeBootTrigger
)

$AppDir = "C:\Users\smoot\OneDrive\Desktop\Kaspa Raffle Website\kaspa-raffle-website"
$startAllScript = Join-Path $AppDir "scripts\start-all.ps1"
$keepAliveScript = Join-Path $AppDir "scripts\keep-alive.ps1"

if (-not (Test-Path $startAllScript)) {
    Write-Error "Missing $startAllScript"
    exit 1
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)

# Remove legacy broken tasks (wrong kaspad path / duplicate runners)
foreach ($old in @("Run Kaspa Node", "Kaspa Raffle Node", "Kaspa Raffle Backend")) {
    $t = Get-ScheduledTask -TaskName $old -ErrorAction SilentlyContinue
    if ($t) {
        Unregister-ScheduledTask -TaskName $old -Confirm:$false
        Write-Host "Removed old task: $old" -ForegroundColor Yellow
    }
}

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 2) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0)

# --- Task 1: start kaspad + backend at login (60s delay for network) ---
$startAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument (
    "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startAllScript`""
)
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$logonTrigger.Delay = "PT1M"

$startTriggers = @($logonTrigger)
if ($IncludeBootTrigger -and $isAdmin) {
    $bootTrigger = New-ScheduledTaskTrigger -AtStartup
    $bootTrigger.Delay = "PT2M"
    $startTriggers += $bootTrigger
    Write-Host "Including AtStartup trigger (requires admin)" -ForegroundColor Cyan
} elseif ($IncludeBootTrigger -and -not $isAdmin) {
    Write-Host "Skipping AtStartup - re-run as Administrator with -IncludeBootTrigger" -ForegroundColor Yellow
}

Register-ScheduledTask `
    -TaskName "Kaspa Raffle Auto Start" `
    -Action $startAction `
    -Trigger $startTriggers `
    -Settings $settings `
    -Description "Starts kaspad and raffle backend at login (and boot if enabled)" `
    -Force | Out-Null

Write-Host "Registered: Kaspa Raffle Auto Start (logon + 1 min delay)" -ForegroundColor Green

# --- Task 2: restart kaspad/backend if they crash (every 5 min while logged in) ---
$keepAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument (
    "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$keepAliveScript`""
)
$keepTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$keepTrigger.Repetition = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ([TimeSpan]::MaxValue)

Register-ScheduledTask `
    -TaskName "Kaspa Raffle Keep Alive" `
    -Action $keepAction `
    -Trigger $keepTrigger `
    -Settings $settings `
    -Description "Restarts kaspad and backend if they stop" `
    -Force | Out-Null

Write-Host "Registered: Kaspa Raffle Keep Alive (every 5 min)" -ForegroundColor Green

Write-Host ""
Write-Host "kaspad will start automatically when you log in to Windows." -ForegroundColor Cyan
Write-Host "If the PC reboots overnight, draws resume once you log back in." -ForegroundColor Cyan
Write-Host ""
Write-Host "Verify after reboot:" -ForegroundColor White
Write-Host '  Get-Process kaspad'
Write-Host '  Invoke-RestMethod http://localhost:3000/health'