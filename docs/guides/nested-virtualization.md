# Nested virtualization (RC)

Nested virtualization lets a workload inside a box launch hardware-accelerated
virtual machines. It is a release-candidate feature: disabled by default,
supported by the local runtime and compatible REST servers, and may change without the compatibility
guarantees of BoxLite's stable APIs. The CLI keeps its experimental ENV opt-in;
this feature does not introduce a public CLI option.

The opt-in is strict. When the host cannot provide nested virtualization,
BoxLite returns `Unsupported` instead of falling back to software emulation or
starting without the feature.

Authorize this capability in the server process:

```bash
BOXLITE_EXPERIMENTAL=nested-virtualization boxlite serve
```

`BOXLITE_EXPERIMENTAL` is a comma-separated allowlist. The CLI reads it once
before operational command dispatch and fails closed on unknown names. Enabling
one feature does not enable any other present or future RC feature.
This authorizes the runtime; ordinary boxes remain ordinary until their creation
request explicitly sets `advanced.nested_virtualization: true`.

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
REST client requires explicit server support before forwarding this requirement.
Uploaded archives requesting nesting remain unsupported over REST. The
[Python SDK](../../sdks/python/README.md#nested-virtualization-rc),
[Node SDK](../../sdks/node/README.md#nested-virtualization-rc),
[Go SDK](../../sdks/go/README.md#nested-virtualization-experimental), and
[C SDK](../../sdks/c/README.md#nested-virtualization-rc) expose explicit runtime
authorization and advanced box options; they do not read the process environment.

## REST contract and saved metadata

Compatible servers advertise `capabilities.nested_virtualization_enabled: true`
through `GET /v1/config`. The SDK rechecks this declaration for each nested create,
then sends `advanced.nested_virtualization: true`. A missing or false declaration
refuses the request. Omitted or false box options preserve ordinary requests.
Client environment variables cannot authorize a remote server.

The server must return the saved requirement in `advanced.nested_virtualization`.
The client rejects a missing or false confirmation and names the created box;
it does not delete, start, retry, or downgrade that resource automatically.
GetOrCreate refuses an existing ordinary or unknown box when true was requested.

`BoxInfo.advanced` contains a safe projection of saved configuration, without
sandbox policy. Older responses remain unknown rather than reading as false.
A saved true value does not prove that an L2 guest has executed.
Servers that do not advertise this contract, including Cloud before its separate
integration, cannot accept nested requests through the SDK.

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
