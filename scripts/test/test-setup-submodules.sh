#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
subject="$repo_root/scripts/setup/setup-submodules.sh"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/boxlite-submodules-test.XXXXXX")"

cleanup() {
    case "$scratch" in
        "${TMPDIR:-/tmp}"/boxlite-submodules-test.*) rm -rf -- "$scratch" ;;
        *) printf 'refusing to clean unexpected test path: %s\n' "$scratch" >&2 ;;
    esac
}
trap cleanup EXIT

fail() {
    printf 'test-setup-submodules: %s\n' "$1" >&2
    exit 1
}

[[ -x "$subject" ]] || fail "production setup script is missing or not executable"

create_remote() {
    local owner="$1"
    local repository="$2"
    local seed="$scratch/seed-$owner-$repository"
    local bare="$scratch/remotes/$owner/$repository.git"

    mkdir -p "$seed" "$(dirname "$bare")"
    git -C "$seed" init -q -b main
    git -C "$seed" config user.name "BoxLite Setup Test"
    git -C "$seed" config user.email "setup-test@boxlite.invalid"
    printf '%s/%s\n' "$owner" "$repository" >"$seed/README.md"
    git -C "$seed" add README.md
    git -C "$seed" commit -qm "seed $owner/$repository"
    git clone -q --bare "$seed" "$bare"
    git -C "$seed" rev-parse HEAD
}

libkrun_oid="$(create_remote boxlite-ai libkrun)"
libkrunfw_oid="$(create_remote boxlite-ai libkrunfw)"
e2fsprogs_oid="$(create_remote tytso e2fsprogs)"
bubblewrap_oid="$(create_remote containers bubblewrap)"

fixture="$scratch/superproject"
mkdir -p "$fixture"
git -C "$fixture" init -q -b main
git -C "$fixture" config user.name "BoxLite Setup Test"
git -C "$fixture" config user.email "setup-test@boxlite.invalid"
git config -f "$scratch/gitconfig" "url.file://$scratch/remotes/boxlite-ai/.insteadOf" "https://github.com/boxlite-ai/"
git config -f "$scratch/gitconfig" "url.file://$scratch/remotes/tytso/.insteadOf" "https://github.com/tytso/"
git config -f "$scratch/gitconfig" "url.file://$scratch/remotes/containers/.insteadOf" "https://github.com/containers/"
cp "$repo_root/.gitmodules" "$fixture/.gitmodules"
git -C "$fixture" add .gitmodules
git -C "$fixture" update-index --add --cacheinfo "160000,$libkrun_oid,src/deps/libkrun-sys/vendor/libkrun"
git -C "$fixture" update-index --add --cacheinfo "160000,$libkrunfw_oid,src/deps/libkrun-sys/vendor/libkrunfw"
git -C "$fixture" update-index --add --cacheinfo "160000,$e2fsprogs_oid,src/deps/e2fsprogs-sys/vendor/e2fsprogs"
git -C "$fixture" update-index --add --cacheinfo "160000,$bubblewrap_oid,src/deps/bubblewrap-sys/vendor/bubblewrap"
git -C "$fixture" commit -qm "add fixture submodules"

cp "$fixture/.gitmodules" "$scratch/gitmodules.original"
git config -f "$fixture/.gitmodules" submodule.src/deps/libkrun-sys/vendor/libkrun.url \
    "https://example.invalid/libkrun.git"
if "$subject" "$fixture" >"$scratch/unexpected-url.log" 2>&1; then
    fail "unexpected URL was accepted"
fi
grep -q 'refusing unexpected submodule' "$scratch/unexpected-url.log" || \
    fail "unexpected URL failure was not explicit"
cp "$scratch/gitmodules.original" "$fixture/.gitmodules"

git config -f "$fixture/.gitmodules" submodule.src/deps/libkrun-sys/vendor/libkrun.path \
    "src/deps/libkrun-sys/vendor/unexpected"
if "$subject" "$fixture" >"$scratch/unexpected-path.log" 2>&1; then
    fail "unexpected submodule path was accepted"
fi
grep -q 'refusing unexpected submodule' "$scratch/unexpected-path.log" || \
    fail "unexpected path failure was not explicit"
cp "$scratch/gitmodules.original" "$fixture/.gitmodules"

git config -f "$fixture/.gitmodules" submodule.extra.path extra
if "$subject" "$fixture" >"$scratch/unexpected-count.log" 2>&1; then
    fail "unexpected submodule count was accepted"
fi
grep -q 'expected 4 submodules, found 5' "$scratch/unexpected-count.log" || \
    fail "unexpected count failure was not explicit"
cp "$scratch/gitmodules.original" "$fixture/.gitmodules"

for invalid_jobs in 0 17; do
    if BOXLITE_SUBMODULE_JOBS="$invalid_jobs" "$subject" "$fixture" \
        >"$scratch/invalid-jobs-$invalid_jobs.log" 2>&1; then
        fail "invalid job count $invalid_jobs was accepted"
    fi
    grep -q 'must be between 1 and 16' "$scratch/invalid-jobs-$invalid_jobs.log" || \
        fail "job-count $invalid_jobs failure was not explicit"
done

missing_count="$(git -C "$fixture" submodule status --recursive | grep -c '^-')"
[[ "$missing_count" == "4" ]] || fail "expected 4 missing submodules, found $missing_count"

GIT_CONFIG_GLOBAL="$scratch/gitconfig" GIT_ALLOW_PROTOCOL=file:https \
    BOXLITE_SUBMODULE_JOBS=2 "$subject" "$fixture" \
    >"$scratch/first-run.log"
grep -q 'initialized' "$scratch/first-run.log" || fail "first run did not initialize submodules"

verify_oid() {
    local path="$1"
    local expected
    local actual

    expected="$(git -C "$fixture" rev-parse "HEAD:$path")"
    actual="$(git -C "$fixture/$path" rev-parse HEAD)"
    [[ "$actual" == "$expected" ]] || fail "$path checked out $actual instead of $expected"
}

verify_oid "src/deps/libkrun-sys/vendor/libkrun"
verify_oid "src/deps/libkrun-sys/vendor/libkrunfw"
verify_oid "src/deps/e2fsprogs-sys/vendor/e2fsprogs"
verify_oid "src/deps/bubblewrap-sys/vendor/bubblewrap"

if git -C "$fixture" submodule status --recursive | grep -q '^[+-U]'; then
    fail "initialized submodule status was not clean"
fi

GIT_CONFIG_GLOBAL="$scratch/gitconfig" GIT_ALLOW_PROTOCOL=file:https \
    "$subject" "$fixture" >"$scratch/second-run.log"
grep -q 'already initialized' "$scratch/second-run.log" || fail "second run was not idempotent"

printf 'test-setup-submodules: all checks passed\n'
