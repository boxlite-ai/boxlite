#!/usr/bin/env bash
# Build custom initramfs for BoxLite Windows WHPX boot.
#
# The Alpine linux-virt kernel has VIRTIO_BLK=m and no built-in vsock,
# so we must load modules from initramfs before mounting the rootfs.
#
# Included modules (extracted from the kernel build):
#   - virtio_blk.ko          (block device for rootfs)
#   - ext4.ko                (filesystem, if built as module)
#   - vsock.ko               (AF_VSOCK protocol family)
#   - vmw_vsock_virtio_transport_common.ko
#   - vmw_vsock_virtio_transport.ko
#   - 9pnet.ko               (9P network protocol)
#   - 9pnet_virtio.ko        (9P over virtio transport)
#   - 9p.ko                  (9P filesystem)
#
# Also includes a statically-linked busybox for /init, mount, insmod, etc.
#
# Usage:
#   ./scripts/build/build-initrd-windows.sh <kernel_source_dir> [output_path]
#
# Arguments:
#   kernel_source_dir  - Path to the built kernel source tree (contains modules)
#   output_path        - Output initrd.img path (default: target/kernel-windows-x86_64/initrd.img)
#
# Prerequisites (Ubuntu/Debian):
#   sudo apt-get install busybox-static cpio gzip

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

KERNEL_SRC="${1:?Usage: $0 <kernel_source_dir> [output_path]}"
OUTPUT="${2:-$REPO_ROOT/target/kernel-windows-x86_64/initrd.img}"

# Verify kernel source
if [ ! -d "$KERNEL_SRC" ]; then
    echo "ERROR: Kernel source directory not found: $KERNEL_SRC"
    exit 1
fi

# Find busybox (static)
BUSYBOX=""
for candidate in /bin/busybox busybox-static busybox; do
    path=$(command -v "$candidate" 2>/dev/null || true)
    if [ -n "$path" ] && file "$path" | grep -q "statically linked"; then
        BUSYBOX="$path"
        break
    fi
done

if [ -z "$BUSYBOX" ]; then
    # Try the common static path on Ubuntu/Debian
    if [ -x "/bin/busybox" ]; then
        BUSYBOX="/bin/busybox"
        echo "WARNING: busybox at $BUSYBOX may not be statically linked"
    else
        echo "ERROR: Static busybox not found."
        echo "Install: sudo apt-get install busybox-static"
        exit 1
    fi
fi

echo "=== Building initramfs for WHPX ==="
echo "Kernel source: $KERNEL_SRC"
echo "Busybox:       $BUSYBOX"
echo "Output:        $OUTPUT"
echo ""

# Create temp initrd structure
INITRD_DIR=$(mktemp -d)
trap 'rm -rf "$INITRD_DIR"' EXIT

# ── Directory structure ──────────────────────────────────────────────────

mkdir -p "$INITRD_DIR"/{bin,dev,lib/modules,mnt/root,proc,sys}

# ── Busybox ──────────────────────────────────────────────────────────────

cp "$BUSYBOX" "$INITRD_DIR/bin/busybox"
chmod 755 "$INITRD_DIR/bin/busybox"

# Create essential symlinks
for cmd in sh mount umount insmod cat switch_root sleep; do
    ln -sf busybox "$INITRD_DIR/bin/$cmd"
done

# ── Kernel modules ───────────────────────────────────────────────────────

# Find the modules directory in the kernel build
MOD_DIR=""
# Check for modules installed via `make modules_install`
if [ -d "$KERNEL_SRC/modules_install" ]; then
    MOD_DIR=$(find "$KERNEL_SRC/modules_install" -name 'kernel' -type d | head -1)
fi
# Check in the build tree directly
if [ -z "$MOD_DIR" ] || [ ! -d "$MOD_DIR" ]; then
    # Modules are built in-tree at their source locations
    MOD_DIR="$KERNEL_SRC"
fi

echo "--- Collecting kernel modules ---"

# Required modules and their typical paths in the kernel tree
declare -A MODULE_PATHS=(
    ["virtio_blk.ko"]="drivers/block/virtio_blk.ko"
    ["ext4.ko"]="fs/ext4/ext4.ko"
    ["vsock.ko"]="net/vmw_vsock/vsock.ko"
    ["vmw_vsock_virtio_transport_common.ko"]="net/vmw_vsock/vmw_vsock_virtio_transport_common.ko"
    ["vmw_vsock_virtio_transport.ko"]="net/vmw_vsock/vmw_vsock_virtio_transport.ko"
    ["9pnet.ko"]="net/9p/9pnet.ko"
    ["9pnet_virtio.ko"]="net/9p/9pnet_virtio.ko"
    ["9p.ko"]="fs/9p/9p.ko"
)

# Also check for dependency modules that may be needed
declare -A OPTIONAL_MODULES=(
    ["jbd2.ko"]="fs/jbd2/jbd2.ko"
    ["crc16.ko"]="lib/crc16.ko"
    ["mbcache.ko"]="fs/mbcache.ko"
)

FOUND=0
MISSING=0

for mod in "${!MODULE_PATHS[@]}"; do
    rel_path="${MODULE_PATHS[$mod]}"
    found=0

    # Try the expected path first
    if [ -f "$MOD_DIR/$rel_path" ]; then
        cp "$MOD_DIR/$rel_path" "$INITRD_DIR/lib/modules/$mod"
        found=1
    else
        # Fall back to find
        mod_path=$(find "$KERNEL_SRC" -name "$mod" -path '*/kernel/*' 2>/dev/null | head -1)
        if [ -z "$mod_path" ]; then
            # Also search without kernel/ prefix (modules_install layout)
            mod_path=$(find "$KERNEL_SRC" -name "$mod" 2>/dev/null | head -1)
        fi
        if [ -n "$mod_path" ]; then
            cp "$mod_path" "$INITRD_DIR/lib/modules/$mod"
            found=1
        fi
    fi

    if [ "$found" -eq 1 ]; then
        echo "  Found: $mod"
        FOUND=$((FOUND + 1))
    else
        echo "  MISSING: $mod (may be built-in)"
        MISSING=$((MISSING + 1))
    fi
