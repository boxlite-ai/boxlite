# Runner memory incident snapshots

## TL;DR

Attribute each minute's host memory reading above 80% to the five largest observed running Boxes, then store and expose that snapshot to administrators.

## Problem

The Runner logs host memory once per minute but cannot identify the largest Box consumers through persisted incident evidence.
CPU incidents already provide authenticated ingestion, idempotent persistence, and administrator queries.
Their five-minute qualification and two-minute attribution windows do not fit an immediate memory snapshot.

## Scope

- Preserve the existing CPU incident behavior and interfaces.
- Reuse the minute resource sampler; every valid host reading strictly above 80% triggers one immediate Box scan.
- Persist up to five Boxes per scan, each with business ID, image, and current bytes, plus report-level sampling completeness.
- Add internal Runner ingestion and administrator queries without customer SDK or OpenAPI changes.
- Do not add rolling averages, peak tracking, delayed qualification, automated Box operations, or a management UI.

## Related work and lessons

Known mechanisms before external search: Linux cgroup v2 memory accounting, gopsutil host metrics, and cAdvisor memory gauges.
Local evidence is the existing CPU incident implementation and minute resource logger.

| Evidence | Decision and reason |
| --- | --- |
| `apps/runner/internal/metrics/collector.go`, `logResourceUsage` and `logResourceSnapshot` | Adapt the existing minute ticker rather than introducing another scheduling loop. |
| `apps/runner/internal/cpumonitor/counter.go`, `readCgroupCounter` | Preserve runtime-ID membership validation so a failed jailer join cannot attribute a parent cgroup to a Box. |
| `apps/api/src/box/cpu-incidents/` and migration `1793232000000` | Reuse authentication, immutable event identity, time-range queries, and additive migration conventions. |
| [Linux cgroup v2, Memory Interface Files](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#memory-interface-files) | Adopt `memory.current`: current bytes charged to the cgroup and descendants, including cache; swap is a separate counter. |
| [gopsutil v4.25.12 host memory](https://github.com/shirou/gopsutil/blob/v4.25.12/mem/mem_linux.go#L313-L323) | Preserve the existing `UsedPercent` metric; Linux defaults to `(Total-Available)/Total*100`. |
| [gopsutil v4.25.12 process memory](https://github.com/shirou/gopsutil/blob/v4.25.12/process/process.go#L76-L83) | Use RSS bytes for the macOS process fallback, with process-identity checks; this differs from Linux cgroup accounting. |
| [cAdvisor metric definitions](https://github.com/google/cadvisor/blob/master/docs/storage/prometheus.md) | Adopt gauge semantics rather than cumulative counter differences; do not add a monitoring service dependency. |
| [Container Profiler](https://arxiv.org/abs/2005.11491) | Historical context for interval sampling, not evidence of current SOTA; full profiling is outside this feature. |

Host pressure and per-Box attribution use different accounting scopes; their percentages and byte totals need not reconcile.
A snapshot identifies the largest observed consumers, not proof that those Boxes caused host memory pressure.
Minute sampling intentionally does not capture every short-lived spike.

### Research record

Search date: 2026-11-05; external search used the web tool, and repository verification used `rg` and `git log`.

| Source | Queries and outcome |
| --- | --- |
| Repository/history | Located `cpumonitor`, minute resource logging, CPU ingestion, entity, migration, and tests; history identifies `e57d8d5b` as the CPU feature. |
| Web/kernel documentation | `site.kernel.org cgroup v2 memory.current total memory descendants`; opened the authoritative interface definition. |
| arXiv | `site.arxiv.org container memory monitoring cgroup`; `site.arxiv.org "memory.current" monitoring snapshot`; opened Container Profiler. |
| Semantic Scholar | `site.semanticscholar.org container memory monitoring cgroup`; `site.semanticscholar.org "Container Profiler" resource utilization`; no additional decision-relevant indexed source. |
| GitHub projects | `site.github.com google cadvisor container_memory_usage_bytes`; opened cAdvisor's metric definitions. |
| GitLab projects | `site.gitlab.com cgroup memory.current monitoring`; results added no required mechanism beyond the kernel accounting interface. |
| Dependency specifications | Opened gopsutil v4.25.12 host, process, and Darwin sources; this is the version declared in `apps/runner/go.mod`. |

The second search round added no required mechanism; stop at the established kernel interface and existing application contracts.
No project is claimed as current SOTA without independently verified activity and adoption evidence.
The paper is historical, and vendor documentation establishes interface existence rather than comparative superiority.

## How it works

```text
Existing minute ticker
  -> read host memory once
  -> valid percentage > 80?
       no: continue existing resource logging
       yes: enumerate running Boxes -> read current bytes -> select top five
            -> bounded report queue -> authenticated POST -> immutable DB row
                                                         -> administrator GET
```

The minute sampler must deliver the memory observation even when unrelated CPU or disk collection fails.
Use the same host reading for logging and incident admission; do not trigger incidents from `/info` or healthcheck requests.
Keep the comparison in float64 so rounding to the existing float32 health metric cannot change the strict threshold decision.

Scan immediately in the minute callback under a bounded context; uploads and retries run in a separate worker.
Do not queue old trigger observations for later scans or replay missed minute ticks.
Each reading above threshold produces a fresh event ID, including consecutive high readings and recovery followed by another high reading.

On Linux, validate the PID's unified cgroup membership against the local runtime Box ID before reading `memory.current`.
Reject missing, mismatched, malformed, negative, or overflowing counters; never fall back to only the Linux launcher process.
On macOS, use a fresh process reader and reject identity changes during sampling.
Box scans are sequential observations, not an atomic host-wide snapshot.

Sort successful observations by current bytes descending, then business Box ID ascending; retain at most five.
Include zero-byte observations and retain each Box image, preserving an empty string.
Enumeration failure, individual read failure, invalid identity, or cancellation before completing the scan marks attribution incomplete.
Report successful observations even when incomplete; no readable Boxes means an empty array.

Store the ranking in one bounded JSONB array; a separate child table would add joins without supporting any required query.
An empty array replaces the single-winner null-ID convention used by CPU incidents.

Completed reports use the CPU transport policy: capacity 32, ten-second requests, and 30-second retries for network errors, HTTP 429, and 5xx.
Permanent failures and overflow are logged and dropped; shutdown cancels workers, and restart loses pending reports.
Retry the original event payload and ID; never rescan or generate another ID during retry.
Disable HTTP redirects to avoid forwarding Runner credentials.

### Persistence and interfaces

Create `runner_memory_incident` in an additive pre-deploy migration.

| Field | PostgreSQL type | Contract |
| --- | --- | --- |
| `id` | `bigint identity` | Primary key; decimal string in JSON. |
| `runnerId` / `eventId` | `uuid` | Unique pair; Runner identity comes from authentication. |
| `sampledAt` | `timestamptz` | Time of the host reading that triggered the scan. |
| `runnerMemoryPercent` | `double precision` | Finite, strictly above 80 and at most 100. |
| `boxes` | `jsonb` | Ordered array of up to five objects: `boxId`, `image`, `memoryBytes` (decimal string). |
| `samplingComplete` | `boolean` | Whether attribution finished without missing observations. |
| `receivedAt` | `timestamptz` | Server receipt time, default `now()`. |

Index `sampledAt` and `(runnerId,id)` as the corresponding CPU table does.
Enforce an array of at most five entries in PostgreSQL; validate nested values, uniqueness, and descending order at ingestion.
Validate decimal byte strings before conversion and bound them to signed 64-bit maximum.
Ignore duplicate `(runnerId,eventId)` inserts without updating the original evidence.
Do not add deletion cascades or automatic retention.

`POST /api/runners/me/memory-incidents` accepts the snapshot fields except `id`, `runnerId`, and `receivedAt`.
Use existing Runner authentication, reject unknown properties, and return 204 for first and duplicate ingestion.
Reject malformed IDs, timestamps, byte strings, percentages, and incoherent attribution with 400.
The route remains excluded from customer OpenAPI and generated SDKs.

`GET /api/admin/runner-memory-incidents` requires administrator authentication and returns `Cache-Control: private, no-store`.
Require timezone-qualified `from` and `to`, with `from < to`, filtering `sampledAt` in `[from,to)`.
Accept optional UUID `runnerId` and integer `limit` from 1 to 200, default 50.
Return `{items:[...]}` with snapshots in ascending ID order, preserving bigint strings.
The [query deduplication follow-up](2026-11-05-incident-query-deduplication.md)
selects each Box's maximum within the filters before applying the snapshot limit;
response arrays contain only the winning entries, while stored arrays remain complete.
Like CPU queries, this endpoint has no pagination and cannot guarantee enumeration beyond the limit.

## Validation

| Claim or risk | Planned check |
| --- | --- |
| Immediate minute policy | Fake-clock tests: no early scan, strict 80% boundary, repeated high minutes, recovery, and invalid host values. |
| Independent host metrics | Verify CPU/disk collection failures do not suppress a valid memory observation; normal health requests do not trigger scans. |
| Correct attribution | Filesystem-backed cgroup tests for hierarchy, VM-inclusive values, mismatched runtime IDs, parsing, ties, exits, and partial reads. |
| Retry and lifecycle | HTTP tests for payload, credentials, retry identity, permanent failure, bounded queues, and cancellation. |
| API security | Real Nest controller tests for Runner/admin separation, validation, response shape, and Swagger exposure. |
| Persistence | PostgreSQL migration round trip, constraints, concurrent deduplication, bigint precision, filters, ordering, and `[from,to)` boundaries. |

This is a new contract; no prior memory incident endpoint or table was found.
Existing CPU tests remain regression coverage for its unchanged behavior.
Run the repository's Make targets for Runner and API tests, formatting, and applicable lint checks.
Observed validation:

- `make test:apps:api TEST_FILES='(memory|cpu)-incident'` with isolated PostgreSQL: four suites, 115 tests passed.
- `make lint:apps`: passed with existing workspace warnings; no new memory-incident warnings.
- `make fmt:apps FILES='api/src/box/memory-incidents/*.ts api/src/migrations/pre-deploy/1793836800000-add-runner-memory-incidents-migration.ts api/src/box/box.module.ts'`: completed.
- `make fmt:check:apps`: blocked by formatting in 208 unchanged workspace files, primarily generated clients.

`make test:apps:runner SETUP_DONE=1 FILTER='MemoryIncident|MemoryObservation|CPUIncident|RunnerResourceLog|CollectReportsTheBoxliteHomeFilesystem|CollectRejectsAZeroCapacityHome'`
passes with `BOXLITE_DEPS_STUB=1`; this builds all Runner packages and runs the focused monitor and collector suites.
`make fmt:go` completed; unrelated pre-existing formatting changes were excluded from the final diff.
No live VM or macOS sampling test was run; Linux attribution is exercised through filesystem-backed cgroup fixtures.

Deploy the migration first, then the API, then Runners.
The runtime, API, and schema contracts are documented in `apps/runner/README.md`, `apps/API.md`, and `apps/SCHEMA.md`.
