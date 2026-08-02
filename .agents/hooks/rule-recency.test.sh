#!/usr/bin/env bash
# Tests for .agents/hooks/rule-recency.sh
#
# Covers the areas CLAUDE.md flags for required tests on this change:
#   1. Parsing + branching: the bare-acknowledgement filter — an exact ack skips;
#      case-folding and trailing punctuation still skip; a prefix like "ok now fix X"
#      must NOT skip.
#   2. Branching + boundaries: periodic cadence (first prompt, then every Nth), acks
#      not advancing the counter, and a new session re-anchoring.
#   3. Design contract: the hook invokes NO model / vendor / language-runtime command
#      — that is what makes it work out-of-the-box under any agent.
#   4. Content: the emitted reminder points to CLAUDE.md's Workflow (where research-before-design lives).
#
# Run with:  bash .agents/hooks/rule-recency.test.sh
# Exits non-zero on any failure.
set -uo pipefail

# Resolve from THIS script's location, not the caller's cwd. `git rev-parse
# --show-toplevel` returns whichever checkout the shell sits in, so running this
# suite from another worktree silently tests THAT checkout's copy instead of the
# one shipped beside these tests, and a two-side check reports a false pass.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$REPO_ROOT/.agents/hooks/rule-recency.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf '  PASS  %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL  %s\n' "$1"; }

# Drive the hook exactly as the harness does: JSON on stdin; stdout is the injected
# text ("" = skipped / silent). TMPDIR points the per-session counter state at TMP so
# tests never touch the real state dir.
emit() {  # emit <session> <prompt> [interval]
  printf '{"session_id":"%s","prompt":"%s"}' "$1" "$2" \
    | TMPDIR="$TMP" RULE_RECENCY_INTERVAL="${3:-5}" bash "$HOOK"
}
assert_emit() { [ -n "$2" ] && ok "$1" || bad "$1 (expected EMIT, got silent)"; }
assert_skip() { [ -z "$2" ] && ok "$1" || bad "$1 (expected skip, got EMIT)"; }

echo "## Ack filter: bare acknowledgements skip (fresh session => would be prompt #1 => would otherwise EMIT)"
i=0
for w in ok okay yes yep sure proceed continue thanks "thank you" thx "go ahead" done next nvm "OK." "Thanks!" "  proceed  "; do
  i=$((i + 1))
  assert_skip "skip bare ack: '$w'" "$(emit "ack-$i" "$w")"
done

echo
echo "## Ack filter: substantive & ack-prefixed prompts inject"
assert_emit "inject: 'how does the pull path work'"                    "$(emit sub-1 "how does the pull path work")"
assert_emit "inject: 'ok now fix the bug in pull()' (prefix ok != ack)" "$(emit sub-2 "ok now fix the bug in pull()")"
assert_emit "inject: 'fix pull()'"                                     "$(emit sub-3 "fix pull()")"

echo
echo "## Cadence (N=2): first emits, then every Nth; acks do not advance the counter"
assert_emit "#1 substantive        -> EMIT"   "$(emit cad "task one"   2)"
assert_skip "ack between           -> skip"   "$(emit cad "ok"         2)"
assert_emit "#2 substantive        -> EMIT"   "$(emit cad "task two"   2)"
assert_skip "ack between           -> skip"   "$(emit cad "thanks"     2)"
assert_skip "#3 substantive        -> silent" "$(emit cad "task three" 2)"
assert_emit "#4 substantive        -> EMIT"   "$(emit cad "task four"  2)"

echo
echo "## Session keying: a new session re-anchors at its own first prompt"
assert_emit "new session emits at #1" "$(emit fresh-session "walk me through the exec path" 5)"

echo
echo "## Robustness: an unparseable prompt fails open (injects, is never mis-skipped)"
assert_emit "unparseable prompt -> inject" \
  "$(printf '{"session_id":"rob","prompt":"a \\"quoted\\" thing"}' | TMPDIR="$TMP" bash "$HOOK")"

echo
echo "## Contract: the hook invokes no model / vendor / language-runtime command"
code_only="$(sed 's/#.*//' "$HOOK")"   # drop full-line and trailing comments
if printf '%s' "$code_only" | grep -qE '\b(claude|codex|gpt|openai|anthropic|gemini|ollama|python3?|curl|wget)\b|bash -c|--model'; then
  bad "no vendor/model/runtime call in executable code"
  printf '%s' "$code_only" | grep -nE '\b(claude|codex|gpt|openai|anthropic|gemini|ollama|python3?|curl|wget)\b|bash -c|--model' | sed 's/^/        offending: /'
else
  ok "no vendor/model/runtime call in executable code"
fi

