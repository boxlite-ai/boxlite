#!/usr/bin/env bash
# Deploy the current checkout on a dedicated KVM host, then test official URLs.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

[[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] || {
    echo "ERROR: readable/writable /dev/kvm is required for real-VM proxy E2E" >&2
    exit 1
}
[[ -f apps/api/src/box/controllers/box-endpoint.controller.ts ]] || {
    echo "ERROR: this checkout must include the official endpoint API (PR #1597)" >&2
    exit 1
}

export BOXLITE_E2E_WITH_PROXY=1
export BOXLITE_E2E_SOURCE_SHA
BOXLITE_E2E_SOURCE_SHA="$(git rev-parse HEAD)"
export BOXLITE_E2E_API_URL=http://localhost:3000/api
export BOXLITE_E2E_AUTH=api-key
# Local deployment verifies Host routing, not external DNS provisioning.
export BOXLITE_E2E_PROXY_CONNECT_HOST=127.0.0.1
export BOXLITE_E2E_SKIP_PATH_VERIFY=0
unset BOXLITE_E2E_PREFIX
mkdir -p target/e2e-proxy
printf '%s\n' "$BOXLITE_E2E_SOURCE_SHA" > target/e2e-proxy/source-revision.txt

cleanup() {
    local result=$?
    trap - EXIT
    # These units belong to the dedicated E2E stack; keep DB/build caches.
    if ! sudo systemctl stop boxlite-proxy boxlite-runner boxlite-api; then
        echo "ERROR: failed to stop E2E services" >&2
        result=1
    fi
    exit "$result"
}
trap cleanup EXIT

# Always rebuild/restart; a healthy service might still be running an older SHA.
bash apps/e2e/bootstrap.sh
# A fresh bootstrap may have installed rustup in its child shell.
# shellcheck disable=SC1091
source "$HOME/.cargo/env"
make dev:python
# Bootstrap owns this path and creates these local test credentials. They are
# passed only in the environment, never printed or embedded in test reports.
# shellcheck disable=SC1090
source "${SECRETS_FILE:-/etc/boxlite-secrets.env}"
export BOXLITE_E2E_API_KEY="$ADMIN_API_KEY"
timeout --signal=TERM --kill-after=30s 10m make test:e2e:proxy
