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
# A zone out of capacity (ZONE_RESOURCE_POOL_EXHAUSTED) rejects a start and
# leaves the VM TERMINATED; capacity often returns within minutes.
START_ATTEMPTS=6
START_RETRY_DELAY=60

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

# boot_vm: start the VM, retrying while the zone rejects the start.
boot_vm() {
    local attempt
    for attempt in $(seq "$START_ATTEMPTS"); do
        vm start --async
        if wait_booted; then
            return 0
        fi
        echo "::warning::$GCP_INSTANCE start attempt $attempt/$START_ATTEMPTS was rejected; $GCP_ZONE may lack capacity" >&2
        [ "$attempt" = "$START_ATTEMPTS" ] || sleep "$START_RETRY_DELAY"
    done
    echo "::error::could not start $GCP_INSTANCE after $START_ATTEMPTS attempts" >&2
    return 1
}

# wait_booted: succeed once RUNNING; fail when the VM sits TERMINATED for a
# minute, which means the start was rejected. Without
# compute.zoneOperations.get the status is the only signal.
wait_booted() {
    local status terminated=0
    for _ in $(seq 60); do
        status=$(vm_status)
        [ "$status" = RUNNING ] && return 0
        if [ "$status" = TERMINATED ]; then
            terminated=$((terminated + 1))
            [ "$terminated" -lt 12 ] || return 1
        else
            terminated=0
        fi
        sleep 5
    done
    echo "::error::$GCP_INSTANCE did not reach RUNNING within 5 minutes" >&2
    exit 1
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

# stored_token: print the stored token, or "" when absent; fails when metadata cannot be read.
stored_token() {
    local instance
    instance=$(vm describe --format=json) || return 1
    jq -er --arg key "$TOKEN_KEY" \
        '[.metadata.items[]? | select(.key == $key) | .value] | first // ""' <<<"$instance"
}

# wait_token VALUE: setMetadata is asynchronous; wait until the stored token is
# VALUE ("" = absent). A failed read never counts as a match.
wait_token() {
    local current
    for _ in $(seq 30); do
        if current=$(stored_token) && [ "$current" = "$1" ]; then
            return 0
        fi
        sleep 2
    done
    echo "::error::the registration token in VM metadata did not reach the expected state" >&2
    return 1
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
    # Boot only once the startup script can read this token, not a stale one.
    wait_token "$token"

    boot_vm
}

case "${1:-}" in
    start) start ;;
    stop) vm stop --async ;;
    # e2e-tests runs PR code on the VM next, so confirm the token is gone.
    clear-token) set_token "" && wait_token "" ;;
    *) echo "usage: $0 start|stop|clear-token" >&2; exit 2 ;;
esac
