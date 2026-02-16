# BoxLite CI/CD Workflows

This directory contains GitHub Actions workflows for building and publishing BoxLite SDKs.

## Workflow Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         config.yml                                   │
│                    (shared configuration)                            │
└─────────────────────────────────────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ↓                       ↓                       ↓
┌───────────────┐     ┌─────────────────┐     ┌─────────────────┐
│build-runtime  │     │build-wheels     │     │build-node       │
│               │     │                 │     │                 │
│ Triggers:     │     │ Triggers:       │     │ Triggers:       │
│ - boxlite/*   │────→│ - release       │     │ - release       │
│ - Cargo.*     │     │ - manual        │     │ - manual        │
│               │     │                 │     │                 │
│ Saves to:     │     │ Restores from:  │     │ Restores from:  │
│ actions/cache │     │ actions/cache   │     │ actions/cache   │
└───────────────┘     └─────────────────┘     └─────────────────┘
```

## Key Design: Cache-Based Separation

Instead of artifacts (which only work within a single workflow), we use **`actions/cache`** to share runtime builds across workflows:

```yaml
# build-runtime.yml saves:
key: boxlite-runtime-{platform}-{hash of core files}

# build-wheels.yml / build-node.yml restore:
key: boxlite-runtime-{platform}-{hash of core files}
restore-keys: boxlite-runtime-{platform}-  # fallback to latest
```

**Benefits:**
- SDK workflows only rebuild runtime on cache miss
- Same core code = same cache key = instant restore
- Core changes = different hash = new build

## Workflows

### `config.yml`

Shared configuration loaded by all workflows.

**Outputs:**
- `platforms` - Platform configurations with os and target (`[{"os":"macos-15","target":"darwin-arm64"},{"os":"ubuntu-latest","target":"linux-x64-gnu"}]`)
- `python-versions` - Python versions (`["3.10", "3.11", "3.12", "3.13"]`)
- `node-versions` - Node.js versions (`["18", "20", "22"]`)
- `node-build-version` - Node.js version for building (`"20"`)
- `rust-toolchain` - Rust toolchain version (`"stable"`)
- `artifact-retention-days` - Days to keep artifacts (`7`)

### `build-runtime.yml`

Builds BoxLite runtime, uploads to GitHub Release, and publishes Rust crates to crates.io.

**Triggers:**
- Push to `main` with changes in `boxlite/**`, `Cargo.*`, etc.
- Release published
- Manual dispatch

**What it builds:**
- `boxlite-guest` - VM guest agent
- `boxlite-shim` - Process isolation shim
- `libkrun`, `libkrunfw`, `libgvproxy` - Hypervisor libraries
- `debugfs`, `mke2fs` - Filesystem tools

**Jobs:**
1. `config` - Load shared configuration
2. `build` - Build runtime for each platform (matrix: macOS ARM64, Linux x64)
3. `upload_to_release` - Upload runtime tarballs to GitHub Release (release only)
4. `publish_crates` - Publish Rust crates to crates.io (release only, after upload)

### `build-wheels.yml`

Builds, tests, and publishes Python SDK.

**Triggers:**
- Releases
- Manual dispatch

**Jobs:**
1. `build_wheels` - Builds Python wheels using cibuildwheel
2. `test_wheels` - Tests import on Python 3.10-3.13
3. `publish` - Publishes to PyPI (on release)
4. `upload_to_release` - Uploads wheels to GitHub Release

### `build-node.yml`

Builds, tests, and publishes Node.js SDK.

**Triggers:**
- Releases
- Manual dispatch

**Package structure:**
- `@boxlite-ai/boxlite` - Main package with TypeScript wrappers
- `@boxlite-ai/boxlite-darwin-arm64` - macOS ARM64 native binary
- `@boxlite-ai/boxlite-linux-x64-gnu` - Linux x64 glibc native binary

**Jobs:**
1. `build` - Builds Node.js addon with napi-rs, outputs tarballs
2. `test` - Tests import on Node 18, 20, 22
3. `publish` - Publishes to npm (on release)
4. `upload-to-release` - Uploads tarballs to GitHub Release

### `lint.yml`

Runs code quality checks.

**Triggers:**
- Push to `main`
- Pull requests

**Jobs:**
1. `rustfmt` - Check Rust formatting
2. `clippy` - Run Clippy linter on all platforms

## Trigger Behavior

| Change | build-runtime | build-wheels | build-node |
|--------|---------------|--------------|------------|
| `boxlite/**` | ✅ Runs | ❌ Skips | ❌ Skips |
| `sdks/python/**` | ❌ Skips | ❌ Skips | ❌ Skips |
| `sdks/node/**` | ❌ Skips | ❌ Skips | ❌ Skips |
| Release published | ✅ Runs (build + upload + publish crates) | ✅ Runs | ✅ Runs |

## Cache Strategy

### Runtime Cache

```yaml
key: boxlite-runtime-{platform}-{hashFiles('boxlite/**', 'Cargo.lock', ...)}
```

- **Same core code** → Cache hit → Skip rebuild (~8 min saved)
- **Core changed** → Cache miss → Rebuild runtime

### Rust Dependencies Cache (Swatinem/rust-cache)

```yaml
shared-key: "boxlite"  # Shared across all workflows
```

- Caches `~/.cargo` and `./target` directories
- Shared across workflow runs
- Invalidates on Cargo.lock changes

## Platform Matrix

Currently supporting 2 platforms:

| Platform | OS Runner | Target |
|----------|-----------|--------|
| macOS ARM64 | `macos-15` | `darwin-arm64` |
| Linux x64 | `ubuntu-latest` | `linux-x64-gnu` |

Additional platforms (darwin-x64, linux-arm64-gnu) can be added to `config.yml` when needed.

## Time Savings

**Scenario: Only Python SDK changed**

| Without separation | With separation |
|-------------------|-----------------|
| Build runtime: 8 min | ❌ Skipped |
| Build Python: 2 min | ✅ 2 min (cache hit) |
| Build Node: 2 min | ❌ Skipped |
| **Total: 12 min** | **Total: 2 min** |

**Savings: 83% faster**

## Secrets Required

- `CARGO_REGISTRY_TOKEN` - crates.io API token for publishing Rust crates
- `PYPI_API_TOKEN` - PyPI API token for publishing Python wheels
- `NPM_TOKEN` - npm access token for publishing Node.js packages

Set these in repository Settings → Secrets and variables → Actions.

## Local Development

```bash
# Build runtime once
make runtime

# Build Python SDK (reuses runtime)
make dev:python

# Build Node.js SDK (reuses runtime)
make dev:node
```

## Troubleshooting

**Cache miss when expected hit:**
- Check if core files changed (hash is different)
- Caches expire after 7 days of non-use
- Branch-based cache isolation may apply

**Runtime binaries missing:**
- Fallback build runs automatically on cache miss
- Check logs for "Runtime cache miss - building runtime"
- Verify submodules initialized

**Node.js package install fails:**
- Platform package must be installed before main package
- Check that tarballs were uploaded correctly

## References

- [GitHub Actions Cache](https://github.com/actions/cache)
- [Swatinem/rust-cache](https://github.com/Swatinem/rust-cache)
- [cibuildwheel](https://cibuildwheel.readthedocs.io/)
- [napi-rs](https://napi.rs/)
