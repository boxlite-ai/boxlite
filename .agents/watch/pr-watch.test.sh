#!/usr/bin/env bash
# Tests for .agents/watch/pr-watch.sh and the arm point in .githooks/pre-push.
#
# Runs against a scratch repo with a stubbed `gh` on PATH — no network, and no
# chained framework hook to trigger.
#
# Covers:
#   1. Event emission: one per concluded check, every terminal bucket, dedup.
#   2. The empty-field regression: a check with no `workflow` must not shift
#      `link` into the workflow column.
#   3. Single-instance lock.
#   4. pre-push arming: branch refs armed, deletions/tags skipped, opt-out.
#
# Run with:  bash .agents/watch/pr-watch.test.sh
# Exits non-zero on any failure.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WATCHER="$REPO_ROOT/.agents/watch/pr-watch.sh"
PREPUSH="$REPO_ROOT/.githooks/pre-push"
TMP="$(mktemp -d)"
trap 'pkill -f "pr-watch.sh --branch" 2>/dev/null; rm -rf "$TMP"' EXIT

pass=0
fail=0

ok() { pass=$((pass + 1)); printf '  PASS  %s\n' "$1"; }
no() { fail=$((fail + 1)); printf '  FAIL  %s\n     %s\n' "$1" "${2:-}"; }

check() {
  local desc="$1" actual="$2" expect="$3"
  if [[ "$actual" == "$expect" ]]; then ok "$desc"; else no "$desc" "got=[$actual] want=[$expect]"; fi
}

# ── scratch repo + gh stub ───────────────────────────────────────────────────

REPO="$TMP/repo"
mkdir -p "$REPO"
git init -q "$REPO"
# A local bare remote, not a github URL: the watcher's first act is an ls-remote
# wait, and this keeps that offline and instant instead of dialing out.
git init -q --bare "$TMP/origin.git"
git -C "$REPO" remote add origin "$TMP/origin.git"
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

# pre-push resolves the watcher against ITS repo root, so the scratch repo needs
# its own copy — the hook under test must find it where a real checkout would.
mkdir -p "$REPO/.agents/watch"
cp "$WATCHER" "$REPO/.agents/watch/pr-watch.sh"
SCRATCH_WATCHER="$REPO/.agents/watch/pr-watch.sh"

STUB="$TMP/bin"
mkdir -p "$STUB"

# Fixture knobs the stub reads at call time, so a test can change CI state
# without rewriting the stub.
export FIXTURE_DIR="$TMP/fixtures"
mkdir -p "$FIXTURE_DIR"

cat > "$STUB/gh" <<'STUB_EOF'
#!/usr/bin/env bash
case "$1 $2" in
  "pr checks")  cat "$FIXTURE_DIR/checks.json" ;;
  "pr view")    cat "$FIXTURE_DIR/view.json" ;;
  "pr list")    cat "$FIXTURE_DIR/prnumber.txt" 2>/dev/null || true ;;
  "api "*|"api")
                cat "$FIXTURE_DIR/inline.json" ;;
  *) exit 1 ;;
esac
STUB_EOF
chmod +x "$STUB/gh"
export PATH="$STUB:$PATH"

