#!/bin/bash
# Startup script for the e2e-local GCP VM (ci-gha-e2e-1): registers the
# GitHub Actions runner on every boot.
#
# The VM has no service account. e2e-local.yml's start-runner job writes a
# fresh registration token to the `runner-reg-token` metadata key, starts the
# VM, and removes the key once the runner is online. Re-registering on every
# boot means a registration GitHub deleted heals on the next start.
#
# This file is the source of truth; the VM runs the copy in its
# `startup-script` metadata. After editing, update it with:
#   gcloud compute instances add-metadata ci-gha-e2e-1 --project boxlite-dev-project \
#     --zone us-east5-a --metadata-from-file startup-script=scripts/ci/gcp-e2e-startup.sh
set -euo pipefail

RUNNER_VERSION=2.338.1
RUNNER_NAME=ci-gha-e2e-1
RUNNER_LABELS=gcp-e2e
REPO_URL=https://github.com/boxlite-ai/boxlite
DIR=/opt/actions-runner

metadata() {
    curl -fsS -H 'Metadata-Flavor: Google' \
        "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"
}

mkdir -p "$DIR"
cd "$DIR"

if [ ! -x ./config.sh ]; then
    curl -fsSL -o runner.tgz \
        "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
    tar xzf runner.tgz
    rm runner.tgz
    ./bin/installdependencies.sh
fi

TOKEN=$(metadata runner-reg-token 2>/dev/null || true)
if [ -z "$TOKEN" ]; then
    echo "ci-gha-e2e: no runner-reg-token; keeping the existing registration"
    if [ -f .runner ]; then ./svc.sh start || true; fi
    exit 0
fi

# Drop the local registration so config.sh accepts the new token.
if [ -f .runner ]; then
    ./svc.sh stop || true
    ./svc.sh uninstall || true
    rm -f .runner .runner_migrated .credentials .credentials_rsaparams
fi

RUNNER_ALLOW_RUNASROOT=1 ./config.sh \
    --url "$REPO_URL" \
    --token "$TOKEN" \
    --name "$RUNNER_NAME" \
    --labels "$RUNNER_LABELS" \
    --unattended \
    --replace
./svc.sh install root
./svc.sh start
echo "ci-gha-e2e: runner $RUNNER_NAME registered"
