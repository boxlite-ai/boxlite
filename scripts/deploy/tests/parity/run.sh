#!/usr/bin/env bash
# Parity test: the JS twins of the runner deploy scripts must issue the same
# semantic command sequence and produce the same artifacts as the bash
# authorities. Run on any host (macOS ok) — every environment-dependent command
# is PATH-shimmed by setup-fixture.sh.
#
# Usage: scripts/deploy/tests/parity/run.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FIXTURE="$WORK/fixture"

bash "$HERE/setup-fixture.sh" "$FIXTURE" >/dev/null

export FIXTURE_ROOT="$FIXTURE"
export PATH="$FIXTURE/shims:$PATH"

fail=0
note() { printf '%s\n' "$*"; }
die_soft() { printf 'FAIL: %s\n' "$*"; fail=1; }

# Normalize per-run randomness. macOS mktemp ignores an inherited TMPDIR for
# bare `mktemp -d`, and node's ESM loader realpaths /var → /private/var, so
# the two implementations legitimately print different-but-equivalent temp
# paths. Collapse them all before diffing.
normalize() { # log
  local work_norm="${WORK#/private}"
  sed -E \
    -e 's|/private/var|/var|g' \
    -e "s|$work_norm/out\.[a-z]+|OUT|g" \
    -e "s|$work_norm/u?tmp\.[a-z]+|ASSIGNEDTMP|g" \
    -e 's|(ASSIGNEDTMP\|/var/folders/[A-Za-z0-9/._+-]+/T\|/tmp)/tmp\.[A-Za-z0-9._-]+|TMP|g' \
    "$1"
}

run_build() { # impl(sh|mjs) tag
  local impl="$1" tag="$2"
  local tmp="$WORK/tmp.$tag" out="$WORK/out.$tag" log="$WORK/calls.$tag.log"
  mkdir -p "$tmp" "$out"
  : > "$log"
  # Reset fixture state the previous run may have consumed/produced.
  rm -rf "$FIXTURE/target" "$FIXTURE/sdks/go/libboxlite.a" "$FIXTURE/apps/go.work" "$FIXTURE/apps/go.work.sum" "$FIXTURE/sdks/c/dist"
  ( cd "$FIXTURE" \
    && CALL_LOG="$log" TMPDIR="$tmp" \
       "scripts/deploy/build-runner-binary.$impl" --output-dir "$out" --build-number 123 --skip-setup \
       > "$WORK/stdout.$tag.log" 2>&1 ) || { die_soft "build-runner-binary.$impl exited non-zero"; cat "$WORK/stdout.$tag.log"; return 1; }
  normalize "$log" > "$log.norm"
}

run_update() { # impl tag artifact_dir
  local impl="$1" tag="$2" artifacts="$3"
  local tmp="$WORK/utmp.$tag" log="$WORK/ucalls.$tag.log"
  mkdir -p "$tmp"
  : > "$log"
  ( cd "$FIXTURE" \
    && CALL_LOG="$log" TMPDIR="$tmp" \
       STAGE=dev AWS_REGION=ap-southeast-1 \
       RUNNER_INSTANCE_ID=i-0fixture000000000 \
       RUNNER_ARTIFACT_DIR="$artifacts" \
       RUNNER_ARTIFACT_S3_URI="s3://fixture-bucket/tmp/runner-rollouts/fixed" \
       "scripts/deploy/runner-update-binary.$impl" "$VERSION_UNDER_TEST" \
       > "$WORK/ustdout.$tag.log" 2>&1 ) || { die_soft "runner-update-binary.$impl exited non-zero"; cat "$WORK/ustdout.$tag.log"; return 1; }
  normalize "$log" > "$log.norm"
}

# ── build parity ────────────────────────────────────────────────────────────
note "==> build: bash authority"
run_build sh bash

if [ ! -f "$FIXTURE/scripts/deploy/build-runner-binary.mjs" ]; then
  die_soft "build-runner-binary.mjs missing — JS twin not implemented yet"
