#!/usr/bin/env bash
# Replay-and-follow one pr-watch event log, then stop when the watch ends.
#
# Separated from pr-watch.sh because the two have opposite jobs: that script
# PRODUCES events from GitHub, this one DELIVERS a log to whoever is watching.
# Consumers point a Monitor (or a plain terminal) at this.
#
# Why not `tail -f`: the stream has to stop on its own when the watch is over,
# and `tail -f | while read … exit` cannot do that — the `exit` runs in the
# pipeline's subshell and leaves `tail` following the file forever. Polling the
# line count keeps termination in the same shell that decides to terminate.
#
# Usage: pr-watch-stream.sh <event-log> [poll-seconds]
set -uo pipefail

log="${1:-}"
poll="${2:-5}"

if [[ -z "$log" ]]; then
  printf 'usage: pr-watch-stream.sh <event-log> [poll-seconds]\n' >&2
  exit 2
fi

# The log is created by pre-push at arm time, but a consumer can start first.
deadline=$(( SECONDS + ${PR_WATCH_STREAM_WAIT:-120} ))
while [[ ! -f "$log" ]]; do
  if (( SECONDS >= deadline )); then
    printf '{"kind":"stream_error","message":"no event log at %s"}\n' "$log"
    exit 1
  fi
  sleep "$poll"
done

sent=0
while :; do
  total="$(wc -l < "$log" 2>/dev/null | tr -d ' ')"
  total="${total:-0}"
  if (( total > sent )); then
    sed -n "$(( sent + 1 )),${total}p" "$log"
    sent="$total"
  fi
  # Checked after flushing so the terminal event is always delivered first.
  if sed -n "1,${total}p" "$log" 2>/dev/null | grep -q '"kind":"watch_end"'; then
    exit 0
  fi
  sleep "$poll"
done
