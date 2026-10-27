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

The [CI coverage selection](../../../make/coverage.mk) includes CLI unit
tests and the `auth` integration target, excluding VM suites such as `ssh_rest.rs`.

Authentication unit tests inspect the resolved REST endpoint and bearer
credential without contacting the hosted API. Login resolves the server URL
once before dispatching to API-key, browser, or device login; each flow receives
that resolved URL. The `auth` integration target validates authentication and
credential storage against loopback HTTP services with isolated credential stores.

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
