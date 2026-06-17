#!/usr/bin/env bash
set -Eeuo pipefail

AUTH="${1:-${AUTH:-oidc}}"
SCOPE="${2:-${SCOPE:-smoke}}"

case "$AUTH" in
  api-key | oidc) ;;
  *)
    echo "AUTH must be api-key or oidc, got: $AUTH" >&2
    exit 2
    ;;
esac

case "$SCOPE" in
  smoke | full) ;;
  *)
    echo "SCOPE must be smoke or full, got: $SCOPE" >&2
    exit 2
    ;;
esac

ROOT="$(git rev-parse --show-toplevel)"
REPORT_DIR="$ROOT/target/rest-test-report"
mkdir -p "$REPORT_DIR"

LOG_FILE="$REPORT_DIR/cli-matrix-$AUTH-$SCOPE.log"
SKIP_FILE="$REPORT_DIR/cli-matrix-$AUTH-$SCOPE.skips"
SUMMARY_FILE="$REPORT_DIR/cli-matrix-$AUTH-$SCOPE.md"
: >"$SKIP_FILE"

exec > >(tee "$LOG_FILE") 2>&1

CLI_BIN="${BOXLITE_CLI:-boxlite}"
SMOKE_IMAGE="${BOXLITE_REST_SMOKE_IMAGE:-alpine:3.23}"
RUN_ID="$(date -u +%Y%m%d%H%M%S)-$$"
BOX_NAME="rest-cli-$AUTH-$RUN_ID"
RUN_BOX_NAME="rest-cli-run-$AUTH-$RUN_ID"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/boxlite-rest-cli.XXXXXX")"
CREATED_BOX=0
CREATED_RUN_BOX=0

BASE_CMD=("$CLI_BIN")
if [ -n "${BOXLITE_HOME:-}" ]; then
  BASE_CMD+=(--home "$BOXLITE_HOME")
fi
if [ -n "${BOXLITE_PROFILE:-}" ]; then
  BASE_CMD+=(--profile "$BOXLITE_PROFILE")
fi
if [ -n "${BOXLITE_REST_URL:-}" ]; then
  BASE_CMD+=(--url "$BOXLITE_REST_URL")
fi

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "Missing required env: $name" >&2
    exit 2
  fi
}

validate_auth_env() {
  case "$AUTH" in
    api-key)
      require_env BOXLITE_REST_URL
      require_env BOXLITE_API_KEY
      ;;
    oidc)
      if [ -n "${BOXLITE_API_KEY:-}" ]; then
        echo "BOXLITE_API_KEY must be unset for AUTH=oidc; API key env takes precedence." >&2
        exit 2
      fi
      echo "AUTH=oidc requires an existing logged-in OIDC profile; auth whoami must prove it."
      ;;
  esac
}

quote_cmd() {
  printf '%q ' "$@"
}

run_cmd() {
  local label="$1"
  shift
  echo
  echo "### $label"
  echo "+ $(quote_cmd "$@")"
  "$@"
}

run_capture() {
  local label="$1"
  local out_file="$2"
  shift 2
  echo
  echo "### $label"
  echo "+ $(quote_cmd "$@")"
  "$@" 2>&1 | tee "$out_file"
  return "${PIPESTATUS[0]}"
}

skip_cmd() {
  local command="$1"
  local reason="$2"
  echo "SKIP $command: $reason" | tee -a "$SKIP_FILE"
}

cleanup() {
  local rc=$?
  set +e
  echo
  echo "### Cleanup"
  if [ "$CREATED_RUN_BOX" -eq 1 ]; then
    echo "+ cleanup run box $RUN_BOX_NAME"
    "${BASE_CMD[@]}" rm -f "$RUN_BOX_NAME" >/dev/null 2>&1 || true
  fi
  if [ "$CREATED_BOX" -eq 1 ]; then
    echo "+ cleanup box $BOX_NAME"
    "${BASE_CMD[@]}" rm -f "$BOX_NAME" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
  write_summary "$rc"
  exit "$rc"
}

write_summary() {
  local rc="$1"
  {
    echo "# REST CLI Matrix Result"
    echo
    echo "- auth: \`$AUTH\`"
    echo "- scope: \`$SCOPE\`"
    echo "- status: \`$([ "$rc" -eq 0 ] && echo pass || echo fail)\`"
    echo "- log: \`$LOG_FILE\`"
    echo "- skips: \`$SKIP_FILE\`"
    echo
    echo "## Covered"
    echo
    echo "- auth status/whoami"
    echo "- list/ls"
    echo "- create/start/exec/stop/rm"
    if [ "$SCOPE" = "full" ]; then
      echo "- list aliases: list/ls/ps"
      echo "- inspect"
      echo "- restart"
      echo "- cp upload/download"
      echo "- stats"
      echo "- run --rm"
    fi
    if [ -s "$SKIP_FILE" ]; then
      echo
      echo "## Skips"
      echo
      sed 's/^/- /' "$SKIP_FILE"
    fi
  } >"$SUMMARY_FILE"
  echo
  echo "Summary: $SUMMARY_FILE"
}

