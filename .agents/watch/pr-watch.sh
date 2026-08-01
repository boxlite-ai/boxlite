#!/usr/bin/env bash
# Agent-agnostic CI + PR-comment watcher.
#
# Armed by .githooks/pre-push after a push, so it runs identically for Claude
# Code, Codex, opencode, and a human at a terminal. Emits one JSON object per
# line — to stdout and to an append-only log — as checks conclude and as
# comments/reviews arrive.
#
# Consumers:
#   Claude Code  .agents/hooks/post-remote-write-watch.sh arms a Monitor on the log
#   other agents tail the log, or run this in the foreground
#   humans       tail -f "$(git rev-parse --git-path pr-watch)"/<branch>.jsonl
#
# Usage:
#   pr-watch.sh --branch <name> [--sha <sha>]   # arm for a just-pushed branch
#   pr-watch.sh --pr <number>                   # watch a known PR
#   pr-watch.sh --pr <number> --once            # one poll pass, then exit
#
# Env:
#   BOXLITE_PR_WATCH=0        disable entirely (checked by the caller and here)
#   PR_WATCH_INTERVAL         poll seconds (default 30; GitHub rate limits)
#   PR_WATCH_IDLE_TIMEOUT     give up after this many idle seconds (default 7200)
#
# Design notes
# ------------
# * No `set -e`: a daemon must outlive a transient `gh` failure. Every network
#   call is `|| true`-guarded and its output validated before use.
# * Every terminal bucket is emitted, not just `pass`. A watcher that reports
#   only success is indistinguishable from one that died — silence must never
#   read as "still green".
# * De-dup is by a stable key per observation, persisted next to the log, so a
#   restarted watcher does not replay the whole history.
#
# Tests: bash .agents/watch/pr-watch.test.sh
set -uo pipefail

readonly DEFAULT_INTERVAL=30
readonly DEFAULT_IDLE_TIMEOUT=7200
readonly BODY_MAX_CHARS=600

branch=""
sha=""
pr_number=""
once=0

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while (( $# )); do
  case "$1" in
    --branch) branch="${2:-}"; shift 2 ;;
    --sha)    sha="${2:-}";    shift 2 ;;
    --pr)     pr_number="${2:-}"; shift 2 ;;
    --once)   once=1; shift ;;
    -h|--help) usage 0 ;;
    *) printf 'pr-watch: unknown argument: %s\n' "$1" >&2; usage 1 ;;
  esac
done

[[ "${BOXLITE_PR_WATCH:-1}" == "0" ]] && exit 0

interval="${PR_WATCH_INTERVAL:-$DEFAULT_INTERVAL}"
idle_timeout="${PR_WATCH_IDLE_TIMEOUT:-$DEFAULT_IDLE_TIMEOUT}"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
state_dir="$(git -C "$repo_root" rev-parse --git-path pr-watch 2>/dev/null || echo "$repo_root/.git/pr-watch")"
[[ "$state_dir" != /* ]] && state_dir="$repo_root/$state_dir"
mkdir -p "$state_dir"

# Slug from the remote URL rather than `gh repo view` — deterministic, offline,
# and correct before the push has landed.
repo_slug() {
  local url
  url="$(git -C "$repo_root" remote get-url origin 2>/dev/null || echo '')"
  case "$url" in
    git@*:*)      printf '%s' "${url#*:}" ;;
    https://*|ssh://*) printf '%s' "${url#*://*/}" ;;
    *)            printf '%s' "$url" ;;
  esac | sed 's/\.git$//'
}
slug="$(repo_slug)"

if [[ -z "$branch" && -n "$pr_number" ]]; then
  branch="pr-${pr_number}"
fi
if [[ -z "$branch" ]]; then
  printf 'pr-watch: need --branch or --pr\n' >&2
  usage 1
fi

safe_branch="${branch//\//-}"
event_log="$state_dir/${safe_branch}.jsonl"
seen_file="$state_dir/${safe_branch}.seen"
lock_dir="$state_dir/${safe_branch}.lock"
touch "$event_log" "$seen_file" 2>/dev/null || true

# Atomic single-instance guard: repeated pushes to the same branch must not
# stack daemons all polling the same PR.
if ! mkdir "$lock_dir" 2>/dev/null; then
  exit 0
