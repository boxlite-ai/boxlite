#!/bin/sh
# Demo: install FUSE, mount a custom filesystem, read from it, cleanup.
set -e

# 1. Install FUSE + fusepy
apt-get update -qq > /dev/null 2>&1
apt-get install -y -qq fuse3 libfuse-dev > /dev/null 2>&1
pip install -q fusepy > /dev/null 2>&1

# 2. Ensure /dev/fuse exists (slim images may lack modprobe)
if [ ! -e /dev/fuse ]; then
    mknod /dev/fuse c 10 229
    chmod 666 /dev/fuse
fi

# 3. Mount the FUSE filesystem in background
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
python3 "$SCRIPT_DIR/hellofs.py" /mnt/hello &
sleep 2

# 4. Demo: read from the virtual filesystem
echo "=== ls /mnt/hello ==="
ls -la /mnt/hello/
echo "=== cat /mnt/hello/hello.txt ==="
cat /mnt/hello/hello.txt
echo "=== mount info ==="
mount | grep hello

# 5. Cleanup
fusermount3 -u /mnt/hello
echo "done"
