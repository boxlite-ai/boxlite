# Building a Custom Kernel with CONFIG_9P_FS=y for True 9p Support

## Problem

### Background: BoxLite's Two-Layer Architecture

BoxLite runs a lightweight VM with a **fixed Linux kernel** (not user-changeable), inside
which it starts OCI containers using user-specified images (alpine, python, ubuntu, etc.).
The kernel, initramfs, and guest agent are BoxLite runtime components; the OCI image is
user-specified. The 9p changes discussed here affect **only the kernel layer**.

### Kernel Version Mismatch

The current VM kernel comes from two completely different delivery mechanisms
depending on the host platform:

| Host Platform | Kernel Delivery | Version | SHARED Mount | 9P Problem? |
|---------------|----------------|---------|-------------|:-----------:|
| macOS / Linux | Embedded in `libkrunfw.dylib` / `libkrunfw.so` | 6.12.62 | **virtiofs** (works) | No |
| Windows (WHPX) | Standalone `vmlinuz` file (no libkrunfw) | 6.12.62 | **virtio-9p** (needs kernel support) | **Yes** |

Both platforms use the same kernel source and config (from the libkrunfw project),
but Windows does not use the libkrunfw library at all — the kernel is a standalone
file read from disk. The 9P problem only exists on Windows because macOS/Linux use
virtiofs instead.

To add 9p filesystem support to the guest, we attempted to use **pre-built kernel modules**
from Alpine's `linux-virt` package (version 6.12.81-0-virt). These modules were:

- `9pnet.ko` (232 KB) -- 9P network protocol core
- `9pnet_virtio.ko` (42 KB) -- 9P over virtio transport
- `9p.ko` (203 KB) -- 9P filesystem client

We added them to the initramfs and had the init script load them with `modprobe`.

### The Failure: vermagic Mismatch

Linux kernel modules contain a `vermagic` string that **must exactly match** the running
kernel's version. This is a safety mechanism to prevent loading incompatible modules:

```
Module vermagic:  6.12.81-0-virt SMP preempt mod_unload aarch64
Running kernel:   6.12.62
```

When the guest tried to load the 9p modules, the kernel rejected them with `ENODEV`
(No such device). The version strings `6.12.81` vs `6.12.62` don't match, so the
kernel refuses to load the modules regardless of whether they're actually compatible.

This cannot be worked around without either:
1. Forcing module load (`modprobe --force`) -- dangerous, may crash
2. Building modules against the exact kernel source (complex)
3. **Building 9p support directly into the kernel** (this document)

### Current Workaround: Fault-Tolerant SHARED Mount

As a temporary measure, the guest agent (`volume.rs`) catches the SHARED mount failure
and falls back to a plain directory:

```
SHARED filesystem mount failed (ENODEV), using plain directory at /run/boxlite/shared
```

This works because the container rootfs uses **virtio-blk block devices** (not 9p), so
the OCI container lifecycle is unaffected. The SHARED mount is only needed for future
host-guest file sharing features.

### Why This Only Affects Windows (For Now)

