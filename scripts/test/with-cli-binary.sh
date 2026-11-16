#!/usr/bin/env bash
# Resolve subprocess CLI paths from Cargo artifacts, independent of test layout.
set -euo pipefail

coverage=false
if [[ "${1:-}" == --coverage ]]; then
    coverage=true
    shift
fi
if [[ $# == 0 ]]; then
    echo 'Usage: with-cli-binary.sh [--coverage] COMMAND [ARG...]' >&2
    exit 2
fi

command -v jq >/dev/null 2>&1 || {
    echo 'jq is required to locate the CLI executable from Cargo artifacts' >&2
    exit 1
}

if "$coverage"; then
    # Match cargo-llvm-cov's collector directories, including separate build dirs.
    if [[ -n "${CARGO_LLVM_COV_TARGET_DIR:-}" ]]; then
        coverage_target="$CARGO_LLVM_COV_TARGET_DIR"
        coverage_build="${CARGO_LLVM_COV_BUILD_DIR:-$coverage_target}"
    else
        metadata="$(cargo metadata --no-deps --format-version=1)"
        coverage_target="$(jq -er '.target_directory + "/llvm-cov-target"' <<<"$metadata")"
        coverage_build="$(jq -er '(.build_directory // .target_directory) + "/llvm-cov-target"' <<<"$metadata")"
    fi
    [[ "$coverage_target" == /* ]] || coverage_target="$PWD/$coverage_target"
    [[ "$coverage_build" == /* ]] || coverage_build="$PWD/$coverage_build"
    export CARGO_LLVM_COV_TARGET_DIR="$coverage_target"
    export CARGO_LLVM_COV_BUILD_DIR="$coverage_build"
fi

artifacts="$(mktemp "${TMPDIR:-/tmp}/boxlite-cli-artifacts.XXXXXX")"
trap 'rm -f "$artifacts"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
(
    if "$coverage"; then
        # Trusted output from the installed collector. Keep instrumentation out
        # of the subsequent llvm-cov command. show-env overwrites collector dirs,
        # so use the separately saved selections for this preparatory build.
        coverage_env="$(cargo llvm-cov show-env --sh)"
        eval "$coverage_env"
        export CARGO_TARGET_DIR="$coverage_target"
        export CARGO_BUILD_BUILD_DIR="$coverage_build"
    fi
    cargo build -p boxlite-cli --bin boxlite --message-format=json-render-diagnostics
) > "$artifacts"

cli_executable="$(jq -ers '
    [.[] | select(.reason == "compiler-artifact"
        and .target.name == "boxlite" and .target.kind == ["bin"]
        and .profile.test == false)] |
    if length == 1 and (.[0].executable | type) == "string"
    then .[0].executable
    else error("expected exactly one non-test boxlite binary artifact") end
' "$artifacts")"
if [[ "$cli_executable" != /* || ! -f "$cli_executable" || ! -x "$cli_executable" ]]; then
    printf 'Cargo reported an invalid CLI executable: %s\n' "$cli_executable" >&2
    exit 1
fi
export CARGO_BIN_EXE_boxlite="$cli_executable"
# exec does not run EXIT traps: remove the artifact stream before handing off.
rm -f "$artifacts"
trap - EXIT
exec "$@"
