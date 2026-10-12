## TL;DR

Build the pinned x86_64 Linux kernel as an ELF `vmlinux` with native Linux tools.
It is the input for the VMM's ELF loader (`VMM_KERNEL`), not a bootable VM.

## Scope and usage

```sh
make vmm:boot BOOT_OUTPUT=target/vmm/boot/x86_64 BOOT_JOBS=8
make test:vmm:boot
```

A Linux host is required; the guest is always x86_64. Host GCC builds the kernel's
own tools and `x86_64-linux-gnu-gcc` builds the kernel. On Debian/Ubuntu install
`build-essential bc bison flex curl xz-utils libelf-dev gcc-x86-64-linux-gnu
binutils-x86-64-linux-gnu`; the script checks dependencies and never installs
packages. Both variables are optional; jobs default to the online CPU count. The
work directory lives under `TMPDIR` and needs about 2 GB. Research and design:
[#1824](https://github.com/boxlite-ai/boxlite/issues/1824).

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
every check passes, so a failed build leaves the previous output untouched.
Locking, cancellation cleanup, output-directory protection and the two-build
reproducibility check follow in the next slice.

Build identity, timestamps and source paths are normalized (`KBUILD_BUILD_*`,
`SOURCE_DATE_EPOCH`, `-ffile-prefix-map`), so identical inputs and toolchains
give identical bytes. `make test:vmm:boot` runs the real script against stubbed
tools and never compiles Linux; booting the kernel is a later slice.
