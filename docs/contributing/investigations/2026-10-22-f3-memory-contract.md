## TL;DR

F3 is implemented as an explicit memory contract and test fixture. S6 is
MOCK_PASS. No real RAM, register, device or process capture/restore is implemented.

> **Update 2026-10-23:** the F3–F5 snapshot prototype and the combined E scenario were
> removed in favor of organization-scoped snapshots
> ([#2087](https://github.com/boxlite-ai/boxlite/pull/2087)).
> Their code, guides and make targets no longer exist; this report is kept as a record.

## Details

Base `9a49d5a5`; macOS 27.0.1 arm64, Python 3.14.6, BoxLite 0.10.7.
No kernel/Docker/Compose dependency is used in this no-VM qualification.
See [public contract and usage](https://github.com/boxlite-ai/boxlite/blob/37ab3f6eca69788a66fb2024053983ed91dc939b/docs/guides/memory-snapshots.md).

The real native Python REST SDK talks to test-only API and runner HTTP servers.
Checks cover requested type/name, query/list state, duplicate name, missing
snapshot, create-from child identity, deletion, refusal of FS substitution and
unmarked memory results. Production-local operations reject memory before disk
mutation; the runner handler returns 501 and rejects a request-level mock toggle.
Cloud controller tests verify owner routing, tenant lookup and permissions.
These are mock/contract tests, not a real guest memory-resume path or a deployed
API/runner end-to-end success. No production switch enables mocks.

Private logs are under `.apps-local/feature-acceptance/2026-10-21/`:

| Command | Exit | Evidence |
| --- | --- | --- |
| `make test:snapshot-contract` | 0 | `f3-r3-contract.log`, 4 passed, S6 MOCK_PASS |
| `make test:apps:api FILTER='memory\|REST box/proxy permission\|BoxliteProxyController'` | 0 | `f3-r3-api-contract.log`, 63 relevant tests |
| `make test:apps:runner FILTER=MemorySnapshot` | 0 | `f3-r2-runner.log`, real handler refuses/validates |
| `make test:unit:rust FILTER=snapshot` | 0 | `f3-r1-rust.log`, 25 core snapshot tests |
| `make test:unit:cli` | 0 | `f3-r2-cli.log`, 275 unit tests |
| `make test:unit:node FILTER=snapshot` | 0 | `f3-r2-node.log`, 5 Rust binding tests; JS filter selected none |
| `make test:unit:reference-server FILTER=snapshot` | 0 | `f3-r3-reference-snapshot.log` |
| `make lint:python`, `make lint:node` | 0 | `f3-r3-lint-python.log`, `f3-r2-lint-node.log` |

Run `make dev:python SETUP_DONE=1` after preparing the runtime, and
`make dev:reference-server` before reference-server tests. Formatting used
`make fmt:rust`, `make fmt:python`, `make fmt:node`, `make fmt:apps`; unrelated
formatter changes were removed.

For the reference adapter regression, all F3 production changes were restored
to base in a separate command; only test code and the user's hook edit remained.
The test-only makefile `/tmp/boxlite-f3-repro.mk` invokes the two checks:
`MAKEFILES=/tmp/boxlite-f3-repro.mk make test:reference-snapshot-regression`.
Exit 2 and both defect signals are in `f3-r3-reference-before-both.log`.
The saved patch is `f3-repro-backup/tracked.patch`; restoring it makes the
same checks pass. No compatibility adapter implements either fix.

Full regressions are **not green**. `make test:apps:api` initially inherited
the local dotenv's 25432 database port; subsequent baseline/final comparisons
explicitly used `DB_PORT=35432 REDIS_PORT=36379` for this task's isolated stack.
Both versions fail with PostgreSQL file-descriptor exhaustion/recovery and
`quay.io` rejected by the local registry allowlist. Baseline: 76 failures;
final: 97 as database recovery varied (`f3-r3-api-baseline.log`,
`f3-r3-api-after.log`, exit 2). Relevant route/permission tests pass separately.
No skipped integration test is counted as acceptance.

`make test:unit:reference-server` reports 34 pass / 4 errors, exit 2:
pre-existing handle-cache fixtures omit `state.exit_code` used by the unchanged
Box serializer (`f3-r3-reference-after.log`). This adjacent test-fixture defect
is recorded, not repaired in the memory feature. Feature attempts: 3/6; no
remaining F3 contract failure. FS snapshots and create-from remain unqualified.
