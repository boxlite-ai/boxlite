#!/bin/bash
# Setup git submodules for BoxLite development.
#
# This script is safe to run repeatedly. It initializes only missing
# submodules and leaves existing submodule checkouts untouched.

set -e

SETUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$SETUP_DIR/.." && pwd)"
# common.sh is resolved from this script's directory above.
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

# Fail closed before an automatic checkout can contact an unexpected remote.
validate_submodule() {
    local repo_root="$1"
    local name="$2"
    local expected_path="$3"
    local expected_url="$4"
    local actual_path
    local actual_url

    actual_path="$(git config -f "$repo_root/.gitmodules" --get "submodule.$name.path" || true)"
    actual_url="$(git config -f "$repo_root/.gitmodules" --get "submodule.$name.url" || true)"
    if [[ "$actual_path" != "$expected_path" || "$actual_url" != "$expected_url" ]]; then
        print_error "Refusing unexpected submodule $name (path=$actual_path, url=$actual_url)" >&2
        return 1
    fi
}

# Validate the complete set because this script performs an automatic network checkout.
validate_submodules() {
    local repo_root="$1"
    local submodule_count

    if [[ ! -f "$repo_root/.gitmodules" ]]; then
        print_error "Expected a BoxLite checkout with .gitmodules" >&2
        return 1
    fi

    submodule_count="$(git config -f "$repo_root/.gitmodules" --get-regexp '^submodule\..*\.path$' 2>/dev/null | wc -l | tr -d ' ')"
    if [[ "$submodule_count" != "4" ]]; then
        print_error "Expected 4 submodules, found $submodule_count" >&2
        return 1
    fi

    validate_submodule \
        "$repo_root" \
        "src/deps/libkrun-sys/vendor/libkrun" \
        "src/deps/libkrun-sys/vendor/libkrun" \
        "https://github.com/boxlite-ai/libkrun.git"
    validate_submodule \
        "$repo_root" \
        "src/deps/libkrun-sys/vendor/libkrunfw" \
        "src/deps/libkrun-sys/vendor/libkrunfw" \
        "https://github.com/boxlite-ai/libkrunfw.git"
    validate_submodule \
        "$repo_root" \
        "src/deps/e2fsprogs-sys/vendor/e2fsprogs" \
        "src/deps/e2fsprogs-sys/vendor/e2fsprogs" \
        "https://github.com/tytso/e2fsprogs.git"
    validate_submodule \
        "$repo_root" \
        "src/deps/bubblewrap-sys/vendor/bubblewrap" \
        "src/deps/bubblewrap-sys/vendor/bubblewrap" \
        "https://github.com/containers/bubblewrap.git"
}

# `git submodule status` prefixes a submodule with "-" only while its gitlink is
# absent. A clone interrupted between fetch and checkout keeps the gitlink and the
# fetched objects but leaves an empty index and no worktree files, so it reports "+"
# or " " and reads as healthy. Emit those paths too, or the broken checkout is never
# repaired.
unchecked_paths() {
    local repo_root="$1"
    local path

    # Fields are "<status><sha> <path> [(describe)]"; only the path is needed.
    while read -r _ path _; do
        [[ -n "$path" ]] || continue
        if [[ ! -e "$repo_root/$path/.git" ]]; then
            printf '%s\n' "$path"
        elif [[ -z "$(git -C "$repo_root/$path" ls-files --cached 2>/dev/null | head -n 1)" ]]; then
            printf '%s\n' "$path"
        fi
    done
}

validate_jobs() {
    local jobs="$1"

    if [[ ! "$jobs" =~ ^[1-9][0-9]*$ ]] || ((jobs > 16)); then
        print_error "BOXLITE_SUBMODULE_JOBS must be between 1 and 16, got $jobs" >&2
        return 1
    fi
}

main() {
    local repo_root="${1:-$PROJECT_ROOT}"
    local jobs="${BOXLITE_SUBMODULE_JOBS:-4}"
    local submodule_status
    local path
    local unchecked=()

    validate_submodules "$repo_root"
    validate_jobs "$jobs"

    submodule_status="$(git -C "$repo_root" submodule status)"
    if grep -q '^U' <<<"$submodule_status"; then
        print_error "Refusing to update conflicted submodules" >&2
        return 1
    fi

    print_step "Checking git submodules... "
    while IFS= read -r path; do
        [[ -n "$path" ]] || continue
        unchecked+=("$path")
    done < <(unchecked_paths "$repo_root" <<<"$submodule_status")

    if ((${#unchecked[@]} == 0)); then
        print_success "Already initialized"
        return 0
    fi

    echo -e "${YELLOW}Initializing with $jobs jobs...${NC}"
    git -C "$repo_root" submodule sync
    # --force is what re-runs the checkout when the recorded commit already matches
    # the submodule's HEAD — the interrupted-clone case. It is confined to the paths
    # with no checkout, so a healthy submodule's local changes are never discarded.
    git -C "$repo_root" submodule update --init --force --depth 1 --jobs "$jobs" \
        -- "${unchecked[@]}"
    print_success "Submodules initialized"
}

main "$@"
