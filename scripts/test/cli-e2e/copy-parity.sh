#!/usr/bin/env bash
# copy-parity.sh — behavioral parity test for `boxlite cp` across backends.
#
# Runs the same copy_in / copy_out scenarios two ways and asserts identical,
# docker-cp-correct results:
#   P1 "local"  — boxlite cp           (in-process backend)
#   P2 "serve"  — boxlite --url <serve> cp   (REST client → boxlite serve)
#
# This is the behavioral proof for the REST/CLI copy parity work (Approach A):
# both paths must match the local backend's docker-cp semantics and honor
# overwrite / include_parent / follow_symlinks.
#
# Requires a box-capable host (macOS Apple Silicon w/ libkrun, or Linux w/ KVM)
# and network access to pull the test image.
#
# Usage:
#   scripts/test/cli-e2e/copy-parity.sh [path-to-boxlite-binary]
# Default binary: ./target/debug/boxlite
set -uo pipefail

BL="${1:-./target/debug/boxlite}"
IMAGE="${BOXLITE_CP_E2E_IMAGE:-alpine:3.23}"
PORT="${BOXLITE_CP_E2E_PORT:-18177}"
# macOS unix-socket paths must stay under SUN_LEN (~104). `mktemp` lands under
# /var/folders/... which is too long once the box appends boxes/<id>/sockets/
# ready.sock. Keep the serve home SHORT (directly under $HOME).
SERVE_HOME="${BOXLITE_CP_E2E_HOME:-$HOME/.blcp-$$}"
WORK="$(mktemp -d -t bl-cp-work.XXXXXX)"
mkdir -p "$SERVE_HOME"
SERVE_PID=""
PASS=0
FAIL=0

log()  { printf '%s\n' "$*" >&2; }
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$*" >&2; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*" >&2; }

# expect_fail <label> <cmd...> — PASS iff the command exits NON-zero.
# Used for --no-overwrite scenarios: a refusal MUST surface as a non-zero exit,
# so a copy that silently no-ops (and rides on a pre-seeded destination) is
# caught here instead of false-passing the unchanged-content check.
expect_fail() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then bad "$label (expected non-zero exit, got success)"; else ok "$label"; fi
}

cleanup() {
  log "── cleanup ──"
  "$BL" rm -f cp-local 2>/dev/null
  if [ -n "$SERVE_PID" ]; then
    "$BL" --url "http://127.0.0.1:${PORT}" rm -f cp-serve 2>/dev/null
    kill "$SERVE_PID" 2>/dev/null
  fi
  rm -rf "$WORK" "$SERVE_HOME"
}
trap cleanup EXIT

# box_state <invoke...> <box-path> → prints a normalized signature:
#   "file:<sha>" | "dir" | "symlink:<target>" | "missing"
box_state() {
  local box_path="$1"; shift
  "$@" exec "$BOX" -- /bin/sh -c "
    if [ -L '$box_path' ]; then echo \"symlink:\$(readlink '$box_path')\";
    elif [ -d '$box_path' ]; then echo dir;
    elif [ -f '$box_path' ]; then echo \"file:\$(sha256sum '$box_path' | cut -d' ' -f1)\";
    else echo missing; fi" 2>/dev/null | tr -d '\r\n'
}

host_state() {
  local p="$1"
  if [ -L "$p" ]; then printf 'symlink:%s' "$(readlink "$p")";
  elif [ -d "$p" ]; then printf 'dir';
  elif [ -f "$p" ]; then printf 'file:%s' "$(shasum -a 256 "$p" | cut -d' ' -f1)";
  else printf 'missing'; fi
}

# assert_eq <label> <expected> <actual-p1> <actual-p2>
assert_eq() {
  local label="$1" exp="$2" a1="$3" a2="$4"
  if [ "$a1" = "$exp" ] && [ "$a2" = "$exp" ]; then
    ok "$label (both=$exp)"
  else
    bad "$label  expected=$exp  local=$a1  serve=$a2"
  fi
}

# ── bring up both backends ──────────────────────────────────────────
log "== building image cache / starting serve =="
"$BL" serve --port "$PORT" --home "$SERVE_HOME" --host 127.0.0.1 >/"$WORK"/serve.log 2>&1 &
SERVE_PID=$!
sleep 2

LOCAL=("$BL")
SERVE=("$BL" --url "http://127.0.0.1:${PORT}")

log "== starting boxes =="
"${LOCAL[@]}" run -d --name cp-local "$IMAGE" -- /bin/sh -c 'sleep 600' >/dev/null 2>&1 \
  || { log "FATAL: cannot start local box"; exit 2; }