fi
# Signal traps must exit explicitly. A bare `trap '<cleanup>' TERM` runs the
# handler and then RESUMES the loop — the daemon would survive every kill short
# of SIGKILL, and each push would leave another one running.
trap 'rm -rf "$lock_dir"' EXIT
trap 'rm -rf "$lock_dir"; exit 143' TERM
trap 'rm -rf "$lock_dir"; exit 130' INT

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# One event = one line of JSON on stdout and in the log. jq builds it so bodies
# with quotes/newlines can't corrupt the stream.
emit() {
  local kind="$1"; shift
  local line
  line="$(jq -nc \
    --arg ts "$(now_iso)" \
    --arg kind "$kind" \
    --arg pr "$pr_number" \
    --arg branch "$branch" \
    --args '$ARGS.positional
            | ($ARGS.positional | length) as $n
            | reduce range(0; $n; 2) as $i ({}; .[$ARGS.positional[$i]] = $ARGS.positional[$i+1])
            | {ts:$ts, kind:$kind, pr:$pr, branch:$branch} + .' \
    "$@" 2>/dev/null)"
  [[ -z "$line" ]] && return 0
  printf '%s\n' "$line" | tee -a "$event_log"
}

seen() { grep -qxF "$1" "$seen_file" 2>/dev/null; }
mark_seen() { printf '%s\n' "$1" >> "$seen_file"; }

# Field separator for jq @tsv rows. NOT a literal tab: bash treats tab as an IFS
# *whitespace* character, so `read` collapses runs of them into one delimiter and
# every row with an empty field (a check with no `workflow`, a comment with no
# `path`) silently shifts its remaining values one column left. US (0x1f) is
# non-whitespace, so each occurrence delimits exactly one field.
readonly FS=$'\037'

# jq's @tsv escapes \t \n \r \\ inside values, so the only real tab bytes in its
# output are separators — safe to translate wholesale.
tsv_rows() { jq -r "$1" | tr '\t' "$FS"; }

# Undo @tsv's escaping for free text, so multi-line review bodies reach the event
# as real newlines. jq re-escapes them when building the JSON, keeping one line.
unescape_tsv() {
  local s="$1"
  s="${s//\\t/$'\t'}"
  s="${s//\\r/$'\r'}"
  s="${s//\\n/$'\n'}"
  printf '%s' "${s//\\\\/\\}"
}

