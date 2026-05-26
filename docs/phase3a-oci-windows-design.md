# Phase 3a: OCI Image Pipeline on Windows

> Design document for Windows OCI image support in BoxLite.
> Author: Claude (AI) + lilongen | Date: 2026-04-11

## Problem Statement

BoxLite's OCI image pipeline extracts container layers and creates ext4 disk
images using Unix-only APIs. On Windows (NTFS), these APIs are unavailable:

| Unix API | Usage | NTFS Equivalent |
|----------|-------|-----------------|
| `libc::mknod()` | Device nodes (block/char) | None |
| `libc::mkfifo()` | Named pipes (FIFO) | `CreateNamedPipe` (different semantics) |
| `std::os::unix::fs::symlink()` | Symbolic links | `CreateSymbolicLink` (requires privilege) |
| `libc::lchown()` | File ownership (UID/GID) | SIDs (incompatible model) |
| `xattr::set()` | Extended attributes | NTFS ADS (different API) |
| `mke2fs` | Create ext4 filesystem | No Windows build |
| `debugfs` | Modify ext4 filesystem | No Windows build |
| `cp -a` | Metadata-preserving copy | `robocopy /COPY:DAT` (lossy) |

The output of the pipeline is always an **ext4 disk image** — the guest VM
mounts it regardless of host OS. The question is: how do we create that ext4
image on Windows?

## Current Flow (Unix)

```
OCI Registry
    │
    ▼
┌─────────────────┐
│ 1. Pull image    │  ← oci-client crate (portable)
│    (tar blobs)   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 2. Extract layers│  ← tar.rs: symlink, mknod, lchown, xattr (UNIX ONLY)
│    to host fs    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 3. Create ext4   │  ← mke2fs + debugfs (UNIX ONLY)
│    disk image    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 4. QCOW2 COW    │  ← qcow2-rs crate (portable)
│    overlay       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 5. Boot VM       │  ← libkrun/libwkrun (platform-specific, already done)
└─────────────────┘
```

Steps 2 and 3 are the blockers. Steps 1, 4, and 5 are already portable.

## Key Insight

We don't need to extract OCI layers to NTFS. We need to go from
**tar blobs → ext4 disk image**. The intermediate host filesystem extraction
is an implementation detail, not a requirement.

---

## Strategy Comparison

### Strategy A: Builder VM (Recommended)

Use libwkrun to boot a temporary Linux helper VM that creates the ext4 disk.

```
Windows Host                          Builder VM (Linux)
┌─────────────┐                      ┌─────────────────────┐
│ Pull OCI     │                      │                     │
│ tar blobs    │──── virtio-blk ────►│ Extract tar layers   │
│              │     (raw disk with   │ mke2fs -d /merged   │
│              │      tar data)       │ debugfs fix-owner   │
│              │                      │                     │
│              │◄─── virtio-blk ─────│ Output: ext4 image   │
│ Install ext4 │     (ext4 result)    │                     │
│ to cache     │                      │ Exit                 │
└─────────────┘                      └─────────────────────┘
```

**Flow:**
1. Collect OCI tar layer blobs (already downloaded, in cache)
2. Create a raw disk image containing the tar blobs (concatenated with manifest)
3. Boot builder VM with: kernel + initramfs + input disk + output disk
4. Builder initramfs script: reads tar blobs, extracts, runs mke2fs, writes result
5. Builder VM exits; host reads ext4 result from output disk
6. Cache ext4 disk image (same as existing `ImageDiskManager` cache)

**Implementation:**

```
src/boxlite/src/
  images/
    builder_vm.rs      # NEW: Builder VM orchestration
    builder_vm/
      kernel           # Embedded: linux-virt kernel (~8MB compressed)
      initramfs.cpio   # Embedded: BusyBox + mke2fs + extraction script (~3MB)
```

Builder initramfs contents:
- BusyBox (shell, tar, cp)
- mke2fs + debugfs (statically linked from e2fsprogs)
- Builder script: `/init` (extracts layers, creates ext4, signals done)

**Pros:**
- Zero changes to existing extraction/ext4 code (reuses tar.rs, ext4.rs inside VM)
- Full OCI fidelity (device nodes, symlinks, xattrs, ownership)
- Same caching semantics (disk image cached per image digest)
- Docker Desktop uses this exact approach (LinuxKit VM)

