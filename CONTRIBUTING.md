# Contributing to BoxLite

Thank you for your interest in contributing to BoxLite!

## Getting Started

### Prerequisites

- Rust 1.75+ (stable)
- macOS (Apple Silicon) or Linux (x86_64/ARM64) with KVM
- Python 3.10+ (for Python SDK development)

### Building from Source

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

For detailed build instructions, see [docs/guides](./docs/guides/README.md#building-from-source).

### Running Tests

```bash
make test
```

Key test entry points:

- `make test` / `make test:all` - full test matrix (unit + integration)
- `make test:unit` - all unit suites
- `make test:integration` - all integration suites
- `make test:all:python` - Python unit + integration suites
- `make test:all:c` - C SDK suite via CMake/CTest

### Coverage

`make codecov` collects fresh Rust coverage. Codecov requires **90% coverage
of changed lines**, with no tolerance below that target. Total project coverage
is reported as an informational status. The local collection command checks
test success; Codecov evaluates changed lines against the pull request's base.

The Rust report combines core, shared, REST, CLI (including authentication
integration tests), C/Node/Python native bindings, native VMM, and the
runtime/shutdown/network tests that need no VM. Hosted runtime and C unit tests
use the existing test-only runtime constructor; production runtime creation
still validates the host. Linux also collects guest unit coverage. Vendored
dependencies, standalone tests, and test scaffolding are excluded; production guest and SDK
paths are not ignored by Codecov. SDK language wrappers, cloud apps, and shim
subprocess execution are separate from the Rust unit report.

The Test workflow also uploads Python and Node.js SDK coverage, Go SDK and
networking bridge coverage, and cloud API coverage. Each reporter includes
unvisited production files. Codecov carries forward reports for unchanged
components when their path-filtered jobs are skipped.

| Command | Report under `target/coverage/` | Requirements |
| --- | --- | --- |
| `make coverage:python` | `python/coverage.xml` | Python development dependencies |
| `make coverage:node` | `node/lcov.info` | Node.js 20+ and SDK dependencies |
| `make coverage:go` | `go-sdk.out`, `gvproxy.out` | Native runtime and Go toolchain |
| `make coverage:api` | `api/lcov.info` | App dependencies, Postgres, Redis |

On a VM-capable host, `make coverage:python:integration` and
`make coverage:node:integration` build the native SDKs and run both unit and
integration tests, replacing their reports with the combined results. Python
tests marked `e2e` still require separate external services and credentials.

These collectors produce fresh reports, bypassing Nx's result cache for API
coverage. Codecov combines them to evaluate the 90% changed-line gate and report
total coverage. A report does not establish coverage for components that
have not been instrumented: shim subprocesses, the cloud runner/proxy, and
dashboard still require additional collection.

```bash
# Unit and non-VM coverage, using the same dependency stubs as CI.
BOXLITE_DEPS_STUB=1 make codecov

# Generate the same LCOV report directly while investigating gaps.
BOXLITE_DEPS_STUB=1 make coverage:lcov

# On a VM-capable host, add runtime and CLI integration coverage to it.
# Leave BOXLITE_DEPS_STUB unset for the real runtime build and execution.
make coverage:integration
```

LCOV is written to `target/coverage/lcov.info`; `make coverage` and
`make coverage:integration` also write `target/coverage/html/index.html`.
Collection starts clean for unit coverage; integration coverage appends to
those profiles. Do not run Rust collectors concurrently in one checkout.
Use `make coverage:report` to inspect partial Rust profiles after a test failure;
such a report does not make the failed test run successful.

The accumulation uses cargo-llvm-cov's `--no-report` followed by `report`, as
in its [upstream CI workflow](https://github.com/taiki-e/cargo-llvm-cov/blob/main/.github/workflows/ci.yml#L448-L450).
Threshold behavior follows [Codecov's status configuration](https://docs.codecov.com/docs/commit-status).

## How to Contribute

### Reporting Issues

- Use [GitHub Issues](https://github.com/boxlite-ai/boxlite/issues)
- Include OS, architecture, and BoxLite version
- Provide minimal reproduction steps
- **Security vulnerabilities:** do not open a public issue. See [SECURITY.md](./SECURITY.md) for the private reporting process.

### Pull Requests

1. Fork the repository, unless you can push here: CI cannot mark a pull request opened from a fork, so it refuses one from an owner, member or collaborator and asks for a branch in this repository instead
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run quality and tests (`make lint && make fmt:check && make test`)
5. Commit with clear messages — see [Commit & PR messages](#commit--pr-messages)
6. Open a Pull Request
7. CI commits `UNREVIEWED.md` and converts the pull request to a draft. Read the diff, delete that file in a commit, and mark the pull request ready; merged with the file still there, it lands on the default branch and says so. From a fork nothing is committed and the check passes, since the workflow cannot write your branch — if it happens to carry `UNREVIEWED.md`, delete it anyway, or merging puts that file on the default branch
8. Sign the [BoxLite Contributor License Agreement](./docs/legal/CLA.md) when CLA Assistant asks you to do so

### Watching CI and PR feedback

Once the pinned agent tooling is installed (`make setup`, once per clone),
every `git push` arms a background watcher via its shared pre-push hook, so it
runs the same for a human, Claude Code, Codex, or any other agent. It waits for
the push to land, waits for a PR to appear (which covers a later `gh pr create` —
`gh` has no hook system), then emits one JSON line per event: each check as it
concludes, plus every new comment, review, and inline review thread.

```bash
# follow the current branch's events; ends itself when the PR merges or closes.
# `/` becomes `-` in the filename, so feature/foo logs to feature-foo.jsonl.
branch="$(git branch --show-current)"
hooks_path="$(git config --get core.hooksPath)"
tooling_root="$(cd "$hooks_path/.." && pwd)"
"$tooling_root/.agents/watch/pr-watch-stream.sh" "$(git rev-parse --git-path pr-watch)/${branch//\//-}.jsonl"

# watch a specific PR in the foreground, without pushing
"$tooling_root/.agents/watch/pr-watch.sh" --pr 1234 --once
```

Events land under `$(git rev-parse --git-path pr-watch)/` — inside `.git/`, so
they are per-worktree and never tracked. What an agent may fix unattended versus
what needs a human is defined by the
[shared escalation policy](https://github.com/boxlite-ai/agent-tooling/blob/main/plugins/boxlite-agent-tooling/.agents/watch/escalation-policy.md).

Set `BOXLITE_PR_WATCH=0` to disable. It is best-effort by construction: a
watcher that cannot start never fails your push.

### Commit & PR messages

Write for a reviewer skimming in ~30 seconds. Describe the change, not the process that produced it.

**Commits** — [Conventional Commits](https://www.conventionalcommits.org):

- Subject: `type(scope): summary` — imperative, ≤72 chars, no trailing period. Types: `feat` `fix` `docs` `refactor` `test` `chore` `perf` `ci` `build`.
- Body: the *why* — the problem, why this change solves it, alternatives rejected; wrap ~72. Squash merges here keep the PR description and drop the branch commits, so the PR body Why section is what reaches `git log`; keep the commit body consistent with it.

**PRs** — title is a Conventional-Commit subject; the description follows [`.github/pull_request_template.md`](./.github/pull_request_template.md) in this order:

| Order | Section | Content | Checked by |
| --- | --- | --- | --- |
| 1 | `## Call graph` | first non-blank content; one column-one `text` fence holding the end-to-end *Before* and *After* path, one line per hop `fn_name  (Type · path/file.rs:LOC)  — role`; only the hops that change, elide the rest with `…` | agent-tooling preflight hook |
| 2 | `Fixes #<n>` | bug fixes only; first non-blank line after the fence; the faulty *Before* hop carries `← BUG: <what goes wrong>` | preflight hook |
| 3 | `## Why` | the problem, why this change solves it, alternatives rejected | reviewer |
| 4 | `## User-facing change` | one line: what a user, SDK caller, or agent now sees differently, or `NONE` | reviewer |
| 5 | `## Verification` | commands run and what they showed; for a fix, the test failing on the reverted change and passing on the restored one | reviewer |

- Root the graph at what a person triggers (a `boxlite` command, an SDK call, an API request) and end it at what they observe; *After* leaves may name the test that guards each changed hop.
- Add a `sequence` fence only when ordering, retries, cancellation, or a callback is the point.
- Paste bodies into `gh pr create --body '…'` single-quoted; the fence's backticks are command substitution inside double quotes, and the hook denies the command.

````markdown
## Call graph

```text
Before
  boxlite exec <box> -- <cmd>                                              — user command
  └─ exec_box            (BoxHandle · src/boxlite/src/portal/exec.rs:88)
       └─ open_console   (Jailer · src/boxlite/src/jailer/console.rs:41)  ← BUG: returns before the socket binds
            └─ attach_stdio (Guest · src/guest/src/io.rs:12)              — never reached; the user gets an empty prompt

After
  boxlite exec <box> -- <cmd>                                              — user command
  └─ exec_box            (BoxHandle · src/boxlite/src/portal/exec.rs:88)
       └─ open_console   (Jailer · src/boxlite/src/jailer/console.rs:41)  — awaits the bind future
            └─ attach_stdio (Guest · src/guest/src/io.rs:12)              — guarded by console::binds_before_attach
```

Fixes #1042

## Why

- `open_console` returned as soon as the bind future existed, so `attach_stdio` raced the socket and the first `exec` showed an empty prompt.
- Awaiting the bind is the smallest change that orders the two.
- Rejected: polling the socket path; it races the unlink the jailer performs on restart.

## User-facing change

`boxlite exec` no longer shows an empty prompt on the first attach.

## Verification

- `cargo test -p boxlite console::binds_before_attach`: fails on the reverted change with "attach before bind", passes with it restored.
````

**Never put in a commit or PR** the process that produced the change (conversation / AI / step-by-step narrative), pasted logs or tickets, or secrets.

### Code Style

Follow the [Rust Style Guide](./docs/development/rust-style.md) which includes:

- [Microsoft Rust Guidelines](https://microsoft.github.io/rust-guidelines)
- BoxLite-specific patterns (async-first, centralized errors, thread-safe types)

**Quick reference:**

- `make fmt` / `make fmt:check` for formatting checks
- `make lint` / `make lint:fix` for lint checks and safe autofix
- Keep functions focused (single responsibility)
- Add tests for new functionality
- Update documentation as needed

## Project Structure

```
src/
  boxlite/        # Core runtime (Rust)
  cli/            # CLI
  server/         # Distributed server
  shared/         # Shared types and protocol
  ffi/            # FFI layer for SDKs
  guest/          # Guest agent (runs inside VM)
  test-utils/     # Test utilities
  deps/           # Vendored C sys crates
sdks/
  python/         # Python SDK
  c/              # C SDK
  node/           # Node.js SDK
examples/         # Example code
```

## License

BoxLite is licensed under the Apache License, Version 2.0.

By contributing, you agree that your contributions will be licensed under the Apache License, Version 2.0. Pull requests must satisfy CLA Assistant using the [BoxLite Contributor License Agreement](./docs/legal/CLA.md).
