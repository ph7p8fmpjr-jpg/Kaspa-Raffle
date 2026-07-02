$AppDir = "C:\Users\smoot\OneDrive\Desktop\Kaspa Raffle Website\kaspa-raffle-website"
$LogFile = Join-Path $AppDir "logs\backend.log"
$Node = "C:\Program Files\nodejs\node.exe"

Set-Location $AppDir
New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null

$existing = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Backend already listening on port 3000"
    exit 0
}

$envFile = Join-Path $AppDir ".env"
if (-not (Test-Path $envFile)) {
    Write-Error ".env missing - run scripts\setup.ps1 first"
    exit 1
}

# Do not redirect stdout/stderr - that can cause node to exit on Windows
Start-Process -FilePath $Node -ArgumentList "backend\server.js" -WorkingDirectory $AppDir -WindowStyle Hidden
Write-Host "Kaspa Raffle backend started on http://localhost:3000"
Write-Host "Logs: check Task Manager for node.exe, or run: curl http://localhost:3000/health"