**Cons:**
- VM boot latency (~2-5s per new image, amortized by cache)
- Increases embedded binary size (~11MB for kernel + initramfs)
- Complex orchestration (virtio-blk data passing)

**Effort:** ~2 weeks

---

### Strategy B: Pure Rust ext4 Writer

Implement ext4 image creation entirely in Rust, bypassing host filesystem.

```
tar blob → tar crate parser → ext4 writer → ext4 disk image
```

**Flow:**
1. Parse each tar layer with the `tar` crate (already a dependency)
2. Process OCI whiteouts (`.wh.` files for layer deletion)
3. Write files/dirs/symlinks/device nodes directly into an ext4 image structure
4. Output: ext4 disk image (same format as mke2fs output)

**Implementation:**

```
src/boxlite/src/
  disk/
    ext4_writer.rs     # NEW: Pure Rust ext4 filesystem builder
    ext4_writer/
      superblock.rs    # Ext4 superblock + block group descriptors
      inode.rs         # Inode table management
      directory.rs     # Directory entry hash tree
      extent.rs        # Extent-based block allocation
      journal.rs       # Minimal journal (clean unmount)
```

**Pros:**
- No VM overhead (instant disk creation)
- No embedded binaries (smaller distribution)
- Fully portable (works on any OS)
- Could replace mke2fs on all platforms

**Cons:**
- Complex (~4000-5000 LOC for ext4 layout)
- No production-ready Rust ext4 writer crate exists
- Must handle: extent trees, hash-tree directories, journal, block allocation
- Risk of subtle ext4 compatibility bugs
- No xattr support in minimal implementation (could add later)

**Effort:** ~4-6 weeks

---

### Strategy C: WSL2 Helper

Shell out to WSL2 to run Linux tools on Windows.

```
boxlite.exe → wsl.exe tar xf ... → wsl.exe mke2fs ... → ext4 disk
```

**Pros:**
- Simplest implementation (~200 LOC shim)
- Full tool availability (mke2fs, debugfs, cp, tar)

**Cons:**
- Requires WSL2 installed + Linux distro (~300MB)
- Users must manage WSL setup
- Not available on Windows Server without Hyper-V
- Slow cross-VM file I/O via 9P filesystem

**Effort:** ~1 week

---

## Recommendation

**Start with Strategy A (Builder VM)**, then optionally add Strategy B as an
optimization.

**Rationale:**
1. We already ship a Linux kernel + initramfs for the guest VM
2. libwkrun already boots VMs on Windows (Phase M1 complete)
3. The builder VM reuses 100% of existing extraction code
4. Docker Desktop validates this architecture at scale
5. The ~2-5s latency per new image is acceptable (cached after first pull)
6. Strategy B can be added later as a no-VM fast path if needed

### Why not WSL2?

WSL2 is a hard dependency that many Windows users don't have. BoxLite's value
proposition is "no daemon, no root, just embed" — requiring WSL2 contradicts
this. The builder VM approach is self-contained within BoxLite's own runtime.

### Why not Pure Rust first?

The ext4 filesystem format is complex. A correct implementation requires:
- Superblock + block group descriptors
- Inode allocation + extent trees
- Hash-tree directories (htree)
- Journal initialization (clean unmount marker)
- Block allocation bitmap management
- Special inode handling (lost+found, resize_inode)

This is ~4000-5000 LOC of low-level filesystem code. Starting with the builder
VM gives us working Windows support in 2 weeks; we can add the Rust ext4 writer
as a performance optimization later.

---

## Detailed Design: Strategy A (Builder VM)

### 1. Builder Image

**Embedded in BoxLite binary** (like existing `embedded-runtime` feature):

| Component | Size (compressed) | Source |
|-----------|------------------|--------|
| `vmlinuz-virt` | ~5MB | Alpine `linux-virt` package |
| `initramfs-builder.cpio.gz` | ~3MB | Custom: BusyBox + e2fsprogs |
| **Total** | ~8MB | |

The builder kernel is the same as the guest kernel. The initramfs is different:
a minimal environment with extraction tools instead of the guest agent.

**Initramfs `/init` script:**