On macOS/Linux, the VMM provides **virtiofs** (not 9p) for the SHARED mount, which
works without kernel modules (virtiofs support is built into libkrunfw's kernel).
On Windows WHPX, the VMM provides **virtio-9p** instead, which requires kernel 9p
support -- hence the problem.

---

## Solution: Build Kernel with CONFIG_9P_FS=y

Setting `CONFIG_9P_FS=y` compiles the 9P filesystem driver **directly into the kernel
binary**. No module loading, no vermagic matching, no initramfs module files needed.

### Linux Kernel Config Options

Linux kernel config has three states for each feature:

| Value | Meaning | File |
|-------|---------|------|
| `=n` | Not compiled at all | -- |
| `=m` | Loadable module (`.ko` file, needs `modprobe`) | `lib/modules/.../*.ko` |
| `=y` | **Built into kernel binary** (available at boot) | Part of `vmlinux`/`bzImage` |

### Three Approaches

| Approach | Pros | Cons |
|----------|------|------|
| **A. CONFIG_9P_FS=y (recommended)** | No module loading, works immediately, simpler boot | Slightly larger kernel (~200KB), requires kernel rebuild |
| **B. Build modules against same kernel source** | Kernel binary unchanged, fast build (~1 min) | Requires exact same .config, initramfs management, fragile vermagic |
| C. Use pre-built modules from distro | No build needed | **Fails** — vermagic mismatch (current situation) |

**Approach A is strongly preferred** for long-term stability. Approach B can be used
for quick validation before committing to A.

### Impact by Platform

| Platform | 9P Needed? | Action |
|----------|:----------:|--------|
| **Windows (WHPX)** | **Yes** — VMM provides virtio-9p | Replace `vmlinuz` file in `BOXLITE_RUNTIME_DIR` |
| **macOS / Linux** | **No** — VMM provides virtiofs | No changes needed (virtiofs is already built into libkrunfw's kernel) |

This is a **Windows-only problem**. On macOS/Linux, the SHARED mount uses virtiofs
(not 9p), which already works out of the box. The kernel rebuild described in this
document only needs to happen for the Windows `vmlinuz` file.

---

## Build Process

### Prerequisites

The kernel must be built for **x86_64** (BoxLite guest VMs are always x86_64, even on
ARM64 macOS hosts). You need an x86_64 Linux build environment:

```bash
# On x86_64 Linux (or cross-compile environment):
sudo apt-get install build-essential bc flex bison libelf-dev libssl-dev
```

Alternatively, use a Lima VM, Docker container, or CI runner with x86_64 architecture.

### Step 1: Get the Kernel Source

The kernel version must match the running VM kernel exactly (currently **6.12.62**).
This is the same version used by the libkrunfw project to build its embedded kernel.

```bash
KERNEL_VERSION="6.12.62"
wget https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${KERNEL_VERSION}.tar.xz
tar xf linux-${KERNEL_VERSION}.tar.xz
cd linux-${KERNEL_VERSION}
```

### Step 2: Get the Base Kernel Config

The kernel config originates from the libkrunfw project (used by both platforms):

```bash
# The config is in the libkrunfw repository (vendored in BoxLite):
# src/deps/libkrun-sys/vendor/libkrunfw/config-libkrunfw_x86_64
cp /path/to/libkrunfw/config-libkrunfw_x86_64 .config
```

Note: On **Windows**, libkrunfw is NOT used at runtime (the kernel is a standalone
file), but the config still originates from the libkrunfw project because both
platforms build from the same kernel source.

If you don't have the exact config, you can extract it from the running kernel
(if `CONFIG_IKCONFIG=y`) or start from `make tinyconfig` and enable what's needed.

### Step 3: Enable 9P Filesystem Support

```bash
# Using the scripts/config helper:
./scripts/config --enable CONFIG_NET_9P           # 9P network protocol
./scripts/config --enable CONFIG_NET_9P_VIRTIO    # 9P over virtio transport
./scripts/config --enable CONFIG_9P_FS            # 9P filesystem client
./scripts/config --enable CONFIG_9P_FS_POSIX_ACL  # POSIX ACLs on 9P mounts
./scripts/config --enable CONFIG_9P_FS_SECURITY   # Security labels on 9P mounts
```

The dependency chain:

```
CONFIG_NET_9P          (equivalent to 9pnet.ko)
  +-- CONFIG_NET_9P_VIRTIO  (equivalent to 9pnet_virtio.ko)
CONFIG_9P_FS           (equivalent to 9p.ko)
  +-- depends on CONFIG_NET_9P
```

Or edit `.config` manually:

```
CONFIG_NET_9P=y
CONFIG_NET_9P_VIRTIO=y
CONFIG_9P_FS=y
CONFIG_9P_FS_POSIX_ACL=y
CONFIG_9P_FS_SECURITY=y
```

### Step 4: Resolve Config Dependencies

```bash
make olddefconfig
# Fills in defaults for any new options introduced by 9P enablement
```

### Step 5: Build the Kernel

```bash
make -j$(nproc) bzImage
```

Output: `arch/x86/boot/bzImage` (compressed, ~5-8 MB)

Build time: ~5-15 minutes depending on CPU.

### Step 6: Verify 9P is Built-In

```bash
# Check config:
grep "9P" .config
# Expected:
#   CONFIG_NET_9P=y
#   CONFIG_NET_9P_VIRTIO=y
#   CONFIG_9P_FS=y
#   CONFIG_9P_FS_POSIX_ACL=y
#   CONFIG_9P_FS_SECURITY=y

# Verify protocol string is in the binary:
grep -c "9p2000" arch/x86/boot/bzImage
# Should be > 0
```

### Step 7: Deploy (Windows Only)

```bash
# Copy to runtime directory
cp arch/x86/boot/bzImage C:\ws-boxlite\runtime\vmlinuz
```

The WHPX VMM reads `vmlinuz` directly from disk via `std::fs::read(kernel_path)`
(see `runner.rs:141`), so replacing the file is all that's needed. No library
recompilation, no libkrunfw rebuild — Windows does not use libkrunfw.

macOS/Linux do not need this change (they use virtiofs, not 9p).

---

## Optional: Build ALL Drivers Built-In

For maximum simplicity, build everything currently loaded as modules into the kernel:

```bash
./scripts/config --enable CONFIG_VIRTIO_BLK       # Block device (currently =m)
./scripts/config --enable CONFIG_EXT4_FS           # Root filesystem (currently =m)
./scripts/config --enable CONFIG_VSOCK             # Host-guest communication
./scripts/config --enable CONFIG_VIRTIO_VSOCKETS   # Virtio vsock transport
./scripts/config --enable CONFIG_NET_9P
./scripts/config --enable CONFIG_NET_9P_VIRTIO
./scripts/config --enable CONFIG_9P_FS
```

This eliminates the initramfs entirely -- the kernel can mount the root ext4 directly
and 9p mounts work immediately. Tradeoffs:

| | With initramfs (current) | All built-in |
|--|--|--|
| Kernel size | ~5 MB + 1.5 MB initrd | ~5.5 MB (no initrd) |
| Boot complexity | init script loads modules | Direct mount |
| Flexibility | Can add modules without rebuild | Must rebuild kernel |
| Boot speed | Slightly slower (module loading) | Slightly faster |

---

## Impact on Existing Code

Once the kernel has built-in 9p support:

1. **Guest `virtiofs.rs`** -- The 9p fallback path will **succeed** on Windows
   (currently falls through to the fault-tolerant error handler in `volume.rs`)
2. **Guest `volume.rs`** -- The fault-tolerant SHARED mount catch becomes a safety net
   rather than the primary path
3. **Initramfs** -- The 9p modules (`9pnet.ko`, `9pnet_virtio.ko`, `9p.ko`) can be
   removed, and the `modprobe 9pnet 9pnet_virtio 9p` lines become no-ops
4. **No user-facing changes** -- OCI images and SDK API are unaffected

### Expected Guest Log (After Fix)

```
[guest] Mounted 9p: BoxLiteShared -> /run/boxlite/shared
```

Instead of the current:

```
[guest] SHARED filesystem mount failed (ENODEV), using plain directory at /run/boxlite/shared
```

---

## Verification Checklist

After deploying the new kernel:

1. Boot VM on Windows WHPX
2. `cat /proc/filesystems | grep 9p` -- should show `nodev  9p`
3. `mount | grep BoxLiteShared` -- should show `BoxLiteShared on /run/boxlite/shared type 9p`
4. Run full E2E test (`vm-bench.py`) -- all 8 phases pass
5. Create a file on host in shared dir, verify visible in guest (and vice versa)
