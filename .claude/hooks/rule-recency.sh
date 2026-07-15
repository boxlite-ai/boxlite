#!/usr/bin/env bash
# UserPromptSubmit hook — periodically re-injects the call-graph / reply rules so they
# stay fresh in context. PURE TEXT INJECTOR: no model call, no vendor CLI, no language
# runtime, no transcript parsing. That is what makes it work OUT OF THE BOX under ANY
# agent — the only requirement is a harness that runs a prompt hook and feeds the
# hook's stdout back into the model's context (Claude Code's UserPromptSubmit, a custom
# loop, etc.). Nothing here is Claude-specific.
#
# Why no "judge": deciding "did this reply forget a warranted call graph?" is a semantic
# call that needs a model, and invoking a model means naming a concrete (vendor) command.
# Forbidding that leaves no external judge — so the judgment is delegated to the agent
# itself: the rule is self-gating (it only shapes code/architecture turns, inert
# otherwise) and carries a one-line self-check for the retroactive "if you just forgot".
#
# Cadence: emit on the first prompt of a session, then every Nth. Override N with
# RULE_RECENCY_INTERVAL (default 5). Best-effort — never blocks a prompt, always exits 0.

interval="${RULE_RECENCY_INTERVAL:-5}"
state_dir="${TMPDIR:-/tmp}/rule-recency"
mkdir -p "$state_dir" 2>/dev/null || true
find "$state_dir" -type f -mtime +1 -delete 2>/dev/null || true   # prune stale sessions

# UserPromptSubmit delivers JSON on stdin: {session_id, prompt, ...}. Key the counter
# per session so each new session re-anchors at its first prompt.
payload="$(cat)"
session="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
[ -z "$session" ] && session="default"

# "Don't inject if not needed": skip bare acknowledgements ("ok", "proceed", "thanks",
# …). This is a LITERAL ack filter, not topic detection — knowing whether a prompt is
# *about* code needs a model, which this hook deliberately has none of. Only an exact
# ack match skips; anything else (incl. "ok now fix X", or an unparseable prompt) injects.
prompt="$(printf '%s' "$payload" | sed -n 's/.*"prompt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
ack="$(printf '%s' "$prompt" | tr '[:upper:]' '[:lower:]' | tr -d '[:punct:]' | tr -s '[:space:]' ' ' | sed 's/^ //;s/ $//')"
case " $ack " in
  " ok "|" okay "|" k "|" kk "|" yes "|" yep "|" yeah "|" ya "|" yup "|" no "|" nope "|" sure "|" cool "|" nice "|" got it "|" thanks "|" thank you "|" ty "|" thx "|" proceed "|" continue "|" go "|" go ahead "|" go on "|" done "|" next "|" stop "|" nvm ")
    exit 0 ;;   # trivial ack -> no inject, no cadence advance
esac

state_file="$state_dir/$session"
count=0
[ -f "$state_file" ] && count="$(cat "$state_file" 2>/dev/null || echo 0)"
count=$((count + 1))
printf '%s' "$count" > "$state_file" 2>/dev/null || true

{ [ "$count" -eq 1 ] || [ $((count % interval)) -eq 0 ]; } || exit 0

cat <<'EOF'
RULES REMINDER (re-anchoring — the full rules live in CLAUDE.md):
• Reply shape (code / architecture questions): lead with a compact call graph —
  one line per hop `fn_name  (Type · file:LOC)  — role`, flow by arrows/indent — then one **Key:** line.
  If a prior reply explained code without one, open your next code reply with the corrected version.
• Minimal words: no preamble, no question-recap, no "great question". Prose only for a "why" a graph can't carry.
• Before non-trivial work: follow CLAUDE.md's Workflow (understand → research → design → implement → test → verify). Research prior art across as many projects as possible BEFORE any design — mandatory.
EOF
exit 0
