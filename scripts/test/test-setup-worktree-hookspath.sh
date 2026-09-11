#!/usr/bin/env bash
# Regression: make/setup must clear worktree-local core.hooksPath before prek install (#1482)
set -euo pipefail

scratch="$(mktemp -d "${TMPDIR:-/tmp}/boxlite-hooks-path-test.XXXXXX")"

cleanup() {
    case "$scratch" in
        "${TMPDIR:-/tmp}"/boxlite-hooks-path-test.*) rm -rf -- "$scratch" ;;
        *) printf 'refusing to clean unexpected test path: %s\n' "$scratch" >&2 ;;
    esac
}
trap cleanup EXIT

fail() {
    printf 'test-setup-worktree-hookspath: %s\n' "$1" >&2
    exit 1
}

main_repo="$scratch/main"
worktree="$scratch/wt"
mkdir -p "$main_repo"
git -C "$main_repo" init -q -b main
git -C "$main_repo" config user.name "BoxLite Setup Test"
git -C "$main_repo" config user.email "setup-test@boxlite.invalid"
git -C "$main_repo" config extensions.worktreeConfig true
printf 'seed\n' >"$main_repo/README.md"
git -C "$main_repo" add README.md
git -C "$main_repo" commit -qm seed

git -C "$main_repo" worktree add -q "$worktree" -b wt-branch

# Emulate agent-tooling worktree-local redirect (#1482).
git -C "$worktree" config --worktree core.hooksPath "$scratch/stale-hooks"
mkdir -p "$scratch/stale-hooks"

before="$(git -C "$worktree" config --worktree --get core.hooksPath || true)"
[[ -n "$before" ]] || fail "failed to seed worktree-local core.hooksPath"
case "$before" in
    *stale-hooks*) ;;
    *) fail "unexpected seeded value: $before" ;;
esac

# Same two commands setup-common.sh runs before prek install.
git -C "$worktree" config --local --unset-all core.hooksPath 2>/dev/null || true
git -C "$worktree" config --worktree --unset-all core.hooksPath 2>/dev/null || true

after="$(git -C "$worktree" config --worktree --get core.hooksPath || true)"
[[ -z "$after" ]] || fail "worktree-local core.hooksPath still set to '$after'"

# Idempotent: second unset must not fail under set -e.
git -C "$worktree" config --local --unset-all core.hooksPath 2>/dev/null || true
git -C "$worktree" config --worktree --unset-all core.hooksPath 2>/dev/null || true

printf 'test-setup-worktree-hookspath: ok\n'
