# Nested virtualization (RC)

Nested virtualization lets a workload inside a box launch hardware-accelerated
virtual machines. It is a release-candidate feature: disabled by default,
supported only by the local runtime, and may change without the compatibility
guarantees of BoxLite's stable CLI and Rust API. Its CLI flag is intentionally
omitted from normal help, shell completions, and the stable command reference.

The opt-in is strict. When the host cannot provide nested virtualization,
BoxLite returns `Unsupported` instead of falling back to software emulation or
starting without the feature.

Enable only this capability for every process that creates, starts, or restarts
the box:

```bash
BOXLITE_EXPERIMENTAL=nested-virtualization boxlite run \
  --nested-virtualization --rm alpine:latest \
  sh -c 'test -r /dev/kvm && test -w /dev/kvm'
```

`BOXLITE_EXPERIMENTAL` is a comma-separated allowlist. The CLI reads it once
before operational command dispatch and fails closed on unknown names. Enabling
one feature does not enable any other present or future RC feature.

For the Rust SDK, opt in explicitly when constructing the runtime. The library
does not read `BOXLITE_EXPERIMENTAL`:

```rust
use boxlite::experimental::{nested_virtualization, ExperimentalFeature, RuntimeBuilder};
use boxlite::{BoxOptions, BoxliteOptions};

let runtime = RuntimeBuilder::new(BoxliteOptions::default())
    .enable(ExperimentalFeature::NestedVirtualization)
    .build()?;

let mut options = BoxOptions::default();
nested_virtualization::configure(&mut options);

let box_ = runtime.create(options, None).await?;
```

The local runtime checks the opt-in again when it consumes persisted box
configuration, so a later CLI `start` or `restart` also needs the variable and
an SDK process must construct its runtime with the same explicit feature. The
REST runtime rejects nested-virtualization configuration even when the opt-in is
present, and a REST server rejects uploaded archives that request it. The RC is
not exposed through the Python, Node.js, Go, or C request APIs.

## Supported hosts

| Host | Requirements |
| --- | --- |
| macOS | Apple silicon M3 or newer, macOS 15 or newer |
| Linux | x86_64, usable KVM, nested KVM enabled for the Intel or AMD module |

Intel Macs and Linux ARM64 hosts are not supported. When BoxLite itself runs in
a VM, the outer hypervisor must expose nested virtualization. On Linux, one of
`/sys/module/kvm_intel/parameters/nested` or
`/sys/module/kvm_amd/parameters/nested` must read `Y` or `1`; changing a loaded
KVM module can disrupt running VMs and may require a reboot.

The guest kernel must include KVM host support. The bundled firmware has it;
callers combining this RC with the custom-kernel RC must provide it themselves.

## Security

BoxLite enables nesting for the box VM and adds the *guest's* `/dev/kvm` to the
OCI workload. The host's `/dev/kvm` is never passed through and no extra Linux
capabilities are granted. Nesting still widens the kernel and hypervisor surface
the workload can reach and lets it consume resources through child VMs, so leave
it disabled when it is not required.

## Troubleshooting

An `Unsupported` error on macOS usually means the Mac or operating system is too
old. On Linux, check that `/dev/kvm` is usable, that the applicable KVM module
reports nesting, and that any outer hypervisor exposes the feature.

The option is immutable for an existing box: a request that requires nesting
will not silently reuse a box created without it. Remove and recreate the box,
or choose a new name.