write_fixtures() {
  cat > "$FIXTURE_DIR/checks.json" <<'EOF'
[
  {"name":"CodeQL","state":"SUCCESS","bucket":"pass","workflow":"","link":"https://gh/runs/1"},
  {"name":"Lint (conclusion)","state":"SUCCESS","bucket":"pass","workflow":"Lint and Format","link":"https://gh/runs/2"},
  {"name":"Test (conclusion)","state":"FAILURE","bucket":"fail","workflow":"Test","link":"https://gh/runs/3"},
  {"name":"Rust Tests","state":"SKIPPED","bucket":"skipping","workflow":"Test","link":"https://gh/runs/4"},
  {"name":"E2E local","state":"IN_PROGRESS","bucket":"pending","workflow":"E2E local","link":"https://gh/runs/5"}
]
EOF
  cat > "$FIXTURE_DIR/view.json" <<'EOF'
{"state":"OPEN",
 "comments":[{"id":"C1","author":{"login":"boxlite-agent"},"body":"line one\nline two","url":"https://gh/c/1"}],
 "reviews":[{"id":"R1","author":{"login":"coderabbitai"},"state":"COMMENTED","body":"nit"}]}
EOF
  cat > "$FIXTURE_DIR/inline.json" <<'EOF'
[{"id":"I1","user":{"login":"coderabbitai"},"path":"src/main.rs","body":"inline note","html_url":"https://gh/i/1"}]
EOF
  printf '42\n' > "$FIXTURE_DIR/prnumber.txt"
}
write_fixtures

run_watch() { (cd "$REPO" && bash "$WATCHER" "$@" 2>&1); }
events_of() { grep "\"kind\":\"$1\"" <<<"$2" 2>/dev/null; }
reset_state() { rm -rf "$REPO/.git/pr-watch"; }

# ── 1. event emission ────────────────────────────────────────────────────────

echo "## Event emission"
reset_state
OUT="$(run_watch --pr 42 --once)"

check "every line is valid JSON" \
  "$(jq -e . <<<"$OUT" >/dev/null 2>&1 && echo yes || echo no)" "yes"

check "emits 4 concluded checks, not the pending one" \
  "$(events_of check "$OUT" | wc -l | tr -d ' ')" "4"

check "emits the FAILING check (silence != success)" \
  "$(events_of check "$OUT" | jq -r 'select(.bucket=="fail") | .name')" "Test (conclusion)"

check "emits the skipped check too" \
  "$(events_of check "$OUT" | jq -r 'select(.bucket=="skipping") | .name')" "Rust Tests"

check "no checks_done while one check is still pending" \
  "$(events_of checks_done "$OUT" | wc -l | tr -d ' ')" "0"

check "emits the issue comment" \
  "$(events_of comment "$OUT" | jq -r '.author')" "boxlite-agent"

check "emits the review" \
  "$(events_of review "$OUT" | jq -r '.author + ":" + .state')" "coderabbitai:COMMENTED"

check "emits the inline review comment with its path" \
  "$(events_of review_comment "$OUT" | jq -r '.path')" "src/main.rs"

# ── 2. the empty-field regression ────────────────────────────────────────────
#
# `IFS=$'\t' read` collapses runs of tabs, so a check with an empty `workflow`
# used to shift `link` one column left — CodeQL reported its URL as its workflow
# name and an empty url. Guard both columns.

echo
echo "## Regression: empty field must not shift columns"
CODEQL="$(events_of check "$OUT" | jq -c 'select(.name=="CodeQL")')"
check "empty workflow stays empty" \
  "$(jq -r '.workflow' <<<"$CODEQL")" ""
check "link lands in url, not workflow" \
  "$(jq -r '.url' <<<"$CODEQL")" "https://gh/runs/1"
check "populated workflow still lands correctly" \
  "$(events_of check "$OUT" | jq -r 'select(.name=="Lint (conclusion)") | .workflow')" "Lint and Format"

# ── 3. body handling ─────────────────────────────────────────────────────────

echo
echo "## Body handling"
check "multi-line comment body survives as one JSON line with real newlines" \
  "$(events_of comment "$OUT" | jq -r '.body' | wc -l | tr -d ' ')" "2"

# ── 4. dedup + lock ──────────────────────────────────────────────────────────

echo
echo "## Dedup and locking"
OUT2="$(run_watch --pr 42 --once)"
check "second pass re-emits nothing" \
  "$(events_of check "$OUT2" | wc -l | tr -d ' ')" "0"

