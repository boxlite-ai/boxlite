# Contributing to BoxLite

Thank you for your interest in contributing to BoxLite!

## Getting Started

### Prerequisites

- Rust 1.88+ (stable)
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

For detailed build instructions, see [Building from source](./docs/contributing/development/building.md).

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

The Test workflow also uploads Python and Node.js SDK coverage; Go SDK,
networking bridge, and cloud runner coverage; and cloud API coverage. Each
reporter includes unvisited production files. Codecov carries forward reports for unchanged
components when their path-filtered jobs are skipped.

| Command | Report under `target/coverage/` | Requirements |
| --- | --- | --- |
| `make coverage:python` | `python/coverage.xml` | Python development dependencies |
| `make coverage:node` | `node/lcov.info` | Node.js 20+ and SDK dependencies |
| `make coverage:go` | `go-sdk.out`, `gvproxy.out`, `runner.out` | Native runtime and Go toolchain |
| `make coverage:api` | `api/lcov.info` | App dependencies, Postgres, Redis |

On a VM-capable host, `make coverage:python:integration` and
`make coverage:node:integration` build the native SDKs and run both unit and
integration tests, replacing their reports with the combined results. Python
tests marked `e2e` still require separate external services and credentials.

These collectors produce fresh reports, bypassing Nx's result cache for API
coverage. Codecov combines them to evaluate the 90% changed-line gate and report
total coverage. A report does not establish coverage for components that
have not been instrumented: shim subprocesses, the cloud proxy, and
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

