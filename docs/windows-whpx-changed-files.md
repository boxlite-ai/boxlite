# Windows WHPX Support — Changed Files

Branch: `feat/windows-whpx-support`
Base: rebased onto `origin/main` (2026-05-02)

## boxlite repo (82 files)

### Build & CI (11 files)

```
.cargo/config.toml
.github/workflows/test-windows-e2e.yml
.github/workflows/test-windows.yml
Cargo.lock
scripts/build/build-initrd-windows.sh
scripts/build/build-windows-runtime.sh
scripts/build/cross-compile-e2fsprogs-windows.sh
scripts/build/cross-compile-gvproxy-windows.sh
scripts/build/cross-compile-kernel-windows.sh
sdks/python/Cargo.toml
sdks/python/src/lib.rs
```

### Core runtime — boxlite crate (55 files)

```
src/boxlite/build.rs
src/boxlite/Cargo.toml
src/boxlite/src/bin/shim/crash_capture.rs
src/boxlite/src/bin/shim/main.rs
src/boxlite/src/db/base_disk.rs
src/boxlite/src/db/boxes.rs
src/boxlite/src/db/migration/v6_to_v7.rs
src/boxlite/src/disk/constants.rs
src/boxlite/src/disk/ext4.rs
src/boxlite/src/disk/mod.rs
src/boxlite/src/images/archive/mod.rs
src/boxlite/src/images/blob_source.rs
src/boxlite/src/images/image_disk.rs
src/boxlite/src/images/mod.rs
src/boxlite/src/images/object.rs
src/boxlite/src/images/storage.rs
src/boxlite/src/jailer/builder.rs
src/boxlite/src/jailer/common/fs.rs
src/boxlite/src/jailer/common/mod.rs
src/boxlite/src/jailer/common/pid.rs
src/boxlite/src/jailer/common/rlimit.rs
src/boxlite/src/jailer/mod.rs
src/boxlite/src/jailer/pre_exec.rs
src/boxlite/src/jailer/sandbox/composite.rs
src/boxlite/src/jailer/sandbox/job_object.rs          NEW — Windows JobObject sandbox
src/boxlite/src/jailer/sandbox/mod.rs
src/boxlite/src/jailer/shim_copy.rs
src/boxlite/src/litebox/box_impl.rs
src/boxlite/src/litebox/init/tasks/container_rootfs.rs
src/boxlite/src/litebox/init/tasks/guest_connect.rs
src/boxlite/src/litebox/init/tasks/guest_init.rs
src/boxlite/src/litebox/init/tasks/guest_rootfs.rs
src/boxlite/src/litebox/init/tasks/vmm_spawn.rs
src/boxlite/src/litebox/init/types.rs
src/boxlite/src/lock/mod.rs
src/boxlite/src/net/port.rs
src/boxlite/src/net/socket_path.rs
src/boxlite/src/portal/connection.rs
src/boxlite/src/rootfs/guest.rs
src/boxlite/src/rootfs/mod.rs
src/boxlite/src/rootfs/operations.rs
src/boxlite/src/runtime/embedded.rs
src/boxlite/src/runtime/layout.rs
src/boxlite/src/runtime/lock.rs
src/boxlite/src/runtime/rt_impl.rs
src/boxlite/src/runtime/signal_handler.rs
src/boxlite/src/system_check.rs
src/boxlite/src/util/binary_finder.rs
src/boxlite/src/util/mod.rs
src/boxlite/src/util/process.rs
src/boxlite/src/vmm/controller/shim.rs
src/boxlite/src/vmm/controller/spawn.rs
src/boxlite/src/vmm/controller/watchdog.rs
src/boxlite/src/vmm/krun/context.rs
src/boxlite/src/vmm/krun/engine.rs
```

### Dependencies — libkrun-sys & libgvproxy-sys (4 files)

```
src/deps/libgvproxy-sys/build.rs
src/deps/libgvproxy-sys/gvproxy-bridge/main.go
src/deps/libkrun-sys/build.rs
src/deps/libkrun-sys/src/lib.rs
```

### Guest agent (8 files)

```
src/guest/src/container/start.rs
src/guest/src/container/zygote.rs
src/guest/src/main.rs
src/guest/src/mounts.rs
src/guest/src/service/guest.rs
src/guest/src/service/server.rs
src/guest/src/storage/virtiofs.rs
src/guest/src/storage/volume.rs
```

### Test utilities (4 files)

```
src/test-utils/Cargo.toml
src/test-utils/src/cache.rs
src/test-utils/src/config_matrix.rs
src/test-utils/src/home.rs
```

## libkrun submodule (51 files, rebased onto origin/main)

