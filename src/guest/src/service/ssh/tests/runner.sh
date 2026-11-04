#!/bin/sh
# Nextest invokes the runner both to list tests and to execute one test.
for arg do
    if [ "$arg" = --list ]; then
        exec "$@"
    fi
done

if [ -z "${NEXTEST_TEST_NAME:-}" ]; then
    echo 'Guest test runner requires NEXTEST_TEST_NAME; upgrade nextest to 0.9.116 or newer.' >&2
    exit 1
fi

case "$NEXTEST_TEST_NAME" in
    service::ssh::tests::*|service::ssh::persistence::tests::*)
        original_mount_namespace=$(readlink /proc/self/ns/mnt) || exit 1
        if [ "$(id -u)" -eq 0 ]; then
            exec unshare --mount --propagation private -- env BOXLITE_SSH_TEST_MOUNT_NAMESPACE="$original_mount_namespace" "$@"
        fi
        exec unshare --user --map-root-user --mount --propagation private -- env BOXLITE_SSH_TEST_MOUNT_NAMESPACE="$original_mount_namespace" "$@"
        ;;
    *) exec "$@" ;;
esac