"${SERVE[@]}" run -d --name cp-serve "$IMAGE" -- /bin/sh -c 'sleep 600' >/dev/null 2>&1 \
  || { log "FATAL: cannot start serve box"; exit 2; }
sleep 2

mk_file() { local f="$WORK/f_$RANDOM.txt"; printf 'hello-%s' "$RANDOM" >"$f"; printf '%s' "$f"; }

log "== copy_in scenarios =="
SF="$(mk_file)"; SHA="$(shasum -a 256 "$SF" | cut -d' ' -f1)"
# 1. file → nonexistent dst path → regular file at exact path (the #384 leak fix)
"${LOCAL[@]}" cp "$SF" "cp-local:/root/one.txt" >/dev/null 2>&1
"${SERVE[@]}" cp "$SF" "cp-serve:/root/one.txt" >/dev/null 2>&1
BOX=cp-local; A1="$(box_state /root/one.txt "${LOCAL[@]}")"
BOX=cp-serve; A2="$(box_state /root/one.txt "${SERVE[@]}")"
assert_eq "copy_in file→nonexistent is file" "file:$SHA" "$A1" "$A2"

# 2. file → existing dir → dir/<basename>
"${LOCAL[@]}" exec cp-local -- mkdir -p /root/d2 >/dev/null 2>&1
"${SERVE[@]}" exec cp-serve -- mkdir -p /root/d2 >/dev/null 2>&1
BN="$(basename "$SF")"
"${LOCAL[@]}" cp "$SF" "cp-local:/root/d2" >/dev/null 2>&1
"${SERVE[@]}" cp "$SF" "cp-serve:/root/d2" >/dev/null 2>&1
BOX=cp-local; A1="$(box_state "/root/d2/$BN" "${LOCAL[@]}")"
BOX=cp-serve; A2="$(box_state "/root/d2/$BN" "${SERVE[@]}")"
assert_eq "copy_in file→existing dir lands inside" "file:$SHA" "$A1" "$A2"

# 3. dir include_parent=true → /root/dst/<dirname>/a.txt
SD="$WORK/sd"; mkdir -p "$SD"; printf 'aaa' >"$SD/a.txt"; ASHA="$(printf 'aaa'|shasum -a 256|cut -d' ' -f1)"
"${LOCAL[@]}" exec cp-local -- mkdir -p /root/p3 >/dev/null 2>&1
"${SERVE[@]}" exec cp-serve -- mkdir -p /root/p3 >/dev/null 2>&1
# include_parent defaults to true (docker-cp), so no flag needed here.
"${LOCAL[@]}" cp "$SD" "cp-local:/root/p3" >/dev/null 2>&1
"${SERVE[@]}" cp "$SD" "cp-serve:/root/p3" >/dev/null 2>&1
BOX=cp-local; A1="$(box_state /root/p3/sd/a.txt "${LOCAL[@]}")"
BOX=cp-serve; A2="$(box_state /root/p3/sd/a.txt "${SERVE[@]}")"
assert_eq "copy_in dir include_parent=true keeps dirname" "file:$ASHA" "$A1" "$A2"

# 3b. dir include_parent=false → contents flattened into dst (no <dir> layer)
"${LOCAL[@]}" exec cp-local -- mkdir -p /root/p3f >/dev/null 2>&1
"${SERVE[@]}" exec cp-serve -- mkdir -p /root/p3f >/dev/null 2>&1
"${LOCAL[@]}" cp --no-include-parent "$SD" "cp-local:/root/p3f" >/dev/null 2>&1
"${SERVE[@]}" cp --no-include-parent "$SD" "cp-serve:/root/p3f" >/dev/null 2>&1
BOX=cp-local; A1="$(box_state /root/p3f/a.txt "${LOCAL[@]}")"
BOX=cp-serve; A2="$(box_state /root/p3f/a.txt "${SERVE[@]}")"
assert_eq "copy_in dir include_parent=false flattens" "file:$ASHA" "$A1" "$A2"

# 4. overwrite=false rejects existing file (original unchanged)
"${LOCAL[@]}" exec cp-local -- /bin/sh -c 'printf orig >/root/ov.txt' >/dev/null 2>&1
"${SERVE[@]}" exec cp-serve -- /bin/sh -c 'printf orig >/root/ov.txt' >/dev/null 2>&1
OSHA="$(printf 'orig'|shasum -a 256|cut -d' ' -f1)"
# The cp MUST fail (source SF exists — used in scenarios 1/2 — so a non-zero
# exit is the overwrite refusal, not a missing-source error).
expect_fail "copy_in --no-overwrite rejects (local)" "${LOCAL[@]}" cp --no-overwrite "$SF" "cp-local:/root/ov.txt"
expect_fail "copy_in --no-overwrite rejects (serve)" "${SERVE[@]}" cp --no-overwrite "$SF" "cp-serve:/root/ov.txt"
BOX=cp-local; A1="$(box_state /root/ov.txt "${LOCAL[@]}")"
BOX=cp-serve; A2="$(box_state /root/ov.txt "${SERVE[@]}")"
assert_eq "copy_in --no-overwrite leaves original" "file:$OSHA" "$A1" "$A2"