echo
echo "## Content: the reminder points to CLAUDE.md's Workflow (research-before-design lives there)"
case "$(emit content-check "how should I design the new cache layer")" in
  *"CLAUDE.md's Workflow"*) ok "reminder points to CLAUDE.md's Workflow" ;;
  *)                        bad "reminder missing the CLAUDE.md Workflow pointer" ;;
esac

echo
echo "## session_id is untrusted: it is scraped from the payload, never a path"
# session_id arrives from the harness, not from the repo. Used raw as a filename,
# `../ESCAPED` writes outside state_dir — which is what this drives.
TRAV_TMP="$(mktemp -d)"
printf '{"session_id":"../ESCAPED","prompt":"explain the code"}' \
  | TMPDIR="$TRAV_TMP" bash "$HOOK" >/dev/null 2>&1
if [[ -e "$TRAV_TMP/ESCAPED" ]]; then
  fail=$((fail + 1)); printf '  FAIL  a traversing session_id cannot write outside the state dir\n'
else
  pass=$((pass + 1)); printf '  PASS  a traversing session_id cannot write outside the state dir\n'
fi
# It must still count the session — containment that drops the counter is a
# different bug. Exactly one state file, and it is named for the hash rather than
# for anything the caller supplied.
trav_key="$(printf '%s' '../ESCAPED' | shasum -a 256 | awk '{print $1}')"
state_files="$(find "$TRAV_TMP" -type f 2>/dev/null | wc -l | tr -d ' ')"
trav_named="$(find "$TRAV_TMP" -type f -name "$trav_key" 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$state_files" == "1" && "$trav_named" == "1" ]]; then
  pass=$((pass + 1)); printf '  PASS  the traversing session gets exactly one state file, hash-named\n'
else
  fail=$((fail + 1)); printf '  FAIL  the traversing session gets exactly one state file, hash-named  (found=%s hash-named=%s)\n' "$state_files" "$trav_named"
fi
# Private to this uid: a world-guessable /tmp path lets another local process
# pre-create or clobber the counters.
perms="$(ls -ld "$TRAV_TMP"/rule-recency-* 2>/dev/null | awk '{print $1}' | head -1)"
case "$perms" in
  drwx------*) pass=$((pass + 1)); printf '  PASS  state dir is private (0700)\n' ;;
  *)           fail=$((fail + 1)); printf '  FAIL  state dir is private (0700)  (got=%s)\n' "${perms:-none}" ;;
esac
rm -rf "$TRAV_TMP"

echo
echo "## the counter is data, not code"
# The hook reads its own state file back into `$(( ))`, and arithmetic expansion
# evaluates its operand — so a state file holding `a[$(cmd)]` runs cmd. Reachable
# by whoever can pre-plant the state directory. One planting buys one run: the
# expression resolves to 0 and the hook overwrites the payload on its way out.
INJ_TMP="$(mktemp -d)"
mkdir -p "$INJ_TMP/rule-recency-$(id -u)"
inj_key="$(printf '%s' 'inj-session' | shasum -a 256 | awk '{print $1}')"
printf 'a[$(touch %s/EXECUTED)]' "$INJ_TMP" > "$INJ_TMP/rule-recency-$(id -u)/$inj_key"
printf '{"session_id":"inj-session","prompt":"explain the code"}' \
  | TMPDIR="$INJ_TMP" bash "$HOOK" >/dev/null 2>&1
if [[ -e "$INJ_TMP/EXECUTED" ]]; then
  fail=$((fail + 1)); printf '  FAIL  a planted state file cannot execute commands\n'
else
  pass=$((pass + 1)); printf '  PASS  a planted state file cannot execute commands\n'
fi
# Rejecting must reset, not wedge. This one passes either way — unvalidated, the
# expression still evaluates to 0 and lands on 1 — so it is a liveness guard against
# a future fix that drops the counter, not the security assertion above it.
inj_after="$(cat "$INJ_TMP/rule-recency-$(id -u)/$inj_key" 2>/dev/null)"
if [[ "$inj_after" == "1" ]]; then
  pass=$((pass + 1)); printf '  PASS  a rejected counter restarts at 1\n'
else
  fail=$((fail + 1)); printf '  FAIL  a rejected counter restarts at 1  (got=%s)\n' "${inj_after:-empty}"
fi
rm -rf "$INJ_TMP"

# Digits are not enough. `$(( ))` reads a leading zero as octal: `010` silently
# counts as 8, and `08` is a hard error that leaves the value unchanged — so unlike
# the injection, which overwrites itself, that one recurs on every prompt forever.
OCT_TMP="$(mktemp -d)"
mkdir -p "$OCT_TMP/rule-recency-$(id -u)"
oct_key="$(printf '%s' 'oct-session' | shasum -a 256 | awk '{print $1}')"
printf '08' > "$OCT_TMP/rule-recency-$(id -u)/$oct_key"
oct_err="$(printf '{"session_id":"oct-session","prompt":"explain the code"}' \
  | TMPDIR="$OCT_TMP" bash "$HOOK" 2>&1 >/dev/null)"
