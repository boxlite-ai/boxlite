#!/usr/bin/env bash
# Consumer installer loader. The adopted release's scripts/install.sh owns installation.
# Before one is adopted, this validates the profile and hold BEFORE any network call
# (the fetch URL comes from the profile), fetches the named release into a scratch
# directory, and runs that release's installer.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$repo_root" ]] || { printf 'agent-tooling: run inside a Git repository\n' >&2; exit 2; }
cache="$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)/agent-tooling"
revision=""
[[ ! -r "$cache/current" ]] || IFS= read -r revision < "$cache/current" || true
runtime="$cache/$revision/plugins/boxlite-agent-tooling/scripts/install.sh"
if [[ "$revision" =~ ^[0-9a-f]{40}$ && -x "$runtime" ]]; then
  exec bash "$runtime" "$@"
fi

fail() { printf 'agent-tooling: %s\n' "$1" >&2; exit 1; }
profile_file="$repo_root/.agent-tooling/profile.json"
[[ -r "$profile_file" ]] || fail "missing $profile_file"
command -v jq >/dev/null 2>&1 || fail "jq is required"
repo="$(jq -r '.tooling.repository // empty | strings' "$profile_file")"
[[ "$repo" == boxlite-ai/agent-tooling ]] || fail "unsupported tooling repository: $repo"
ref="$(jq -r '.tooling.ref // empty | strings' "$profile_file")"
[[ -n "$ref" ]] || fail "tooling.ref must name the branch to float on in $profile_file"
[[ ! "$ref" =~ ^[0-9a-f]{40}$ ]] || fail "tooling.ref names a branch; to freeze a revision write it to .agent-tooling/hold"
if [[ "$ref" == -* ]] || ! git check-ref-format "refs/heads/$ref" >/dev/null 2>&1; then
  fail "tooling.ref is not a valid branch name: $ref"
fi
hold_file="$repo_root/.agent-tooling/hold"
if [[ -e "$hold_file" ]]; then
  sha="$(tr -d '\n' < "$hold_file")"
  [[ "$sha" =~ ^[0-9a-f]{40}$ && "$(wc -c < "$hold_file")" -le 41 ]] \
    || fail "$hold_file must contain exactly one full lowercase commit SHA"
else
  sha=""
  read -r sha _ < <(git ls-remote "https://github.com/$repo.git" "refs/heads/$ref") || true
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "could not resolve $ref on $repo and no revision is installed"
fi

# A linked-worktree hook exports GIT_DIR; scratch Git calls must not inherit it.
scratch_git() {
  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_INDEX_FILE -u GIT_PREFIX \
    -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_NAMESPACE \
    git -C "$scratch" "$@"
}
mkdir -p "$cache"
scratch="$(mktemp -d "$cache/.bootstrap.XXXXXX")"
trap 'rm -rf -- "$scratch"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
scratch_git init -q
scratch_git fetch -q --depth 1 "https://github.com/$repo.git" "$sha"
scratch_git -c advice.detachedHead=false checkout -q --detach "$sha"
[[ "$(scratch_git rev-parse HEAD)" == "$sha" ]] || fail "fetched revision does not match $sha"
bash "$scratch/plugins/boxlite-agent-tooling/scripts/install.sh" "$@"
