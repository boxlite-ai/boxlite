## TL;DR

Persist cloud resize targets and billing before a recoverable Runner job applies them.

Design: [recoverable cloud CPU and memory resize](https://github.com/boxlite-ai/boxlite/issues/2203).

## Scope

Existing SDK/CLI resize calls grow a running Linux/KVM Box. Cloud keeps whole-GiB
memory rounding. Accepted targets and target-based billing never roll back when
application fails. Box remains `started`; its existing Job carries progress.
No shrink, replacement VM, new task queue, or automatic Guest restart is added.
If the Guest exits, wait for the same Box to restart and reconcile the target.

Acceptance requires durable recovery after API/Runner process loss, no duplicate
billing switch on retry, token-fenced completion, and unchanged behavior for
ordinary lifecycle jobs. Admission defaults disabled until compatible deployment.

## Related work and lessons

[PostgreSQL row locks](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)
serialize competing writers through transaction completion. Box → Job → usage
locks protect acceptance, billing activation and completion across API replicas.
Runner calls happen outside transactions. Database statement time controls lease
expiry and due-time checks, avoiding disagreements between API clocks.

[Kubernetes controllers](https://kubernetes.io/docs/concepts/architecture/controller/#desired-state)
separate persisted intent from observed state. Absolute-target reconciliation fits
grow-only CPU/RAM: repeating a request is safe, while rollback cannot recover
already allocated memory. Reuse the existing Job table and DB-first Runner poll;
Redis notification remains a hint. A separate queue or operations table would
duplicate existing ownership and polling without resolving partial application.

Local constraints found during review:

- [JobService](../../../apps/api/src/box/services/job.service.ts) previously claimed
  all pending jobs and terminated stale ones. Resize needs its own readiness,
  lease and retry policy; ordinary jobs retain their existing behavior.
- [Box invariants](../../../apps/api/src/box/entities/box.entity.ts) clear pending
  when state equals desired state. `resizeJobId` now preserves the lifecycle fence.
- [UsageService](../../../apps/api/src/usage/services/usage.service.ts) bills each
  interval's opening snapshot. Delayed state events must reread and lock Box;
  otherwise they can overwrite a newer target interval.
- [Runtime resize](../../../src/boxlite/src/litebox/resize.rs) can report mapped
  memory before Guest hotplug finishes. Every claim must apply its explicit target,
  even when an empty resource query already matches.
- Runner startup previously replayed all in-progress jobs. Resize must instead
  expire its old claim and acquire a fresh token.

## How it works

`POST /v1[/{prefix}]/boxes/:id/resize` checks ownership, `write:boxes`, organization
suspension, running state, per-box limits and Runner capability. A supplied memory
target rounds up to GiB once, before checking the current boot ceiling. `{}` reads
actual allocation without creating a job or changing billing.

| Phase | Atomic write | Failure behavior |
| --- | --- | --- |
| Accept | Under usage lease and Box lock, save target CPU/GiB, pending marker and `RESIZE_BOX/BILLING_PENDING` | No Runner may claim yet |
| Bill | Close old interval/open target interval at one timestamp; set `APPLY` and due time | Retain target; retry at startup/every 15 seconds |
| Claim | Lock due APPLY jobs with `SKIP LOCKED`; issue token, increment attempt, grant 120-second lease | Other claims skip the locked rows |
| Apply | Confirm lease, query runtime, apply explicit target; heartbeat every 30 seconds | Requeue with jittered 1–60 second backoff |
| Complete | Validate owner, token, unexpired lease and exact target; clear Box marker with job completion | Old tokens cannot finish a reclaimed job |

Same-target requests join the existing job; different targets conflict. HTTP waits
30 seconds, then returns `504 resize_in_progress` while work continues. Box info
reports the accepted target; the empty resize query reports runtime allocation.
Cache invalidation after acceptance/completion covers Box id and name lookups.

Usage event handlers verify current state and resize ownership under the usage
lease and Box lock. Daily rollover excludes BILLING_PENDING rows before LIMIT;
APPLY rows can roll over at the persisted target even while Runner retries.
Stop/delete/migration/snapshot work remains fenced until completion. A Guest
restart may retain old or partially applied resources, so the durable job still
must reconcile after that restart. This operation never restarts Guest itself.

## Validation

The tests in [cloud-resize.integration.spec.ts](../../../apps/api/src/box/services/cloud-resize.integration.spec.ts)
use isolated PostgreSQL schemas, Redis leases and HTTP Runner preflight. They
exercise admission, rounding, billing transaction failure, repeated requests,
claim races, expiry, stale tokens, cache invalidation and daily rollover when a
full batch of other boxes is stuck in billing. Go executor tests exercise real
HTTP status reports, heartbeat loss, partial failure replay and explicit apply
when queried allocation already matches.

Regression tests for pending invariants and delayed STARTED/STOPPED/STOPPING/
ERROR/ARCHIVED/DESTROYED events fail at their assertions on baseline `6e43e7f4`
with every production file unchanged, then pass with the complete implementation.
Go and TypeScript generated clients also send real HTTP requests to check that
ordinary job status updates omit `claimToken`, while resize reports include it.

`make test:runner-ci:resize` uses real Python/Node SDKs and CLI against the isolated
API/Runner/KVM stack. It grows 1 CPU/1 GiB → 2/2 → 3/2 → 4/3, blocks a billing
write, observes accepted target versus old allocation, kills API/Runner/proxy,
restarts them, and checks successful replay. Boot id and PID 1 start time stay
unchanged; live plus archived billing intervals have contiguous boundaries.
The harness removes its Box after success and retains failures for inspection.

The real process-loss scenario interrupts BILLING_PENDING before the first
Runner claim. APPLY lease expiry/reclaim and stale completion are covered by
database and Go executor tests; they are not a real-KVM mid-apply crash test.
The API suite, application type-check, client request tests and targeted Runner
resize tests passed on `6e43e7f4` plus this change. The full Runner suite has four
stop/capture integration failures in guest-port, snapshot-copy and SSH tests,
reporting `capture shim still alive`. All four reproduce on unchanged baseline
`6e43e7f4` with the same native artifacts. Native stop/capture repair is outside
this change.
Cleanup also found VM children still holding deleted files after SDK removal;
the task-owned children were stopped by verified process identity. Native process
cleanup is a separate follow-up, not changed by this cloud implementation.

## Delivery and operations

Install the additive migration, upgrade every API writer and Runner, then enable
`CLOUD_RESIZE_ENABLED=true`. Old API writers must not consume active resize jobs.
Disable admission before rollback and drain jobs before restoring old API/schema.
Queries and same-target joins still work with admission disabled.

Retry requires the original Runner and Box to return. For a stopped Guest, an
operator may start that same Box through its owning Runner; lost storage needs
operational recovery. Target billing intentionally persists while waiting. See
the [API runbook](../../../apps/api/README.md#cloud-resize).
