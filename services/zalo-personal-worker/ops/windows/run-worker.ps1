# ============================================================
# PHASE 07 (OPS-09) - Windows supervisor for the Zalo Personal worker.
#
# Runs `node dist/main.js run` (or src/main.ts with -Dev) and decides what to do
# when it exits, from the worker's exit code:
#   0  stopped on purpose (Ctrl+C, `npm run stop`)          -> exit, no restart
#   1  crash (unexpected error)                             -> restart (bounded)
#   2  configuration error                                  -> exit, fix .env first
#   3  a PERSON must act (Zalo refused / kicked the session,
#      no session, QR needed)                               -> exit, NEVER retried
#   4  refused (another instance holds the lock / STOP file) -> exit
#   5  network: reconnect attempts exhausted                -> restart after a pause (bounded)
# Restarts are limited to -MaxRestarts per rolling 24 h, with a growing pause, so
# a broken machine can never hammer Zalo. Only ONE worker per account: the worker
# itself takes an exclusive lock in its data dir (a 2nd copy exits with code 4).
# This script never turns sending on: sending follows the .env and server flags.
#
# Usage (PowerShell, in services\zalo-personal-worker):
#   powershell -ExecutionPolicy Bypass -File ops\windows\run-worker.ps1
#   powershell -ExecutionPolicy Bypass -File ops\windows\run-worker.ps1 -Dev   # src/main.ts (no build)
# ============================================================
param(
  [switch]$Dev,
  [int]$MaxRestarts = 6,
  [int]$BasePauseSeconds = 30
)

$ErrorActionPreference = 'Stop'
$workerDir = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $workerDir
$logDir = Join-Path $env:LOCALAPPDATA 'CongTrangBedding\zalo-personal\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$supervisorLog = Join-Path $logDir 'supervisor.log'

function Write-Log([string]$msg) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line
  Add-Content -Path $supervisorLog -Value $line -Encoding UTF8
}

$entry = if ($Dev) { 'src/main.ts' } else { 'dist/main.js' }
if (-not $Dev -and -not (Test-Path (Join-Path $workerDir 'dist\main.js'))) {
  Write-Log 'dist\main.js missing: run "npm run build" first (or use -Dev).'
  exit 2
}

$restarts = New-Object System.Collections.Generic.List[datetime]
while ($true) {
  Write-Log "starting worker ($entry)"
  & node --env-file-if-exists=.env $entry run
  $code = $LASTEXITCODE
  switch ($code) {
    0 { Write-Log 'worker stopped on purpose (exit 0) - supervisor ends'; exit 0 }
    2 { Write-Log 'configuration error (exit 2) - fix .env, then start again'; exit 2 }
    3 { Write-Log 'MANUAL ACTION REQUIRED (exit 3): Zalo refused / kicked the session or no session. Check the account on the phone, close Zalo Web/PC of this account, then run "npm run login". NOT restarting.'; exit 3 }
    4 { Write-Log 'refused (exit 4): another worker holds the lock or a STOP was requested ("npm run resume"). NOT restarting.'; exit 4 }
    default {
      $now = Get-Date
      $recent = @($restarts | Where-Object { $_ -gt $now.AddHours(-24) })
      $restarts = New-Object System.Collections.Generic.List[datetime]
      foreach ($r in $recent) { $restarts.Add($r) }
      if ($restarts.Count -ge $MaxRestarts) {
        Write-Log "exit $code - $MaxRestarts restarts in 24 h reached: giving up (check network / logs)."
        exit $code
      }
      $pause = [math]::Min($BasePauseSeconds * [math]::Pow(2, $restarts.Count), 1800)
      if ($code -eq 5) { $pause = [math]::Max($pause, 300) } # network: give the line time to come back
      $restarts.Add($now)
      Write-Log "exit $code - restart $($restarts.Count)/$MaxRestarts in $pause s"
      Start-Sleep -Seconds $pause
    }
  }
}
