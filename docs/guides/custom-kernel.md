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

## C and Go SDKs

The local C constructor `boxlite_runtime_new_experimental` accepts the same
comma-separated feature names as Rust. Pass `"custom-kernel"`, then set the
absolute file path with `boxlite_advanced_options_set_kernel_path` and apply
the advanced options with `boxlite_options_set_advanced`. The original
`boxlite_runtime_new` constructor enables no experimental features. Neither
constructor reads `BOXLITE_EXPERIMENTAL`.

The Go SDK wraps these interfaces:

```go
rt, err := boxlite.NewRuntime(
    boxlite.WithExperimentalFeatures("custom-kernel"),
)
if err != nil { return err }
defer rt.Close()
advanced, err := boxlite.NewAdvancedBoxOptions()
if err != nil { return err }
defer advanced.Close()
if err := advanced.SetKernelPath("/opt/boxlite/kernel.bin"); err != nil {
    return err
}
box, err := rt.Create(ctx, "alpine:3.21", boxlite.WithAdvancedOptions(advanced))
```

Formats are auto-detected. These bindings currently expose the kernel file
only; Rust/CLI retain their additional initramfs and command-line options.
Reconstructing the runtime to restart a custom-kernel Box requires the same
feature opt-in. Files are staged per Box; changing the source file does not
replace an existing Box's staged kernel. A trusted archive records the source
path, so install that kernel on the destination before import.

Runner operators can set `BOXLITE_KERNEL_PATH` to use this mechanism for new
Boxes. The Runner handles the feature opt-in internally; `--kernel` remains a
local CLI option, not a Runner argument. With no path configured, the Runner
uses the ordinary bundled kernel.
