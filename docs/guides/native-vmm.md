# Native VMM engine (RC)

The native engine runs a box on BoxLite's own VMM (`boxlite-vmm`) instead of
libkrun. It is a release-candidate feature for the VMM milestones: disabled by
default, Linux x86_64 only, supported only by the local runtime, and it may
change without the compatibility guarantees of BoxLite's stable CLI and Rust
API. It has no CLI flag yet.

The engine is still being built up device by device, so a box on it does not
become ready yet: it has no vsock, virtio-fs or virtio-net device. What it does
today is boot the pinned kernel, attach the container and guest root disks over
virtio-blk, and run `boxlite-guest` as PID 1 on the ext4 root until the agent
needs one of those devices. Requests the engine cannot serve at all fail
`start` with `Unsupported`: a box without a kernel, a non-ELF kernel, a
virtio-fs root, or nested virtualization. Virtio-fs shares, networking and the
agent's socket bridge are logged as unattached and the boot continues; those
exceptions go away as each device lands.

The engine takes its kernel from the custom-kernel RC until the runtime bundles
one: build it with `make vmm:boot` and pass `target/vmm/boot/x86_64/vmlinux`.
Opt in to both capabilities for every process that creates, starts, or restarts
the box. The library does not read `BOXLITE_EXPERIMENTAL`:

```rust
use boxlite::experimental::custom_kernel::{self, KernelFormat, KernelOptions};
use boxlite::experimental::{native_vmm, ExperimentalFeature, RuntimeBuilder};
use boxlite::{BoxOptions, BoxliteOptions};

let runtime = RuntimeBuilder::new(BoxliteOptions::default())
    .enable(ExperimentalFeature::CustomKernel)
    .enable(ExperimentalFeature::NativeVmm)
    .build()?;

let mut options = BoxOptions::default();
custom_kernel::configure(
    &mut options,
    KernelOptions::new("/absolute/path/to/vmlinux").with_format(KernelFormat::Elf),
);
native_vmm::configure(&mut options);

let box_ = runtime.create(options, None).await?;
```

The engine choice is persisted with the box and rechecked on every start, so a
later start needs the same opt-in. It is immutable for an existing box:
`get_or_create` refuses to reuse a box that runs on another engine. The REST
runtime rejects the option, and a REST server rejects uploaded archives that
carry it.

## Where to look when it stops

The guest's serial console lands in `logs/console.log` under the box
directory. The runtime-level test in `src/boxlite/tests/native_vmm.rs` pins how
far the boot gets; `make test:integration:vmm:native` runs it together with the
shim-level kernel boot. The
[VMM design](../contributing/architecture/vmm/README.md#where-the-engine-plugs-in-m2)
describes the adapter and the devices it still lacks.
