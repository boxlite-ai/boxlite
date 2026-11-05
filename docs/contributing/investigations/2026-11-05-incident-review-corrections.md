# Incident review corrections

## TL;DR

Regenerate incident clients and fix validated request, sampling, identity, and cancellation defects without changing normal CPU or memory attribution policies.

## Evidence and scope

PR 2365's API client drift job reports generated TypeScript/Go additions missing from the branch. Its CodeRabbit findings concern generated clients, DTO validation, memory readers, reporter URL checks, and CPU startup availability. Additional review findings concern database deadlines, Nx test inputs, and boundary assertions.

The CPU ring starts empty and `/info` waits only thirty seconds. Fixed five-second sampling supplies the initial reading within that wait and preserves the default sixty-sample averaging horizon; see [fixed CPU sampling](2026-11-05-fixed-cpu-sampling.md). Class-validator nested traversal accepts array elements, so require every Box element to be an object. Both reporters must reject `url.URL.ForceQuery` before constructing their endpoint.

## Design

Keep normal cadence and snapshot contracts. Bound Linux reads with a per-reader single-operation slot and a buffered result channel: cancellation releases the caller, while the outstanding kernel read retains the slot until it completes. Subsequent scans can time out waiting for that slot without creating unbounded workers. Use a root-injectable reader factory to exercise the actual Linux dispatch with proc/cgroup fixtures.

Carry Box StartedAt into memory attribution. Expose the existing process-reader branch as a helper and reject missing start times or process creation after the Box start before reading RSS. Preserve the second creation-time check. Linux continues using its validated cgroup identity.

Wrap both incident ranking queries in transactions with `SET LOCAL statement_timeout = '5s'`, following `admin/services/usage.service.ts`. Preserve arbitrary valid time ranges and ensure timeouts cannot leak to later pooled queries. Add DB_HOST to API test inputs and explicitly include Go test files in the inherited Go test executor inputs.

Regenerate all three clients with the same pinned generator and tasks as CI. Keep Runner ingestion excluded and admin queries exported. Do not modify coverage policy.

## Verification

Run focused regression tests with only test changes present first: nested arrays must reach the HTTP status assertion, trailing-query URLs must be rejected, startup must populate the CPU ring before thirty seconds, blocked cgroup reads must return on cancellation, and reused process identity must not supply RSS. Temporary test-only invocation adapters expose the old cgroup reader and unchanged process-reader branch where new seams are needed; remove them before the fixed run.

Add boundary assertions for numeric ID ties, observed five-minute CPU qualification, queue ordering, minute-log sample freshness, Linux dispatch, and SQL timeout scope. Run relevant Make tests, inspect Nx resolved inputs, regenerate clients twice for a stable result, and report platform-specific verification limits.

## Historical review verification

Before these review fixes, with production unchanged and only regression tests plus temporary test-only reader invocation adapters present, the original code failed the nested-array HTTP status assertions, trailing-query URL checks, CPU startup-ring assertion, blocked-read cancellation assertion, and process-start identity assertions. Both PostgreSQL ranking queries remained blocked beyond seven seconds instead of returning SQLSTATE `57014`.

After removing the adapters and applying the fixes, `make test:apps:api TEST_FILES='(memory|cpu)-incident'` passed all 127 tests against PostgreSQL. The five-second statement timeout canceled each blocked query, and the next pooled query retained the original zero timeout. Runner CPU, memory, and resource-log tests passed through `make test:apps:runner` with the corresponding name filters and native-dependency stubs. The blocked-read test also verifies that a later read waits for the occupied slot and resumes when the kernel read finishes. `make lint:apps` passed with the existing 393 warnings and no errors.

The process identity helper was exercised against a real process on Linux; native macOS execution and live-VM memory accounting were not tested here. CPU timing tests use proc fixtures and a fake clock. Resolved Nx targets retain existing cache inputs while adding `DB_HOST` for API tests and Go test files for Go tests.

All three CI client-generation tasks completed with OpenAPI Generator 7.23.0. A second generation produced identical contents across all 564 tracked or newly generated client files. The CI contract-boundary checks passed. oasdiff 1.33.0 reported only the added memory query endpoint and a CPU limit-description change, with no breaking changes or existing-default changes. Existing generated TypeScript request tests and Runner compilation against the regenerated Go client passed.
