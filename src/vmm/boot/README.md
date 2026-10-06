## TL;DR

Build a pinned x86_64 Linux kernel and a minimal test initramfs with native Linux tools.

## Scope and usage

These are inputs for the VMM's first-boot tests. Building them does not boot a VM.
The test `/init` prints `BOXLITE_M1_OK` as PID 1 and requests a reboot; it is not
the BoxLite guest agent or a production root filesystem.

```sh
make vmm:boot
make vmm:boot BOOT_OUTPUT=/tmp/boxlite-boot BOOT_JOBS=8
make test:vmm:boot
```

The build requires a Linux host. Guest architecture is always x86_64. Host GCC
builds kernel tools; `x86_64-linux-gnu-gcc` builds the kernel and static init.
This also permits cross-compiling on arm64 Linux with an x86_64 cross toolchain,
although local qualification covers x86_64 Linux only. macOS builds are out of
scope; use a Linux machine or VM there.

On Debian/Ubuntu, install the prerequisites yourself:

```sh
sudo apt-get install build-essential bc bison flex curl xz-utils libelf-dev \
  libssl-dev gcc-x86-64-linux-gnu binutils-x86-64-linux-gnu \
  libc6-dev-amd64-cross util-linux
```

The script checks dependencies and never installs packages. It also accepts
`--output DIR` and `--jobs N` directly. Output paths are relative to the caller.
Jobs default to the online CPU count. Use a dedicated output directory: existing
files outside the six artifacts below are rejected before building.

## How it works

`kernel.lock` pins Linux 6.12.110, its tarball SHA256 and its build epoch. The
tarball is cached under `target/vmm/boot/.cache` and verified on every invocation.
A corrupt cached tarball is an error; remove it before retrying. Downloads use a
temporary file, bounded retries and a timeout before entering the cache.

Every invocation extracts sources and compiles in a fresh temporary directory.
There is no incremental build cache or rebuild switch. Builds in one checkout
are serialized with a nonblocking lock; a concurrent invocation fails clearly.

`kernel.config` is applied to `allnoconfig`. The build rejects settings that
Kconfig changes or drops. The machine uses MP tables, a legacy serial console
and an external initramfs; ACPI, PCI and loadable modules are disabled.

The kernel's native `gen_init_cpio` packages a static `/init` and `/dev/console`
from a manifest. No root privileges, host device-node creation or external
`cpio` executable are required. All artifacts are staged before replacing a
previous output directory; build failures preserve previous outputs.

| File | Purpose |
| --- | --- |
| `vmlinux` | ELF kernel for direct loading |
| `bzImage` | Compressed x86 boot-protocol image |
| `test-initramfs.cpio` | Uncompressed `newc` archive containing the test init |
| `kernel.config` | Effective kernel configuration |
| `build-info.txt` | Source, input and host-toolchain identity |
| `SHA256SUMS` | Checksums of the other five artifacts |

The default output directory is `target/vmm/boot/x86_64/`. A future boot test
should use `console=ttyS0 rdinit=/init reboot=k panic=-1` and require both the
marker and a reset exit. Failed writes or reboot requests leave PID 1 waiting
for a host-enforced timeout instead of returning and panicking Linux.

## Reproducibility and validation

Build identity, timestamps, input paths and archive metadata are normalized.
Metadata records tool versions, the static libc hash and repository input
hashes, without a wall-clock build time or absolute local paths. Reproducibility
is promised only for identical inputs and toolchain environments; compilers
and system libraries are not downloaded or pinned by this build.

`make test:vmm:boot` exercises the actual build script with controlled external
tools: arguments, Make forwarding, cache validation, fresh builds, configuration
checks, failure preservation and cleanup. These tests do not compile Linux.

Native qualification builds twice in independent directories, checks ELF
architecture, absence of dynamic dependencies in init, archive permissions and
device metadata, required configuration, checksums and byte equality of all six
outputs. Booting the kernel under KVM is a separate VMM integration test.

## Related work and decisions

- [crosvm's guest Makefile, lines 132 onward](https://github.com/google/crosvm/blob/87ff72bcc25b009e4f7b618bd783bc0bb9f39b36/e2e_tests/guest_under_test/Makefile#L132)
  uses native kernel Make with explicit architecture and cross tools. We adopt
  that boundary, with fresh builds instead of incremental output reuse.
- [Linux: populating initramfs](https://docs.kernel.org/filesystems/ramfs-rootfs-initramfs.html#populating-initramfs)
  documents manifest-based device nodes and static init programs. We use that
  mechanism to avoid a root filesystem image and privileged packaging.
- [Linux: reproducible builds](https://docs.kernel.org/kbuild/reproducible-builds.html)
  identifies timestamps, build identity and paths as sources of variation.
  We normalize them and record the installed toolchain instead of distributing
  an additional toolchain or requiring a container runtime.