# follow_symlinks: a host dir with target.txt + link.txt -> target.txt.
LK="$WORK/lk"; mkdir -p "$LK"; printf data >"$LK/target.txt"; ln -s target.txt "$LK/link.txt"
DSHA="$(printf 'data'|shasum -a 256|cut -d' ' -f1)"

# 5a. default (follow_symlinks=false) → the symlink is preserved as a link.
"${LOCAL[@]}" exec cp-local -- mkdir -p /root/lkdef >/dev/null 2>&1
"${SERVE[@]}" exec cp-serve -- mkdir -p /root/lkdef >/dev/null 2>&1
"${LOCAL[@]}" cp "$LK" "cp-local:/root/lkdef" >/dev/null 2>&1
"${SERVE[@]}" cp "$LK" "cp-serve:/root/lkdef" >/dev/null 2>&1
BOX=cp-local; A1="$(box_state /root/lkdef/lk/link.txt "${LOCAL[@]}")"
BOX=cp-serve; A2="$(box_state /root/lkdef/lk/link.txt "${SERVE[@]}")"
assert_eq "copy_in default preserves symlink" "symlink:target.txt" "$A1" "$A2"

# 5b. --follow-symlinks → the link is dereferenced into a regular file.
"${LOCAL[@]}" exec cp-local -- mkdir -p /root/lkfol >/dev/null 2>&1
"${SERVE[@]}" exec cp-serve -- mkdir -p /root/lkfol >/dev/null 2>&1
"${LOCAL[@]}" cp --follow-symlinks "$LK" "cp-local:/root/lkfol" >/dev/null 2>&1
"${SERVE[@]}" cp --follow-symlinks "$LK" "cp-serve:/root/lkfol" >/dev/null 2>&1
BOX=cp-local; A1="$(box_state /root/lkfol/lk/link.txt "${LOCAL[@]}")"
BOX=cp-serve; A2="$(box_state /root/lkfol/lk/link.txt "${SERVE[@]}")"
assert_eq "copy_in --follow-symlinks dereferences link" "file:$DSHA" "$A1" "$A2"

log "== copy_out scenarios =="
# 5. box file → nonexistent host path → regular file at exact path (F-010)
"${LOCAL[@]}" exec cp-local -- /bin/sh -c 'printf boxdata >/root/out.txt' >/dev/null 2>&1
"${SERVE[@]}" exec cp-serve -- /bin/sh -c 'printf boxdata >/root/out.txt' >/dev/null 2>&1
BSHA="$(printf 'boxdata'|shasum -a 256|cut -d' ' -f1)"
H1="$WORK/out_local.txt"; H2="$WORK/out_serve.txt"
"${LOCAL[@]}" cp "cp-local:/root/out.txt" "$H1" >/dev/null 2>&1
"${SERVE[@]}" cp "cp-serve:/root/out.txt" "$H2" >/dev/null 2>&1
assert_eq "copy_out file→nonexistent host is file" "file:$BSHA" "$(host_state "$H1")" "$(host_state "$H2")"

# 6. box dir include_parent=false → host dir gets flattened contents
"${LOCAL[@]}" exec cp-local -- /bin/sh -c 'mkdir -p /root/od && printf z >/root/od/z.txt' >/dev/null 2>&1
"${SERVE[@]}" exec cp-serve -- /bin/sh -c 'mkdir -p /root/od && printf z >/root/od/z.txt' >/dev/null 2>&1
ZSHA="$(printf 'z'|shasum -a 256|cut -d' ' -f1)"
HD1="$WORK/od_local"; HD2="$WORK/od_serve"; mkdir -p "$HD1" "$HD2"
"${LOCAL[@]}" cp --no-include-parent "cp-local:/root/od" "$HD1" >/dev/null 2>&1
"${SERVE[@]}" cp --no-include-parent "cp-serve:/root/od" "$HD2" >/dev/null 2>&1
assert_eq "copy_out dir include_parent=false flattens" "file:$ZSHA" "$(host_state "$HD1/z.txt")" "$(host_state "$HD2/z.txt")"

