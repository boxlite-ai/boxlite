## TL;DR

Build the pinned x86_64 Linux kernel as an ELF `vmlinux`, by default inside a
pinned BoxLite box. It is the input for the VMM's ELF loader (`VMM_KERNEL`), not
a bootable VM.

## Scope and usage

```sh
make vmm:boot BOOT_OUTPUT=target/vmm/boot/x86_64 BOOT_JOBS=8
make vmm:boot:host
make test:vmm:boot
```

`make vmm:boot` builds inside a Linux box, so the host needs no kernel
toolchain; it targets Linux and macOS (Apple Silicon) hosts, and macOS is not
yet qualified. `make vmm:boot:host` runs the same build script directly on a
Linux host that has the packages below. Both take `BOOT_OUTPUT` and
`BOOT_JOBS`; jobs default to the online CPU count. Research and design:
[#1824](https://github.com/boxlite-ai/boxlite/issues/1824) and
[#1890](https://github.com/boxlite-ai/boxlite/issues/1890).

## How it works

`kernel.lock` pins Linux 6.12.110, its tarball SHA-256 and the build epoch. The
tarball is cached under `target/vmm/boot/.cache`, verified on every run, and
downloaded into that directory first so the cache never holds a partial file.
Every run extracts and compiles in a fresh temporary directory. `kernel.config`
is applied over `allnoconfig`; any fragment line Kconfig changed or dropped fails
the build. Address randomization is off, so the ELF entry must equal
`CONFIG_PHYSICAL_START=0x1000000`. The outputs are `vmlinux` (ELF64 x86-64),
`kernel.config` (effective configuration), `build-info.txt` (source, input and
toolchain identity) and `SHA256SUMS`. Only those four names are written, after
every build check passes; a failure while they are copied, such as a full disk,
can leave old and new files mixed, which `SHA256SUMS` then exposes. Nothing
serializes builds, so run one build per checkout at a time.

Build identity, timestamps and source paths are normalized (`KBUILD_BUILD_*`,
`SOURCE_DATE_EPOCH`, `-ffile-prefix-map`), so identical inputs and toolchains
give identical bytes. `make test:vmm:boot` runs both scripts against stubbed
tools and never compiles Linux or starts a box. Booting the kernel is a later
slice.

## Default: building inside a BoxLite box

`boxlite.lock` pins a BoxLite CLI release, its SHA-256 for each host and a
digest-pinned `ubuntu:24.04` builder image. The release is downloaded into
`target/vmm/boot/.cache`, verified and run from there; nothing is installed.
`BOXLITE_HOME` and, on Linux, `XDG_DATA_HOME` point at `target/vmm/boot/.boxlite`,
so an installed or locally built BoxLite keeps its own images, boxes and
database. macOS extracts the runtime into its versioned directory under
`~/Library/Application Support/boxlite/runtimes`. The box mounts the repository
at `/src` and the output directory at `/out`, so the output can be anywhere on the
host. The wrapper makes the output path absolute and creates it first, because
BoxLite mounts only an existing absolute host path.

`make test:vmm:boot` skips the host build tests on hosts without GNU coreutils
(macOS); the box tests run everywhere.

The box installs the packages listed below on every run, so it needs network
access. Sources are extracted to the box's ext4 root disk (`/tmp` there is tmpfs,
and a macOS mount may be case-insensitive). Apple Silicon hosts get an arm64 box
that cross-compiles. `build-info.txt`, and so `SHA256SUMS`, record the box's
architecture and compiler. macOS is not yet qualified.

The box gets 4096 MiB of memory, a 4 GiB root disk (a build peaks at about
2.15 GiB) and one vCPU per job. Jobs are capped at 16, the most vCPUs the guest
kernel bundled with the pinned BoxLite brings up (`CONFIG_NR_CPUS`); the wrapper
prints a note when it lowers them. Before downloading anything it fails unless
the host has 4096 MiB of available memory (`free` on Linux, `vm_stat` on macOS)
and 4 GiB free on the file system holding `target/vmm/boot/.boxlite` (`df`).
Neither check needs root.

## Host build

`make vmm:boot:host` requires a Linux host; the guest is always x86_64. Host GCC
builds the kernel's own tools and `x86_64-linux-gnu-gcc` builds the kernel. On
Debian/Ubuntu install `build-essential bc bison flex curl xz-utils libelf-dev
gcc-x86-64-linux-gnu binutils-x86-64-linux-gnu`; the script checks dependencies
and never installs packages. The work directory lives under `TMPDIR` and needs
about 2 GB.