oct_after="$(cat "$OCT_TMP/rule-recency-$(id -u)/$oct_key" 2>/dev/null)"
if [[ "$oct_after" == "9" && -z "$oct_err" ]]; then
  pass=$((pass + 1)); printf '  PASS  a leading-zero counter advances in base ten, silently\n'
else
  fail=$((fail + 1)); printf '  FAIL  a leading-zero counter advances in base ten, silently  (got=%s err=%.60s)\n' "${oct_after:-empty}" "${oct_err:-none}"
fi
rm -rf "$OCT_TMP"

# Same wedge, reached through the character class instead of the value. `[0-9]` is a
# collation range, so some locales admit non-ASCII digits, which then choke 10#.
# Drive it through a locale that actually behaves that way here; only when no
# installed locale is permissive for any of the digits below, fall back to pinning
# the literal set in the source — the behavioural probe would be vacuous there,
# and dropping the case entirely would lose the guard exactly where the bug hides.
# Each permissive family admits its own script's digit and not the others': ja_JP
# takes fullwidth ３, hi_IN takes ३, fa_* and ar_* take ۳ and ٣. Probing only one
# would fall through to the weaker branch on a box that could have driven the real
# thing, so pair every candidate locale with every digit.
loose_locale=""
loose_digit=""
for cand in $(locale -a 2>/dev/null); do
  case "$cand" in *[Uu][Tt][Ff]*) ;; *) continue ;; esac
  for d in $'\xef\xbc\x93' $'\xe0\xa5\xa9' $'\xdb\xb3' $'\xd9\xa3'; do
    if LC_ALL="$cand" bash -c 'case "$1" in *[!0-9]*) exit 1 ;; *) exit 0 ;; esac' _ "$d" 2>/dev/null; then
      loose_locale="$cand"; loose_digit="$d"; break 2
    fi
  done
done
if [[ -n "$loose_locale" ]]; then
  LOC_TMP="$(mktemp -d)"
  mkdir -p "$LOC_TMP/rule-recency-$(id -u)"
  loc_key="$(printf '%s' 'loc-session' | shasum -a 256 | awk '{print $1}')"
  printf '%s' "$loose_digit" > "$LOC_TMP/rule-recency-$(id -u)/$loc_key"
  loc_err="$(printf '{"session_id":"loc-session","prompt":"explain the code"}' \
    | LC_ALL="$loose_locale" TMPDIR="$LOC_TMP" bash "$HOOK" 2>&1 >/dev/null)"
  loc_after="$(cat "$LOC_TMP/rule-recency-$(id -u)/$loc_key" 2>/dev/null)"
  if [[ "$loc_after" == "1" && -z "$loc_err" ]]; then
    pass=$((pass + 1)); printf '  PASS  a non-ASCII digit is rejected under %s\n' "$loose_locale"
  else
    fail=$((fail + 1)); printf '  FAIL  a non-ASCII digit is rejected under %s  (got=%s err=%.50s)\n' "$loose_locale" "${loc_after:-empty}" "${loc_err:-none}"
  fi
  rm -rf "$LOC_TMP"
elif grep -q "\[!0123456789\]" "$HOOK"; then
  pass=$((pass + 1)); printf '  PASS  counter guard spells the digit class out (no permissive locale here to drive it)\n'
else
  fail=$((fail + 1)); printf '  FAIL  counter guard uses a collation range, which some locales widen\n'
fi


# RULE_RECENCY_INTERVAL reaches `count % interval`, the same arithmetic context as
# the counter. A zero divides and a non-numeric value is evaluated as an expression,
# and either recurs on every prompt after the first — this hook's header promises it
# never blocks one. Two prompts, because prompt 1 short-circuits on `count -eq 1`.
for bad_interval in 0 'a[$(true)]' '' 08; do
  IV_TMP="$(mktemp -d)"
  iv_err=""
  for _ in 1 2; do
    iv_err="$iv_err$(printf '{"session_id":"iv","prompt":"explain the code"}' \
      | RULE_RECENCY_INTERVAL="$bad_interval" TMPDIR="$IV_TMP" bash "$HOOK" 2>&1 >/dev/null)"
  done
  if [[ -z "$iv_err" ]]; then
    pass=$((pass + 1)); printf '  PASS  RULE_RECENCY_INTERVAL=%s is survivable\n' "${bad_interval:-<empty>}"
  else
    fail=$((fail + 1)); printf '  FAIL  RULE_RECENCY_INTERVAL=%s is survivable  (err=%.60s)\n' "${bad_interval:-<empty>}" "$iv_err"
  fi
  rm -rf "$IV_TMP"
done

echo
echo "RESULT: $pass passed, $fail failed"
exit $(( fail > 0 ? 1 : 0 ))
