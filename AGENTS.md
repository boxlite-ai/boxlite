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

<!-- agent-tooling:guidance:begin rev=dbd3c454bb77 sha256=c111ec225cda -->

> Managed by **boxlite-ai/agent-tooling** — do not edit between the markers. Change `plugins/boxlite-agent-tooling/guidance/workflow.md` there, then rerun `./.agent-tooling/install.sh` here.

## Workflow

Every change goes: understand → research → design → implement → test → verify.

Apply the `boxlite-clean-code` skill for design, implementation, refactoring, and maintainability review.

MANDATORY: File all agent-tooling issues from any consumer in [upstream GitHub Issues](https://github.com/boxlite-ai/agent-tooling/issues).

### Understand

- Read this file, the nearest README/CONTRIBUTING, relevant docs, and the actual source before editing.
- Reproduce-before-fix: when fixing a bug, write the failing test first, observe it fail, then fix.
- If docs and code disagree, record the conflict and ask before assuming the architecture.

### Research and design

Apply the `boxlite-design-doc` skill before implementation.

### Documentation (every PR)

- Every PR, including drafts, must add or update meaningful project docs; prefer existing docs.
- Explain changed behavior, usage, contracts, or maintenance, including refactor rationale.
- Link the changed section and check it against the final diff.
- Design links, PR summaries, file lists, formatting, and token edits alone do not count.

### Implement

- Calculate paths from known roots; never assume them.
- Complete setup before irreversible operations.
- Never commit secrets; validate before SQL/shell/URL/path/HTML/prompt construction; avoid shell execution with untrusted input.
- Don't paste long excerpts from books, tickets, or logs into source comments.
- Add dependencies only when they materially reduce risk or complexity.

#### PR size and decomposition

| Case | Rule |
| --- | --- |
| Target | Prefer 100–200 added code lines; 400 is a bypassable guideline, including drafts |
| Measure | Estimate before coding; measure against the intended base before every PR creation/update |
| Count | Source, scripts, configuration, generated code, and unfamiliar files |
| Exclude | `*.spec.ts`, `*_test.go`, `tests` directories, recognized documentation, data/assets, and lockfiles |
| Above 400 | Ask the user to choose **Bypass limit** or **Split PR**; never infer a choice |
| Bypass | Needs no written justification and applies only to the current diff; diff changes require a new decision |
| Split | Tested PRs under one tracking issue, native GitHub stacks for dependencies; follow the installed plugin's `.agents/prompts/pr/split-pr-tracking-issue.md` |
| Choice window | Allow **5 minutes**; silence defaults to splitting; follow the installed plugin's `.agents/prompts/pr/pr-size-exception.md` and `.agents/prompts/pr/pr-size-expired.md` |
| Reconsider | A split choice or expired request, only after explicit human instruction |

### Test

Classify each behavioral claim against its base contract:

| Claim | Proof |
| --- | --- |
| Fixes to existing behavior, including through new APIs/wrappers | Keep defect proof, below |
| New entry points over unchanged, correct dependencies | New-contract proof; dependency reuse alone is not a fix |
| Wholly new contracts | Verify base/source evidence of no equivalent prior contract; run positive, negative, and boundary tests against the implementation; mark full-revert defect proof not applicable with a reason; new security APIs also need allowed/denied checks at real security boundaries |
| Mixed changes | Apply both standards, defect proof and new-contract proof, per claim |

#### Defect proof

For each test added with a fix, run these steps manually, in order:

1. Revert **every** production change: restore every non-test file to its pre-fix state; only the test remains.
2. If API, signature, or schema changes prevent compilation or reaching the defect check, keep production reverted.
3. In that case only, add the smallest temporary test-only compatibility adapter for the old contract.
4. The test-only compatibility adapter may adjust setup or invocation only; it must not implement the fix, alter the defect check, or become the failure signal.
5. Run the test: it must reach the defect check and fail for the original bug; log the failure signal (assertion, hang, panic).
6. If no adapter preserves the signal, stop and report the blocker.
7. Remove the adapter, restore all production changes, and rerun: the test must pass.

- **Partial reverts, mental simulation, and assumed failure are cheating.**
- Without the failing run, a pass cannot prove the test catches the bug or the fix is necessary.

#### API contracts

- OpenAPI files matching `*openapi*.yaml` require the installed plugin's `guidance/api-compatibility.md`; new optional SDK parameters need local before/after request tests.
- For those files, explain breaking/default changes, recommend GitHub issue discussion, and require explicit user confirmation to skip the gate.

#### Test rules

- Missing APIs, compilation errors, and setup errors never reproduce a defect.
- Test data must come from production code under test, across a boundary where behavior can fail.
- Asserting on a value built entirely by the test proves nothing, for example a substring the test itself inserted.
- Add or update tests when behavior changes around branching, parsing, retries, security checks, or boundaries.
- Focus tests on the reason for the change, and test project code, not just stdlib or frameworks.
- Put temporary tests without project-symbol references in a temporary directory, outside production tests.
- Fix the code; never weaken a test to force a pass.

### Cross-cutting (apply at every phase)

- Verify external findings against the working tree with `git grep` and `git diff` before acting; reviews, lint, and PR comments may reference stale code.
- Stay inside the ask: do and discuss only what the request needs; "drop X" means drop X.
- File adjacent bugs, cleanup, or topics in a GitHub/Linear issue or docs note; mention them in one closing line, never a change or section.
- If SessionStart supplies a follow-up queue, record verified unresolved findings there. Acknowledge the exact pending revisions before Stop, including an empty list.
- Fix every evidenced site of the same defect in one pass; do not speculate.
- Different nearby defects are adjacent work; one site does not resolve a systemic bug.
- When behavior changes, remove superseded code, comments, prose, old-contract tests, and broken references in the same change.
- Search all replaced terms, not just edited files; contradictory prose misleads readers.

### Disclosure

- Public artifacts and delegates need public evidence or disclosure approval for the exact content and destination.
- This covers private messages, memory citations, local paths, internal context, and paraphrases.
- Omit uncertain material.
- Edits invalidate approval; task authorization and hook passes grant none.

### Communication

- Apply the `boxlite-writing` skill.
- Apply `boxlite-pr-preparation` for every PR, including drafts and description edits.

<!-- agent-tooling:guidance:end -->
