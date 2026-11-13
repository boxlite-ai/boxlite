# CLI development guide

This guide covers building, testing, and contributing to the BoxLite CLI (`boxlite`). The CLI is implemented in the `boxlite-cli` crate and follows the same [Rust Style Guide](./rust-style.md) as the rest of the project.

## Building the CLI

From the repository root:

```bash
make cli
```

This builds the debug runtime first (if needed) via `make runtime:debug`, then runs `cargo build -p boxlite-cli`. The binary is produced at:

```text
./target/debug/boxlite
```

Run it with `./target/debug/boxlite --help`. For a release build, use:

```bash
cargo build -p boxlite-cli --release
```

The release binary is at `./target/release/boxlite`.

## Testing

### `make test` vs `make test:integration:cli`

- **`make test`** runs the strict full matrix (unit + integration) across core and SDK suites.
- **`make test:integration:cli`** runs only the CLI integration tests. It depends on `runtime:debug` and then:

  ```bash
  cargo test -p boxlite-cli --tests --no-fail-fast -- --test-threads=1
  ```

When working on the CLI, run both as needed:

```bash
make test
make test:integration:cli
```

### No-VM boundary tests vs VM integration tests

The `serve` command has two test surfaces with different responsibilities:

- **Inline unit modules** (`src/cli/src/commands/serve/mod.rs` `mod tests` and
  its child `serve/tests/*.rs`) cover request shape, error mapping,
  middleware, REST transport, and OpenAPI contracts without a VM:

  ```bash
  make test:unit:cli
  ```

- **Integration tests** (`src/cli/tests/*.rs`, e.g. `ssh_rest.rs`) run the
  real `boxlite serve` process and a guest to verify VM-dependent behavior:

  ```bash
  make test:integration:cli FILTER=ssh_rest
  ```

`make test:unit:cli` builds the CLI and uses `jq` (required on PATH) to read its
executable path from Cargo's JSON artifact output before running cargo test or nextest. It exports that exact
path as `CARGO_BIN_EXE_boxlite` for unit tests that launch subprocesses. This also
works with cached builds and custom target/build directories, without depending
on Cargo's internal test layout (which changed in Cargo 1.100).

Collect the CLI portion of coverage independently with:

```bash
BOXLITE_DEPS_STUB=1 make coverage:cli
make coverage:report
```

`coverage:cli` appends profiles; the aggregate `coverage`/`coverage:lcov` targets
clean profiles first and include this collector. It accepts the existing
`FILTER`, `NEXTEST_FILTER_EXPR`, and `NEXTEST_PROFILE` settings. The preparatory
CLI build uses cargo-llvm-cov's instrumentation and selected target/build
directories, including `CARGO_LLVM_COV_TARGET_DIR` and
`CARGO_LLVM_COV_BUILD_DIR` overrides. Instrumentation stays inside that build's
subshell so it cannot alter the following cargo-llvm-cov invocation. Both entry
points stop before tests if building or resolving the CLI executable fails.

After changing these Make entry points, run both `make test:unit:scripts` and
`make test:apps:infra`. Their Cargo fakes must emit executable artifact metadata;
fixtures that isolate PATH must also expose the wrapper's real shell utilities.

The [CI coverage selection](../../../make/coverage.mk) includes CLI unit tests
and the `auth`, `ssh_cloud`, `custom_kernel_rc`, and `checkpoint` integration
targets, excluding VM suites such as `ssh_rest.rs`.
It also excludes inline `::vm_install::` tests, even when a caller's filter
selects them; those remain in `make test:integration:cli` on a VM-capable host.
In-process alias-installation tests parse the real CLI schema with environment
bindings removed and resolve saved credentials without an ambient API-key
override. Child-process regressions inject CLI settings to check this isolation
without changing the parallel test runner's environment.

The shared SSH fixture launches the normal `boxlite` executable, so
`make test:unit:cli` builds it before running inline tests.
Integration targets build it through Cargo's target selection.
The fixture honors `CARGO_BIN_EXE_boxlite`; without that integration-test variable,
it resolves the executable beside the nearest Cargo `deps` or `build` directory.
For example, `custom-profile/build/boxlite-cli/<hash>/out/harness` and
`custom-profile/deps/harness` both use `custom-profile/boxlite`.
This supports custom target directories and profiles with colocated build outputs.
If `build.build-dir` separates those outputs, set `CARGO_BIN_EXE_boxlite` to the
normal CLI executable; missing binaries fail with a build instruction.

The `checkpoint` target runs real CLI commands against loopback HTTP without a
guest. It checks checkpoint management, import creation/replacement, tenant and
credential forwarding, pagination, deletion errors, and rejection of configuration
overrides. These command paths contribute coverage alongside the inline parser
and reference-server tests.

