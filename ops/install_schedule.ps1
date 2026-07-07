# Register (or replace) the daily dashboard refresh in Windows Task
# Scheduler for the current user. Opt-in by design: run this yourself;
# nothing installs it automatically.
#
#   Right-click → "Run with PowerShell", or from a PowerShell prompt:
#   powershell -ExecutionPolicy Bypass -File ops\install_schedule.ps1
#
# The task runs ops\refresh.py daily at 07:00 with StartWhenAvailable, the
# closest Windows equivalent of launchd's run-on-wake: a start missed
# while the machine slept runs as soon as it can. (UNTESTED ON WINDOWS at
# the time of writing — logic-reviewed only; see CHANGELOG 2026-07-07.)

$ErrorActionPreference = "Stop"

$TaskName = "GB power dashboard refresh"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Python = Join-Path $Root ".venv\Scripts\python.exe"

if (-not (Test-Path $Python)) {
    Write-Host ""
    Write-Host "No .venv found at $Python"
    Write-Host "Run the installer first (double-click install.bat in the"
    Write-Host "project folder), then run this again."
    exit 1
}

$Action = New-ScheduledTaskAction -Execute $Python `
    -Argument ('"{0}"' -f (Join-Path $Root "ops\refresh.py")) `
    -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -Daily -At 7:00am
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $Action `
    -Trigger $Trigger -Settings $Settings -Force | Out-Null

Write-Host "Registered '$TaskName' (daily 07:00, runs on wake if missed)."
Write-Host "Check status : Get-ScheduledTask -TaskName '$TaskName'"
Write-Host "Run now      : Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Uninstall    : Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
