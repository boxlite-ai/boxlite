# CLAUDE.md

## Project Overview

- [README.md](./README.md) — features, quick start, supported platforms
- [docs/architecture/README.md](./docs/architecture/README.md) — components, use cases
- [sdks/python/README.md](./sdks/python/README.md) — Python SDK (3.10+, PyO3 bindings, async API)
- [sdks/node/README.md](./sdks/node/README.md) — Node.js/TypeScript SDK (18+, napi-rs bindings)
- [sdks/go/README.md](./sdks/go/README.md) — Go SDK (1.24+, CGO + prebuilt native library)
- [sdks/c/README.md](./sdks/c/README.md) — C SDK (C11, cbindgen FFI, Simple + Native API)

## Tech Stack

- [docs/architecture/README.md#tech-stack](./docs/architecture/README.md#tech-stack) 

## Project Structure

- [CONTRIBUTING.md](./CONTRIBUTING.md#project-structure) — directory layout
- [docs/architecture/README.md](./docs/architecture/README.md) — component architecture

## Common Commands

- `make help` — list all targets ([Makefile](./Makefile))
- Always use `make` targets for build, test, lint, format, setup, and distribution. Do not run `cargo`, `npm`, `python`, `go`, or `cbindgen` directly when a make target exists — the Makefile encapsulates correct flags, cross-compilation, environment setup, and ordering.

## Code Style

- [docs/development/rust-style.md](./docs/development/rust-style.md)

## Workflow

Every change goes: understand → research → design → implement → test → verify. Leave the code easier to read, test, and change than you found it. Make small, deliberate changes that directly support the task; don't rewrite or reformat unrelated code.

**Understand**

- Read this file, the nearest README/CONTRIBUTING, relevant docs, and the actual source before editing.
- Identify the smallest behavioral change that satisfies the request.
- Check the existing naming, module layout, test style, logging, and error-handling conventions in the affected area.
- Look for nearby tests or scripts that already define expected behavior.
- Reproduce-before-fix: when fixing a bug, write the failing test first, observe it fail, then fix. Do not create tests that don't actually test project code. A test that only exercises stdlib or framework code is not a real test.
- If docs and implementation disagree, capture the conflict and ask before making architectural assumptions.

**Research**

- Cite real `file:line` refs from similar projects. The user routinely asks "research other projects" if this step is skipped.

**Design**

- Don't be yes-man — challenge assumptions (yours too); ask whether a layer needs to know what you're about to teach it.
- Search before implement — `grep` for existing code first.
- Single responsibility — one function, one reason to change.
- One level of abstraction per function — don't mix orchestration with parsing, validation, persistence, rendering.
- **High cohesion, loose coupling via struct facade:** group related state + behavior into a struct; expose 1-2 `pub` entry points; keep internals + helpers private (minimizes cross-module knowledge). *Anti-pattern:* scattered free `pub fn`s callers must stitch together — leaks call order, helper graph, and shared state into every call site; every new caller re-learns the workflow. *Example:* [`ImageManager`](src/boxlite/src/images/manager.rs) exposes `new`/`pull`/`list`/`load_from_local` and hides `Arc<ImageStore>`, blob sources, manifest handling. *Exception:* stateless utilities (e.g., [`jailer/common/`](src/boxlite/src/jailer/common/) async-signal-safe helpers).
- Co-locate related code — fields, methods, and helpers that work together stay in the same file/module.
- DRY when it's the same rule, policy, or transformation. Tolerate small local duplication when an abstraction would hide important local behavior.
- Validation at the boundary — untrusted inputs get checked where they enter; trust internal code.
- Composition over inheritance / framework magic.
- Only what's used — no future-proofing; delete dead code immediately.
- No premature optimization — measure first.

**Implement**

- Boring code — obvious > clever. Code is read more than written.
- Names reveal intent, domain, and units. Booleans are predicates (`is_ready`, `has_token`, `can_retry`). Avoid `data`/`info`/`tmp`/`thing`/`handle`/`process` outside tiny scopes. Don't reuse one variable for two concepts in the same scope.
- Guard clauses + early returns over deeply nested control flow.
- Short argument lists. Group related values into typed options. Don't use boolean flags that make one function do two workflows — split them.
- Visible side effects: network calls, file writes, process exec, DB mutations should be explicit at the call site.
- Explicit errors — fail fast on missing config / invalid inputs; include operation, resource id, endpoint/status, input shape. Preserve the original cause when wrapping. Never swallow silently. Mask secrets in errors and logs.
- Explicit paths — calculate from known roots, never assume.
- Prepare before execute — setup before irreversible operations.
- No `sleep` for events — channels/waitpid/futures.
- Concurrency: timeouts, retries, cancellation explicit for external work. No unbounded queues/concurrency/memory. Close/release files, sockets, clients, browser handles, subprocesses. Retry loops must be idempotent (or document why safe).
- Security: no secrets in commits, logs, or test fixtures. Validate before SQL/shell/URL/path/HTML/prompt. Avoid shell execution with untrusted input.
- Comments explain *why*, not *what*: non-obvious intent, hidden constraints, deliberate trade-offs. Delete comments that restate the code or preserve dead decisions. Update nearby comments when behavior changes. Don't paste long excerpts from books, tickets, or logs.
- Follow the repository's existing formatter, linter, language level, and module style. Keep diffs focused — no whitespace churn outside touched lines. Add a new dependency only when it materially reduces risk or complexity.

**Test**

- Every test must reference a project symbol — no framework- or standard-library-only filler. Self-check: "name the project symbol this test calls." Filler tests would stay green if the production fix were ripped out.
- Add or update tests when behavior changes around branching, parsing, retries, security checks, or boundaries.
- Prefer focused tests that prove the *right* reason for the change.
- Do not create tests that don't actually test project code. A test that only exercises stdlib or framework code is not a real test.
- Temporary tests that don't reference a project symbol must be written to a temporary directory — they are not production tests.
- Never weaken a test to force it green — fix the code under test, not the assertion.

**Verify** (before reporting done)

- Run the smallest relevant verification first (`make test`, package-scoped test), then broaden if risk justifies.
- Don't claim tests passed unless they actually ran. If verification can't run, state the blocker and the residual risk.

**Cross-cutting** (apply at every phase)

- Verify external findings against the working tree before acting. `/codex:adversarial-review`, lint, and PR comments work from a snapshot — they may name deleted code. `git grep` and `git diff` first.
- Honor scope reduction: "drop X" means drop X. Don't bundle adjacent improvements unprompted.

Adapted from Clean Code (Robert C. Martin) via the polygala-inc AGENTS.md distillation.
