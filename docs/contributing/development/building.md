# Building from source

## Prerequisites

- Rust 1.88+ (stable)
- macOS (Apple Silicon) or Linux (x86_64/ARM64) with KVM
- Python 3.10+ (for Python SDK development)

## Quick start

```bash
# Clone the repository
git clone https://github.com/boxlite-ai/boxlite.git
cd boxlite

# Initialize submodules
git submodule update --init --recursive

# Build
make setup
make dev:python
```

## NixOS and Nix

`make setup` does not install packages on NixOS. Use the flake dev shell at the
repo root instead. It needs [flakes enabled](https://wiki.nixos.org/wiki/Flakes),
is community-maintained, and is verified on x86_64 NixOS only.

```bash
nix develop -c make cli
```

- `flake.lock` pins nixpkgs (`nixos-26.05`), so every host gets the same gcc,
  musl, glibc, Go, and LLVM. Run `nix flake update` to move the pin.
- Rust is not pinned by Nix: rustup follows `rust-toolchain.toml`, as on CI.
- musl comes from `pkgsCross.musl64` as `x86_64-linux-musl-*` and `musl-gcc` on
  `PATH`; static glibc is on `LIBRARY_PATH` only. Adding either as a shell
  package breaks dynamic host links.
- `BOXLITE_LIBRESOLV_DIR` points `libgvproxy-sys` at a directory holding
  `libresolv.a`, for hosts without `/usr/lib/<triple>` or `/usr/lib64`.
- CI checks it: the `nix` job in `.github/workflows/test.yml` runs this command
  with `--ignore-environment` on Ubuntu and boots a box when build inputs
  change. A red `nix` job does not block merge yet, but a change to build
  scripts, Make recipes, or `-sys` crates that breaks the shell should fix
  `flake.nix` too. Ubuntu has `/usr/lib`, so CI misses a regression that breaks
  only on NixOS, such as a lost `BOXLITE_LIBRESOLV_DIR`.
- After a failed build, remove `src/deps/libkrun-sys/vendor/libkrun/target`
  before retrying; a stale libkrun build script stays cached there.

## Makefile targets

| Target             | Description                              |
|--------------------|------------------------------------------|
| `make setup`       | Install platform-specific dependencies   |
| `make guest`       | Build guest binary + filesystem tools    |
| `make shim`        | Build boxlite-shim binary                |
| `make runtime`     | Build complete BoxLite runtime           |
| `make dev:python`  | Local Python SDK development             |
| `make dist:python` | Build portable Python wheels             |
| `make clean`       | Clean build artifacts                    |

## Release version alignment

The runtime, CLI, C bindings, and Python/Node SDKs share the Rust workspace version.
Update these together when preparing a release:

- `Cargo.toml`: `workspace.package.version` and internal `workspace.dependencies` versions.
- `Cargo.lock`: the matching workspace package versions.
- `sdks/python/pyproject.toml`: `project.version`.
- `sdks/node/package.json` and `package-lock.json`: package version and lockfile root versions.
- Root `package.json`: the `@boxlite-ai/boxlite` dependency range.

Select Cargo lock entries by package name: third-party dependencies can share the
old version number. `boxlite-test-utils` keeps its independent version. The Go release
workflow derives its `sdks/go/v...` tag from `Cargo.toml`. Version edits prepare source
metadata; publishing follows the [release workflows](../../../.github/workflows/README.md).

## TLS dependency security updates

BoxLite's Rust HTTPS clients use rustls. Registry pulls trust both the bundled
Mozilla roots and the host certificate store, so update the certificate verifier
as well as the bundled roots when addressing CA distrust advisories.

For CVE-2026-111943, require `rustls-webpki` 0.103.16 or later in the 0.103 series
([RUSTSEC-2026-0382](https://rustsec.org/advisories/RUSTSEC-2026-0382.html)) and
resolve `webpki-roots` 1.x to at least 1.0.10
([RUSTSEC-2026-0381](https://rustsec.org/advisories/RUSTSEC-2026-0381.html)).
The existing direct `webpki` dependency sets the verifier minimum for downstream
Rust consumers too. `webpki-roots` 0.26.11 is a compatibility wrapper: its resolved
1.x parent supplies the roots and must also be patched.

Use package-specific `cargo update --precise` updates to keep unrelated versions
locked. Check `cargo audit` and the resolved dependency trees with default and
all features, then run the image tests with
`BOXLITE_DEPS_STUB=1 make test:unit:rust FILTER=images::`.
Rebuild and redistribute the CLI and SDK native binaries; editing the lockfile or
updating the host trust store does not update an already-built verifier or its
bundled roots.

## Platform support

| Platform | Architecture          | Hypervisor           |
|----------|-----------------------|----------------------|
| macOS    | ARM64 (Apple Silicon) | Hypervisor.framework |
| Linux    | x86_64                | KVM                  |
| Linux    | ARM64                 | KVM                  |

## Build scripts

Build scripts are located in `scripts/`:

```text
scripts/
├── setup/              # Platform-specific setup
│   ├── macos.sh
│   ├── ubuntu.sh
│   ├── manylinux.sh
│   └── musllinux.sh
├── build/              # Build scripts
│   ├── build-guest.sh         # Guest binary (cross-compile)
│   ├── build-guest-deps.sh    # Static guest e2fsprogs tools
│   ├── build-shim.sh          # Shim binary
│   └── build-runtime.sh
├── package/            # Packaging scripts
└── common.sh           # Shared utilities
```
