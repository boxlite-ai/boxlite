# Full test results: checkpoint output handoff

## TL;DR

The Linux x86_64/KVM matrix and separate SDK → API → runner → VM suite were
executed on 2026-11-03. Results remain red: seven matrix assertions and, after
environment corrections, 16 E2E failures plus 12 setup errors. The focused
checkpoint acceptance cases passed.

## Scope and results

Ran `make test:all SETUP_DONE=1 FAIL_FAST=false` without name filters, with
`NEXTEST_PROFILE=ci`, then completed suites blocked by failed prerequisites.
The runtime was rebuilt from the working tree. API database tests used a
dedicated PostgreSQL database and Redis instance. No production code or failure
assertions were changed during this full-test run.

| Suite | Latest result |
| --- | --- |
| Core Rust unit | 1,348 passed, 3 failed, 2 skipped; one pass reported leaky |
| Shared / hypervisor and VMM unit | 71 / 114 passed; 26 hardware tests skipped |
| REST unit | 167 passed |
| OpenAPI reference unit | 5 passed |
| C FFI unit | 123 passed, 1 skipped |
| gvproxy unit | HTTP/2 multiplexed-stream test failed twice |
| Python unit / Rust bindings | 311 / 35 passed |
| Node unit / Rust bindings | 124 / 44 passed after native build |
| C SDK unit / Go SDK suites | 9 passed / passed |
| Rust VM integration | 300 passed, 16 skipped after cache correction |
| CLI integration target | 585 passed, 2 skipped; stress binary excluded by target |
| Python integration | 173 passed, 23 skipped |
| Node integration | 101 passed, 17 skipped |
| C integration | 2 passed |
| Infrastructure | 733 passed, 1 failed, 1 skipped after Git metadata correction |
| Dashboard | 576 passed, 1 failed |
| API, including database integration | 2,372 passed, 1 failed |
| Runner, proxy, image-service, Go API client, OTel collector | Nx targets passed |

The infra prerequisite initially prevented Nx from running. Its failure was
retained, and the other seven Nx projects were subsequently executed through
the same make recipe with only that already-tested prerequisite bypassed.

## Remaining matrix failures

All seven are listed below. Byte counts are the actual assertion values from
this run, not proposed replacement expectations.

| Test / source | Expected → observed | Follow-up |
| --- | --- | --- |
| `runtime::import::tests::untrusted_import_derives_the_fsize_limit_from_the_disk` (`src/boxlite/src/runtime/import.rs`) | 42,949,672,960 → 48,268,050,592 bytes | Verify disk plus checkpoint headroom against the import contract. |
| `runtime::options::tests::sanitize_falls_back_to_the_default_disk_size` (`src/boxlite/src/runtime/options.rs`) | 21,474,836,480 → 26,793,214,112 bytes | Verify the default disk/RAM ceiling calculation. |
| `runtime::options::tests::sanitize_scales_fsize_with_the_requested_disk` (same file) | 42,949,672,960 → 48,268,050,592 bytes | Verify scaling with the requested disk and memory ceilings. |
| `TestMitmProxy_HTTP2_MultiplexedStreams` (`src/deps/libgvproxy-sys/gvproxy-bridge/mitm_proxy_test.go`) | Concurrent requests succeed → `io: read/write on closed pipe`; rerun: `http2: client connection force closed via ClientConn.Close` | Trace ownership of the shared connection versus individual stream cleanup. Both complete suite runs failed. |
| `the wheel smoke check rejects a package with a missing native extension` (`apps/infra/deployment/workflow-checks.test.ts`) | Missing `boxlite.boxlite` → missing `boxlite.agents` | Ensure the fixture contains the pure-Python modules so it reaches the intended native-extension check. |
| `design language > does not grow: arbitrary font sizes (use text-label/meta/body/em/section/page)` (`apps/dashboard/src/design-language.test.ts`) | At most 291 uses → 318 | Inspect new arbitrary sizes and convert appropriate uses to existing design tokens; do not raise the ceiling merely to pass. |
| `JobType > exposes only job types with an active producer and runner handler` (`apps/api/src/box/enums/job-type.enum.spec.ts`) | Old exact list → four additional types: `PAUSE_BOX`, `RESUME_BOX`, `CREATE_CHECKPOINT`, `IMPORT_CHECKPOINT` | Verify producers and runner handlers for all four before changing the expected list. |

The size-limit observations are consistent with additional checkpoint headroom,
while the assertions encode disk-only ceilings. This run did not independently
qualify the complete sizing formula. None of these findings establishes the
introducing commit or proves that every failure belongs in test expectations.

Focused reproduction commands, after preparing the same prerequisites:

```sh
make test:unit:rust FILTER=fsize
make test:unit:gvproxy FILTER=TestMitmProxy_HTTP2_MultiplexedStreams
make test:apps:infra
make test:apps:dashboard
make test:apps:api FILTER=JobType
```

## Full REST E2E

`make test:e2e` selected all 352 cases against an isolated stack built from the
working tree. The first run reported 296 passed, 17 failed, 12 errors, 22 skipped,
and 5 expected failures.