# A new check appearing is still emitted after the dedup pass.
jq '. + [{"name":"New Job","state":"SUCCESS","bucket":"pass","workflow":"Test","link":"https://gh/runs/9"}]' \
  "$FIXTURE_DIR/checks.json" > "$FIXTURE_DIR/checks.tmp" && mv "$FIXTURE_DIR/checks.tmp" "$FIXTURE_DIR/checks.json"
OUT3="$(run_watch --pr 42 --once)"
check "a newly-concluded check IS emitted after dedup" \
  "$(events_of check "$OUT3" | jq -r '.name')" "New Job"

mkdir -p "$REPO/.git/pr-watch/pr-42.lock"
OUT4="$(run_watch --pr 42 --once)"
check "held lock makes a second instance exit silently" \
  "$(printf '%s' "$OUT4" | wc -c | tr -d ' ')" "0"
rmdir "$REPO/.git/pr-watch/pr-42.lock"

# ── 5. terminal states ───────────────────────────────────────────────────────

echo
echo "## Terminal states"
reset_state
jq '[.[] | select(.bucket != "pending")]' "$FIXTURE_DIR/checks.json" > "$FIXTURE_DIR/checks.tmp" \
  && mv "$FIXTURE_DIR/checks.tmp" "$FIXTURE_DIR/checks.json"
OUT5="$(run_watch --pr 42 --once)"
check "checks_done fires once all checks conclude" \
  "$(events_of checks_done "$OUT5" | jq -r '.failed')" "1"

reset_state
jq '.state = "MERGED"' "$FIXTURE_DIR/view.json" > "$FIXTURE_DIR/view.tmp" && mv "$FIXTURE_DIR/view.tmp" "$FIXTURE_DIR/view.json"
OUT6="$(run_watch --pr 42)"     # no --once: must still exit, PR is MERGED
check "merged PR ends the watch without --once" \
  "$(events_of watch_end "$OUT6" | jq -r '.reason')" "PR MERGED"

write_fixtures

# ── 6. the stream reader ─────────────────────────────────────────────────────

echo
echo "## Stream reader"
STREAM="$REPO_ROOT/.agents/watch/pr-watch-stream.sh"
SLOG="$TMP/stream.jsonl"
printf '%s\n' '{"kind":"watch_start"}' '{"kind":"check","bucket":"pass"}' > "$SLOG"
( sleep 2; printf '%s\n' '{"kind":"check","bucket":"fail"}' >> "$SLOG"
  sleep 2; printf '%s\n' '{"kind":"watch_end","reason":"PR MERGED"}' >> "$SLOG" ) &
SOUT="$(bash "$STREAM" "$SLOG" 1)"
SRC=$?
wait

check "replays existing lines and follows new ones" \
  "$(printf '%s\n' "$SOUT" | wc -l | tr -d ' ')" "4"
check "delivers watch_end before terminating" \
  "$(printf '%s\n' "$SOUT" | tail -1 | jq -r '.kind')" "watch_end"
check "exits 0 at watch_end instead of following forever" "$SRC" "0"

MISSING="$(PR_WATCH_STREAM_WAIT=2 bash "$STREAM" "$TMP/does-not-exist.jsonl" 1 2>/dev/null)"
check "a log that never appears reports an error instead of hanging" \
  "$(printf '%s' "$MISSING" | jq -r '.kind')" "stream_error"

# ── 7. pre-push arming ───────────────────────────────────────────────────────
#
# Drive the hook the way git does: ref updates on stdin. is_agent is forced off
# so the audit gate is skipped — this suite tests the arm, not the gate.

echo
echo "## pre-push arming"

ZERO="0000000000000000000000000000000000000000"
SHA="1111111111111111111111111111111111111111"

# TERM does not take effect while the daemon sits in `sleep`: bash runs a trap
# only after the foreground child returns. Polling for actual absence keeps a
# still-dying watcher from being misread as the NEXT case's arm.
kill_watchers() {
  pkill -f "pr-watch.sh --branch" 2>/dev/null
  local deadline=$(( SECONDS + 15 ))
  while (( SECONDS < deadline )); do
    pgrep -f "pr-watch.sh --branch" >/dev/null 2>&1 || return 0
    sleep 1
  done
  pkill -9 -f "pr-watch.sh --branch" 2>/dev/null
  sleep 1
}

