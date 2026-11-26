#!/bin/sh
# PHASE 07 (OPS-10) — container entrypoint: same exit-code policy as the Windows
# supervisor (ops/windows/run-worker.ps1):
#   0          stopped on purpose            -> container exits (restart policy on-failure: no restart)
#   2, 3, 4    a PERSON must act (config / Zalo refused or kicked the session / lock, STOP)
#              -> the container stays up but idle and UNHEALTHY; it never retries Zalo
#   5          network: reconnects exhausted -> wait 5 minutes, then exit 1 (bounded restart)
#   1 / other  crash                         -> exit (bounded restart by Docker)
# SIGTERM / SIGINT are forwarded so the worker finishes the in-flight send and its report.
node dist/main.js "$@" &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null' TERM INT
wait "$pid"
code=$?
# a trapped signal interrupts the first wait: wait for the worker's own exit
if [ "$code" -gt 128 ]; then wait "$pid"; code=$?; fi
case "$code" in
  0) exit 0 ;;
  2|3|4)
    echo "zalo-worker: manual action required (exit $code) - see the log above and docs/zalo-ai/phase-07-operations.md. Not restarting."
    trap 'exit 0' TERM INT
    while :; do sleep 3600 & wait $!; done ;;
  5)
    echo "zalo-worker: network unavailable (exit 5) - retry in 5 minutes"
    sleep 300
    exit 1 ;;
  *) exit "$code" ;;
esac