1. Fork the repository or create a branch here if you have push access
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run quality and tests (`make lint && make fmt:check && make test`)
5. Commit with clear messages — see [Commit & PR messages](#commit--pr-messages)
6. Open a Pull Request
7. CI converts unacknowledged PRs to draft. Read the current diff, check that the description accurately explains it, then post the exact `/reviewed <full-head-SHA>` command from the bot comment. Only a new, unedited comment from the PR author counts. Once `Author reviewed the PR` passes, click **Ready for review**. A new commit, or editing/deleting the only acknowledgment, returns the PR to draft and requires a fresh comment. Forks use the same flow. Maintainer approval remains separate
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
- Body: the *why* — the problem, why this change solves it, alternatives rejected; wrap ~72. Squash merges here keep the PR description and drop the branch commits, so the PR body is what reaches `git log`; keep the commit body consistent with it.

**PRs** — title is a Conventional-Commit subject. Use
[`.github/pull_request_template.md`](./.github/pull_request_template.md) as a starting
point; choose bullets, a real example, a table, a diagram, or short prose by clarity.
No diagram, source annotation, or section order is mandatory.

- Link the design doc on the `Design doc:` line: a 1–3 page GitHub issue, Notion
  page, or Linear issue, in that preference order. Every PR needs one, drafts
  included; keep it aligned with the final scope. Use `Fixes #<n>` only when the PR
  closes that GitHub issue.
- Keep each PR within 400 changed lines (target 100–200), counting tests, docs, and
  generated text. Split larger work into child issues under a parent issue, one
  coherent PR per child.
- Explain the problem, how the change produces the result, and the resulting
  behavior once. Keep the whole description within
  **120 words**, fenced blocks included, with no paragraph over 80 words and no list
  item over 40. Table pipes and box-drawing characters do not count as words. No walls of text.
- Keep material risks and untested behavior visible. Link detailed evidence instead
  of pasting logs, file inventories, or exhaustive test counts.
- Include decisive verification as `command → observed result`. For a fix, briefly
  report the observed failure with all production changes reverted and the pass with
  the complete fix restored.

The shared hook applies these limits to the text agents post to GitHub: PR bodies,
drafts included, and issues, comments, reviews, discussions, and release notes, whether
sent through `gh` flags or API `body=` fields. It rejects text it cannot inspect. Later
bot additions are outside this check; the writing rules still apply.

Illustrative example; behavior and test results are hypothetical:

```markdown
Design doc: https://github.com/example/repo/issues/123

Reduce routine SDK CI work while retaining weekly compatibility coverage.

- A PR changing both SDKs runs 11 jobs instead of 21.
- Full platform combinations run weekly and on manual requests.

Verification: workflow checks passed. Hosted CI timing has not been measured.
```

**Never put in a commit or PR** the process that produced the change (conversation / AI / step-by-step narrative), pasted logs or tickets, or secrets.

### Code Style

Follow the [Rust style guide](./docs/contributing/development/rust-style.md), which includes:

- [Microsoft Rust Guidelines](https://microsoft.github.io/rust-guidelines)
- BoxLite-specific patterns (async-first, centralized errors, thread-safe types)

**Quick reference:**

- `make fmt` / `make fmt:check` for formatting checks
- `make lint` / `make lint:fix` for lint checks and safe autofix
- Keep functions focused (single responsibility)
- Add tests for new functionality
- Update documentation in the same pull request, in the place [Documentation](#documentation) assigns

## Project Structure

```text
src/
  boxlite/        # Core runtime (Rust)
  cli/            # boxlite CLI
  shim/           # Per-box shim process
  guest/          # Guest agent (runs inside the VM)
  vmm/            # BoxLite's own VMM
  hypervisor/     # Hypervisor backends for the VMM
  shared/         # Types and protocol shared by host, shim, and guest
  test-utils/     # Test utilities
  deps/           # Vendored C sys crates
sdks/
  python/         # Python SDK
  node/           # Node.js SDK
  go/             # Go SDK
  c/              # C SDK
openapi/          # REST API contract
examples/         # Example code
docs/             # Documentation (see Documentation below)
apps/             # Hosted platform: API, runner, preview proxy, dashboard, infrastructure
scripts/          # Build, release, and test scripts
```

## Documentation

Every doc has one home, and other docs link to it instead of repeating it. Place a doc by the
first rule that matches:

1. **A dated record** — a root-cause analysis, investigation, or design study — goes in
   [`docs/contributing/investigations/`](./docs/contributing/investigations/), whichever code it
   covers.
2. **One directory's code** — what it is, how to build and test it, how it works inside — goes in
   that directory's `README.md`: `src/<crate>/`, `sdks/<lang>/`, `apps/<app>/`,
   `examples/<name>/`. A topic too long for the README gets its own file beside it, linked from
   the README. A README that a package registry publishes (`src/cli/`, `sdks/<lang>/`) is
   written for that package's users first; a contributor guide too long for it goes in
   `docs/contributing/development/`.
3. **Several hosted-platform services** go in the [`apps/`](./apps/README.md) hub:
   `apps/README.md` for architecture, `apps/API.md` for interfaces, `apps/SCHEMA.md` for the data
   model, and `apps/infra/docs/` for deployment and operations.
4. **Using BoxLite** — the runtime, CLI, and SDKs — goes in [`docs/`](./docs/README.md), by what
   the reader needs:

   | The reader needs                                    | Directory               |
   | --------------------------------------------------- | ----------------------- |
   | A first working box                                 | `docs/getting-started/` |
   | Steps toward one goal                               | `docs/guides/`          |
   | How and why BoxLite works                           | `docs/concepts/`        |
   | Exact facts: APIs, CLI flags, configuration, errors | `docs/reference/`       |
   | A quick answer to a common question                 | `docs/faq.md`           |

5. **Working on BoxLite** across components goes in
   [`docs/contributing/`](./docs/contributing/README.md):

   | The reader needs                     | Directory                         |
   | ------------------------------------ | --------------------------------- |
   | How the code fits together           | `docs/contributing/architecture/` |
   | How to build, test, and ship changes | `docs/contributing/development/`  |

6. **The repository itself**: this file for the contribution process,
   [`AGENTS.md`](./AGENTS.md) for agent rules,
   [`.github/workflows/README.md`](./.github/workflows/README.md) for CI workflows,
   [`SECURITY.md`](./SECURITY.md) for vulnerability reports, and
   [`docs/legal/CLA.md`](./docs/legal/CLA.md) for the CLA, whose URL is published.

Apart from dated records (rule 1), `docs/` never explains how an `apps/` service works: those
services are deployment internals, not the portable contract
([reference](./docs/reference/README.md#http-api-reference)).

The four user-facing sections follow [uv's documentation](https://github.com/astral-sh/uv/tree/main/docs),
and the top-level contributor section follows [Deno's](https://github.com/denoland/docs).

When you add or change a doc:

- Link every page from its section's `README.md`, a landing page that introduces each page in a
  sentence.
- Create a directory only when its second doc arrives; until then, use the closest existing one.
- Name files in lowercase kebab-case, such as `guest-networking.md`.
- Write headings under `docs/` in sentence case: capitalize the first word and proper nouns only.
- Keep an experimental feature's page in the section its content belongs to, and state its
  status, such as release candidate, in the title or the first paragraph.
- Change a doc in the same pull request as the behavior it describes, and delete docs for behavior
  that no longer exists.

## License

BoxLite is licensed under the Apache License, Version 2.0.

By contributing, you agree that your contributions will be licensed under the Apache License, Version 2.0. Pull requests must satisfy CLA Assistant using the [BoxLite Contributor License Agreement](./docs/legal/CLA.md).
