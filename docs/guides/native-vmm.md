# Native VMM engine (RC)

The native engine runs a box on BoxLite's own VMM (`boxlite-vmm`) instead of
libkrun. It is a release-candidate feature for the VMM milestones: disabled by
default, Linux x86_64 only, supported only by the local runtime, and it may
change without the compatibility guarantees of BoxLite's stable CLI and Rust
API. It has no CLI flag yet.

The experimental integration attaches virtio-blk, reporting balloon, vsock,
aggregate virtio-fs, Linux gvproxy networking and virtio-console. It boots the
pinned kernel and guest root, receives the guest ready notification and can
initialize and execute an Alpine box. Unsupported requests fail explicitly:
missing/non-ELF kernels, a virtio-fs root, nested virtualization and datagram
network backends.

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
`get_or_create` refuses to reuse a box that runs on another engine, and a
request without an engine asks for the default Libkrun engine, so it does not
reuse a native box either. The REST
runtime rejects the option, and a REST server rejects uploaded archives that
carry it.

## Where to look when it stops

The guest's console lands in `logs/console.log` under the box
directory. The runtime-level test in `src/boxlite/tests/native_vmm.rs` checks successful
startup and exec. These native engine boot tests remain `#[ignore]` and are
not selected by `make test:integration` or the E2E local workflow. Run
`make test:integration:vmm:native` manually to exercise them together with the
shim-level kernel boot, using the pinned kernel described above. The
[VMM design](../contributing/architecture/vmm/README.md#where-the-engine-plugs-in-m2)
describes the adapter and platform qualification requirements.

## Linux x86_64 M2 and M3 matrices

The [qualification report](../contributing/investigations/2026-11-10-native-m2-m3-qualification.md)
records the complete runs, remaining failures and acceptance limits.

```sh
make vmm:boot:host
make runtime:debug
make test:integration:vmm:m2 ENGINE=native SETUP_DONE=1
make test:integration:vmm:m2 ENGINE=krun SETUP_DONE=1
make test:integration:vmm:m3 ENGINE=native SETUP_DONE=1
make test:integration:vmm:m3 ENGINE=krun SETUP_DONE=1
```

Each target explicitly selects the engine in test helpers;
compiling the `native` Cargo feature alone does not select it. `VMM_KERNEL` can
override the kernel and `BOXLITE_RUNTIME_DIR` can select a prepared runtime.
Without `SETUP_DONE=1`, each target first rebuilds the runtime. `FILTER`
or `NEXTEST_FILTER_EXPR` narrows the same matrix for diagnosis. The default
runner uses four workers and zero retries. Each run records inputs, logs and
its exit status under `target/vmm-matrix/`; `VMM_REPORT_DIR` overrides the run
directory, which must be empty. Kernel and runtime hashes, host kernel, source
revision/diff, test input hashes and untracked test inputs accompany the actual
selected-test list. Recovery subprocesses inherit the same engine and runtime.
It includes the normally ignored network VM tests and requires their egress
preflight checks; unavailable external endpoints fail the run instead of skipping.

M2 covers lifecycle, shutdown, detach, recovery, exec options and users,
main commands, TTY, zygote, copy and ownership, disk snapshots, clone/export/import,
network policy and gvproxy. M3 covers copy ownership, mount security, secret
substitution, security enforcement, network policy and directory volumes at
2, 3, 8 and 32 mounts. Each directory case checks host-to-guest reads,
guest-to-host writes, stop and removal; security enforcement checks mixed
read-only and writable exports. Secret-substitution cases are configuration
checks, and mount ID-mapping output is diagnostic rather than an acceptance assertion.
Kernel/guest probes are run separately with `make test:integration:vmm:native`,
`make test:integration:vmm:linux` and `make test:integration:vmm:mounts`.

Normal test invocations retain libkrun. Both engines keep existing jailer defaults;
the common shim currently skips seccomp with in-process gvproxy networking.
The native kernel includes the script loader for shebang entrypoints; the Linux
x86_64 seccomp profile allows `fstatfs`, `getpeername`, `getegid` and `fchmodat`
for filesystem metadata, Unix peer addresses, aggregate root ownership and modes.
Run all four combinations against the same artifacts, retaining failed runs
before proceeding to the next combination. Test failures, diagnostic skips and
missing prerequisites remain failures or limitations in the report; a completed
run is not an all-green result. ARM64/macOS, virtio-rng, host-sleep clock resync,
full per-thread filtering and filesystem conformance remain outside these runs,
so these matrices alone cannot establish complete M2 or M3 acceptance.
