#!/usr/bin/env bash
# Tests for .agents/hooks/run-verdict-audit.sh (the harness-neutral audit runner).
#
# Contract:
#   - resolves VERDICT_AUDITOR_CMD first (stdin = audit prompt), else claude CLI
#   - succeeds (exit 0) only when a FRESH, well-formed dossier lands
#   - exit 1 when the runner ran but produced no dossier
#   - exit 2 when no runner is available / no transcript arg
#   - a pre-existing dossier does not count as success (freshness check)
#
# Run with:  bash .agents/hooks/run-verdict-audit.test.sh
set -uo pipefail

# Resolve from THIS script's location, not the caller's cwd. `git rev-parse
# --show-toplevel` returns whichever checkout the shell sits in, so running this
# suite from another worktree silently tests THAT checkout's copy instead of the
# one shipped beside these tests, and a two-side check reports a false pass.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="$REPO_ROOT/.agents/hooks/run-verdict-audit.sh"

pass=0
fail=0

setup() {
  local d; d="$(mktemp -d)"
  git -C "$d" init -q
  git -C "$d" config user.email t@t.test
  git -C "$d" config user.name tester
  printf 'x\n' > "$d/f"
  printf '.agents/state/last-verdict.json\n' > "$d/.gitignore"
  git -C "$d" add -A
  git -C "$d" commit -qm base
  mkdir -p "$d/.agents/state"
  printf '{"type":"assistant","message":{"content":[{"type":"text","text":"tests pass"}]}}\n' > "$d/transcript.jsonl"
  printf '%s' "$d"
}

check_eq() {  # desc  got  want
  local desc="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1)); printf '  PASS  %s\n' "$desc"
  else
    fail=$((fail + 1)); printf '  FAIL  %s  (got=%s want=%s)\n' "$desc" "$got" "$want"
  fi
}

# Stub that writes a plausible dossier (what a real auditor leaves behind).
DOSSIER_STUB='cat >/dev/null; mkdir -p "$CLAUDE_PROJECT_DIR/.agents/state"; printf "{\"branch\":\"main\",\"head\":\"h\",\"tree_hash\":\"t\",\"verdict\":\"PASS\",\"proof\":[],\"findings\":[]}" > "$CLAUDE_PROJECT_DIR/.agents/state/last-verdict.json"'

echo "## Runner resolution and success criteria"
R="$(setup)"
( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_AUDITOR_CMD="$DOSSIER_STUB" bash "$RUNNER" "$R/transcript.jsonl" >/dev/null 2>&1 )
check_eq "stub writes dossier → exit 0"                      "$?" 0
dossier_state="missing"; [[ -s "$R/.agents/state/last-verdict.json" ]] && dossier_state="present"
check_eq "dossier present after run"                         "$dossier_state" "present"
rm -rf "$R"

R="$(setup)"
( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_AUDITOR_CMD='cat >/dev/null' bash "$RUNNER" "$R/transcript.jsonl" >/dev/null 2>&1 )
check_eq "stub writes nothing → exit 1"                      "$?" 1
rm -rf "$R"

# A leftover dossier from an earlier audit must NOT satisfy the freshness check.
R="$(setup)"
printf '{"branch":"main","head":"h","tree_hash":"t","verdict":"PASS","proof":[],"findings":[]}' > "$R/.agents/state/last-verdict.json"
touch -t 202001010000 "$R/.agents/state/last-verdict.json"
( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_AUDITOR_CMD='cat >/dev/null' bash "$RUNNER" "$R/transcript.jsonl" >/dev/null 2>&1 )
check_eq "stale pre-existing dossier does not count → exit 1" "$?" 1
rm -rf "$R"

echo
echo "## Audit lock: the gate's only evidence that a run is in progress"
# The gate's own in-flight cases WRITE the lock themselves, so without coverage here
# reverting this file leaves both suites green while the fix goes inert. The stub runs
# INSIDE the audit — the only vantage point that sees a lock held for the run.
R="$(setup)"
# Key names must not be substrings of one another: with `pid=`/`ppid=` a greedy
# `.*pid=` matches the SECOND field, so both extractions return the same number and the
# comparison below passes no matter what the runner wrote.
OBSERVE_STUB='cat >/dev/null
  L="$CLAUDE_PROJECT_DIR/.agents/state/verdict-audit.lock"
  if [ -r "$L" ]; then
    P="$(cat "$L")"
    set -- $P
    printf "present lockpid=%s deadline=%s runnerpid=%s now=%s alive=%s\n" \
      "$1" "${2:-none}" "$PPID" "$(date +%s)" \
      "$(kill -0 "$1" 2>/dev/null && echo yes || echo no)" > "$CLAUDE_PROJECT_DIR/lock-probe"
  else
    printf "absent\n" > "$CLAUDE_PROJECT_DIR/lock-probe"
  fi
  printf "{\"branch\":\"main\",\"head\":\"h\",\"tree_hash\":\"t\",\"verdict\":\"PASS\",\"proof\":[],\"findings\":[]}" > "$CLAUDE_PROJECT_DIR/.agents/state/last-verdict.json"'
