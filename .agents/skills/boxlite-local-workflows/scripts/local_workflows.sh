#!/usr/bin/env bash
# Run reproducible local BoxLite workflows.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
DRY_RUN=0

usage() {
    cat <<'EOF'
Usage: local_workflows.sh [OPTIONS] WORKFLOW [-- COMMAND...]

Workflows:
  apps
    make dev:go
    VERSION=<workspace version> GOFLAGS=-tags=boxlite_dev make build:apps

  e2e-local
    generate clients, run the apps build, then npm --prefix apps run e2e:local

  infra-local
    make -C apps/infra-local up

  redeploy-infra-local
    Regenerate clients, build all apps, and restart all infra-local L2 apps.

Default local deployment: infra-local. Select a workflow explicitly.

The e2e-local workflow starts the local Dex E2E environment. If COMMAND is
omitted, it keeps the environment running until interrupted.

Options:
  --dry-run       Print commands without executing them
  -h, --help      Show this help

Examples:
  local_workflows.sh apps
  local_workflows.sh e2e-local -- npm --prefix apps run e2e:dev
  local_workflows.sh e2e-local -- npx playwright test
  local_workflows.sh infra-local
  local_workflows.sh redeploy-infra-local

For the apps workflow, VERSION defaults to the [workspace.package] version in
Cargo.toml. An explicit VERSION environment variable is preserved.

Build sequence for apps:
  make dev:go
  VERSION=<workspace version> GOFLAGS=-tags=boxlite_dev make build:apps
EOF
}

die() {
    echo "error: $*" >&2
    exit 2
}

run() {
    printf '+'
    printf ' %q' "$@"
    printf '\n'
    if [ "$DRY_RUN" -eq 0 ]; then
        "$@"
    fi
}

run_make() {
    run make -C "$REPO_ROOT" "$@"
}

read_workspace_version() {
    local cargo_toml="$REPO_ROOT/Cargo.toml"

    [ -f "$cargo_toml" ] || die "missing workspace manifest '$cargo_toml'"

    awk '
        /^\[workspace\.package\]$/ { in_workspace_package=1; next }
        /^\[/ { in_workspace_package=0 }
        in_workspace_package && /^[[:space:]]*version[[:space:]]*=/ {
            value = $0
            sub(/^[^"]*"/, "", value)
            sub(/".*$/, "", value)
            print value
            exit
        }
    ' "$cargo_toml"
}

run_apps_workflow() {
    local apps_version="${VERSION:-$(read_workspace_version)}"
    [ -n "$apps_version" ] || die "could not read workspace version from '$REPO_ROOT/Cargo.toml'"

    run_make dev:go
    run env VERSION="$apps_version" GOFLAGS=-tags=boxlite_dev make -C "$REPO_ROOT" build:apps
}

workflow=""
workflow_args=()
while [ "$#" -gt 0 ]; do
    case "$1" in
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        --)
            [ -n "$workflow" ] || die "select a workflow before '--'"
            shift
            workflow_args=("$@")
            break
            ;;
        apps|e2e-local|infra-local|redeploy-infra-local)
            [ -z "$workflow" ] || die "only one workflow may be selected"
            workflow="$1"
            shift
            ;;
        *)
            die "unknown argument '$1' (use --help for usage)"
            ;;
    esac
done

[ -n "$workflow" ] || { usage >&2; exit 2; }

case "$workflow" in
    apps)
        [ "${#workflow_args[@]}" -eq 0 ] || die "apps does not accept a command after '--'"
        run_apps_workflow
        ;;
    e2e-local)
        run npm --prefix "$REPO_ROOT/apps" run generate:api-client
        run_apps_workflow
        if [ "${#workflow_args[@]}" -eq 0 ]; then
            run npm --prefix "$REPO_ROOT/apps" run e2e:local -- --
        else
            run npm --prefix "$REPO_ROOT/apps" run e2e:local -- -- "${workflow_args[@]}"
        fi
        ;;
    infra-local)
        [ "${#workflow_args[@]}" -eq 0 ] || die "infra-local does not accept a command after '--'"

        run make -C "$REPO_ROOT/apps/infra-local" up
        run make -C "$REPO_ROOT/apps/infra-local" status
        ;;
    redeploy-infra-local)
        [ "${#workflow_args[@]}" -eq 0 ] || die "redeploy-infra-local does not accept a command after '--'"
        run npm --prefix "$REPO_ROOT/apps" run generate:api-client
        run_apps_workflow

        # The public workflow is "all". The Makefile's actual interface uses
        # COMPONENTS= for the four L2 applications.
        run make -C "$REPO_ROOT/apps/infra-local" restart \
            "COMPONENTS=api runner proxy dashboard"
        ;;
    *)
        die "unsupported workflow '$workflow'"
        ;;
esac