assert_contains() {
  local file="$1"
  local pattern="$2"
  if ! grep -q "$pattern" "$file"; then
    echo "Expected output to contain: $pattern" >&2
    echo "Output file: $file" >&2
    exit 1
  fi
}

trap cleanup EXIT

validate_auth_env
command -v "$CLI_BIN" >/dev/null 2>&1 || {
  echo "CLI binary not found: $CLI_BIN" >&2
  exit 2
}

echo "REST CLI matrix"
echo "auth=$AUTH"
echo "scope=$SCOPE"
echo "cli=$CLI_BIN"
echo "box=$BOX_NAME"
echo "image=$SMOKE_IMAGE"
echo "log=$LOG_FILE"

run_cmd "auth status" "${BASE_CMD[@]}" auth status
WHOAMI_OUT="$TMP_DIR/whoami.out"
run_capture "auth whoami" "$WHOAMI_OUT" "${BASE_CMD[@]}" auth whoami
assert_contains "$WHOAMI_OUT" "Logged in as:"
assert_contains "$WHOAMI_OUT" "Server:"

run_cmd "list boxes" "${BASE_CMD[@]}" ls --format json
if [ "$SCOPE" = "full" ]; then
  run_cmd "list alias" "${BASE_CMD[@]}" list --format json
  run_cmd "ps alias" "${BASE_CMD[@]}" ps --format json
fi

run_cmd "create box" "${BASE_CMD[@]}" create --name "$BOX_NAME" "$SMOKE_IMAGE"
CREATED_BOX=1
run_cmd "start box" "${BASE_CMD[@]}" start "$BOX_NAME"

EXEC_OUT="$TMP_DIR/exec.out"
run_capture "exec stdout over REST attach" "$EXEC_OUT" "${BASE_CMD[@]}" exec "$BOX_NAME" -- sh -lc "echo hi-from-cli-$AUTH"
assert_contains "$EXEC_OUT" "hi-from-cli-$AUTH"

if [ "$SCOPE" = "full" ]; then
  run_cmd "inspect box" "${BASE_CMD[@]}" inspect "$BOX_NAME" --format json
  run_cmd "stats box" "${BASE_CMD[@]}" stats "$BOX_NAME" --format json

  UPLOAD="$TMP_DIR/upload.txt"
  DOWNLOAD="$TMP_DIR/download.txt"
  printf 'hello-from-cp-%s\n' "$AUTH" >"$UPLOAD"
  run_cmd "cp host to box" "${BASE_CMD[@]}" cp "$UPLOAD" "$BOX_NAME:/tmp/boxlite-rest-cli-upload.txt"
  run_cmd "cp box to host" "${BASE_CMD[@]}" cp "$BOX_NAME:/tmp/boxlite-rest-cli-upload.txt" "$DOWNLOAD"
  assert_contains "$DOWNLOAD" "hello-from-cp-$AUTH"

  run_cmd "restart box" "${BASE_CMD[@]}" restart "$BOX_NAME"
  RESTART_OUT="$TMP_DIR/restart-exec.out"
  run_capture "exec after restart" "$RESTART_OUT" "${BASE_CMD[@]}" exec "$BOX_NAME" -- sh -lc "echo hi-after-restart-$AUTH"
  assert_contains "$RESTART_OUT" "hi-after-restart-$AUTH"

  RUN_OUT="$TMP_DIR/run.out"
  run_capture "run one-shot box" "$RUN_OUT" "${BASE_CMD[@]}" run --rm --name "$RUN_BOX_NAME" "$SMOKE_IMAGE" sh -lc "echo hi-from-run-$AUTH"
  assert_contains "$RUN_OUT" "hi-from-run-$AUTH"
  CREATED_RUN_BOX=1
fi

run_cmd "stop box" "${BASE_CMD[@]}" stop "$BOX_NAME"
run_cmd "remove box" "${BASE_CMD[@]}" rm -f "$BOX_NAME"
CREATED_BOX=0

skip_cmd "info" "CLI info currently reports local runtime/options, not REST API behavior."
skip_cmd "logs" "CLI logs currently reads local runtime console logs, not REST-backed box stdout."
skip_cmd "pull" "REST runtime currently does not support image operations."
skip_cmd "images" "REST runtime currently does not support image operations."
skip_cmd "remove" "No boxlite remove command exists; rm is the supported command."

echo
echo "REST CLI matrix passed."
