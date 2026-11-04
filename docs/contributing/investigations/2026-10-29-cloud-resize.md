## TL;DR

Persist cloud resize targets at admission, but commit Box CPU/RAM and the usage billing switch only after the Runner confirms the target.

Design: [recoverable cloud CPU and memory resize](https://github.com/boxlite-ai/boxlite/issues/2203).

## Scope

Existing SDK/CLI resize calls grow a running Linux/KVM Box. Cloud keeps whole-GiB
memory rounding. The target is durable in the Job payload; the Box keeps its old
size until the Runner confirms the resize. A failed resize leaves the old size and
billing unchanged and releases the lifecycle fence after a bounded retry. No shrink,
replacement VM, new task queue, or automatic Guest restart is added.

Acceptance requires durable recovery after API/Runner process loss, no duplicate
billing switch on retry, token-fenced completion, bounded terminal failure, and
unchanged behavior for ordinary lifecycle jobs. Admission defaults disabled until
compatible deployment.

## Related work and lessons

[PostgreSQL row locks](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)
serialize competing writers through transaction completion. Admission and completion
use Box → Job row locks; the usage lease is taken first; usage-period writes follow.
Runner calls happen outside transactions. Database statement time controls lease,
due-time and deadline checks, avoiding disagreements between API clocks.

[Kubernetes controllers](https://kubernetes.io/docs/concepts/architecture/controller/#desired-state)
separate persisted intent from observed state. The Job payload carries the absolute
target; completion commits the observed Box size. Reuse the existing Job table and
DB-first Runner poll; Redis notification remains a hint. A separate queue or workflow
engine would duplicate existing ownership and polling without resolving partial
application.

[KEP-1287 in-place Pod resources](https://www.kubernetes.dev/resources/keps/1287/)
uses explicit resize pending/in-progress conditions and retries on sync. This design
keeps the explicit target and observed-resource validation but rejects Kubernetes
cgroup/kubelet mechanics and a new scheduler.

Local constraints found during review:

- [JobService](../../../apps/api/src/box/services/job.service.ts) claims pending jobs
  and terminates stale ordinary work. Resize uses its own bounded lease/retry policy;
  ordinary jobs retain their existing behavior.
- [Box invariants](../../../apps/api/src/box/entities/box.entity.ts) clear pending
  when state equals desired state. `resizeJobId` preserves the lifecycle fence.
- [UsageService](../../../apps/api/src/usage/services/usage.service.ts) bills each
  interval's opening snapshot. Completion calls the existing `closeUsagePeriod` and
  `openUsagePeriodFor` in the same transaction as the Box and Job writes.
- [Runtime resize](../../../src/boxlite/src/litebox/resize.rs) can report mapped
  memory before Guest hotplug finishes. Every claim applies its explicit target,
  even when an empty resource query already matches.
- The earlier product resize surface was removed as unsafe (#1037). The cloud route
  uses the Runner native resize path and does not recreate or destroy the Box.

## How it works

`POST /v1[/{prefix}]/boxes/:id/resize` checks ownership, `write:boxes`, organization
suspension, running state, per-box limits and Runner capability. A supplied memory
target rounds up to GiB once, before checking the current boot ceiling. `{}` reads
actual allocation without creating a job or changing Box or billing.

| Phase | Atomic write | Failure behavior |
| --- | --- | --- |
| Accept | Under usage lease and Box lock, save the target, `APPLY`, due time and deadline. Box gets only `pending/resizeJobId`. | No Box size or billing change |
| Claim | Lock due APPLY jobs with `SKIP LOCKED`; issue token, increment attempt, grant a 120-second lease | Other claims skip the locked rows |
| Apply | Confirm lease, query runtime, apply explicit target; heartbeat every 30 seconds | Requeue with jittered 1–60 second backoff; Box and billing stay old |
| Recover | Every 15 seconds: requeue expired leases below the bound; terminalize at the attempt/deadline bound, including unclaimed PENDING jobs past the deadline | Terminal failure clears `pending/resizeJobId` and leaves Box and billing unchanged |
| Complete | Validate owner, token, unexpired lease and exact target. In one transaction: update Box `cpu/mem`, clear the fence, close the old period, open the target period, mark the Job `COMPLETED` | Old tokens cannot finish a reclaimed or terminal job |

Lock order for admission and completion: usage Redis lease → Box row `FOR UPDATE` →
Job row `FOR UPDATE` → usage-period writes. Completion uses the passed `EntityManager`
and does not acquire a second lease.

Same-target requests join the existing job; different targets conflict. HTTP waits
30 seconds, then returns `504 resize_in_progress` while work continues. Box info
reports the committed (old until completion) size; the empty resize query reports
runtime allocation. Cache invalidation after acceptance, completion and terminal
failure covers Box id and name lookups.

Usage event handlers verify current state and resize ownership under the usage lease
and Box lock. Daily rollover during `APPLY` bills the old shape because the Box row is
still old; completion switches to the target. Stop/delete/migration/snapshot work
remains fenced until completion or terminal failure.

## Late apply and residual risk

A Runner can apply the native resize and fail to report before the job is
terminalized. No automatic runtime reconcile is added. A same-target request does not
take the no-op path unless the committed Box and the runtime both equal the target;
when only the runtime is ahead, admission creates a reconciliation job. `POST
/resize {}` reports runtime allocation while `GET box` reports committed resources,
so operators can detect the mismatch and retry. Without a retry, the mismatch persists.

## Validation

The tests in [cloud-resize.integration.spec.ts](../../../apps/api/src/box/services/cloud-resize.integration.spec.ts)
use isolated PostgreSQL schemas, Redis leases and HTTP Runner preflight. They cover
admission leaving Box/billing old, immediate claimability, completion updating Box and
both usage periods atomically, completion failure rollback, duplicate completion,
bounded retry/terminal failure, late-report rejection, lease expiry, cache
invalidation and daily rollover during `APPLY`. Go executor tests exercise real HTTP
status reports, heartbeat loss, partial failure replay and explicit apply when queried
allocation already matches.

Regression tests for pending invariants and delayed STARTED/STOPPED/STOPPING/ERROR/
ARCHIVED/DESTROYED events must fail with every production file reverted, then pass
with the complete implementation. Go and TypeScript generated clients also send real
HTTP requests to check that ordinary job status updates omit `claimToken`, while
resize reports include it.

`make test:runner-ci:resize` uses real Python/Node SDKs and CLI against the isolated
API/Runner/KVM stack. It grows 1 CPU/1 GiB → 2/2 → 3/2 → 4/3, blocks the completion
period write, observes old Box/billing versus the runtime allocation, kills
API/Runner/proxy, restarts them, and checks successful replay. Boot id and PID 1 start
time stay unchanged; live plus archived billing intervals have contiguous boundaries.
The harness removes its Box after success and retains failures for inspection.

The real process-loss scenario interrupts a blocked completion before the final
period write. APPLY lease expiry/reclaim and stale completion are covered by database
and Go executor tests; they are not a real-KVM mid-apply crash test.

## Delivery and operations

Install the additive migration, upgrade every API writer and Runner, then enable
`CLOUD_RESIZE_ENABLED=true`. Old API writers must not consume active resize jobs.
Disable admission before rollback and drain jobs before restoring old API/schema.
Queries and same-target joins still work with admission disabled.

If the branch was deployed before this change, the pre-deploy backfill must cover
every open `RESIZE_BOX` job: set `APPLY`, due time and deadline; restore Box
`cpu/mem` from `payload.previous` when the old admission already wrote the target;
and close/reopen the usage period to the previous shape. If unreleased, fold the
deadline column into the existing additive migration and skip the backfill.

Retry requires the original Runner and Box to return. For a stopped Guest, an
operator may start that same Box through its owning Runner; lost storage needs
operational recovery. See the [API runbook](../../../apps/api/README.md#cloud-resize).