```sh
#!/bin/sh
set -e

# Mount input disk (tar layers manifest + blobs)
mkdir -p /input /output /merged
mount /dev/vda /input      # virtio-blk: tar data
mount /dev/vdb /output     # virtio-blk: result ext4

# Read manifest (layer count, sizes, offsets)
. /input/manifest.sh

# Extract layers in order (same logic as tar.rs)
for layer in $LAYERS; do
    tar xf "/input/$layer" -C /merged
done

# Process whiteouts (OCI layer deletion markers)
find /merged -name '.wh.*' -exec sh -c '
    name="${1##*.wh.}"
    dir="$(dirname "$1")"
    rm -rf "$dir/$name" "$1"
' _ {} \;

# Create ext4 image
mke2fs -t ext4 -d /merged -r 1 -N 0 -m 0 \
    -O ^has_journal,extent,huge_file,flex_bg,metadata_csum,64bit,dir_nlink,extra_isize \
    /output/image.ext4 ${DISK_SIZE_BLOCKS}

# Fix ownership (all files to root:root if not already)
if [ $(id -u) -ne 0 ]; then
    debugfs -w -f /tmp/fix_owner.cmds /output/image.ext4
fi

# Signal completion
echo "DONE" > /output/.complete
poweroff -f
```

### 2. Data Passing via virtio-blk

Two raw disk images are used for host ↔ builder VM communication:

**Input disk** (host → builder):
```
┌──────────────────────────────────┐
│ Partition 1: ext4 (or raw)       │
│   /manifest.sh                   │  ← Layer names, sizes
│   /layer-0.tar.gz                │  ← OCI layer blob
│   /layer-1.tar.gz                │  ← OCI layer blob
│   ...                            │
└──────────────────────────────────┘
```

**Output disk** (builder → host):
```
┌──────────────────────────────────┐
│ Raw ext4 image                   │  ← The finished rootfs
│   /bin /etc /usr /var ...        │
│   /.complete                     │  ← Sentinel file
└──────────────────────────────────┘
```

**Alternative: 9P filesystem sharing**

If libwkrun's virtio-9p is available (it is — Phase 1 of libwkrun), we can
share a host directory instead of raw disk images:

```
Host directory: %TEMP%\boxlite-builder-{id}\
  input/
    manifest.sh
    layer-0.tar.gz
    layer-1.tar.gz
  output/
    image.ext4       ← Builder writes result here
```

The 9P approach is simpler (no disk image creation) but slower for large files.
For typical OCI images (<1GB), the difference is negligible.

**Recommendation:** Start with 9P (simpler), optimize to virtio-blk later if
needed.

### 3. API Design

```rust
// src/boxlite/src/images/builder_vm.rs

/// Builds an ext4 disk image from OCI layers using a Linux helper VM.
///
/// On Unix, this is never called (native mke2fs path is used).
/// On Windows, this replaces the native ext4 creation path.
pub struct ImageBuilder {
    kernel_path: PathBuf,
    initramfs_path: PathBuf,
}

impl ImageBuilder {
    /// Create ext4 disk image from OCI layer tar blobs.
    ///
    /// Boots a temporary builder VM, passes tar layers via 9P share,
    /// and collects the resulting ext4 image.
    pub async fn build_ext4(
        &self,
        layer_tarballs: &[PathBuf],
        output_path: &Path,
        disk_size: u64,
    ) -> BoxliteResult<()> {
        // 1. Create temp directory with input files
        // 2. Write manifest.sh
        // 3. Symlink/copy layer tarballs to input/
        // 4. Boot builder VM with 9P shares
        // 5. Wait for VM exit
        // 6. Verify output/.complete exists
        // 7. Move output/image.ext4 to output_path
    }
}
```

### 4. Integration Points

**`ImageDiskManager::build_and_install()`** — the main caller:

```rust
// Current (Unix):
let prepared = RootfsBuilder::new().prepare(merged_path, image).await?;
let temp_disk = create_ext4_from_dir(&prepared_path, &disk_clone)?;

// New (Windows):
#[cfg(unix)]
{
    let prepared = RootfsBuilder::new().prepare(merged_path, image).await?;
    let temp_disk = create_ext4_from_dir(&prepared_path, &disk_clone)?;
}
#[cfg(windows)]
{
    let layer_tarballs = image.layer_tarballs();
    let builder = ImageBuilder::from_embedded_runtime()?;
    builder.build_ext4(&layer_tarballs, &temp_disk_path, disk_size).await?;
}
```

