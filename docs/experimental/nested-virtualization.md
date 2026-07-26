# Nested virtualization (RC)

Nested virtualization lets a workload inside a box launch hardware-accelerated
virtual machines. It is a release-candidate feature: disabled by default,
supported only by the local runtime, and subject to change without BoxLite's
stable CLI and SDK compatibility guarantees. Its CLI flag is intentionally
omitted from normal help, shell completions, and the stable command reference.

The opt-in is strict. If the host cannot provide nested virtualization, BoxLite
returns `Unsupported` before starting the workload; it never falls back to
software emulation or silently starts without the feature.

## Enable the CLI feature

Enable only this capability for every process that creates, starts, or restarts
the box:

```bash
BOXLITE_EXPERIMENTAL=nested-virtualization boxlite run \
  --nested-virtualization --rm alpine:latest \
  sh -c 'test -r /dev/kvm && test -w /dev/kvm'
```

```bash
BOXLITE_EXPERIMENTAL=nested-virtualization boxlite create \
  --nested-virtualization --name vm-host alpine:latest
BOXLITE_EXPERIMENTAL=nested-virtualization boxlite start vm-host
```

`BOXLITE_EXPERIMENTAL` is a comma-separated allowlist. The CLI reads it once
before command dispatch and fails closed on unknown names. Enabling this token
does not enable any other current or future RC feature.

## Enable the Rust feature

Rust callers opt in when constructing a local runtime. The library does not
read `BOXLITE_EXPERIMENTAL`:

```rust
use boxlite::experimental::{
    nested_virtualization, ExperimentalFeature, RuntimeBuilder,
};
use boxlite::{BoxOptions, BoxliteOptions, RootfsSpec};

let runtime = RuntimeBuilder::new(BoxliteOptions::default())
    .enable(ExperimentalFeature::NestedVirtualization)
    .build()?;

let mut options = BoxOptions {
    rootfs: RootfsSpec::Image("alpine:latest".into()),
    ..Default::default()
};
nested_virtualization::configure(&mut options);

let box_ = runtime.create(options, None).await?;
```

The local runtime rechecks persisted configuration when a box starts or
restarts, so each SDK process must construct its runtime with the same feature.
The RC is not exposed through the Python, Node.js, Go, or C request APIs yet;
those runtimes do not currently have a generic way to inject explicit feature
state.

## Supported hosts

| Host | Requirements |
| --- | --- |
| macOS | Apple silicon M3 or newer and macOS 15 or newer |
| Linux | x86_64, usable KVM, and nested KVM enabled for the Intel or AMD module |

The option is not supported on Intel Macs or Linux ARM64 hosts. If BoxLite is
itself running in a VM, the outer hypervisor must expose nested virtualization.
BoxLite's guest kernel must also include KVM host support. This is present in
the bundled firmware; callers combining this RC with the custom-kernel RC are
responsible for providing it in that kernel.

On Linux, one of these files must contain `Y` or `1`:

```bash
cat /sys/module/kvm_intel/parameters/nested 2>/dev/null
cat /sys/module/kvm_amd/parameters/nested 2>/dev/null
```

Changing a loaded KVM module can disrupt running VMs and may require a host
reboot; follow the host distribution or cloud provider's instructions.

## Security and remote boundaries

BoxLite enables nesting for the box VM and adds the guest's `/dev/kvm` device
to the OCI workload. It does not pass through the host's `/dev/kvm` or grant
extra Linux capabilities. Nested virtualization still expands the kernel and
hypervisor surface available to the workload and lets it consume resources
through child VMs, so leave it disabled when it is not required.

REST-backed runtimes reject nested-virtualization options on `create` and
`get_or_create`. A REST server also rejects uploaded archives that request the
feature or select server host filesystem paths before installing their disks.
Trusted local imports preserve the archived option and remain subject to the
runtime-scoped feature check.

## Troubleshooting

An `Unsupported` error on macOS usually means the Mac or operating system is
too old. On Linux, check that `/dev/kvm` is usable, the applicable KVM module
reports nesting, and any outer hypervisor exposes the feature.

The option is immutable for an existing box. A request that requires nesting
cannot silently reuse a non-nested box; remove and recreate the box or choose a
new name. If host validation succeeds but `/dev/kvm` cannot be exposed to the
workload, BoxLite fails startup rather than launching a partially configured
box.
