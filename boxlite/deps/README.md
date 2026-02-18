# FFI Dependency Crates

This directory contains `-sys` crates that provide FFI bindings to native libraries.

## Crates

| Crate | Library | Description |
|-------|---------|-------------|
| `libkrun-sys` | libkrun, libkrunfw | VM execution engine (KVM-based) |
| `libgvproxy-sys` | libgvproxy | Networking backend (gvisor-tap-vsock) |

## Convention

Each `-sys` crate follows a convention for exposing library paths to downstream crates:

```
cargo:{LIBNAME}_BOXLITE_DEP=<path>
```

This becomes available as `DEP_{LINKS}_{LIBNAME}_BOXLITE_DEP` in dependent crates.
The `boxlite` crate auto-discovers these using regex and bundles all libraries into a runtime directory.

## Stub Mode

For CI linting (clippy), building native libraries can be skipped by setting environment variables:

```bash
BOXLITE_DEPS_STUB=1      # Skip building libkrun/libkrunfw/libgvproxy
```

This emits stub link directives allowing `cargo clippy` to check Rust code without expensive native builds.

## Build Behavior

### macOS
- Uses Homebrew-installed libraries via pkg-config
- Libraries are copied to OUT_DIR with fixed install names

### Linux
- `libkrun-sys`: Builds from vendored sources (git submodules)
- `libgvproxy-sys`: Builds from Go sources using cgo