# A daemon that ignores SIGTERM is unkillable in practice, and every push would
# leave another one polling. Guards the signal traps in pr-watch.sh: a bare
# `trap '<cleanup>' TERM` runs the handler and then RESUMES the loop.
term_kills_daemon() {
  kill_watchers
  reset_state
  ( cd "$REPO" && nohup bash "$SCRATCH_WATCHER" --branch termprobe --sha deadbeef \
      >/dev/null 2>&1 & )
  sleep 2
  pgrep -f "pr-watch.sh --branch termprobe" >/dev/null 2>&1 || { echo "never-started"; return; }
  pkill -TERM -f "pr-watch.sh --branch termprobe" 2>/dev/null
  # Generous: bash defers a trap until the foreground `sleep` returns.
  local deadline=$(( SECONDS + 20 ))
  while (( SECONDS < deadline )); do
    pgrep -f "pr-watch.sh --branch termprobe" >/dev/null 2>&1 || { echo "died"; return; }
    sleep 1
  done
  echo "survived"
  pkill -9 -f "pr-watch.sh --branch termprobe" 2>/dev/null
}

arm() {
  local stdin_line="$1" ; shift
  kill_watchers
  reset_state
  # The watcher's first act is a bounded ls-remote wait against the local bare
  # remote, so it stays alive long enough to observe without touching a network.
  (cd "$REPO" && printf '%s\n' "$stdin_line" \
    | env -u CLAUDECODE -u CODEX_SANDBOX -u AGENT_GATED ${@+"$@"} \
      bash "$PREPUSH" origin "$TMP/origin.git" >/dev/null 2>&1)
  sleep 1
  local result
  if pgrep -f "pr-watch.sh --branch" >/dev/null 2>&1; then result=armed; else result=idle; fi
  kill_watchers
  printf '%s' "$result"
}

check "branch push arms a watcher" \
  "$(arm "refs/heads/feat $SHA refs/heads/feat $ZERO")" "armed"

check "branch DELETION arms nothing" \
  "$(arm "refs/heads/feat $ZERO refs/heads/feat $SHA")" "idle"

check "tag push arms nothing" \
  "$(arm "refs/tags/v1 $SHA refs/tags/v1 $ZERO")" "idle"

check "BOXLITE_PR_WATCH=0 opts out" \
  "$(arm "refs/heads/feat $SHA refs/heads/feat $ZERO" BOXLITE_PR_WATCH=0)" "idle"

check "daemon dies on SIGTERM (traps must exit, not resume)" \
  "$(term_kills_daemon)" "died"

# The gate's own exit code must be untouched by the arm.
reset_state
(cd "$REPO" && printf 'refs/heads/feat %s refs/heads/feat %s\n' "$SHA" "$ZERO" \
  | env -u CLAUDECODE -u CODEX_SANDBOX -u AGENT_GATED bash "$PREPUSH" origin url >/dev/null 2>&1)
check "hook still exits 0 after arming" "$?" "0"
kill_watchers

# A missing watcher must not break pushes for checkouts that predate this file.
reset_state
mv "$SCRATCH_WATCHER" "$TMP/moved-watcher.sh"
(cd "$REPO" && printf 'refs/heads/feat %s refs/heads/feat %s\n' "$SHA" "$ZERO" \
  | env -u CLAUDECODE -u CODEX_SANDBOX -u AGENT_GATED bash "$PREPUSH" origin url >/dev/null 2>&1)
check "absent watcher does not fail the push" "$?" "0"
mv "$TMP/moved-watcher.sh" "$SCRATCH_WATCHER"

echo
printf 'pr-watch: %d passed, %d failed\n' "$pass" "$fail"
(( fail == 0 ))
