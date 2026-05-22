#!/usr/bin/env bash
# Stop native L2 processes (api / runner / proxy / dashboard).
# Does NOT stop L1 boxes — use `make down` for those.
#
# Usage: stack-down.sh [component...]   (default: all L2)
#        stack-down.sh --all            (also stop L1 boxes)

set -euo pipefail
. "$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )/_stack-common.sh"

INCLUDE_L1=false
if [ "${1:-}" = "--all" ]; then
  INCLUDE_L1=true
  shift
fi

COMPONENTS=("${@:-}")
if [ ${#COMPONENTS[@]} -eq 0 ] || [ -z "${COMPONENTS[0]}" ]; then
  # Reverse-order: dashboard first so it doesn't keep retrying API while shutting down
  COMPONENTS=(dashboard proxy runner api)
fi

stop_component() {
  local comp="$1"
  local pid
  pid="$(component_pid "$comp" || true)"
  if [ -z "$pid" ]; then
    ok "$comp not running"
    return
  fi
  log "stopping $comp (PID $pid)..."
  # SIGTERM first, then SIGKILL after 5s.
  # Use pgid kill to clean up child workers (e.g. nx → node).
  local pgid
  pgid="$(ps -o pgid= -p "$pid" | tr -d ' ')"
  if [ -n "$pgid" ]; then
    kill -TERM -"$pgid" 2>/dev/null || true
  else
    kill -TERM "$pid" 2>/dev/null || true
  fi
  local elapsed=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge 5 ]; then
      log "$comp not responding to SIGTERM, sending SIGKILL"
      [ -n "$pgid" ] && kill -KILL -"$pgid" 2>/dev/null || true
      kill -KILL "$pid" 2>/dev/null || true
      break
    fi
  done
  rm -f "$(pid_file "$comp")"
  ok "$comp stopped"
}

for comp in "${COMPONENTS[@]}"; do
  case "$comp" in
    api|runner|proxy|dashboard) stop_component "$comp" ;;
    *) die "unknown component: $comp (valid: api runner proxy dashboard)" ;;
  esac
done

# Belt-and-suspenders: some processes start before pid files exist or get
# orphaned. Sweep by name — but ONLY for components we were asked to stop,
# so partial stops (e.g. `stack-down runner`) don't kill the others.
log "sweeping orphans..."
for comp in "${COMPONENTS[@]}"; do
  case "$comp" in
    runner)    pkill -TERM -f "boxlite-runner$"      2>/dev/null || true ;;
    proxy)     pkill -TERM -f "boxlite-proxy$"       2>/dev/null || true ;;
    api)       pkill -TERM -f "nx.*serve.*api"       2>/dev/null || true ;;
    dashboard) pkill -TERM -f "nx.*serve.*dashboard" 2>/dev/null || true ;;
  esac
done

if [ "$INCLUDE_L1" = "true" ]; then
  log "stopping L1 boxes..."
  ( cd "${INFRA_LOCAL_DIR}" && make down )
fi

ok "stack down"