truncate_body() {
  local body="$1"
  if (( ${#body} > BODY_MAX_CHARS )); then
    printf '%s… [truncated, see url]' "${body:0:$BODY_MAX_CHARS}"
  else
    printf '%s' "$body"
  fi
}

# ── discovery ────────────────────────────────────────────────────────────────

# Wait for the pushed sha to appear on the remote. Arming happens in pre-push,
# i.e. BEFORE the push completes, so polling the PR immediately would race.
wait_for_push_landed() {
  [[ -z "$sha" ]] && return 0
  local deadline=$(( SECONDS + 300 ))
  while (( SECONDS < deadline )); do
    local remote_sha
    remote_sha="$(git -C "$repo_root" ls-remote origin "refs/heads/$branch" 2>/dev/null | awk '{print $1}')"
    [[ "$remote_sha" == "$sha" ]] && return 0
    sleep 5
  done
  emit warn message "pushed sha never appeared on origin/$branch; watching anyway" sha "$sha"
  return 0
}

# A push may precede `gh pr create` by minutes. Polling for the PR to appear is
# what lets one pre-push arm cover PR creation too — no `gh` hook needed.
resolve_pr_number() {
  [[ -n "$pr_number" ]] && return 0
  local deadline=$(( SECONDS + 900 )) found
  while (( SECONDS < deadline )); do
    found="$(gh pr list --repo "$slug" --head "$branch" --state open \
              --json number --jq '.[0].number // empty' 2>/dev/null || true)"
    if [[ "$found" =~ ^[0-9]+$ ]]; then
      pr_number="$found"
      emit pr_found url "https://github.com/$slug/pull/$found"
      return 0
    fi
    (( once )) && return 1
    sleep "$interval"
  done
  return 1
}

# ── polling ──────────────────────────────────────────────────────────────────

# Emits every check that has left `pending`, including skips, exactly once.
# Matrix jobs share a name in this repo (the `${{ matrix.* }}` expression is not
# expanded in the check name), so `link` is the de-dup discriminator.
poll_checks() {
  local checks
  checks="$(gh pr checks "$pr_number" --repo "$slug" \
              --json name,state,bucket,workflow,link 2>/dev/null || true)"
  if ! printf '%s' "$checks" | jq -e 'type == "array"' >/dev/null 2>&1; then
    return 1
  fi

  local total concluded
  total="$(printf '%s' "$checks" | jq 'length')"
  (( total == 0 )) && return 1

  while IFS="$FS" read -r name bucket state workflow link; do
    [[ -z "$name" ]] && continue
    local key="check:${link:-$name}:${bucket}"
    seen "$key" && continue
    mark_seen "$key"
    emit check name "$name" bucket "$bucket" state "$state" \
                workflow "$workflow" url "$link"
  done < <(printf '%s' "$checks" \
            | tsv_rows '.[] | select(.bucket != "pending")
                        | [.name, .bucket, .state, (.workflow // ""), (.link // "")] | @tsv')

  concluded="$(printf '%s' "$checks" | jq '[.[] | select(.bucket != "pending")] | length')"
  if (( concluded == total )) && ! seen "checks_done:${total}"; then
    mark_seen "checks_done:${total}"
    emit checks_done \
      total "$total" \
      failed "$(printf '%s' "$checks" | jq '[.[] | select(.bucket == "fail" or .bucket == "cancel")] | length')" \
      passed "$(printf '%s' "$checks" | jq '[.[] | select(.bucket == "pass")] | length')" \
      skipped "$(printf '%s' "$checks" | jq '[.[] | select(.bucket == "skipping")] | length')"
  fi
  return 0
}

# Issue comments + review submissions. Inline review threads live in neither of
# these and are fetched separately below.
#
# Reports the PR state by assigning the global `pr_state`, NOT by echoing it.
# `emit` writes events to stdout, so a caller using `state=$(poll_conversation)`
# would capture every comment and review into that variable instead of letting
# them reach the event stream — they'd survive only in the log file.
poll_conversation() {
  local view
  view="$(gh pr view "$pr_number" --repo "$slug" \
            --json state,comments,reviews 2>/dev/null || true)"
  printf '%s' "$view" | jq -e 'type == "object"' >/dev/null 2>&1 || return 1

  while IFS="$FS" read -r id author body url; do
    [[ -z "$id" ]] && continue
    seen "comment:$id" && continue
    mark_seen "comment:$id"
    emit comment author "$author" body "$(truncate_body "$(unescape_tsv "$body")")" url "$url"
  done < <(printf '%s' "$view" \
            | tsv_rows '.comments[]? | [.id, (.author.login // "?"), (.body // ""), (.url // "")] | @tsv')

  while IFS="$FS" read -r id author review_state body; do
    [[ -z "$id" ]] && continue
    seen "review:$id" && continue
    mark_seen "review:$id"
    emit review author "$author" state "$review_state" \
                body "$(truncate_body "$(unescape_tsv "$body")")" \
                url "https://github.com/$slug/pull/$pr_number"
  done < <(printf '%s' "$view" \
            | tsv_rows '.reviews[]? | [.id, (.author.login // "?"), (.state // ""), (.body // "")] | @tsv')

  pr_state="$(printf '%s' "$view" | jq -r '.state // "OPEN"')"
}

poll_inline_comments() {
  local inline
  inline="$(gh api "repos/$slug/pulls/$pr_number/comments?per_page=100" 2>/dev/null || true)"
  printf '%s' "$inline" | jq -e 'type == "array"' >/dev/null 2>&1 || return 0

  while IFS="$FS" read -r id author path body url; do
    [[ -z "$id" ]] && continue
    seen "inline:$id" && continue
    mark_seen "inline:$id"
    emit review_comment author "$author" path "$path" \
                        body "$(truncate_body "$(unescape_tsv "$body")")" url "$url"
  done < <(printf '%s' "$inline" \
            | tsv_rows '.[] | [.id, (.user.login // "?"), (.path // ""), (.body // ""), (.html_url // "")] | @tsv')
}

# ── main ─────────────────────────────────────────────────────────────────────

command -v gh >/dev/null 2>&1 || { printf 'pr-watch: gh not found\n' >&2; exit 127; }
command -v jq >/dev/null 2>&1 || { printf 'pr-watch: jq not found\n' >&2; exit 127; }

wait_for_push_landed

if ! resolve_pr_number; then
  emit watch_end reason "no open PR found for branch"
  exit 0
fi

emit watch_start url "https://github.com/$slug/pull/$pr_number" interval "$interval"

last_progress=$SECONDS
while :; do
  poll_checks
  poll_inline_comments
  pr_state="OPEN"        # poll_conversation overwrites; a failed poll keeps watching
  poll_conversation

  # Any new line written since the last pass counts as progress.
  if [[ -s "$seen_file" ]]; then
    current_seen="$(wc -l < "$seen_file" 2>/dev/null | tr -d ' ')"
    if [[ "${current_seen:-0}" != "${previous_seen:-}" ]]; then
      previous_seen="$current_seen"
      last_progress=$SECONDS
    fi
  fi

  if [[ "$pr_state" == "MERGED" || "$pr_state" == "CLOSED" ]]; then
    emit watch_end reason "PR ${pr_state}"
    break
  fi

  (( once )) && break

  if (( SECONDS - last_progress > idle_timeout )); then
    emit watch_end reason "idle for ${idle_timeout}s"
    break
  fi

  sleep "$interval"
done
