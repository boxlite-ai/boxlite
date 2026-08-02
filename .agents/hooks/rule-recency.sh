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

# Same treatment as the counter below, and for the same reason: this reaches an
# arithmetic context (`count % interval`), so a non-numeric value is evaluated as
# an expression and zero divides. Either one recurs on every prompt, and the header
# above promises this hook never blocks one.
interval="${RULE_RECENCY_INTERVAL:-5}"
case "$interval" in ''|*[!0123456789]*) interval=5 ;; esac
interval=$((10#$interval))
[ "$interval" -gt 0 ] || interval=5
# Per-user private state. A shared /tmp/rule-recency lets two users collide on one
# counter; the uid suffix separates them, and -m 700 makes the directory private
# from birth.
#
# Mode at creation, never `chmod` afterwards. That is the whole security property:
# the name is as guessable as the old one, so anything able to write $TMPDIR can
# pre-plant a symlink here, and a `chmod` would follow it. Ownership is no defence
# — it is the reason it works: chmod through a link to root-owned /usr just fails
# EPERM, while a link to ~/.ssh succeeds, because that one IS ours. `-m` acts only
# when mkdir creates the path, so a pre-planted one keeps the mode it had.
#
# Its mode only. What lands inside is inherited and accepted: the counter write, and
# the day-old prune below, which reaches into a pre-created real directory (though
# not through a symlink — find is not given -L, and does not descend one it is
# handed). Both predate this change; the payload is an integer prompt counter.
#
# Dropping `-p` is separate and NOT what closes that hole (`-p -m` is equally safe):
# it is SC2174 — with `-p`, `-m` skips any parent mkdir creates. The parent is
# $TMPDIR, so there is nothing to create; already-exists falls into the `|| true`.
#
# What the redirect can still do is bounded at the point of use, not here: the
# counter read below is validated before it reaches arithmetic.
state_dir="${TMPDIR:-/tmp}/rule-recency-$(id -u)"
mkdir -m 700 "$state_dir" 2>/dev/null || true
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

# Hash the session rather than trusting it as a path component. The value comes
# straight from the harness payload, so a session_id of `../../…` would redirect
# the read and the write outside state_dir. (Prompt text cannot reach here: the
# scrape is greedy and an escaped `\"session_id\"` inside a JSON string does not
# match.) A hash is fixed-length, path-safe, and still one file per session.
session_key="$(printf '%s' "$session" | shasum -a 256 2>/dev/null | awk '{print $1}')"
[ -z "$session_key" ] && session_key=default
state_file="$state_dir/$session_key"
count=0
[ -f "$state_file" ] && count="$(cat "$state_file" 2>/dev/null || echo 0)"
# Validate before the arithmetic, not after: $(( )) re-evaluates its operand, so a
# state file holding `a[$(cmd)]` runs cmd. The file is reachable by anyone who can
# pre-plant the directory above.
#
# Digits alone are not enough — $(( )) reads a leading zero as octal, so a planted
# `010` counts as 8 and `08` is a hard error that leaves the value unchanged, so it
# recurs on every prompt forever. 10# forces base ten.
#
# The class is spelled out rather than ranged: `[0-9]` is a collation range, and
# under ja_JP/hi_IN/fa_*/ar_* it admits non-ASCII digits, which then wedge 10# with
# the same never-clearing error. Only this literal set reaches the arithmetic.
case "$count" in ''|*[!0123456789]*) count=0 ;; esac
count=$((10#$count + 1))
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
