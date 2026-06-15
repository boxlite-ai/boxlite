#!/usr/bin/env bash
# Common helpers for stack-*.sh scripts.
# Defines paths, port numbers, color helpers. Sourced by other scripts; not
# meant to be invoked directly.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
INFRA_LOCAL_DIR="$( cd "${SCRIPT_DIR}/.." && pwd )"
APPS_DIR="$( cd "${INFRA_LOCAL_DIR}/.." && pwd )"
REPO_ROOT="$( cd "${APPS_DIR}/.." && pwd )"

# Repo-scoped state root — ALL generated local-stack artifacts live here
# (gitignored):
#   bin/             native runner + proxy binaries
#   logs/            L2 process logs + pid files
#   data/            L1 service volumes (pg / redis / minio / registry)
#   boxlite/         SDK home for the L1 boxes (BOXLITE_HOME)
#   boxlite-runner/  runner home for L3 user boxes (BOXLITE_HOME_DIR)
APPS_LOCAL_DIR="${REPO_ROOT}/.apps-local"

# Exported so the `boxlite` CLI (these scripts grep `boxlite ls` to inspect
# L1 boxes) and the python orchestrator resolve the SAME home. The runner is
# unaffected: stack-up.sh hands it its own sibling home via BOXLITE_HOME_DIR.
export BOXLITE_HOME="${BOXLITE_HOME:-${APPS_LOCAL_DIR}/boxlite}"

LOGS_DIR="${APPS_LOCAL_DIR}/logs"
mkdir -p "${LOGS_DIR}" "${APPS_LOCAL_DIR}/bin"

# Native binary locations (built by stack-build.sh; large and
# platform-specific, kept out of git via the .apps-local ignore).
RUNNER_BIN="${RUNNER_BIN:-${APPS_LOCAL_DIR}/bin/boxlite-runner}"
PROXY_BIN="${PROXY_BIN:-${APPS_LOCAL_DIR}/bin/boxlite-proxy}"

# Ports
PORT_API=3001
PORT_RUNNER=3003
PORT_PROXY=4000
PORT_DASHBOARD=3000

# Components (order matters for up: API first so runner can register)
ALL_COMPONENTS=(api runner proxy dashboard)

# Colors (TTY only)
if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_DIM=""; C_BOLD=""; C_RESET=""
fi

log()  { printf "%s[stack]%s %s\n" "${C_BLUE}" "${C_RESET}" "$*"; }
ok()   { printf "%s✓%s %s\n" "${C_GREEN}" "${C_RESET}" "$*"; }
warn() { printf "%s⚠%s %s\n" "${C_YELLOW}" "${C_RESET}" "$*"; }
err()  { printf "%s✗%s %s\n" "${C_RED}" "${C_RESET}" "$*" >&2; }
die()  { err "$*"; exit 1; }

pid_file()  { echo "${LOGS_DIR}/$1.pid"; }
log_file()  { echo "${LOGS_DIR}/$1.log"; }

# Is a recorded PID still alive?
#
# Note: for `nx serve` components (api/dashboard), the .pid file actually
# stores the wrapper bash subshell's PID — the real node process is a
# grandchild. The pid here is a "supervisor PID" representing whether the
# component is meant to be up. Combine with port_listening() to decide
# whether it's actually healthy. stop_component() kills the supervisor
# and falls back to pkill-by-name to clean up grandchildren.
component_pid() {
  local comp="$1"
  local pf
  pf="$(pid_file "$comp")"
  [ -f "$pf" ] || { echo ""; return; }
  local pid
  pid="$(cat "$pf" 2>/dev/null || true)"
  [ -z "$pid" ] && { echo ""; return; }
  if kill -0 "$pid" 2>/dev/null; then
    echo "$pid"
  else
    rm -f "$pf"
    echo ""
  fi
}

# Is a TCP port listening locally?
port_listening() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN
}

# Wait until a TCP port starts listening (default 60s).
wait_port() {
  local port="$1"
  local timeout="${2:-60}"
  local elapsed=0
  while ! port_listening "$port"; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$timeout" ]; then
      return 1
    fi
  done
}

# Wait for an HTTP endpoint to return 2xx/3xx (default 90s).
wait_http() {
  local url="$1"
  local timeout="${2:-90}"
  local elapsed=0
  while ! curl -sS -o /dev/null --max-time 2 -w "%{http_code}" "$url" 2>/dev/null \
        | grep -qE '^(2|3)[0-9][0-9]$'; do
    sleep 2
    elapsed=$((elapsed + 2))
    if [ "$elapsed" -ge "$timeout" ]; then
      return 1
    fi
  done
}

# Resolve the runner home directory (where its SQLite + boxes live).
# Defaults into the repo-scoped state root; BOXLITE_HOME_DIR still wins
# so a user-pinned runner home stays respected (stack-up.sh forwards
# this exact value to the runner process).
RUNNER_HOME="${BOXLITE_HOME_DIR:-${APPS_LOCAL_DIR}/boxlite-runner}"

# Library path the runner needs at startup (libboxlite.dylib for CGO).
RUNNER_DYLIB_DIR="${REPO_ROOT}/sdks/go"
