# Nested virtualization (RC)

Nested virtualization lets workloads inside a box launch hardware-accelerated
virtual machines. This release-candidate feature is disabled by default.
Its policy belongs to the runtime environment; SDK create calls have no per-box
nested virtualization option.

## Local SDKs, CLI and server

Set the variable on the process that constructs the local runtime:

```bash
BOXLITE_EXPERIMENTAL=nested-virtualization boxlite run --rm alpine:latest \
  sh -c 'test -r /dev/kvm && test -w /dev/kvm'
```

Rust, Python, Node.js, Go and C local runtimes capture this policy during
initialization. Every subsequent new box uses it; there is no separate CLI flag
or SDK setter. Changing the environment after construction does not change that
runtime. Unknown feature names and non-UTF-8 values fail initialization.
Custom-kernel authorization retains its existing explicit SDK opt-in.

A `boxlite serve` process uses its own local environment. REST clients use the
ordinary create request and ignore their local feature environment, including
unknown or non-UTF-8 values. Client environment never authorizes the server.

## Cloud integration

The Runner uses an internal managed entry point that preserves each control-plane
decision instead of applying its local environment to every tenant.
Cloud organization admission is supplied by the dependent
[organization policy PR](https://github.com/boxlite-ai/boxlite/pull/2360).

## Existing boxes

The creation-time decision is saved and immutable. Changing the environment or
organization setting affects future creates; existing boxes retain their saved
configuration. A nested box still requires current runtime/Runner authorization
when it starts or restarts. Replay and recovery preserve the saved requirement
and cannot downgrade it.

`get_or_create` reuses a same-name box with its saved nesting decision and returns
`created=false`. A missing name creates a box using the current runtime policy.
Other security and engine compatibility checks still apply. Nested archive
import and migration remain unsupported.

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

To change an existing box's nesting configuration, explicitly remove and
recreate it, or use a new name. Enabling the policy does not upgrade a reused box.
