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

<!-- agent-tooling:guidance:begin rev=592fd726154f sha256=c3ed8d66f7e1 -->

> Managed by **boxlite-ai/agent-tooling** — do not edit between the markers. Change `plugins/boxlite-agent-tooling/guidance/workflow.md` there, then rerun `./.agent-tooling/install.sh` here.

## Workflow

Every change goes: understand → research → design → implement → test → verify.
Apply the `boxlite-clean-code` skill for design, implementation, refactoring, and maintainability review.

### Understand

- Read this file, the nearest README/CONTRIBUTING, relevant docs, and the actual source before editing.
- Reproduce-before-fix: when fixing a bug, write the failing test first, observe it fail, then fix.
- If docs and code disagree, record the conflict and ask before assuming the architecture.

### Research and design

Apply the `boxlite-design-doc` skill before implementation.

### Documentation (every PR)

- Every PR, including drafts, must add or update meaningful project docs. Prefer existing docs; explain changed behavior, usage, contracts, or maintenance (including refactor rationale).
- Link the changed section and check it against the final diff. Design links, PR summaries, file lists, formatting, and token edits alone do not count.

### Implement

- Calculate paths from known roots; never assume them.
- Complete setup before irreversible operations.
- Never commit secrets. Validate before SQL/shell/URL/path/HTML/prompt construction; avoid shell execution with untrusted input.
- Don't paste long excerpts from books, tickets, or logs into source comments.
- Add dependencies only when they materially reduce risk or complexity.

#### PR size and decomposition

- Target 100–200 added code lines; cap 400 code additions, including drafts. Count source, scripts, configuration, and generated code; exclude `*.spec.ts`, `*_test.go`, files under `tests` directories, recognized documentation, data/assets, and lockfiles. Unclassified files count. Estimate before coding; measure against the intended base before every PR creation/update.
- Split into tested PRs under one tracking issue; use native GitHub stacks for dependencies. Follow the installed plugin's `.agents/prompts/pr/split-pr-tracking-issue.md`.
- Exceptions: human justification within **5 minutes**, otherwise split. Diff changes invalidate approval. Follow the installed plugin's `.agents/prompts/pr/pr-size-exception.md` and `.agents/prompts/pr/pr-size-expired.md`.

### Test

- For each test added with a fix, manually run both steps in order:
  1. Revert **every** production change: restore every non-test file to its pre-fix state; only the test remains. If API, signature, or schema changes prevent compilation or reaching the defect check, keep production reverted and add the smallest temporary test-only compatibility adapter for the old contract. The test-only compatibility adapter may adjust setup or invocation only; it must not implement the fix, alter the defect check, or become the failure signal. Run the test: it must reach the defect check and fail for the original bug. Log the failure signal (assertion, hang, panic). **Partial reverts, mental simulation, and assumed failure are cheating.** If no adapter preserves the signal, stop and report the blocker.
  2. Remove the adapter, restore all production changes, and rerun: the test must pass. Without step 1, a pass cannot prove the test catches the bug or the fix is necessary.
- Test data must come from production code under test, across a boundary where behavior can fail. Asserting on a value built entirely by the test proves nothing—for example, checking a substring the test itself inserted.
- Add or update tests when behavior changes around branching, parsing, retries, security checks, or boundaries.
- Focus tests on the reason for the change.
- Test project code, not just stdlib or frameworks.
- Put temporary tests without project-symbol references in a temporary directory, outside production tests.
- Fix the code; never weaken a test to force a pass.

### Cross-cutting (apply at every phase)

- Verify external findings against the working tree with `git grep` and `git diff` before acting; reviews, lint, and PR comments may reference stale code.
- Stay inside the ask: do and discuss only what the request needs. File adjacent bugs, cleanup, or topics in a GitHub/Linear issue or docs note; mention them in one closing line, never a change or section. "drop X" means drop X.
- Fix every evidenced site of the same defect in one pass; do not speculate. Different nearby defects are adjacent work; one site does not resolve a systemic bug.
- When behavior changes, remove superseded code, comments, prose, old-contract tests, and broken references in the same change. Search all replaced terms, not just edited files; contradictory prose misleads readers.

### Disclosure

Public artifacts/delegates: public evidence or disclosure approval for exact content/destination, including private messages, memory citations, local paths, internal context, paraphrases. Omit uncertain material. Edits invalidate approval; task authorization and hook passes grant none.

### Communication

Apply the `boxlite-writing` skill.

- Check PR explanations against the diff, including drafts and description edits. State the problem, resulting behavior, and decisive verification once; file lists alone do not explain a change. Omit work logs and exhaustive test counts. Adapt repository templates.

<!-- agent-tooling:guidance:end -->
