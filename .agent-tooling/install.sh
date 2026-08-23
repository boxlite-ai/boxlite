#!/usr/bin/env bash
# Consumer bootstrap: install the tooling revision this repository floats on.
#
# The profile declares a BRANCH (`tooling.ref`), not a revision. This script resolves
# the branch tip, fetches that exact commit into the immutable content-addressed cache
# (.git/agent-tooling/<sha>/), runs the fetched revision's own setup — which validates
# the profile and configures the Git gates — and only THEN records the revision as
# current. `current` is written last on purpose: it means "fully adopted", so a crash
# anywhere earlier leaves the previous revision active and verifiable.
#
# The recorded revision, not the profile, is what scripts/verify-installation.sh holds
# commits and pushes to — a pure local check, so gates stay fail-closed offline while
# resolution happens only here and in scripts/refresh-installation.sh.
#
# Emergency brake: a `.agent-tooling/hold` file containing exactly one full lowercase
# commit SHA freezes the installation at that revision (resolution is skipped
# entirely). A malformed hold aborts the installation — a broken brake must stop the
# vehicle, never quietly keep floating.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$repo_root" ]] || { printf 'agent-tooling: run inside a Git repository\n' >&2; exit 2; }
profile_file="$repo_root/.agent-tooling/profile.json"
[[ -r "$profile_file" ]] || { printf 'agent-tooling: missing %s\n' "$profile_file" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { printf 'agent-tooling: jq is required\n' >&2; exit 1; }

tooling_repo="$(jq -er '.tooling.repository | select(type == "string" and length > 0)' "$profile_file")" || {
  printf 'agent-tooling: tooling.repository is required\n' >&2
  exit 1
}
[[ "$tooling_repo" == "boxlite-ai/agent-tooling" ]] || {
  printf 'agent-tooling: unsupported tooling repository: %s\n' "$tooling_repo" >&2
  exit 1
}
tooling_ref="$(jq -er '.tooling.ref | select(type == "string" and length > 0)' "$profile_file")" || {
  printf 'agent-tooling: tooling.ref must name the branch to float on\n' >&2
  exit 1
}
[[ ! "$tooling_ref" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'agent-tooling: tooling.ref names a branch; to freeze a revision write it to .agent-tooling/hold\n' >&2
  exit 1
}
# check-ref-format allows a leading dash (it is legal REF syntax); refuse it anyway
# so the ref can never read as an option to anything downstream.
if [[ "$tooling_ref" == -* ]] || ! git check-ref-format "refs/heads/$tooling_ref" >/dev/null 2>&1; then
  printf 'agent-tooling: tooling.ref is not a valid branch name: %s\n' "$tooling_ref" >&2
  exit 1
fi

common_git_dir="$(git -C "$repo_root" rev-parse --git-common-dir)"
[[ "$common_git_dir" == /* ]] || common_git_dir="$repo_root/$common_git_dir"
cache_parent="$common_git_dir/agent-tooling"
record_file="$cache_parent/current"
mkdir -p "$cache_parent"

recorded_sha() {
  local rec
  rec="$(head -n1 "$record_file" 2>/dev/null || true)"
  [[ "$rec" =~ ^[0-9a-f]{40}$ ]] || return 1
  printf '%s' "$rec"
}

hold_file="$repo_root/.agent-tooling/hold"
target_sha=""
target_source=""
if [[ -e "$hold_file" ]]; then
  hold_sha="$(tr -d '\n' < "$hold_file")"
  { [[ "$hold_sha" =~ ^[0-9a-f]{40}$ ]] && [[ "$(wc -c < "$hold_file")" -le 41 ]]; } || {
    printf 'agent-tooling: %s must contain exactly one full lowercase commit SHA\n' "$hold_file" >&2
    exit 1
  }
  target_sha="$hold_sha"
  target_source="hold"
else
  resolved="$(git ls-remote "https://github.com/$tooling_repo.git" "refs/heads/$tooling_ref" 2>/dev/null | awk 'NR==1{print $1}')" || true
  if [[ "$resolved" =~ ^[0-9a-f]{40}$ ]]; then
    target_sha="$resolved"
    target_source="$tooling_ref"
  else
    # Offline (or the branch is gone). An installed consumer keeps working on the
    # last adopted revision; only the very first installation needs the network.
    if current="$(recorded_sha)" && [[ -d "$cache_parent/$current" ]]; then
      printf 'agent-tooling: could not resolve %s on %s; keeping %s\n' "$tooling_ref" "$tooling_repo" "$current" >&2
      exit 0
    fi
    printf 'agent-tooling: could not resolve %s on %s and no revision is installed\n' "$tooling_ref" "$tooling_repo" >&2
    exit 1
  fi
fi

lock_dir="$cache_parent/.install.lock"
if ! mkdir "$lock_dir" 2>/dev/null; then
  printf 'agent-tooling: another installation is already in progress: %s\n' "$lock_dir" >&2
  exit 1
fi
printf '%s\n' "$$" > "$lock_dir/pid"

scratch=""
cleanup() {
  if [[ -n "$scratch" && -d "$scratch" && "$scratch" == "$cache_parent"/.install.* ]]; then
    rm -rf -- "$scratch"
  fi
  rm -f -- "$lock_dir/pid"
  rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

checkout="$cache_parent/$target_sha"
if [[ -e "$checkout" ]]; then
  actual="$(git -C "$checkout" rev-parse HEAD 2>/dev/null || true)"
  [[ "$actual" == "$target_sha" ]] || {
    printf 'agent-tooling: cached checkout has unexpected HEAD: %s\n' "$checkout" >&2
    exit 1
  }
else
  scratch="$(mktemp -d "$cache_parent/.install.XXXXXX")"
  git -C "$scratch" init -q
  git -C "$scratch" remote add origin "https://github.com/$tooling_repo.git"
  git -C "$scratch" fetch -q --depth 1 origin "$target_sha"
  git -C "$scratch" -c advice.detachedHead=false checkout -q --detach "$target_sha"
  actual="$(git -C "$scratch" rev-parse HEAD)"
  [[ "$actual" == "$target_sha" ]] || {
    printf 'agent-tooling: fetched %s instead of resolved %s\n' "$actual" "$target_sha" >&2
    exit 1
  }
  mv "$scratch" "$checkout"
  scratch=""
fi

setup="$checkout/plugins/boxlite-agent-tooling/scripts/setup.sh"
[[ -x "$setup" ]] || { printf 'agent-tooling: fetched checkout has no executable setup script\n' >&2; exit 1; }
"$setup" "$repo_root"

# Adopt: everything above succeeded, so this revision is now "current". The record
# moves FIRST, then the metadata — deliberately. A crash between these writes can
# cost the history a line for an adoption that DID happen (a detectable gap: current
# has no matching tail entry); metadata-first would let the history claim an adoption
# that never happened, and a trail that can lie is worse than one that can skip.
tmp_record="$cache_parent/.current.$$"
printf '%s\n' "$target_sha" > "$tmp_record"
mv "$tmp_record" "$record_file"
printf '%s %s %s\n' "$(date +%s)" "$target_source" "$target_sha" >> "$cache_parent/history.log"
touch "$cache_parent/last-check"
printf 'agent-tooling: adopted %s (%s)\n' "$target_sha" "$target_source"
