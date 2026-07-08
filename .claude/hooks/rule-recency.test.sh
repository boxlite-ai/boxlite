#!/usr/bin/env bash
# Tests for .claude/hooks/rule-recency.sh
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
# Run with:  bash .claude/hooks/rule-recency.test.sh
# Exits non-zero on any failure.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK="$REPO_ROOT/.claude/hooks/rule-recency.sh"
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
echo "RESULT: $pass passed, $fail failed"
exit $(( fail > 0 ? 1 : 0 ))