# 7. box dir, default include_parent=true → host keeps the source dir name.
"${LOCAL[@]}" exec cp-local -- /bin/sh -c 'mkdir -p /root/op && printf y >/root/op/y.txt' >/dev/null 2>&1
"${SERVE[@]}" exec cp-serve -- /bin/sh -c 'mkdir -p /root/op && printf y >/root/op/y.txt' >/dev/null 2>&1
YSHA="$(printf 'y'|shasum -a 256|cut -d' ' -f1)"
HP1="$WORK/op_local"; HP2="$WORK/op_serve"; mkdir -p "$HP1" "$HP2"
"${LOCAL[@]}" cp "cp-local:/root/op" "$HP1" >/dev/null 2>&1
"${SERVE[@]}" cp "cp-serve:/root/op" "$HP2" >/dev/null 2>&1
assert_eq "copy_out dir include_parent=true keeps dirname" "file:$YSHA" "$(host_state "$HP1/op/y.txt")" "$(host_state "$HP2/op/y.txt")"

# 8. overwrite=false → existing host file left unchanged.
"${LOCAL[@]}" exec cp-local -- /bin/sh -c 'printf boxnew >/root/ow.txt' >/dev/null 2>&1
"${SERVE[@]}" exec cp-serve -- /bin/sh -c 'printf boxnew >/root/ow.txt' >/dev/null 2>&1
BNEWSHA="$(printf 'boxnew'|shasum -a 256|cut -d' ' -f1)"
OWSHA="$(printf 'hostold'|shasum -a 256|cut -d' ' -f1)"
OW1="$WORK/ow_local.txt"; OW2="$WORK/ow_serve.txt"
printf hostold >"$OW1"; printf hostold >"$OW2"
# Prove the box source actually exists, so a refusal below is the overwrite
# rejection — not a missing-source error riding on the pre-seeded host file.
BOX=cp-local; A1="$(box_state /root/ow.txt "${LOCAL[@]}")"
BOX=cp-serve; A2="$(box_state /root/ow.txt "${SERVE[@]}")"
assert_eq "copy_out --no-overwrite: box source present" "file:$BNEWSHA" "$A1" "$A2"
# The cp MUST fail (refuse to clobber the existing host file).
expect_fail "copy_out --no-overwrite rejects (local)" "${LOCAL[@]}" cp --no-overwrite "cp-local:/root/ow.txt" "$OW1"
expect_fail "copy_out --no-overwrite rejects (serve)" "${SERVE[@]}" cp --no-overwrite "cp-serve:/root/ow.txt" "$OW2"
assert_eq "copy_out --no-overwrite leaves host file" "file:$OWSHA" "$(host_state "$OW1")" "$(host_state "$OW2")"

# 9. follow_symlinks (box → host): default preserves the link, --follow-symlinks derefs.
"${LOCAL[@]}" exec cp-local -- /bin/sh -c 'mkdir -p /root/lkb && printf data >/root/lkb/target.txt && ln -sf target.txt /root/lkb/link.txt' >/dev/null 2>&1
"${SERVE[@]}" exec cp-serve -- /bin/sh -c 'mkdir -p /root/lkb && printf data >/root/lkb/target.txt && ln -sf target.txt /root/lkb/link.txt' >/dev/null 2>&1
LB1="$WORK/lkb_local"; LB2="$WORK/lkb_serve"; mkdir -p "$LB1" "$LB2"
"${LOCAL[@]}" cp "cp-local:/root/lkb" "$LB1" >/dev/null 2>&1
"${SERVE[@]}" cp "cp-serve:/root/lkb" "$LB2" >/dev/null 2>&1
assert_eq "copy_out default preserves symlink" "symlink:target.txt" "$(host_state "$LB1/lkb/link.txt")" "$(host_state "$LB2/lkb/link.txt")"

LBF1="$WORK/lkbf_local"; LBF2="$WORK/lkbf_serve"; mkdir -p "$LBF1" "$LBF2"
"${LOCAL[@]}" cp --follow-symlinks "cp-local:/root/lkb" "$LBF1" >/dev/null 2>&1
"${SERVE[@]}" cp --follow-symlinks "cp-serve:/root/lkb" "$LBF2" >/dev/null 2>&1
assert_eq "copy_out --follow-symlinks dereferences link" "file:$DSHA" "$(host_state "$LBF1/lkb/link.txt")" "$(host_state "$LBF2/lkb/link.txt")"

log ""
log "════════════════════════════════════════════"
log "  copy parity: PASS=$PASS  FAIL=$FAIL"
log "════════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
