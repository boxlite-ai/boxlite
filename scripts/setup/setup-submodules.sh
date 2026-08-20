#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
if [[ -z "$repo_root" || ! -f "$repo_root/.gitmodules" ]]; then
    printf 'setup:submodules: expected a BoxLite checkout with .gitmodules\n' >&2
    exit 1
fi

validate_submodule() {
    local name="$1"
    local expected_path="$2"
    local expected_url="$3"
    local actual_path
    local actual_url

    actual_path="$(git config -f "$repo_root/.gitmodules" --get "submodule.$name.path" || true)"
    actual_url="$(git config -f "$repo_root/.gitmodules" --get "submodule.$name.url" || true)"
    if [[ "$actual_path" != "$expected_path" || "$actual_url" != "$expected_url" ]]; then
        printf 'setup:submodules: refusing unexpected submodule %s (path=%s, url=%s)\n' \
            "$name" "$actual_path" "$actual_url" >&2
        exit 1
    fi
}

submodule_count="$(git config -f "$repo_root/.gitmodules" --get-regexp '^submodule\..*\.path$' 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$submodule_count" != "4" ]]; then
    printf 'setup:submodules: expected 4 submodules, found %s\n' "$submodule_count" >&2
    exit 1
fi

validate_submodule \
    "src/deps/libkrun-sys/vendor/libkrun" \
    "src/deps/libkrun-sys/vendor/libkrun" \
    "https://github.com/boxlite-ai/libkrun.git"
validate_submodule \
    "src/deps/libkrun-sys/vendor/libkrunfw" \
    "src/deps/libkrun-sys/vendor/libkrunfw" \
    "https://github.com/boxlite-ai/libkrunfw.git"
validate_submodule \
    "src/deps/e2fsprogs-sys/vendor/e2fsprogs" \
    "src/deps/e2fsprogs-sys/vendor/e2fsprogs" \
    "https://github.com/tytso/e2fsprogs.git"
validate_submodule \
    "src/deps/bubblewrap-sys/vendor/bubblewrap" \
    "src/deps/bubblewrap-sys/vendor/bubblewrap" \
    "https://github.com/containers/bubblewrap.git"

jobs="${BOXLITE_SUBMODULE_JOBS:-4}"
if [[ ! "$jobs" =~ ^[1-9][0-9]*$ ]] || ((jobs > 16)); then
    printf 'setup:submodules: BOXLITE_SUBMODULE_JOBS must be between 1 and 16, got %s\n' "$jobs" >&2
    exit 1
fi

submodule_status="$(git -C "$repo_root" submodule status --recursive)"
if grep -q '^U' <<<"$submodule_status"; then
    printf 'setup:submodules: refusing to update conflicted submodules\n' >&2
    exit 1
fi

if ! grep -q '^-' <<<"$submodule_status"; then
    printf 'setup:submodules: already initialized\n'
    exit 0
fi

printf 'setup:submodules: initializing missing submodules with %s jobs\n' "$jobs"
git -C "$repo_root" submodule sync --recursive
git -C "$repo_root" submodule update --init --recursive --depth 1 --jobs "$jobs"
printf 'setup:submodules: initialized\n'