else
  note "==> build: js twin"
  run_build mjs js

  if ! diff -u "$WORK/calls.bash.log.norm" "$WORK/calls.js.log.norm"; then
    die_soft "build call sequence differs (bash vs js)"
  fi

  bash_tarball=$(ls "$WORK/out.bash"/boxlite-runner-v*-linux-amd64.tar.gz 2>/dev/null || true)
  js_tarball=$(ls "$WORK/out.js"/boxlite-runner-v*-linux-amd64.tar.gz 2>/dev/null || true)
  if [ -z "$bash_tarball" ] || [ -z "$js_tarball" ]; then
    die_soft "missing output tarball (bash='$bash_tarball' js='$js_tarball')"
  else
    [ "$(basename "$bash_tarball")" = "$(basename "$js_tarball")" ] \
      || die_soft "tarball names differ: $(basename "$bash_tarball") vs $(basename "$js_tarball")"
    if ! diff <(/usr/bin/tar -tzf "$bash_tarball" | sort) <(/usr/bin/tar -tzf "$js_tarball" | sort); then
      die_soft "tarball member lists differ"
    fi
    for member in boxlite-runner.guest.sha256 boxlite-runner.runtime-suffix; do
      b=$(/usr/bin/tar -xzOf "$bash_tarball" "$member" 2>/dev/null || /usr/bin/tar -xzOf "$bash_tarball" "./$member")
      j=$(/usr/bin/tar -xzOf "$js_tarball" "$member" 2>/dev/null || /usr/bin/tar -xzOf "$js_tarball" "./$member")
      [ "$b" = "$j" ] || die_soft "sidecar $member differs: '$b' vs '$j'"
    done
  fi
fi

# ── update parity ───────────────────────────────────────────────────────────
if [ -n "${bash_tarball:-}" ]; then
  VERSION_UNDER_TEST=$(basename "$bash_tarball")
  VERSION_UNDER_TEST="${VERSION_UNDER_TEST#boxlite-runner-v}"
  VERSION_UNDER_TEST="${VERSION_UNDER_TEST%-linux-amd64.tar.gz}"

  note "==> update: bash authority (v$VERSION_UNDER_TEST)"
  run_update sh bash "$WORK/out.bash"

  if [ ! -f "$FIXTURE/scripts/deploy/runner-update-binary.mjs" ]; then
    die_soft "runner-update-binary.mjs missing — JS twin not implemented yet"
  else
    note "==> update: js twin"
    run_update mjs js "$WORK/out.bash"   # same artifact dir: compare orchestration, not build noise

    if ! diff -u "$WORK/ucalls.bash.log.norm" "$WORK/ucalls.js.log.norm"; then
      die_soft "update call sequence differs (bash vs js)"
    fi

    # The SSM payload is the highest-risk surface: extract the base64 arg from
    # the recorded send-command call and byte-compare the decoded scripts.
    extract_payload() {
      grep '^aws ssm send-command' "$1" | sed -E 's/.*commands=\["echo ([A-Za-z0-9+/=]+) \| base64 -d \| bash"\].*/\1/'
    }
    pb=$(extract_payload "$WORK/ucalls.bash.log")
    pj=$(extract_payload "$WORK/ucalls.js.log")
    if [ -z "$pb" ] || [ -z "$pj" ]; then
      die_soft "could not extract SSM payload (bash=${#pb}b js=${#pj}b)"
    elif [ "$pb" != "$pj" ]; then
      printf '%s' "$pb" | base64 -d > "$WORK/payload.bash.sh" || true
      printf '%s' "$pj" | base64 -d > "$WORK/payload.js.sh" || true
      diff -u "$WORK/payload.bash.sh" "$WORK/payload.js.sh" | head -80 || true
      die_soft "SSM remote payload differs between implementations"
    else
      note "    SSM payload byte-identical ($(printf '%s' "$pb" | wc -c | tr -d ' ') b64 chars)"
    fi
  fi
fi

if [ "$fail" -ne 0 ]; then
  note "PARITY: FAIL"
  exit 1
fi
note "PARITY: PASS"