( cd "$R" && CLAUDE_PROJECT_DIR="$R" VERDICT_AUDITOR_CMD="$OBSERVE_STUB" bash "$RUNNER" "$R/transcript.jsonl" >/dev/null 2>&1 )
probe="$(cat "$R/lock-probe" 2>/dev/null || echo NO-PROBE)"
held="no"
[[ "$probe" =~ ^present\ lockpid=[0-9]+\ deadline=[0-9]+\ runnerpid=[0-9]+\ now=[0-9]+\ alive=yes$ ]] && held="yes"
gone="no";  [[ -e "$R/.agents/state/verdict-audit.lock" ]] || gone="yes"
# Asserted as ONE pair: "released" alone is trivially true for a runner that never took
# a lock, so only held-then-released distinguishes the fix from its absence.
check_eq "lock held by a LIVE pid during the run, released after" \
  "held=$held released=$gone" "held=yes released=yes"
# A lock naming an unrelated process would keep the gate silent after this runner is
# gone. Sentinels differ so a missing probe fails rather than comparing two empties.
check_eq "lock names the runner process itself" \
  "$(printf '%s' "$probe" | sed -nE 's/.*lockpid=([0-9]+).*/\1/p'    | grep . || echo NO-LOCKPID)" \
  "$(printf '%s' "$probe" | sed -nE 's/.*runnerpid=([0-9]+).*/\1/p'  | grep . || echo NO-RUNNERPID)"
# Asserted as a RANGE: too short and long audits resume storming, too long and a dead
# run buys silence past the ceiling. Bounds are READ OUT of the gate — hardcoding them
# lets this keep passing while the gate's real ceiling moves underneath it.
gate_const() {  # name -> value, or empty if the gate stops declaring it that way
  sed -nE "s/^$1=([0-9]+)\$/\1/p" "$REPO_ROOT/.agents/hooks/preflight-verdict-check.sh" | head -n1
}
probe_deadline="$(printf '%s' "$probe" | sed -nE 's/.*deadline=([0-9]+).*/\1/p' | grep . || echo 0)"
probe_now="$(printf '%s' "$probe" | sed -nE 's/.*now=([0-9]+).*/\1/p' | grep . || echo 0)"
window="$(( probe_deadline - probe_now ))"
gate_dossier_bound="$(gate_const max_age_seconds)"
gate_lock_ceiling="$(gate_const audit_lock_max_seconds)"
if [[ -z "$gate_dossier_bound" || -z "$gate_lock_ceiling" ]]; then
  in_range="gate-constants-unreadable"      # fail loudly rather than compare to empty
else
  in_range="no"
  (( window > gate_dossier_bound && window <= gate_lock_ceiling )) && in_range="yes"
fi
check_eq "lock deadline outlives the gate's dossier bound, within its ceiling" "$in_range" "yes"
rm -rf "$R"

# The no-runner path exits before auditing; a lock left there promises a verdict that
# never comes. The state dir is removed first so its RE-creation proves the lock code
# ran — otherwise "no lock" is equally true of a runner that never had it.
R="$(setup)"; rm -rf "$R/.agents/state"
( cd "$R" && CLAUDE_PROJECT_DIR="$R" PATH=/usr/bin:/bin VERDICT_AUDITOR_CMD='' bash "$RUNNER" "$R/transcript.jsonl" >/dev/null 2>&1 )
reached="no"; [[ -d "$R/.agents/state" ]] && reached="yes"
gone="no";    [[ -e "$R/.agents/state/verdict-audit.lock" ]] || gone="yes"
check_eq "no-runner exit 2 takes the lock then clears it" \
  "took=$reached released=$gone" "took=yes released=yes"
rm -rf "$R"

echo
echo "## Failure modes"
R="$(setup)"
( cd "$R" && CLAUDE_PROJECT_DIR="$R" bash "$RUNNER" >/dev/null 2>&1 )
check_eq "missing transcript arg → exit 2"                   "$?" 2
rm -rf "$R"

R="$(setup)"
out="$( cd "$R" && CLAUDE_PROJECT_DIR="$R" PATH=/usr/bin:/bin VERDICT_AUDITOR_CMD='' bash "$RUNNER" "$R/transcript.jsonl" 2>&1 )"
check_eq "no runner available → exit 2"                      "$?" 2
names_seam="no"; printf '%s' "$out" | grep -q VERDICT_AUDITOR_CMD && names_seam="yes"
check_eq "exit-2 message names VERDICT_AUDITOR_CMD"          "$names_seam" "yes"
rm -rf "$R"

