# BoxLite agent instructions

## Project Overview

- [README.md](./README.md) — features, quick start, supported platforms
- [docs/concepts/README.md](./docs/concepts/README.md) — how BoxLite works: boxes, images, storage, networking, security
- [sdks/python/README.md](./sdks/python/README.md) — Python SDK (3.10+, PyO3 bindings, async API)
- [sdks/node/README.md](./sdks/node/README.md) — Node.js/TypeScript SDK (18+, napi-rs bindings)
- [sdks/go/README.md](./sdks/go/README.md) — Go SDK (1.24+, CGO + prebuilt native library)
- [sdks/c/README.md](./sdks/c/README.md) — C SDK (C11, cbindgen FFI, Simple + Native API)
- [src/cli/README.md](./src/cli/README.md) — `boxlite` CLI quick start and commands reference
- [docs/reference/README.md](./docs/reference/README.md) — SDK API references (Python, Node, Rust, C) and CLI reference

## Tech Stack

- [docs/contributing/architecture/README.md](./docs/contributing/architecture/README.md) — runtime components, SDK bindings, and the source map

## Project Structure

- [CONTRIBUTING.md](./CONTRIBUTING.md#project-structure) — directory layout
- [docs/contributing/architecture/README.md](./docs/contributing/architecture/README.md) — component architecture

## Documentation

- [CONTRIBUTING.md](./CONTRIBUTING.md#documentation) — where each doc goes; place every new or moved doc by its rules.

## Common Commands

- `make help` — list all targets ([Makefile](./Makefile))
- Always use `make` targets for build, test, lint, format, setup, and distribution. Do not run `cargo`, `npm`, `python`, `go`, or `cbindgen` directly when a make target exists — the Makefile encapsulates correct flags, cross-compilation, environment setup, and ordering.

## Code Style

- [docs/contributing/development/rust-style.md](./docs/contributing/development/rust-style.md)

## Commit & PR Messages

- [CONTRIBUTING.md](./CONTRIBUTING.md#commit--pr-messages) — the local commit rules and concise PR-description guidance.

## Local Exemplars

- High-cohesion facade (the shared Design rule's exemplar here): [`ImageManager`](src/boxlite/src/images/manager.rs) exposes `new`/`pull`/`list`/`load_from_local` and hides `Arc<ImageStore>`, blob sources, and manifest handling.
- Facade exception — stateless utilities: [`jailer/common/`](src/boxlite/src/jailer/common/) async-signal-safe helpers.

<!-- agent-tooling:guidance:begin rev=933b5ec899eb sha256=eb19d38bc4ea -->

> Managed by **boxlite-ai/agent-tooling** — do not edit between the markers. Change `plugins/boxlite-agent-tooling/guidance/workflow.md` there, then rerun `./.agent-tooling/install.sh` here.

## Workflow

Every change goes: understand → research → design → implement → test → verify. Leave the code easier to read, test, and change than you found it. Make small, deliberate changes that directly support the task; don't rewrite or reformat unrelated code.

**Understand**

- Read this file, the nearest README/CONTRIBUTING, relevant docs, and the actual source before editing.
- Check the existing naming, module layout, test style, logging, and error-handling conventions in the affected area.
- Look for nearby tests or scripts that already define expected behavior.
- Reproduce-before-fix: when fixing a bug, write the failing test first, observe it fail, then fix.
- If docs and implementation disagree, capture the conflict and ask before making architectural assumptions.

**Research**

- Cite real `file:line` refs from similar projects. The user routinely asks "research other projects" if this step is skipped.

**Design**

- Before writing any code, create a 1–3 page design doc. Host it in this preference order: GitHub issue > Notion > Linear issue. Cover the problem, proposed approach, alternatives and trade-offs, and validation plan. Walls of text are forbidden; use short paragraphs, bullets, tables, or diagrams. Every PR, including drafts, must link the doc and keep it aligned with the final scope.
- Don't be yes-man — challenge assumptions (yours too); ask whether a layer needs to know what you're about to teach it.
- Search before implement — `grep` for existing code first.
- Single responsibility — one function, one reason to change.
- One level of abstraction per function — don't mix orchestration with parsing, validation, persistence, rendering.
- **High cohesion, loose coupling via a facade:** group related state + behavior into one type or module; expose 1–2 public entry points; keep internals and helpers private (minimizes cross-module knowledge). _Anti-pattern:_ scattered free public functions callers must stitch together — leaks call order, helper graph, and shared state into every call site; every new caller re-learns the workflow. _Exception:_ stateless utility modules of small pure helpers. Concrete in-repo exemplars belong in each repository's own instructions.
- DRY when it's the same rule, policy, or transformation. Tolerate small local duplication when an abstraction would hide important local behavior.
- Validation at the boundary — untrusted inputs get checked where they enter; trust internal code.
- Composition over inheritance / framework magic.
- Only what's used (Occam's razor) — design the simplest API that meets current requirements; no future-proofing. Delete dead code immediately.
- No premature optimization — measure first.

**PR size and decomposition (hard requirement)**

- Target 100–200 changed lines; maximum 400 additions + deletions across the entire PR against its intended base. Count tests, docs, and generated text. Drafts have the same limit; splitting commits does not reduce PR size.
- Estimate before implementing; measure before creating a PR and before each update. If the base or size cannot be determined, resolve that uncertainty before publishing. Never omit tests, compress code, or hide changes to meet the limit.
- For work exceeding the limit, prepare a concrete split plan. Create a parent GitHub issue and child issues with scope, dependencies, acceptance criteria, and estimated size; group them in a milestone, using a Project for multiple workstreams.
- Each child becomes a coherent, working PR within the limit, including its relevant tests. Link the child and parent issues. Implement and validate one slice at a time; re-plan if a slice grows beyond the limit.
- A human developer may authorize an oversized PR only after seeing its measured size, exact base/head, and proposed split. Ask once, without a preselected approval, for a typed response: `pr-size-exception: <specific reason this change must remain one PR>`.
- The reason must identify the affected change, the concrete constraint, and why the proposed split is unsafe or impractical. Bare approvals, “urgent,” “too much work,” and generic convenience claims do not qualify. Never invent, paraphrase, or pre-fill the developer's reason.
- Wait up to **3 minutes** from that question using a non-blocking prompt and an actual deadline. Continue reversible split preparation while waiting. Invalid replies do not restart the timer; an explicit cancellation or revised user instruction takes precedence.
- Without a valid exception by the deadline, automatically follow the split plan and continue with small PRs; do not end the task waiting for permission. Silence is never approval for an oversized PR. If timed prompting is unavailable, keep the size limit and continue splitting.
- Bind an exception to the shown repository, base/head, and measured diff; any change to that diff invalidates it. Preserve the developer's exact reason with that context in the PR description and parent issue. An exception waives only size, never tests, review, or `reviewed:` acknowledgment.
- A late reply cannot authorize the expired request or unrelated slices. Reassess the current work before requesting any new exception; never repeat the same request merely to extend the deadline.

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
- Comments explain _why_, not _what_: non-obvious intent, hidden constraints, deliberate trade-offs. Delete comments that restate the code or preserve dead decisions. Don't paste long excerpts from books, tickets, or logs.
- Follow the repository's existing formatter, linter, language level, and module style. Add a new dependency only when it materially reduces risk or complexity.

**Test**

- Two-side verification for reproducer tests. When you add a test alongside a fix, demonstrate it in this order, both manually run:
  1. You must revert **every** production change — every non-test file back to its pre-fix state, only the test remains. If that revert changes an API, signature, or schema so the test cannot compile or reach its defect check, keep production fully reverted and add only the smallest temporary test-only compatibility adapter needed to exercise the old contract. A test-only compatibility adapter may adapt setup or invocation only; it must not implement the fix, alter the defect check, or become the failure signal. Run the test. It must reach the defect check and fail for the original bug — log the observed failure signal (assertion text, hang, panic). **Partial reverts, mental simulation, or "it would obviously fail without the fix" are treated as cheating.** If no such adapter can preserve that signal, stop and surface the blocker.
  2. Remove any temporary compatibility adapter, restore the production change in full, and run the test. It must pass.
     Without a complete step 1 you've only proved your code works, not that the fix was necessary or that this test would have caught the bug.
- A test is only meaningful when there's something that could go wrong between the data being produced and the assertion being made. If the test builds the value it then asserts on (e.g., formatting a string and then asserting that the same string contains a substring it just put in), the assertion is tautological — nothing crossed a boundary, so nothing is being tested. The data must come from production code under test, not from the test body itself.
- Add or update tests when behavior changes around branching, parsing, retries, security checks, or boundaries.
- Prefer focused tests that prove the _right_ reason for the change.
- Do not create tests that don't actually test project code. A test that only exercises stdlib or framework code is not a real test.
- Temporary tests that don't reference a project symbol must be written to a temporary directory — they are not production tests.
- Never weaken a test to force it green — fix the code under test, not the assertion.

**Verify** (before reporting done)

- Run the smallest relevant verification first (the narrowest target the repo's tooling offers — a package-scoped test, a single suite), then broaden if risk justifies.
- Don't claim tests passed unless they actually ran. If verification can't run, state the blocker and the residual risk.

**Cross-cutting** (apply at every phase)

- Verify external findings against the working tree before acting. Reviews, lint, and PR comments work from a snapshot — they may name deleted code. `git grep` and `git diff` first.
- Stay inside the ask: do and discuss only what the request needs. Anything adjacent — another bug, an unrelated cleanup, a related topic — is never a change or a section: file it for future improvement (GitHub issue, Linear issue, or a docs note) and give it one line at the end. "drop X" means drop X.
- Treat every failure as a class, not an instance: fix every site of the same defect in the same pass — grounded in what's actually there, not speculation. A different defect nearby is adjacent work. A single-site fix to a systemic bug isn't done.
- Supersede completely: when behavior changes, delete every artifact describing the old way in the same change — code, comments, prose, tests asserting the old contract, and cross-references that now point at nothing. Grep for what you replaced, not just the file you edited. Prose that contradicts the code is worse than none, because it is read as current.

**Communication**

- Help the human understand quickly. Choose a call graph, sequence diagram, real example, bullets, table, or short prose—whichever explains the point best. These are recommendations, not mandatory forms; do not force a diagram, source annotations, or fixed sections.
- Walls of text are always forbidden. Keep paragraphs and items short, remove repetition, and link detailed evidence. GitHub PRs (including drafts), issues, comments, reviews, discussions, and release notes use the same reply-summary prompt. Requests for depth allow more focused sections, not dense text. Keep material risks, failures, and uncertainty visible.
- Every PR description must explain how the change produces its intended result through the key steps or decisions, using the form best suited to that PR. Listing modified files is not an explanation. State the problem, resulting behavior, and decisive verification once. Review the explanation against the diff, including for drafts and after description edits. Link detailed evidence; omit work logs and exhaustive test counts. Repository templates are starting points.

Adapted from Clean Code (Robert C. Martin) via the polygala-inc AGENTS.md distillation.
<!-- agent-tooling:guidance:end -->
