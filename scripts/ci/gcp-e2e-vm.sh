#!/bin/bash
# Drive the e2e-local GCP VM from GitHub Actions as the controller service
# account (ci-gha-e2e-ctl).
#
# Usage: gcp-e2e-vm.sh start|stop|clear-token
#   start        hand the VM a fresh runner registration token and boot it;
#                reuse it when it already runs with its runner online
#   stop         request a stop without waiting
#   clear-token  remove the registration token from the VM's metadata
#
# The controller holds only compute.instances.get/start/stop/setMetadata on
# this one VM. It lacks compute.zoneOperations.get, so nothing here waits on
# a gcloud operation: start/stop use --async, status is polled, and metadata
# is written through the setMetadata REST call.
#
# Env: GCP_PROJECT, GCP_ZONE, GCP_INSTANCE, RUNNER_LABEL, REPO, and GH_TOKEN
# (a GitHub App token with administration:write).
set -euo pipefail

: "${GCP_PROJECT:?}" "${GCP_ZONE:?}" "${GCP_INSTANCE:?}" "${RUNNER_LABEL:?}" "${REPO:?}"

TOKEN_KEY=runner-reg-token

vm() {
    gcloud compute instances "$1" "$GCP_INSTANCE" \
        --project "$GCP_PROJECT" --zone "$GCP_ZONE" "${@:2}"
}

vm_status() {
    vm describe --format='value(status)'
}

wait_status() {
    for _ in $(seq 60); do
        [ "$(vm_status)" = "$1" ] && return 0
        sleep 5
    done
    echo "::error::$GCP_INSTANCE did not reach $1 within 5 minutes" >&2
    return 1
}

runner_online() {
    gh api "repos/$REPO/actions/runners" --jq "any(.runners[];
        .status == \"online\" and any(.labels[]; .name == \"$RUNNER_LABEL\"))" | grep -qx true
}

# set_token VALUE: store VALUE under TOKEN_KEY, or drop the key when VALUE is empty.
set_token() {
    vm describe --format=json |
        jq -c --arg key "$TOKEN_KEY" --arg value "$1" '{
            fingerprint: .metadata.fingerprint,
            items: ([(.metadata.items // [])[] | select(.key != $key)]
                + (if $value == "" then [] else [{key: $key, value: $value}] end))
        }' |
        curl -fsS -o /dev/null -X POST \
            -H "Authorization: Bearer $(gcloud auth print-access-token)" \
            -H 'Content-Type: application/json' --data-binary @- \
            "https://compute.googleapis.com/compute/v1/projects/$GCP_PROJECT/zones/$GCP_ZONE/instances/$GCP_INSTANCE/setMetadata"
}

has_token() {
    vm describe --format=json |
        jq -e --arg key "$TOKEN_KEY" 'any(.metadata.items[]?; .key == $key)' >/dev/null
}

start() {
    local status token
    status=$(vm_status)
    if [ "$status" = RUNNING ] && runner_online; then
        echo "$GCP_INSTANCE is running with its runner online"
        return 0
    fi
    if [ "$status" != TERMINATED ]; then
        echo "$GCP_INSTANCE is $status without an online runner; stopping it first"
        [ "$status" = STOPPING ] || vm stop --async
        wait_status TERMINATED
    fi

    token=$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token)
    echo "::add-mask::$token"
    set_token "$token"
    # setMetadata is asynchronous; boot only once the startup script can read the token.
    for _ in $(seq 30); do
        has_token && break
        sleep 2
    done
    has_token || { echo "::error::the registration token never reached the VM metadata" >&2; return 1; }

    vm start --async
    wait_status RUNNING
}

case "${1:-}" in
    start) start ;;
    stop) vm stop --async ;;
    clear-token) set_token "" ;;
    *) echo "usage: $0 start|stop|clear-token" >&2; exit 2 ;;
esac