Seven C/Go cases initially skipped for missing client artifacts passed after
building the release C library and using the local Go SDK. The first box-creation
case initially timed out; its unchanged rerun passed after image preparation.
Combining the latest result for each case gives **304 passed, 16 failed,
12 errors, 15 skipped, and 5 expected failures**. Initial failures remain recorded.

### Sixteen remaining failed cases

Paths below are relative to `apps/e2e/cases/`. Parametrized names identify each
failed invocation; no test was changed or removed to obtain these counts.

| File and case | Observed failure |
| --- | --- |
| `test_cli_detach_recovery.py::test_detached_box_survives_cli_exit_and_is_reusable` | Detached `run ... -- sleep 300` exits 1. |
| `test_cli_detach_recovery.py::test_detached_box_exec_propagates_exit_code_on_fresh_cli` | Same detached creation command exits 1 before the exit-code check. |
| `test_cli_entry.py::test_cli_run_exec_chain` | Detached creation exits 1. |
| `test_cli_entry.py::test_cli_exec_exit_code_propagates` | Detached creation exits 1 before the exec assertion. |
| `test_cli_entry.py::test_cli_run_foreground_streams_command_output` | Exit 1: `WS connect failed: WebSocket protocol error: Handshake not finished`. |
| `test_box_management.py::test_box_options_inbound_mode_controls_preview_access[disabled-403]` | Expected HTTP 403, observed 404 after the cache window. |
| `test_preview_access.py::test_preview_inbound_overrides_private_credentials[http]`, `[ws]`, `[connect]` (three cases) | Expected HTTP 403, observed 404 after the cache window. |
| `test_preview_lifecycle.py::test_preview_denied_declaration_does_not_wake_guest[inbound-disabled-403]` | Expected HTTP 403, observed 404 after the cache window. |
| `test_exec_timeout.py::test_exec_timeout_kills_long_command` | `TimeoutError` while waiting for completion. |
| `test_exec_timeout.py::test_exec_timeout_kills_sigterm_ignoring_process` | `TimeoutError` while waiting for completion. |
| `test_execution_shutdown.py::test_exec_on_stopped_box_is_typed_error` | Expected an exception, but none was raised. |
| `test_lifecycle_comprehensive.py::test_stop_start_preserves_rootfs` | `InvalidArgumentError: State change in progress`. |
| `test_lifecycle_comprehensive.py::test_rapid_create_remove_no_leak` | A created box remained in the final listing. |
| `test_node_comprehensive.py::test_node_lifecycle_stop_start` | Driver exits 2: `invalid argument: State change in progress`. |

### Twelve setup errors from one CLI fixture

The `detached_box` fixture in `test_cli_comprehensive.py` invokes
`boxlite run -d <image> -- sleep 600` and gets exit 1. Therefore the following
12 cases do not reach their own assertions:

```text
test_cli_stderr_separate
test_cli_large_stdout
test_cli_exec_env_var
test_cli_exec_workdir
test_cli_sequential_execs
test_cli_exit_code[0]
test_cli_exit_code[1]
test_cli_exit_code[2]
test_cli_exit_code[42]
test_cli_exit_code[127]
test_cli_nonexistent_command
test_cli_ls_shows_box
```

A related skipped case, `test_cli_comprehensive.py::test_cli_run_with_name`,
records `executable '--' not found in $PATH`. This is evidence to investigate
argument forwarding, not proof that every detached-creation failure has the
same cause. That case skips on the command failure, so its skip is not evidence
that the name option works.

### E2E follow-up boundaries

- Compare CLI parsing, serialized REST command arguments and runner argv; inspect
  the failed WebSocket upgrade separately from command creation.
- Check the intended distinction between a forbidden port (403) and an absent or
  concealed port (404) before changing access-control assertions.
- Trace timeout delivery, guest process termination, wait completion and stream
  closure separately; longer sleeps alone would not establish a fix.
- Establish whether SDK stop/start/remove waits for completion or returns after
  admission, then compare the state-transition and deletion assertions with that
  contract. A delayed listing alone does not establish a permanent resource leak.

Remaining skips include private registry credentials, additional identity
profiles, an HTTPS browser setup, guest tooling, and unavailable capabilities.
The isolated stack did not advertise cloud snapshot/checkpoint storage support;
this is not live GCS/IAM or cloud checkpoint qualification.

## Environment corrections and limits

- Native Node bindings and release C/Go client prerequisites were built before
  rerunning their affected suites.
- The shared VM cache initially resolved beneath a non-traversable home
  directory. Shim stderr confirmed bubblewrap permission denial. Moving only
  the task cache to a traversable temporary directory made the preflight pass;
  all 300 Rust VM cases were then rerun. Host permissions were unchanged.
- The source archive initially lacked Git metadata. Supplying the tested HEAD
  and index resolved three infra failures involving `git ls-files`.
- Changed source-file SHA-256 values matched the local working tree. Logs and
  JUnit reports were retained. Full lint, stress/benchmark targets, other
  platforms, private-image credentials and live cloud services were not covered.