# A no-runner invocation exits 2 WITHOUT auditing, so it must not destroy a dossier
# on its way out. The freshness removal therefore sits inside each runner branch.
D="$(mktemp -d)"; mkdir -p "$D/.agents/state"
printf '{"verdict":"PASS","branch":"b","tree_hash":"t"}' > "$D/.agents/state/last-verdict.json"
printf 'x' > "$D/t.jsonl"
( cd "$D" && env -u VERDICT_AUDITOR_CMD CLAUDE_PROJECT_DIR="$D" PATH=/usr/bin:/bin \
    bash "$RUNNER" "$D/t.jsonl" >/dev/null 2>&1 )
if [[ -f "$D/.agents/state/last-verdict.json" ]]; then
  pass=$((pass + 1)); printf '  PASS  a no-runner invocation leaves an existing dossier intact\n'
else
  fail=$((fail + 1)); printf '  FAIL  a no-runner invocation leaves an existing dossier intact\n'
fi
rm -rf "$D"

# Freshness is proven by existence, so an auditor that rewrites within one second is
# still accepted — mtime comparison rejected it, and a fast stub hits that window.
D="$(mktemp -d)"; mkdir -p "$D/.agents/state"
printf '{"verdict":"STALE","branch":"b","tree_hash":"t"}' > "$D/.agents/state/last-verdict.json"
printf 'x' > "$D/t.jsonl"
( cd "$D" && CLAUDE_PROJECT_DIR="$D" \
    VERDICT_AUDITOR_CMD='cat >/dev/null; printf "{\"verdict\":\"PASS\",\"branch\":\"b\",\"tree_hash\":\"t\"}" > "$CLAUDE_PROJECT_DIR/.agents/state/last-verdict.json"' \
    bash "$RUNNER" "$D/t.jsonl" >/dev/null 2>&1 )
rc=$?
got="$(jq -r '.verdict' "$D/.agents/state/last-verdict.json" 2>/dev/null)"
if [[ "$rc" == "0" && "$got" == "PASS" ]]; then
  pass=$((pass + 1)); printf '  PASS  a same-second rewrite is accepted as fresh\n'
else
  fail=$((fail + 1)); printf '  FAIL  a same-second rewrite is accepted as fresh  (rc=%s verdict=%s)\n' "$rc" "$got"
fi
rm -rf "$D"

echo
echo "## Frontmatter stripping: subagent wiring must never reach the model"
# strip_frontmatter() is only called from the claude-CLI branch, so every other case in
# this file leaves it uncovered — the keys it parses (name/tools/model/effort) decide
# what the auditor is told, and one of them arriving as an instruction would be silent.
# Fake `claude` on PATH so the REAL branch runs against the REAL shipped spec, and
# capture exactly what would have been sent as the system prompt.
R="$(setup)"
mkdir -p "$R/.claude/agents"
cp "$REPO_ROOT/.claude/agents/verdict-auditor.md" "$R/.claude/agents/verdict-auditor.md"
BIN="$(mktemp -d)"; CAP="$R/captured-system-prompt.txt"
cat > "$BIN/claude" <<'FAKE'
#!/usr/bin/env bash
cat >/dev/null                      # consume the audit prompt on stdin
prev=""
for a in "$@"; do
  [[ "$prev" == "--append-system-prompt" ]] && printf '%s' "$a" > "$SPEC_CAPTURE"
  prev="$a"
done
mkdir -p "$CLAUDE_PROJECT_DIR/.agents/state"
printf '{"branch":"main","head":"h","tree_hash":"t","verdict":"PASS","proof":[],"findings":[]}' \
  > "$CLAUDE_PROJECT_DIR/.agents/state/last-verdict.json"
FAKE
chmod +x "$BIN/claude"
( cd "$R" && CLAUDE_PROJECT_DIR="$R" SPEC_CAPTURE="$CAP" PATH="$BIN:$PATH" \
    env -u VERDICT_AUDITOR_CMD bash "$RUNNER" "$R/transcript.jsonl" >/dev/null 2>&1 )
# grep -c PRINTS 0 and EXITS 1 on no-match, so `|| echo 0` would append a second zero.
leaked="$(grep -cE '^(name|description|tools|model|effort):' "$CAP" 2>/dev/null || true)"
check_eq "no frontmatter key reaches the system prompt"      "$leaked" "0"
body_ok="no"; grep -q '^## Procedure' "$CAP" 2>/dev/null && body_ok="yes"
check_eq "...while the procedure body survives"              "$body_ok" "yes"
rm -rf "$R" "$BIN"

echo
echo "RESULT: $pass passed, $fail failed"
exit $(( fail > 0 ? 1 : 0 ))
