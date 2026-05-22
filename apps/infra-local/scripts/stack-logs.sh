#!/usr/bin/env bash
# Tail a component's log. Without args, lists which logs exist.
#
# Usage: stack-logs.sh                # list available logs
#        stack-logs.sh api            # tail -f api.log
#        stack-logs.sh api -n 200     # last 200 lines, no follow
#        stack-logs.sh all            # multiplex all (prefixed)

set -euo pipefail
. "$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )/_stack-common.sh"

if [ $# -eq 0 ]; then
  echo "Available logs in ${LOGS_DIR}:"
  ls -1t "${LOGS_DIR}"/*.log 2>/dev/null | sed 's|.*/||; s|^|  |' || echo "  (none yet)"
  echo
  echo "Usage:  stack-logs.sh <component> [tail args]"
  exit 0
fi

if [ "$1" = "all" ]; then
  # `tail -f` multiple files at once; each line gets ==> filename <== headers.
  exec tail -F "${LOGS_DIR}"/*.log
fi

COMP="$1"; shift
LOG="$(log_file "$COMP")"
[ -f "$LOG" ] || die "no log file at $LOG (component never started?)"

if [ $# -eq 0 ]; then
  exec tail -F "$LOG"
else
  exec tail "$@" "$LOG"
fi
