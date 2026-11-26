# ============================================================
# PHASE 07 (OPS-09) - start the Zalo Personal worker at Windows logon (Task Scheduler).
#
# * Runs as the CURRENT user (the DPAPI-protected session only opens for that
#   Windows user), at logon, through ops\windows\run-worker.ps1 (bounded restarts,
#   never after Zalo refused the session).
# * MultipleInstances = IgnoreNew: Task Scheduler never starts a second copy; the
#   worker's own lock file is a second guard.
# * No Task Scheduler restart-on-failure: the supervisor script decides.
# * Starting the task does not enable sending: that stays in .env + server flags.
#
# Usage (normal PowerShell, in services\zalo-personal-worker):
#   powershell -ExecutionPolicy Bypass -File ops\windows\register-task.ps1            # register
#   powershell -ExecutionPolicy Bypass -File ops\windows\register-task.ps1 -Remove    # unregister
# ============================================================
param([switch]$Remove, [string]$TaskName = 'CongTrangBedding Zalo Worker')

$ErrorActionPreference = 'Stop'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed task '$TaskName'."
  exit 0
}

$workerDir = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$script = Join-Path $workerDir 'ops\windows\run-worker.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$script`"" -WorkingDirectory $workerDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# a short delay after logon: network + DNS first
$trigger.Delay = 'PT1M'
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Zalo Personal worker (CONGTRANGBEDDING). Supervisor: ops\windows\run-worker.ps1' -Force | Out-Null
Write-Host "Registered task '$TaskName' (at logon, single instance). Start now: Start-ScheduledTask -TaskName '$TaskName'"