done

# Collect optional dependency modules (best-effort)
for mod in "${!OPTIONAL_MODULES[@]}"; do
    rel_path="${OPTIONAL_MODULES[$mod]}"
    if [ -f "$MOD_DIR/$rel_path" ]; then
        cp "$MOD_DIR/$rel_path" "$INITRD_DIR/lib/modules/$mod"
        echo "  Found (optional): $mod"
    else
        mod_path=$(find "$KERNEL_SRC" -name "$mod" 2>/dev/null | head -1)
        if [ -n "$mod_path" ]; then
            cp "$mod_path" "$INITRD_DIR/lib/modules/$mod"
            echo "  Found (optional): $mod"
        fi
    fi
done

echo "  Modules: $FOUND found, $MISSING missing"

# ── Init script ──────────────────────────────────────────────────────────

cat > "$INITRD_DIR/init" << 'INIT_SCRIPT'
#!/bin/sh
# BoxLite WHPX initramfs init script.
# Loads required kernel modules and switch_root to the real rootfs.

/bin/mount -t proc proc /proc
/bin/mount -t sysfs sysfs /sys
/bin/mount -t devtmpfs devtmpfs /dev

# Load virtio block driver (needed for rootfs disk)
[ -f /lib/modules/virtio_blk.ko ] && /bin/insmod /lib/modules/virtio_blk.ko

# Load ext4 dependencies (if present as modules)
[ -f /lib/modules/crc16.ko ] && /bin/insmod /lib/modules/crc16.ko
[ -f /lib/modules/mbcache.ko ] && /bin/insmod /lib/modules/mbcache.ko
[ -f /lib/modules/jbd2.ko ] && /bin/insmod /lib/modules/jbd2.ko
[ -f /lib/modules/ext4.ko ] && /bin/insmod /lib/modules/ext4.ko

# Load vsock modules (needed for host-guest communication)
[ -f /lib/modules/vsock.ko ] && /bin/insmod /lib/modules/vsock.ko
[ -f /lib/modules/vmw_vsock_virtio_transport_common.ko ] && \
    /bin/insmod /lib/modules/vmw_vsock_virtio_transport_common.ko
[ -f /lib/modules/vmw_vsock_virtio_transport.ko ] && \
    /bin/insmod /lib/modules/vmw_vsock_virtio_transport.ko

# Load 9p modules (needed for host directory sharing via virtio-9p)
[ -f /lib/modules/9pnet.ko ] && /bin/insmod /lib/modules/9pnet.ko
[ -f /lib/modules/9pnet_virtio.ko ] && /bin/insmod /lib/modules/9pnet_virtio.ko
[ -f /lib/modules/9p.ko ] && /bin/insmod /lib/modules/9p.ko

# Parse root= and init= from kernel command line
ROOT_DEV=""
ROOT_FSTYPE=""
INIT_BIN="/init"
for param in $(/bin/cat /proc/cmdline); do
    case "$param" in
        root=*) ROOT_DEV="${param#root=}" ;;
        rootfstype=*) ROOT_FSTYPE="${param#rootfstype=}" ;;
        init=*) INIT_BIN="${param#init=}" ;;
    esac
done

# Wait briefly for block device to appear
if [ -n "$ROOT_DEV" ] && [ ! -e "$ROOT_DEV" ]; then
    /bin/sleep 0.1
fi

# Mount rootfs
if [ -n "$ROOT_DEV" ]; then
    MOUNT_OPTS=""
    if [ -n "$ROOT_FSTYPE" ]; then
        MOUNT_OPTS="-t $ROOT_FSTYPE"
    fi
    /bin/mount $MOUNT_OPTS "$ROOT_DEV" /mnt/root
fi

# Move virtual filesystems into the new root so they survive switch_root.
# Without this, /proc, /sys, /dev are unmounted and the guest agent
# (running as PID 1) would have no access to them.
for fs in proc sys dev; do
    [ -d "/mnt/root/$fs" ] && /bin/mount --move "/$fs" "/mnt/root/$fs"
done

# switch_root to the real rootfs, forwarding kernel -- args to init
exec /bin/switch_root /mnt/root "$INIT_BIN" "$@"
INIT_SCRIPT

chmod 755 "$INITRD_DIR/init"

# ── Pack initramfs ───────────────────────────────────────────────────────

echo ""
echo "--- Packing initramfs ---"

mkdir -p "$(dirname "$OUTPUT")"

(cd "$INITRD_DIR" && find . | cpio -o -H newc --quiet | gzip -9 > "$OUTPUT")

SIZE=$(du -h "$OUTPUT" | cut -f1)
FILE_COUNT=$(find "$INITRD_DIR" -type f | wc -l | tr -d ' ')
MOD_COUNT=$(ls "$INITRD_DIR/lib/modules/"*.ko 2>/dev/null | wc -l | tr -d ' ')

echo ""
echo "=== Done ==="
echo "Output:   $OUTPUT ($SIZE)"
echo "Files:    $FILE_COUNT total, $MOD_COUNT kernel modules"
echo "Init:     Loads virtio_blk + ext4 + vsock + 9p, parses root=/init= from cmdline"
