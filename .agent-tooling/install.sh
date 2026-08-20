#!/usr/bin/env bash
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
tooling_sha="$(jq -er '.tooling.sha | select(test("^[0-9a-f]{40}$"))' "$profile_file")" || {
  printf 'agent-tooling: tooling.sha must be a full 40-character lowercase commit SHA\n' >&2
  exit 1
}
[[ "$tooling_repo" == "boxlite-ai/agent-tooling" ]] || {
  printf 'agent-tooling: unsupported tooling repository: %s\n' "$tooling_repo" >&2
  exit 1
}

common_git_dir="$(git -C "$repo_root" rev-parse --git-common-dir)"
[[ "$common_git_dir" == /* ]] || common_git_dir="$repo_root/$common_git_dir"
cache_parent="$common_git_dir/agent-tooling"
checkout="$cache_parent/$tooling_sha"
mkdir -p "$cache_parent"

if [[ -e "$checkout" ]]; then
  actual="$(git -C "$checkout" rev-parse HEAD 2>/dev/null || true)"
  [[ "$actual" == "$tooling_sha" ]] || {
    printf 'agent-tooling: cached checkout has unexpected HEAD: %s\n' "$checkout" >&2
    exit 1
  }
else
  scratch="$(mktemp -d "$cache_parent/.install.XXXXXX")"
  cleanup() {
    if [[ -n "${scratch:-}" && -d "$scratch" && "$scratch" == "$cache_parent"/.install.* ]]; then
      rm -rf -- "$scratch"
    fi
  }
  trap cleanup EXIT INT TERM

  git -C "$scratch" init -q
  git -C "$scratch" remote add origin "https://github.com/$tooling_repo.git"
  git -C "$scratch" fetch -q --depth 1 origin "$tooling_sha"
  git -C "$scratch" -c advice.detachedHead=false checkout -q --detach "$tooling_sha"
  actual="$(git -C "$scratch" rev-parse HEAD)"
  [[ "$actual" == "$tooling_sha" ]] || {
    printf 'agent-tooling: fetched %s instead of pinned %s\n' "$actual" "$tooling_sha" >&2
    exit 1
  }
  mv "$scratch" "$checkout"
  scratch=""
  trap - EXIT INT TERM
fi

setup="$checkout/plugins/boxlite-agent-tooling/scripts/setup.sh"
[[ -x "$setup" ]] || { printf 'agent-tooling: pinned checkout has no executable setup script\n' >&2; exit 1; }
exec "$setup" "$repo_root"
