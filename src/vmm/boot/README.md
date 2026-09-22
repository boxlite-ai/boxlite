# M1 boot artifacts

Build the Linux x86_64 kernel and test initramfs for the native VMM's first
boot. These artifacts do not replace libkrunfw or the production guest image.
ARM artifacts and native VMM execution follow in later M1 changes.

From the repository root, with Docker running and Buildx installed:

```sh
make vmm:boot
```

The builder runs on its native Linux architecture and cross-compiles for
x86_64. Outputs are exported to `target/vmm/boot/x86_64/`:

| File | Purpose |
| --- | --- |
| `vmlinux` | ELF kernel for the native VMM's direct boot loader |
| `bzImage` | The same kernel, packaged for QEMU artifact qualification |
| `test-initramfs.cpio` | Uncompressed `newc` archive with static `/init` and `/dev/console` |
| `kernel.config` | Complete resolved kernel configuration |
| `build-info.txt` | Source pin, build epoch, builder architecture, compiler/packages and input hashes |
| `SHA256SUMS` | Checksums of the exported artifacts |

The configuration enables MP tables, the in-kernel x86 interrupt controller's
guest interfaces, 8250 serial and CMOS RTC. ACPI, PCI, modules, disks and virtio
devices are not needed for this initramfs. `build.sh` fails if Kconfig drops a
requested setting, instead of silently shipping a different machine contract.

## Test guest contract

Pass this command line with the kernel and the separate initramfs:

```text
console=ttyS0 rdinit=/init reboot=k panic=-1
```

`/init` verifies that it is PID 1, writes the exact line `BOXLITE_M1_OK` to the
console, syncs, then requests `reboot(RESTART)`. The host must enforce a boot
timeout, check the marker and check termination separately. This program is a
test fixture, not `boxlite-guest`; the marker does not represent an application
exit status.

## Reproducibility and verification

The source archive is Linux **6.12.110**, checked against the SHA-256 in
`kernel.lock`. The Dockerfile pins the Debian base image by digest and apt
packages to the **2026-09-19** Debian snapshot. The source tree, output paths,
build user/host/version, timestamp, initramfs ownership/order/mtime and compiler
path mappings are fixed. Kernel source and package downloads are bounded and
fail the build on error.

The reproducibility claim is for the same source inputs and **builder
architecture**. Changing the Docker builder between arm64 and amd64 changes
the native toolchain packages; cross-builder byte identity is not assumed.
The builder does not install a compiler or kernel onto the host.

```sh
# Fast wrapper argument/path/failure checks, without a Docker daemon.
make test:vmm:boot

# Requires Docker and qemu-system-x86_64; may take several minutes.
make test:vmm:boot-artifacts

# Optional: compare two fresh builds, without QEMU.
make test:vmm:boot-reproducible
```

The artifact test builds once (reusing Docker's cache), verifies every output
checksum, then boots one vCPU under QEMU TCG. The guest must print the exact
success marker, request reboot and let QEMU exit within 90 seconds. The optional
reproducibility test bypasses the compilation stage's cache for two fresh
builds, verifies their checksums and compares every output byte for byte.

Temporary artifacts are removed after either test. QEMU validates the kernel
and initramfs; it does not validate BoxLite's still-unimplemented native
backend. SMP boot is not qualified here. Native boot, SMP qualification and
hardware-backed CI follow in later M1 PRs.

## Reference research

The first-boot choices follow these pinned implementations:

- Firecracker [`docs/rootfs-and-kernel-setup.md:7–16,35–64`](https://github.com/firecracker-microvm/firecracker/blob/68698adfee9b252df130b7a98e3ba04eb81f0f54/docs/rootfs-and-kernel-setup.md#L7-L64)
  recommends ELF `vmlinux` for x86 and uses a checked-in guest configuration.
  This build exports ELF and a QEMU qualification image from the same build.
- Firecracker [`resources/rebuild.sh:60–93`](https://github.com/firecracker-microvm/firecracker/blob/68698adfee9b252df130b7a98e3ba04eb81f0f54/resources/rebuild.sh#L60-L93)
  builds a separate `newc` initramfs with a BusyBox shell `/init`.
- Linux [`ramfs-rootfs-initramfs.rst:265–282`](https://github.com/torvalds/linux/blob/v6.12/Documentation/filesystems/ramfs-rootfs-initramfs.rst#L265-L282)
  recommends a static hello-world `/init` and QEMU for a first boot test. This
  fixture adds a reboot so the host can check completion. Linux's
  `gen_init_cpio -t` fixes timestamps and ownership without root.
- libkrunfw [`Makefile:1–14`](https://github.com/libkrun/libkrunfw/blob/617938cf2ae9a3a0e5696d23a5d6252cd7a1ef4f/Makefile#L1-L14)
  fixes the kernel version, timestamp and build user/host. Our container also
  pins package resolution, because the base image alone does not freeze apt.
- Linux's [reproducible-build guidance](https://github.com/torvalds/linux/blob/v6.12/Documentation/kbuild/reproducible-builds.rst#L16-L59)
  identifies timestamps, user/host names and absolute paths as build inputs.
  `build.sh` fixes those inputs; the optional test checks the resulting bytes.

The M0 [machine layout and lifecycle](../../../docs/architecture/vmm/README.md)
remain the native VMM contract. Research references should be revisited before
each later M1 implementation PR.