Authentication unit tests inspect the resolved REST endpoint and bearer
credential without contacting the hosted API. Login resolves the server URL
once before dispatching to API-key, browser, or device login; each flow receives
that resolved URL. The `auth` integration target validates authentication and
credential storage against loopback HTTP services with isolated credential stores.

The `contexts` integration target also runs without a VM. It exercises the real
CLI with temporary homes and loopback servers: persistent selection, Docker's
context/URL precedence, legacy aliases, credentials and tenant routing, logout,
and private atomic preference writes. Run it with the auth and help checks:

```bash
BOXLITE_DEPS_STUB=1 make test:integration:cli SETUP_DONE=1 \
  NEXTEST_FILTER_EXPR='binary(contexts) | binary(auth) | binary(help) | binary(completion)'
```

`contexts::initialize` snapshots a workload's context and credentials before
dispatch. A unit test changes both files between backend detection and runtime
creation, then verifies the actual HTTP endpoint, bearer, and tenant path remain
unchanged. Auth commands resolve the name once but retain their credential
read/write and OIDC refresh behavior. Local-only commands and completion skip
context initialization. These stubbed checks do not exercise a guest VM.

VM integration tests pull images, create boxes, and run real commands. They require a working VM environment (KVM on Linux or Hypervisor.framework on macOS). Tests use a shared test home (`/tmp/bl`), a global lock to avoid concurrent use, and pre-pulled images (`alpine:latest`, `python:alpine`) to reduce rate limits.

### CLI test layout

- **Entry points:** `boxlite-cli/tests/*.rs` — one file per command (e.g. `run.rs`, `create.rs`, `exec.rs`, `list.rs`).
- **Shared setup:** `boxlite-cli/tests/common/mod.rs` provides `boxlite()` returning a `TestContext` that:
  - Uses `CARGO_BIN_EXE_boxlite` and `--home` pointing at a shared directory (e.g. `/tmp/bl`).
  - Uses a global lock so tests don’t run concurrently against the same home.
  - Pre-pulls images, sets a timeout (e.g. 60s), and exposes `cleanup_box` / `cleanup_boxes`.

Tests use `assert_cmd::Command` and `predicates` to assert exit codes and stdout/stderr. New tests should use `common::boxlite()` and clean up any boxes they create (e.g. with `--rm` or `ctx.cleanup_box(...)`).

Example pattern:

```rust
#[test]
fn test_run_exit_code_success() {
    let mut ctx = common::boxlite();
    ctx.cmd
        .args(["run", "--rm", "alpine:latest", "sh", "-c", "exit 0"]);
    ctx.cmd.assert().success();
}
```

## Code structure

- **Entry:** `boxlite-cli/src/main.rs` — parses the CLI and dispatches to `commands::*`.
- **Subcommands and flags:** `src/cli.rs` — clap definitions: `Cli`, `Commands`, `GlobalFlags`, `ProcessFlags`, `ResourceFlags`, `ManagementFlags`.
- **Command implementations:** `src/commands/*.rs` — each command has an `execute(args, global)`; they share `global.create_runtime()` and similar helpers.

### Adding a new subcommand

1. Add a new variant to `Commands` in `src/cli.rs` and the corresponding `Args` type (or reuse existing flags).
2. In `src/commands/mod.rs`, add the new module and export the `execute` function.
3. In `src/main.rs`, add a branch in `run_cli` that calls the new command’s `execute`.
4. Add tests in `boxlite-cli/tests/<command>.rs` and run `make test:integration:cli`.

The nine agent commands use two subcommand levels (`agent wait`).
`clap_complete` 4.6.3 emits their Fish options, but its second-level conditions
match command names anywhere in the input. `generate_fish_completion` replaces
those agent conditions with exact command-path checks so IDs, messages and option
values cannot hide verbs or enable unrelated flags. The interpreter tests cover these cases;
revisit the condition replacement when upgrading `clap_complete`. The generated
global option specification also needs the legacy `--profile` alias added because
the generator only enumerates canonical names there. Tests exercise both selector
spellings through Fish's interpreter.

## Command reference

| Command        | Description |
|----------------|-------------|
| `make cli`     | Build the CLI (after building the debug runtime). |
| `make test:integration:cli` | Run CLI integration tests (single-threaded). |
| `make test`    | Run strict full matrix (unit + integration across core + SDK). |
| `make test:integration:core` | Run core integration suites (Rust + CLI). |
| `make fmt`     | Format all supported language surfaces. |
| `make lint:rust` | Run Rust lint checks (clippy). |

## See also

- [Rust Style Guide](./rust-style.md) — coding standards for BoxLite.
- [CONTRIBUTING.md](../../../CONTRIBUTING.md) — general contribution workflow.
- [boxlite-cli/README.md](../../../src/cli/README.md) — user-facing CLI documentation.
