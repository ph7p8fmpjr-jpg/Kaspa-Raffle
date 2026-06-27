# Run this ONCE as Administrator (right-click PowerShell -> Run as administrator)
# Adds boot-time startup in addition to login startup

$AppDir = "C:\Users\smoot\OneDrive\Desktop\Kaspa Raffle Website\kaspa-raffle-website"
$startAllScript = Join-Path $AppDir "scripts\start-all.ps1"
$taskName = "Kaspa Raffle Auto Start"

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startAllScript`""
$bootTrigger = New-ScheduledTaskTrigger -AtStartup
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($bootTrigger, $logonTrigger) -Settings $settings -Description "Starts kaspad and raffle backend at boot and login" -Force -RunLevel Highest

Write-Host "Installed $taskName with boot + login triggers" -ForegroundColor Green