After rebasing onto `origin/main`, the diff only shows our actual WHPX changes
(no upstream-merged noise). 40 files are new Windows code, 11 are integration
touchpoints in existing upstream files.

### Windows FFI entry point (1 file, NEW)

```
src/libkrun/src/windows_api.rs
```

### Windows VMM — boot (6 files, all NEW)

```
src/vmm/src/windows/boot/acpi.rs                   ACPI tables
src/vmm/src/windows/boot/loader.rs                  Kernel loader
src/vmm/src/windows/boot/mod.rs                     Boot module
src/vmm/src/windows/boot/mp_table.rs                MP table for SMP
src/vmm/src/windows/boot/params.rs                  Boot params
src/vmm/src/windows/boot/setup.rs                   Boot setup
```

### Windows VMM — devices (8 files, all NEW)

```
src/vmm/src/windows/devices/ioapic.rs               IOAPIC
src/vmm/src/windows/devices/irq_chip.rs             IRQ chip (PIC/APIC auto-transition)
src/vmm/src/windows/devices/lapic.rs                Lock-free LAPIC + SharedApicState
src/vmm/src/windows/devices/manager.rs              Device manager
src/vmm/src/windows/devices/mod.rs                  Devices module
src/vmm/src/windows/devices/pic.rs                  Legacy 8259 PIC
src/vmm/src/windows/devices/pit.rs                  8254 PIT timer
src/vmm/src/windows/devices/serial.rs               16550 serial console
```

### Windows VMM — virtio devices (15 files, all NEW)

```
src/vmm/src/windows/devices/virtio/balloon.rs       virtio-balloon
src/vmm/src/windows/devices/virtio/block_worker.rs  Async block I/O worker
src/vmm/src/windows/devices/virtio/block.rs         virtio-blk
src/vmm/src/windows/devices/virtio/disk.rs          Disk abstraction (raw + QCOW2)
src/vmm/src/windows/devices/virtio/mmio.rs          MMIO transport
src/vmm/src/windows/devices/virtio/mod.rs           Virtio module
src/vmm/src/windows/devices/virtio/net.rs           virtio-net (UDS transport)
src/vmm/src/windows/devices/virtio/p9/filesystem.rs 9P filesystem
src/vmm/src/windows/devices/virtio/p9/mod.rs        9P module
src/vmm/src/windows/devices/virtio/p9/protocol.rs   9P protocol
src/vmm/src/windows/devices/virtio/queue.rs         Virtio queue
src/vmm/src/windows/devices/virtio/rng.rs           virtio-rng
src/vmm/src/windows/devices/virtio/vsock/connection.rs  vsock connection
src/vmm/src/windows/devices/virtio/vsock/mod.rs     vsock (UDS transport)
src/vmm/src/windows/devices/virtio/vsock/packet.rs  vsock packet
```

### Windows VMM — core (10 files, all NEW)

```
src/vmm/src/windows/cmdline.rs                      Kernel command line
src/vmm/src/windows/context.rs                      VM context
src/vmm/src/windows/error.rs                        Error types
src/vmm/src/windows/insn.rs                         x86 instruction decode
src/vmm/src/windows/memory.rs                       Guest memory manager
src/vmm/src/windows/mod.rs                          Windows module root
src/vmm/src/windows/runner.rs                       VM runner (multi-vCPU)
src/vmm/src/windows/types.rs                        WHPX type wrappers
src/vmm/src/windows/vcpu.rs                         vCPU + INIT-SIPI-SIPI
src/vmm/src/windows/whpx.rs                         WHPX API bindings
```

### Upstream integration touchpoints (11 files, MODIFIED)

```
Cargo.lock                                          Dependency resolution
include/libkrun.h                                   C API header (krun_start/wait/stop stubs)
src/devices/src/virtio/vsock/device.rs               TSI flags import adjustment
src/devices/src/virtio/vsock/muxer.rs                TSI flags import adjustment
src/libkrun/Cargo.toml                               cfg(unix) gating for devices/polly/utils
src/libkrun/src/lib.rs                               cfg(windows) module gate + Unix stubs
src/vm-memory/Cargo.lock                             Dependency resolution
src/vmm/Cargo.toml                                   Windows deps (windows-sys, uds_windows, etc.)
src/vmm/examples/boot_kernel.rs                      cfg gate for Unix-only example
src/vmm/src/builder.rs                               cfg gate for Unix-only builder
src/vmm/src/lib.rs                                   pub mod windows
```

## Summary

| Category | Files |
|----------|-------|
| boxlite repo | 82 |
| libkrun — Windows code (NEW) | 40 |
| libkrun — upstream integration | 11 |
| **Total** | **133** |
| **Our WHPX work** | **122** |
