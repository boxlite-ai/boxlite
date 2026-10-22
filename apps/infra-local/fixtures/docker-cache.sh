#!/bin/sh
# Qualified Docker 27.5.1 guest cache entrypoint; see docs/guides/runner-local-cache.md.
# Requires docker:27.5.1-dind with e2fsprogs and util-linux installed.
# /cache must be an exclusively leased BoxLite runner cache volume.
set -eu

cache=/cache
root=/var/lib/docker
image=$cache/docker.ext4
profile=$cache/docker-profile
mkdir -p /run "$root"
exec 9>/run/boxlite-docker-cache.lock
flock -n 9 || { echo 'Docker cache is already mounted by this guest' >&2; exit 1; }
test -d "$cache" && test ! -L "$cache"
mountpoint -q "$cache" || { echo '/cache must be a mounted runner cache' >&2; exit 1; }
test ! -L "$image" && test ! -L "$profile"
docker --version | grep -q '^Docker version 27\.5\.1, ' || {
    echo 'Docker cache requires Docker 27.5.1' >&2; exit 1;
}
dockerd --version | grep -q '^Docker version 27\.5\.1, ' || {
    echo 'Docker cache requires dockerd 27.5.1' >&2; exit 1;
}
containerd --version | grep -q ' v1\.7\.25 ' || {
    echo 'Docker cache requires containerd v1.7.25' >&2; exit 1;
}
cat >/run/docker-profile.expected <<'PROFILE'
format=2
docker=27.5.1
containerd=1.7.25
driver=overlay2
data-root=/var/lib/docker
containerd-snapshotter=false
dns-search=.
filesystem=ext4
size-bytes=2147483648
PROFILE
if test -e "$profile"; then
    cmp /run/docker-profile.expected "$profile" || {
        echo 'Docker cache profile mismatch; use a different cache ID' >&2
        exit 1
    }
    test -f "$image" || { echo 'Docker cache image is missing' >&2; exit 1; }
else
    test ! -e "$image" || { echo 'Refuse unprofiled Docker cache image' >&2; exit 1; }
    cp /run/docker-profile.expected "$profile"
    truncate -s 2147483648 "$image"
    mkfs.ext4 -F "$image"
    sync
fi

# The runner lease excludes every other Box, including after runner restart.
# Do not mount a damaged filesystem or recreate an existing image on failure.
rc=0
e2fsck -p "$image" || rc=$?
test "$rc" -le 1 || { echo "Docker cache fsck failed: $rc" >&2; exit "$rc"; }
test -e /dev/loop-control || mknod /dev/loop-control c 10 237
test -e /dev/loop0 || mknod /dev/loop0 b 7 0
loop=$(losetup --find --show "$image")
if ! mount -t ext4 "$loop" "$root"; then
    losetup -d "$loop"
    exit 1
fi
printf '%s\n' "$loop" >/run/boxlite-docker-cache.loop
cat >/run/boxlite-docker.json <<'CONFIG'
{"hosts":["unix:///var/run/docker.sock"],"data-root":"/var/lib/docker","storage-driver":"overlay2","features":{"containerd-snapshotter":false},"dns-search":["."]}
CONFIG
dockerd --config-file=/run/boxlite-docker.json &
daemon=$!
trap 'kill -TERM "$daemon" 2>/dev/null || true' TERM INT
status=0
wait "$daemon" || status=$?
# A signal may interrupt wait before dockerd finishes its shutdown.
if kill -0 "$daemon" 2>/dev/null; then
    wait "$daemon" || status=$?
fi
sync
umount "$root"
losetup -d "$loop"
rm -f /run/boxlite-docker-cache.loop
exit "$status"
