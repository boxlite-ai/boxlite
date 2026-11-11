**Status:** Implemented locally, including startup/minute scheduling; cloud acceptance pending

## TL;DR

Prepare all DNS records before confirmation, provision HTTPS through bounded steps, and let the latest verified organization own the hostname.

## Problem

Before this change, the worker discovered certificate DNS only after ownership verification, polled every five seconds, and capped routing proofs at five minutes.
Subscription expiry is hidden inside the DNS deadline, so removing that deadline alone would bypass billing authorization.
Resource IDs, generations, ownership labels and execution leases already provide recovery boundaries worth retaining.

## Scope

Explicit prepare and verify operations control admission; advance requests and an API startup/minute task resume confirmed setup; list/detail remain read-only.
Existing permission, subscription, namespace and organization quota controls remain mandatory.
No publication or cloud deployment is part of this change; other API timers and Cloud Run CPU/minimum-instance settings remain unchanged.

## Related work and lessons

| Method | Evidence | Decision |
| --- | --- | --- |
| Persistent one-step reconciliation | Existing custom-domain GCP adapter and [Google LRO guidance](https://google.aip.dev/151) | Pick: reuse IDs and leases from requests and bounded scheduled rounds |
| Controller DNS self-check | [cert-manager DNS01](https://cert-manager.io/docs/configuration/acme/dns01/) | Adapt: check only after explicit confirmation, before submission |
| In-process periodic task | Existing NestJS scheduler and [task scheduling](https://docs.nestjs.com/techniques/task-scheduling) | Pick: startup and minute rounds; accept pauses when API has no CPU |
| External scheduler or dedicated worker | External triggering or continuously running compute | Reject for this scope: user requires no new scheduler, minimum instances or continuous CPU settings |
| General durable workflow engine | [DSE research](https://arxiv.org/abs/2412.13314) | Reject: additional runtime is unnecessary for a small persisted state machine |
| Provider-managed renewal and alerts | [Google troubleshooting](https://docs.cloud.google.com/certificate-manager/docs/troubleshooting), [logs](https://docs.cloud.google.com/certificate-manager/docs/logs-metrics) | Adopt renewal; independent monitoring still needs deployment |

## How it works

`Get DNS configuration → prepare authorization → show three records → Confirm DNS → verify → claim → submit → advance certificate/map/TLS → ready`.

Preparation reserves one organization slot and stable challenge/IDs, but performs no DNS query or certificate creation.
Google authorization creation is itself asynchronous: bounded prepare requests may resume it before showing all three records together.
Opening an unconfirmed draft never initiates cloud work; the user can explicitly resume preparation.

Verification checks TXT, traffic CNAME/address and authorization CNAME, reporting record-specific errors and distinguishing unavailable queries.
Before cloud submission, persist confirmation, successful DNS checks, hostname ownership and submission intent.
Only an accepted operation or verified existing certificate, followed by a successful database save, permits the submitted message.
Unknown submission outcomes remain distinguishable and are recovered by reading deterministic resources before retrying.

Each invocation has a 25-second external-work budget, two-second workflow SQL statement limits, and cancellation propagated to DNS/TLS/cloud calls; it does not wait for issuance or continue after returning.
The page polls explicit advance operations only for confirmed work, respects server backoff, and stops when hidden, closed or ready.
Google issuance continues without API CPU; map creation and TLS readiness resume on an advance request or the next eligible API task round.

### Startup and minute task amendment

Run one awaited round at application bootstrap, then every 60 seconds through the installed NestJS schedule package.
Skip overlapping rounds on one instance; existing database hostname leases arbitrate across instances and interactive requests.
Select at most three due, confirmed, live, incomplete configurations in oldest-due order and advance each once concurrently.
Exclude unconfirmed, superseded, deleted, ready and currently leased hostnames; existing backoff remains authoritative.
Run one maintenance round alongside setup so cleanup and hourly observations cannot be starved by a setup backlog.
Await all selected work, log unexpected failures, and release the local overlap guard even when a task fails.
Shutdown stops new rounds and awaits active work; abrupt shutdown recovers from persisted state after lease expiration.
The external-work abort and SQL statement limits do not bound every pool or subscription-cache wait, so shutdown has no absolute duration guarantee.
This adds approximately 100 production lines and no dependencies, IAM, minimum instances, continuous CPU changes or cloud resources.

The task is best effort: [Cloud Run request-based CPU allocation](https://docs.cloud.google.com/run/docs/configuring/billing-settings) does not guarantee idle execution.
No instances means no checks; restart runs a new round, while CPU resumption permits the existing interval to run again.
Startup may wait for one bounded round; no step waits for complete certificate issuance.
Alerts and guaranteed monitoring during API inactivity still require an independent deployed mechanism; this task provides neither guarantee.

### Ownership and concurrency

Use a short PostgreSQL transaction to acquire a hostname-wide lease, then perform network work outside the transaction.
Claims, invalidation and result publication verify lease owner, generation, deadline and deletion state using the current database clock.
Successful verification atomically supersedes every other live configuration for that hostname, transfers the domain to the winner and clears its target.
This transfer happens only on first confirmation; repeated verification of the current winner advances idempotently and never clears its binding.
Unverified submissions never interrupt the current owner; a superseded configuration cannot regain ownership using its old challenge or confirmation.
Same-organization repeated creation reuses its live draft; organization ownership, rather than individual membership, remains the authority boundary.
Late executors cannot publish; already-sent cloud writes can still finish and must be caught by retained tombstones.
Before creating the winner's map entry, reconcile superseded resources for that hostname so duplicate map hostnames do not block setup.
Cleanup addresses only fixed IDs belonging to that configuration and generation, never the winning configuration's resources.

### Readiness, subscription and observations

Ready means completed onboarding, not a five-minute DNS/TLS lease.
Bind and route independently refresh bounded subscription grants; grants never slide on reads or exceed the paid cycle.
Use a maximum sixty-second positive grant, with existing cross-instance refresh fencing; unknown authorization fails closed after its grant expires.
Use a new cache namespace so legacy one-day grants cannot survive the cutover.
Recheck ownership/target after external authorization work, and check grant expiry after transactional lock waits.
An observed certificate expiration and last-check timestamp describe observations only; neither is a permanent routing gate after Google renewal.
Probe timeouts record uncertainty, not revocation of completed setup.

### Lifecycle and migration

Preserve live challenges across retries instead of rotating them every day; thirty-day abandoned drafts become cleanup candidates.
Deleted/superseded records retain ownership metadata; logical revocation and unbinding happen before cloud cleanup.
Bound creation rate and retained cleanup backlog separately from the one-live-domain quota.
A bounded maintenance operation scans abandoned drafts and tombstones without polling unconfirmed DNS.
The startup/minute task also invokes maintenance independently of the UI, subject to API execution availability; independent alerts remain outstanding.

Additive migration retains legacy columns but stops using short deadlines for routing; actual certificate expiry is initially unknown where only capped values exist.
Legacy incomplete records retain resources and require confirmation before new certificate work; ready records with explicit prior ownership failures require review.
Legacy ready rows with only elapsed freshness windows keep their completed setup and targets, subject to current subscription authorization.
Cutover requires draining old API revisions and leases before enabling new writers; old binaries must not run concurrently or be rolled back directly.
Migration disables legacy due scans; normal deployment documentation must still require draining old requests that could schedule old work.

## Validation

| Claim | Planned evidence |
| --- | --- |
| No cloud writes from reads; no DNS before confirmation | Controller/service and UI request traces |
| Validation precedes claim/submission | DNS failure tests with zero certificate creates |
| Submission ambiguity is recoverable | Lost POST response and failed database-save fault injection |
| Latest verified owner wins safely | Real PostgreSQL barriers, invalidated leases, cleared target, cross-organization tests |
| Five-minute inactivity and renewal do not disable routes | Real routing tests advancing observation deadlines while grant remains valid |
| Authorization still works | Expired/suspended subscription, delete/unbind and organization isolation tests |
| Cleanup and migration are bounded and recoverable | Partial deletion, late resources, old-phase and rejected-ownership fixtures |
| Startup/minute scheduling resumes confirmed work only | Real Nest lifecycle/fake-clock tests plus PostgreSQL due-selection, backoff, lease and restart fixtures |
| Scheduling failures and overlap remain bounded | Failed round recovery, concurrent ticks, shutdown, disabled feature and batch-limit tests |

Existing bugs require full-production-revert failing runs; changed/new contracts need positive, negative and boundary tests rather than compilation failures.
Real issuance, propagation, renewal and deployed scheduling cannot be established by local mocks and remain cloud acceptance items.

## Local validation record

Explicit confirmation, minute-based advancement and latest-verified ownership are intentional contract changes; the prior worker polled all phases every five seconds.
New entry points and authorization boundaries are tested with positive, negative and concurrency cases; missing old APIs are not claimed as defect reproductions.
The prior resource-identity and failed-certificate fixes remain covered by their existing regression tests.

Local validation uses disposable PostgreSQL and Redis plus controlled DNS, TLS and Google responses.
The API domain/routing/preview suites, complete Dashboard suite, proxy suite and API/Dashboard production builds pass.
After adding the startup/minute task, the API domain/routing/preview checks pass with 14 suites and 250 tests; Dashboard passes with 101 files and 918 tests.
The API production build and workspace lint pass; lint reports zero errors and 562 warnings.
Scheduling tests exercise real Nest bootstrap, minute callbacks, overlap suppression, failed-round recovery and shutdown while work is active.
PostgreSQL tests verify confirmed-only due selection, three-item batches, restart recovery and shared leases between replicas and explicit requests.
No cloud issuance, mapping propagation, natural renewal, deployed task execution or alert delivery has been validated in this change.
