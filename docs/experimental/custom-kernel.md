# Custom kernel (RC)

Custom-kernel boot is a release-candidate feature. It is disabled by default,
is supported only by the local runtime, and may change without the compatibility
guarantees of BoxLite's stable CLI and Rust API. Its CLI flags are intentionally
omitted from normal help, shell completions, and the stable command reference.

Enable only this capability for the process that creates, starts, or restarts
the box:

```bash
BOXLITE_EXPERIMENTAL=custom-kernel boxlite run \
  --kernel /absolute/path/to/vmlinux \
  --kernel-format elf \
  --initramfs /absolute/path/to/initramfs.img \
  --kernel-args "console=ttyS0 panic=-1" \
  alpine:latest
```

`BOXLITE_EXPERIMENTAL` is a comma-separated allowlist. The CLI reads it once
before operational command dispatch and fails closed on unknown names. Enabling
one feature does not enable any other present or future RC feature.

`--kernel-format` defaults to `auto`. Supported explicit values are `raw`,
`elf`, `pe-gz`, `image-bz2`, `image-gz`, and `image-zstd`; availability is
architecture-dependent. `--initramfs` and `--kernel-args` require `--kernel`.
Boot files are copied into the box before the shim starts.

For the Rust SDK, opt in explicitly when constructing the runtime. The library
does not read `BOXLITE_EXPERIMENTAL`:

```rust
use boxlite::experimental::custom_kernel::{self, KernelFormat, KernelOptions};
use boxlite::experimental::{ExperimentalFeature, RuntimeBuilder};
use boxlite::{BoxOptions, BoxliteOptions};

let runtime = RuntimeBuilder::new(BoxliteOptions::default())
    .enable(ExperimentalFeature::CustomKernel)
    .build()?;

let mut options = BoxOptions::default();
custom_kernel::configure(
    &mut options,
    KernelOptions::new("/absolute/path/to/vmlinux")
        .with_format(KernelFormat::Elf)
        .with_initramfs("/absolute/path/to/initramfs.img")
        .with_command_line("console=ttyS0 panic=-1"),
);

let box_ = runtime.create(options, None).await?;
```

The local runtime checks the opt-in again when it consumes persisted box
configuration. A later CLI `start` or `restart` therefore also needs
`BOXLITE_EXPERIMENTAL=custom-kernel`; an SDK process must construct its runtime
with the same explicit feature. The REST runtime rejects custom-kernel
configuration even when the opt-in is present.
