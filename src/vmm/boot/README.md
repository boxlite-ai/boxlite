## TL;DR

Build the pinned x86_64 Linux kernel as an ELF `vmlinux` with native Linux tools.
It is the input for the VMM's ELF loader (`VMM_KERNEL`), not a bootable VM.

## Scope and usage

```sh
make vmm:boot BOOT_OUTPUT=target/vmm/boot/x86_64 BOOT_JOBS=8
make test:vmm:boot
BOOT_REAL_BUILD=1 make test:vmm:boot
```

A Linux host is required; the guest is always x86_64. Host GCC builds the kernel's
own tools and `x86_64-linux-gnu-gcc` builds the kernel. On Debian/Ubuntu install
`build-essential bc bison flex curl xz-utils libelf-dev gcc-x86-64-linux-gnu
binutils-x86-64-linux-gnu`; the script checks dependencies and never installs
packages. Both variables are optional; jobs default to the online CPU count. The
work directory lives under `TMPDIR` and needs about 2 GB. Use a dedicated output
directory: entries other than the four artifacts are rejected before building.
Research and design: [#1824](https://github.com/boxlite-ai/boxlite/issues/1824).

## How it works

`kernel.lock` pins Linux 6.12.110, its tarball SHA-256 and the build epoch. The
tarball is cached under `target/vmm/boot/.cache`, verified on every run, and
downloaded into that directory first so the cache never holds a partial file.
Every run extracts and compiles in a fresh temporary directory. `kernel.config`
is applied over `allnoconfig`; any fragment line Kconfig changed or dropped fails
the build. Address randomization is off, so the ELF entry must equal
`CONFIG_PHYSICAL_START=0x1000000`. The outputs are `vmlinux` (ELF64 x86-64),
`kernel.config` (effective configuration), `build-info.txt` (source, input and
toolchain identity) and `SHA256SUMS`. They are staged next to the output
directory and swapped in by rename; the previous output is kept until the swap
succeeds and restored if it fails. Builds in one checkout are serialized with a
non-blocking lock, and a cancelled build kills its whole process tree and
removes its work directory.

Build identity, timestamps and source paths are normalized (`KBUILD_BUILD_*`,
`SOURCE_DATE_EPOCH`, `-ffile-prefix-map`), so identical inputs and toolchains
give identical bytes. `make test:vmm:boot` runs the real script against stubbed
tools and never compiles Linux. `BOOT_REAL_BUILD=1` adds two native builds and
checks byte equality, the ELF header, segment placement and configuration.
Booting the kernel is a later slice.

## Building inside a BoxLite box

`make vmm:boot:box` runs the same build inside a Linux box, for macOS (Apple
Silicon) or for Linux hosts without the packages above. It takes `BOOT_OUTPUT`
and `BOOT_JOBS`; the output must be inside the repository, the box's only mount.
Design: [#1890](https://github.com/boxlite-ai/boxlite/issues/1890).

`boxlite.lock` pins a BoxLite CLI release, its SHA-256 for each host and a
digest-pinned `ubuntu:24.04` builder image. The release is downloaded into
`target/vmm/boot/.cache`, verified and run from there; nothing is installed.
`BOXLITE_HOME` and, on Linux, `XDG_DATA_HOME` point at `target/vmm/boot/.boxlite`,
so an installed or locally built BoxLite keeps its own images, boxes and
database. macOS extracts the runtime into its versioned directory under
`~/Library/Application Support/boxlite/runtimes`.

The box installs the Debian packages listed above on every run, so it needs
network access. Sources are extracted to the box's ext4 root disk (`/tmp` there
is tmpfs, and a macOS mount may be case-insensitive). Apple Silicon hosts get an
arm64 box that cross-compiles. `build-info.txt`, and so `SHA256SUMS`, record the
box's architecture and compiler. macOS is not yet qualified.

The build lock only serializes builds inside one box. BoxLite's virtiofs mount
does not implement file locks, so the guest kernel keeps them local: a box
build does not exclude a host build or another box build of the same checkout.
Run one build per checkout at a time; overlapping runs can overwrite each
other's output.