**`GuestRootfsManager`** — guest binary injection:

Currently uses `inject_file_into_ext4()` (debugfs). On Windows, the builder VM
can also handle this — pass the guest binary along with the layers.

Alternatively, inject via a secondary builder VM invocation or include the
guest binary in the 9P share.

### 5. Caching

The caching layer (`ImageDiskManager`) is unchanged. The cache key is the
OCI image digest. Whether the ext4 was created by mke2fs or a builder VM,
the output is the same format and lives in the same cache directory.

First pull of a new image:
1. Download tar blobs (same as today)
2. Create ext4 via builder VM (~5-10s: 2s boot + extraction time)
3. Cache ext4 to `~/.boxlite/images/disk-images/{digest}.ext4`

Subsequent uses:
1. Cache hit → return immediately (same as today)

### 6. Guest Binary Injection

Current approach: `inject_file_into_ext4()` uses `debugfs write` to inject
`boxlite-guest` into the ext4 image after creation.

**Windows approach options:**

a) **Include in builder VM** — pass guest binary to builder VM, inject during
   ext4 creation. Requires the builder initramfs to handle injection.

b) **Separate injection VM** — boot a tiny VM just to run `debugfs write`.
   Simpler but adds another VM boot.

c) **Pre-inject in layers** — add guest binary as an additional "layer" on
   top of the OCI layers. The builder VM treats it like any other file.

**Recommendation:** Option (c) — pass guest binary as an additional file in the
9P share. The builder script copies it to the right location before running
mke2fs. This avoids a second VM boot and integrates naturally with the existing
flow.

---

## Implementation Plan

### Phase 3a-1: Builder Initramfs (1 week)

1. Create Alpine-based initramfs with BusyBox + e2fsprogs (static)
2. Write `/init` builder script
3. Test manually: boot with libwkrun, pass test data, verify ext4 output
4. Compress and embed in BoxLite binary

### Phase 3a-2: ImageBuilder API (1 week)

1. `images/builder_vm.rs` — VM orchestration
2. Wire into `ImageDiskManager::build_and_install()` with `#[cfg(windows)]`
3. Handle guest binary injection (option c)
4. Integration tests (mock VM for CI, real VM for local testing)

### Phase 3a-3: End-to-End Testing (3 days)

1. Test on Win10 dev machine: `boxlite run alpine echo hello`
2. Verify caching works (second run hits cache)
3. Verify complex images (multi-layer, symlinks, device nodes)
4. Performance benchmarking (first pull vs cached)

---

## Open Questions

1. **Embedded size budget**: Adding ~8MB for builder kernel + initramfs. Is this
   acceptable for the embedded-runtime feature? The guest kernel is already ~5MB.

2. **Builder VM memory**: How much RAM does the builder need? mke2fs + tar
   extraction typically need ~256MB. Could be configurable.

3. **Parallel image builds**: If multiple boxes pull different images
   simultaneously, should builder VMs run in parallel? libwkrun supports
   multiple VMs.

4. **Fallback for non-libwkrun**: If someone ports BoxLite to Windows without
   libwkrun (e.g., Hyper-V backend), the builder VM needs to work with that
   engine too. The `ImageBuilder` should use the engine abstraction, not
   libwkrun directly.

---

## Alternatives Considered

### Rust ext4 crate (ext4-rs)

The `ext4-rs` crate is **read-only**. No production-ready Rust ext4 writer
exists. Writing one is ~4000-5000 LOC and requires deep filesystem knowledge.

### FUSE + ext4fuse on Windows

Windows FUSE (WinFsp) + ext4 driver could mount ext4 images on Windows. But
this adds a kernel driver dependency and doesn't solve the creation problem.

### Docker-in-Docker approach

Use Docker Desktop's VM to create images. This defeats BoxLite's purpose
("no daemon needed").

### Pre-built image repository

Host pre-built ext4 images for common OCI images. This works for Alpine/Ubuntu
but not for custom images. Could be a CDN-based acceleration for cold starts.

---

## Success Criteria

1. `boxlite run alpine:latest echo hello` works on Windows
2. Complex OCI images with symlinks and multi-layer whiteouts work
3. Image cache works (first pull slow, subsequent instant)
4. No WSL2 or Docker Desktop required
5. Embedded binary size increase < 15MB