The [focused handoff record](checkpoint-output-handoff.md) documents the failing
old implementation, passing regression tests, and three real checkpoint KVM cases.

## Direct follow-up corrections (2026-11-03)

The original full-run results above are retained. The following targeted checks
cover only failures directly introduced or exposed by the managed-checkpoint
commits; they do not constitute another full-matrix pass.

- The exact `JobType` expectation now includes `PAUSE_BOX`, `RESUME_BOX`,
  `CREATE_CHECKPOINT` and `IMPORT_CHECKPOINT`. Their API producers, executor
  dispatch and native runner handlers were checked before updating the list.
  `make test:apps:api FILTER=JobType` changed from one failure and one pass to
  two passes, with Nx daemon and isolated plugin workers disabled for this host.
- The infrastructure coverage check now excludes Markdown from its test-source
  inventory. A report whose filename contains `tests` is prose, while executable
  files under documentation directories remain subject to the existing check.
  The tracked report itself reproduced the false positive before the correction.
  `make test:apps:infra` changed from 732 passed, two failed and one skipped to
  733 passed, one failed and one skipped in its first test phase. The remaining
  wheel-fixture failure is unchanged; subsequent phases did not run.

These two corrections change test expectations and classification only. They do not
change the job protocol, checkpoint implementation or coverage exclusions.

The subsequent isolated API/database/runner/KVM run exposed a separate defect in
the new raw-import path: native inspection returned memory-format version 9 as
the response schema version, while the API requires schema version 1. A real
managed restore and explicit resume passed process identity, start time, heap
marker, boot identity and advancing-counter checks before raw import returned
503, `Runner returned an invalid checkpoint inspection`.

Native inspection now reports admission-summary schema version 1. Memory-format
9 and local-path metadata version 2 retain their existing native validation;
the API's strict schema check is unchanged. The existing production inspection
test was extended before the fix and failed with actual 9 versus expected 1.
After the fix, `make test:unit:rust FILTER=checkpoint_cloud_` passed six tests in
each of the default and REST configurations, using dependency stubs on macOS.
These unit results do not establish VM restoration; `make fmt:check:rust` also passed.

After that correction, the real managed and raw restores both preserved the
guest process. The Python SDK stage then exposed a second integration gap:
new targets were reported as `unknown`, and raw-import SDK calls did not wait
for restoration. The cloud mapper now reports an admitted target heading for
Paused as restoring (`configured` on the REST wire). Managed and raw imports
share the existing bounded SDK polling, submit once, and return only at Paused;
other unknown or running states remain errors.

The same SDK boundary also revealed a media-type mismatch: the SDK and OpenAPI
use `application/zstd`, but the cloud import route accepted only octet-stream.
Public import now accepts both, and public export reports `application/zstd`.
Internal runner transfer framing and media types are unchanged.

With every non-test change reverted, the new regressions failed on
`unknown` versus `configured`, `Configured` versus `Paused`, rejected zstd
uploads (400 versus 201), and the octet-stream export header. Restoring all fixes
passed 55 default and 63 REST checkpoint unit tests, plus 21 targeted API tests.
These checks include actual HTTP requests, strict rejection of unexpected
restore states, and verification that polling never resubmits the upload.

### Real SDK follow-up and remaining qualification

The isolated production-controller/database/runner/KVM harness passed managed
and raw restore, explicit resume, and the original process/start-time/heap-marker/
boot-identity/counter assertions. Python async and sync SDKs both passed named
capture, catalog operations, managed restore, pause/resume, pair export/inspection,
raw import and resume. The storage client uploaded and downloaded real native
archives through an isolated GCS-protocol service.

Node completed capture, catalog lookup, managed restore, resume/pause and export,
then inspection rejected the native `next_synthetic_ino` value `2^63`. The pinned
N-API serializer already converts large opaque JSON integers losslessly to
`bigint`; the binding's extra recursive rejection prevented that conversion.
Removing it leaves all typed numeric-field range checks intact. With all
production changes reverted, the new real-VM Node integration regression failed
at inspection with the safe-integer error. After restoring the complete fix and
rebuilding, it passed and checked the exact `1n << 63n` value in every share.

The focused Node regression was followed by the full Node SDK round trip on
2026-11-03 against `d3c32b0e`. The isolated harness passed its complete case in
546 seconds (exit 0), retaining the original assertions. Node passed named
capture, catalog get/list, managed restore to Paused, resume/pause, export of
exactly two files, inspection, raw import to Paused, explicit resume and the
catalog removal call. The same run repeated the managed/raw process-continuity
checks and completed test-box cleanup.

The Go/C cloud cases were not rerun. The earlier Python async/sync results remain
valid; the last binding fix only changes Node inspection conversion. Complete
cross-SDK and live-cloud qualification therefore remains partial.

The harness uses real native/SDK and API service code, PostgreSQL, Redis and KVM,
with test seams for identity, image resolution, placement and commerce. It does
not qualify live GCS/IAM: no test bucket was available. No cloud resources or
deployments were created. The existing firmware was reused, and host security
policy was unchanged. Task services and VMs were stopped after each run.
