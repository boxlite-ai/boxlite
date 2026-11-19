# Shared CI Listener

This server-side TypeScript library is the common boundary for the hosted API and
standalone Listener image. Hosts supply execution and storage adapters; the shared
controller must not depend on Nest, process environment or a specific database.

`WorkerExecutor` is consumed by the native API provider, which binds operations to
the original installation scope. The actual GitHub runner remains the executable
in the worker image; this library does not execute CI steps.

The API connect service also uses the shared GitHub App JWT signer and HTTP
transport. Requests use fixed GitHub.com origins, reject redirects, bound JSON
responses to 1 MiB and keep credentials out of errors. Mutation errors distinguish
a known HTTP denial from an outcome that may have produced a remote effect; execution
controllers must persist intents before execution mutations. Key loading remains
with the host.

`CiGitHubApp` owns one App identity and private loaders for its signing key, OAuth
client secret and webhook secret. Authentication and connect verification are
shared by the hosted registry and standalone host. An optional account type
restricts new connect/admission; original cleanup retains the original App source.
Self-owned Apps can omit that type and serve both personal and organization accounts.
`ScopeApplications` atomically associates each execution scope with its original
App when the scope is first defined. Missing or conflicting associations fail closed;
there is no legacy association backfill.
Multiple Apps retain one journal, scheduling lease and host capacity provider.
`AppDeliveryRecovery.prefix` separates each App's delivery history without
creating another execution namespace or quota.

`GitHubAppSource` lists installations and issues purpose-specific credentials for
repository discovery, Actions reads, repository runners or organization runners.
It rechecks installation identity and permissions before issuing a token, requests
the least required permission, and narrows repository operations to one repository.
`GitHubCredential` keeps its token in a JavaScript private field and refuses JSON
serialization. Invalid metadata prevents use while preserving the revocation handle.
Retirement stops further requests even when revocation needs a retry. Personal
tokens use the same request interface and are never revoked by `close()`.

Credential use has a short window; the controller must close an old App credential
before issuing its replacement and keep handles until cleanup succeeds. Controller
integration now records durable issuance intents in `ListenerCredentials`;
both the standalone Node host and the API assemble those integrations through
their own execution and persistence adapters.

`GitHubAppSource.deliveryPage()` exposes one validated App webhook-delivery page,
including an opaque next cursor. Delivery IDs remain exact decimal strings, even
above JavaScript's safe integer range. Pagination validates the fixed GitHub route
and rejects a next cursor equal to the current cursor; a multi-page scan must keep
its own visited-cursor history. Empty or short pages can still carry a next cursor.

`redeliver()` requires a successful `beforeMutation` callback before POST. The
caller must persist its intent and verify the original App root and execution
lease there. HTTP 202 only confirms a redelivery request, not inbox persistence or
job execution. These helpers use App JWTs and introduce no new configuration.
Both App hosts assemble `AppDeliveryRecovery` when their existing webhook secret
configuration is present. Replayed webhooks use the existing signature verifier
and binding-authorized inbox; recovery metadata grants no execution capability.

The recovery controller keeps one App-wide background slot, alternating delivery
pages and bounded pending-item scans. It saves `replay/item/<GUID>` before advancing
`replay/progress`, so interruption repeats a page instead of dropping its work.
Incremental scans overlap the completed watermark by one minute. Cursor hashes
survive restart and detect multi-page cycles; invalid order or cursors trigger a
reported rescan without advancing the completed watermark. The protective limit is
10,000 cursors per pass, not a throughput or latency guarantee.

Before each replay, hosts recheck the App root, execution lease and current target
authority. Hosted use requires a connected current owner; standalone use verifies
the App installation is current and unsuspended. The callback persists an intent
UUID and a five-minute retry deadline before POST. An uncertain replay can repeat
the same GUID; this permission does not apply to uncertain Box or JIT creation.
A receipt proves durable inbox acceptance. A later App delivery record with the
same GUID and a 2xx response also stops transport retries, including legitimately
ignored events; neither observation proves a CI job finished. Old failed attempts
cannot reopen a confirmed GUID, and new events cannot reset an existing retry.

[GitHub's delivery history](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)
covers three days. Replay metadata is retained for that
window and pruned in bounded steps. Unconfirmed expiry reports a retention gap;
it never settles a job notice, removes an allocation or returns resource quota.
Global backoff honors GitHub retry deadlines, while a single delivery's 400/404/422
does not cool down other targets. Bounded repository job scans remain the fallback
outside the delivery-history window. See [the controller](src/replay/recovery.ts).

`ListenerCredentials` owns per-purpose App or pinned-repository PAT borrows. App
issuance records its intent before HTTP, retains known handles until retirement
succeeds and defers an immediate remint after an uncertain issuance. Replacement
starts after retiring the previous handle. A stale borrower cannot revoke its
replacement or release the replacement's purpose lock; concurrent retirement
shares one operation. Tokens remain private and failed/unknown issuance records
contain metadata only. PAT retirement closes the local handle without revoking
the user's token. Hosts must close borrows and the provider during shutdown.
After successful revocation, metadata deletion still uses the captured execution
lease. Ordinary deletion failures retain the handle and retry without repeating
revocation. If that write loses its lease, local retirement finishes and leaves
the metadata to the current scheduler; remote revocation failures still retain
the handle. This grants no stale owner permission to modify execution state.

## Credential metadata collection

New issuance metadata records its holder's lease owner, epoch and optional
deployment, never the token. The current scheduler collects at most sixteen
credential records per step, using database time and version-conditional writes.
It skips the exact current holder and independently leased scan credentials.
Issued App metadata is eligible at its persisted expiry; stale PAT borrow metadata
requires a recorded former holder and never revokes the user's token. Unknown
issuance, invalid expiry and legacy PAT records without holder proof remain.
This collector cannot stop Boxes, unregister runners or change capacity.

A malformed non-scan credential record aborts the current page without committing
its metadata deletions or advancing the collection cursor. Subsequent cycles
report `credential-collection` with `StateCorrupt` and retry the same page;
records on later pages remain uncollected until an operator repairs the original
record or restores consistent state. Corruption does not authorize skipping or
deleting unknown metadata, revoking a PAT, or releasing worker capacity.

## Deployment retirement

A positively observed higher deployment permanently retires the old Listener;
temporary same-deployment lease loss still permits recovery and reacquisition.
The old process stops scheduling and new compensation claims, cancels discovery
and replay, and closes its worker/backend, scanner and host credential owners.
Every owner is attempted even when another close fails. Pending local revocation
uses exponential retry delay capped at sixty seconds without restarting scheduling.
An in-flight scan opening or uncancellable worker create does not delay the
other owners' retirement. The old Listener retains ownership until each actual
operation settles, closes any late reader without
querying GitHub, and retries failed retirement before returning.

The current owner restores existing Box/runner identities, allocations and quota;
deployment never resets capacity or stops a running worker merely because its
creator retired. Authorized webhook ingress remains available on a retired hosted
API. Shared database/Redis pools and existing HTTP connections belong to the API
host's lifecycle. Retirement does not guarantee immediate instance termination or
eliminate database connection pressure and lock contention.

`GitHubJobs` verifies the original repository identity before and after reading a
job. A job notice must match the repository, run and job IDs returned by GitHub.
Admission also requires an unassigned queued job and a complete supported label
set containing exactly one routing label: `boxlite` for configured defaults, or
`boxlite-2vcpu-4gbmem-10gbdisk` for explicit resources. Compensation scans inspect queued, running,
waiting, pending and requested workflow runs. A changing or truncated inventory,
permission failure or API pagination cap is an error; callers retain their wake
and retry discovery instead of acknowledging an incomplete pass.

## Docker startup

Every CI worker Box requests guest privilege and prepares Docker before starting
the GitHub runner. Docker-dependent actions, service containers and scripts use
the guest-local `/var/run/docker.sock`. Bootstrap runs as root; readiness probes
and the GitHub runner execute as `runner` with the docker group active.

```text
Privileged CI Box -> Docker API ready -> run.sh -> workflow service containers -> steps
```

The official GitHub runner image supplies Docker binaries and util-linux `setpriv`.
Bootstrap switches directly to `runner:docker`, initializes the runner's
supplementary groups and sets `HOME`, `USER` and `LOGNAME` for both probes and
runner execution. The image's sudoers grants the sudo group access but excludes
root, so root bootstrap must not depend on sudo for this switch.

Other environment variables, including JIT configuration, are inherited.
Bootstrap installs `iptables` with apt when missing, starts `dockerd`, and probes
the API as the runner user. Dependency installation and readiness share a
120-second deadline; a ready daemon is reused.

Preparation failures stop startup and print the last 60 daemon log lines.
Failed JIT delivery stops an owned daemon;
an existing daemon remains untouched. Normal teardown belongs to the Box lifecycle.

Hosts need Docker-capable firmware and privileged guest support; standalone REST
creation also requires privileged creation to be enabled. Custom worker images
must supply Bash, Docker binaries, the docker group, util-linux `setpriv` and GNU
timeout, plus apt when `iptables` is absent.
See [Docker inside a Box](../../../docs/guides/docker-in-docker.md).

## Resource labels

Both hosts share resource parsing across webhook hints, compensation, job matching,
Box creation and JIT registration. `boxlite` uses configured CPU and memory with
10 GiB disk. `boxlite-2vcpu-4gbmem-10gbdisk` creates **2 vCPU, 4 GiB RAM and
10 GiB disk**; its JIT runner advertises that resource label, replacing `boxlite`.
Other requested labels must match the worker's supported platform labels.

`DEFAULT_RUNNER_LABELS` supplies the shared immutable platform labels and `boxlite`
default to both hosts and hosted scans. Per-job selection replaces `boxlite` with
the validated custom label. `DEFAULT_WORKER_DISK_GIB` supplies the same 10-GiB
default to resource validation, pool launch and both Box request adapters.

All three custom quantities must be positive decimal integers without signs,
fractions, exponent notation or leading zeroes. CPU is limited to 1–16 and memory
to 1–128 GiB. Disk must convert exactly to a safe integer byte count (at most
8,388,607 GiB); actual provisioning also remains subject to backend limits.
Labels are case-insensitive. Duplicate routing labels, multiple resource labels,
or `boxlite` combined with a resource label are rejected. Unsupported or invalid
jobs cannot reserve workers through compensation or job admission; signed
webhooks with invalid resource labels receive HTTP 400.

These labels request resources, not entitlements. Hosted creation still runs
BoxService's organization CPU, memory and disk checks and Commerce creation quota.
Standalone sends the same quantities through its authenticated REST create API,
which retains its backend checks. A hosted resource refusal before persistence
records the existing confirmed-rejection fact and returns its occupied slot.
Unknown creation outcomes retain capacity until the original Box can be reconciled.

New allocations persist canonical advertised labels in `supply.labels`. The
routing label supplies both creation resources and JIT registration; the original
job is provenance rather than an exclusive assignment. Legacy allocations without
a label snapshot read their original job metadata during recovery. An attempted
create only recovers its original Box ID and never repeats POST. Default
`boxlite` quantities still come from the host configuration.

Organization runner-group names are independent of workflow routing labels and
retain their configured defaults.

`GitHubRunners` registers JIT runners in a fixed repository or organization group.
Organization admission requires a selected, non-inherited group with the exact
installed repository set supplied by its host. Workflow restrictions and public
repository access require explicit policy checks; unsafe group policies reject
admission before registration. The required `beforeMutation` callback must journal
each registration/removal intent and check the current execution lease. The
returned `JitRegistration` keeps configuration private, cannot be JSON serialized
and permits one delivery attempt. A malformed configuration still retains a known
runner ID for cleanup. Cleanup confirms absence through complete enumeration under
the original authority, without requiring a revoked group ACL to admit new work.
A 404 by itself never proves runner absence.
Runner lookups/removals, job reads, App credential issuance and state operations
capture caller-owned identities and selectors before their first asynchronous
operation. Mutating a supplied object or array while a call waits cannot change
the verified runner ID, journaled deletion target, token purpose/repository, job
notice, execution lease, read keys or recovery prefixes used by that call.

`verifyWebhook` checks HMAC-SHA256 over the original body bytes, a bounded payload,
delivery UUID and matching event structure. The API already uses this verifier.
The standalone HTTP host must apply its own body, concurrency and timeout limits
before invoking it. `ListenerInbox` atomically stores the delivery receipt, wake
and job identity in either database, with no execution lease required. Concurrent
duplicates converge; conflicting bodies/events or job identities are rejected.
A new delivery updates record versions, so settlement using an older captured
version fails rather than removing newer work. The API uses the same inbox through its binding-authorized PostgreSQL adapter.

`ListenerState` stores durable records through either the host's PostgreSQL pool
or the Node 24 SQLite adapter. PostgreSQL uses the single `ci_listener_state` table;
the API migration creates it. SQLite keeps `listener.sqlite` and its WAL/SHM files
in a private directory supplied by the standalone host.

Execution writes require a lease bound to the namespace, owner and epoch. Ingress
can commit receipts and notices without the scheduling lease. Batches use UUID
versions and atomic conditional writes; expired leases, stale versions, missing
roots and unsupported schemas reject admission. Point reads can carry the same
lease fence; recovery reads bounded pages from active indexes.
Permanent business roots can be seeded atomically during namespace initialization;
subsequent initialization checks their presence and never overwrites them. Recovery
selects indexed key prefixes so retained delivery receipts and inactive historical
scopes are not enumerated. Unleased reads serve ingress CAS lookups and dashboard
aggregates; they never grant permission to execute jobs.

### Execution lease storage

`@owner` stores `{owner, epoch}` with record schema 2, or adds `deployment` with
schema 3 for deployment-aware hosts; `@lease` stores `{until}` with schema 1.
The identity and its UUID record version remain stable throughout
a scheduler's tenure. Renewal extends only the deadline; takeover increments the
epoch and changes both records atomically.

Execution checks hold a shared `FOR SHARE` lock on `@owner` before reading
`@lease`, so unrelated readers and allocation transactions can overlap.
Standby ticks and webhook receipts validate an initialized journal's roots and
requested seeds in a consistent snapshot. A missing or legacy owner sends
initialization through serialized bootstrap, which rereads the roots before
creating or migrating them. Missing seeds in an existing journal fail validation.
During a standby tick, acquisition reads the owner and deadline without a row
lock. A live lease or a different deployment ends the probe immediately.
Renewal shares the owner lock with workers and locks `@lease` for update before
checking expiry against database time. A worker can hold its transaction open
while the owner renews. Concurrent renewals serialize on the deadline row.
Activation, takeover and bootstrap take the owner lock exclusively, so an
identity change waits for guarded transactions and renewals to finish.
Adapters without shared point reads fall back to the exclusive lock; SQLite
serializes transactions at the file boundary.
Renewal rejects an expired or replaced owner and never shortens its deadline,
even if a caller requests a shorter TTL. A takeover candidate rechecks the
deployment and deadline against database time after obtaining the owner lock.
The lock is held until the database transaction commits or rolls back.

A failed renewal cancels in-flight work for that Listener session. The
`listener-renewal` warning identifies that operation before the session drains.
Hosted database failures include the SQLSTATE code without query text or parameters.

Snapshot checks read the deadline without locking that frequently updated row.
For example, a snapshot can precede a renewal from 10:00:30 to 10:00:40 and still
lock the unchanged scheduler identity. An older deadline can cause conservative
lease rejection, but cannot extend authority; actual takeover changes the locked
identity and can still produce a serialization error. Neither the shared state
adapter nor the hosted adapter automatically retries transactions.

Initialization upgrades a legacy schema-1 owner containing `{owner, epoch, until}`
under the bootstrap transaction and owner lock. It preserves identity, epoch,
deadline and journal data while creating `@lease` and writing schema-2 `@owner`.
An interrupted upgrade rolls back completely; mixed or missing records fail closed.
Repeated initialization validates the existing records without resetting them.
Conditional-write conflicts during bootstrap, migration, takeover or renewal
abort the whole transaction, preserving the previous identity, deadline and journal.
Malformed identity or deadline payloads block initialization or ingress rather
than admitting new work with incomplete lease metadata.

Pre-schema-2 binaries reject owner schema 2. During that upgrade, an old scheduler stops renewing
and an upgraded instance can acquire after the preserved deadline expires.
Upgrade all hosts sharing a namespace; reverting binaries alone is unsupported,
and deleting execution state would lose recovery records. The existing PostgreSQL
and SQLite tables are retained: identity columns belong to `@owner`, and
`lease_until` belongs to `@lease`.

### Deployment eligibility

A host may construct `ListenerState(database, namespace, deployment)` with a
positive safe integer assigned by its deployment workflow. After HTTP is serving,
it calls `activate()`: a higher deployment takes the same owner lock as execution
transactions, waits for those transactions to finish, then atomically advances the
deployment and epoch, clears the owner and expires the lease. Same-deployment
activation is idempotent; an older deployment cannot move the target backwards.

The first activation upgrades owner schema 2 to 3, so earlier binaries fail closed
instead of renewing an ownership record they do not understand. Acquisition,
renewal and execution writes require the active deployment. Initialization and
webhook ingress do not activate a deployment. Unversioned standalone hosts retain
schema 2 and cannot acquire an upgraded namespace. Keep the journal when upgrading;
rolling back to an older binary requires an explicit state-format recovery plan.

No HTTP call holds this database lock. A call issued before takeover may finish,
but stale state commits fail; the replacement owner recovers its persisted intent
using original resource identifiers. A retired API may keep WebSockets open and
accept authorized ingress without retaining scheduling authority.

### Conditional admission writes

Admission commits may include read-only record-version checks. The transaction
locks those records and rejects a missing or changed version before writing any
allocation. The checked policy keeps its version, so multiple admissions can use
one snapshot until an authorized configuration update commits. Hosts still own
policy authorization and resolution.

`CapacityProvider.resolve({ scope, repository, job, lease, signal })` is the single
admission-policy port. The standalone host always returns its `CI_WORKER_MAX` total;
the hosted API resolves account settings and Commerce. The controller does not
branch on the host or know account/repository quota rules. Each policy supplies
one or more explicit `global`, `organization` or GitHub `account` limits. Every
reservation atomically increments all three usage counters, even if the current
policy selects only one. Counter CAS and policy record-version checks prevent
concurrent overspending. Zero pauses new admission; null has no numeric ceiling.
Missing or invalid policies fail closed. The capacity API reads the organization
counter directly, without reading scope or worker history.

Every candidate asks the provider separately, including its repository identity;
a policy is never cached across different repositories by the controller.
Compensation only records pending jobs and does not query capacity. Existing worker recovery runs
before policy lookup and continues when Commerce or settings are unavailable.
Future repository rules belong in the hosted provider and candidate selection;
strict repository limits also require runner eligibility to be partitioned.
The triggering job alone does not identify the repository an organization worker
will actually execute. Repository-specific limits are not implemented.

```mermaid
flowchart TD
    L[Shared Listener] -->|resolve with scope, repository and job| P[CapacityProvider]
    P --> E[Standalone: EnvironmentCapacity]
    P --> H[Hosted: CiSettingsService]
    E -->|CI_WORKER_MAX total| R[Capacity policy and version checks]
    H -->|Account setting clamped by Commerce| R
    R --> K[ExecutionJournal: read selected usage counters]
    K -->|Counter CAS and policy version checks| S[(SQLite or PostgreSQL)]
    S -->|Reservation committed| B[Create JIT Box]
```

The storage layer does not authorize GitHub requests or platform tenants. Hosts
must recheck their live binding in the same transaction used to persist ingress,
and execution adapters must enforce authorization at the actual side-effect
boundary. Both hosts implement those checks; deployed hosted acceptance remains pending.
Temporary GitHub tokens and JIT configuration must never be written as payloads.

The execution journal retains immutable scope definitions addressed by their hash.
Known worker lookups, App authorization and quota checks use point reads; none
enumerates historical scopes. `active-scope/<scope>` and
`active-worker/<scope>/<worker>` index only unfinished allocations. Each new reservation has an independent
`supply/<allocation-id>` identity. Legacy `job/<installation>/<repository>/<job>`
records remain valid for original cleanup; new supply is not deduplicated by its
trigger job. Reservation and
final release update these memberships and the scope activity version atomically.
There is no global historical-scope catalog or 10,000-scope ceiling.

Usage includes uncertain creates and all historical generations whose original
Box is not yet confirmed absent. Each quota domain keeps a permanent marker and
counter, including at zero. Losing either member of an established pair fails
closed; initialization never silently repairs it. Point reads validate referenced
records, not arbitrary unreferenced historical debris. Coordinated loss of both
a domain marker and its counter cannot always be distinguished from a new domain.

The journal format is version 2 and requires a fresh CI execution namespace. Old
namespaces fail initialization; there is no migration, compatibility read or
backfill. For the current dev-only rollout, stop the Listener and explicitly reset
its CI execution state before starting this version, after accounting for any
remaining Boxes/runners. This is not an instruction to clear shared application
data or Box storage. Neither startup nor this change resets dev state automatically.
Each effect records an operation UUID first. Resource IDs are immutable, and an
unknown create cannot be reset, retried or settled through a missing-resource result.

`WorkerPool` drives boot, JIT registration/delivery and cleanup through host-bound
capabilities. JIT configuration stays in memory and is sent at most once. A triggering job supplies demand rather than an exclusive assignment:
the Box may execute another authorized matching job. A completed notification alone
does not stop it. An elapsed timeout or runner absence alone does not prove
that its Box is idle. Delivered workers remain until actual exit or confirmed
[idle retirement](#surplus-idle-retirement). Physical Box capacity
returns after its original Box is confirmed absent. The allocation stays indexed
until both original resources are absent, preserving original-resource cleanup.
The host must enforce authority and execution epoch
again at actual side effects, including native Box persistence. Both host entry
points use this kernel; runtime acceptance remains a separate deployment check.

## GitHub runner scale sets

Set `CI_SCALE_SET_BINDINGS` to a JSON object mapping a binding ID to an array of resource labels. Both hosts use the shared TypeScript protocol client.

```json
{"personal-token":["boxlite","boxlite-2vcpu-4gbmem-10gbdisk"]}
```

Use the hosted installation binding ID, standalone `installation:<id>`, or standalone `personal-token`. A `*` entry enables every binding. An absent setting leaves existing bindings on classic scheduling.

The elected listener opens one cancellable session per binding, execution scope and worker specification. Each session sends its available capacity to GitHub and explicitly acquires eligible job requests. An authenticated queued-job observation can seed an additional supported resource label, up to 64 watched specifications per scope.

GitHub reports the total assigned jobs, including running jobs. If it reports 16 and five usable workers already hold reservations, the planner can reserve up to 11 more within quota. It counts pending Box creates across restarts.

A durable target precedes message acknowledgment. A dedicated JIT configuration binds each runner to its set and its original Box. Registration recovery uses a targeted name lookup and verifies the set ID.

The default polling deadline is two minutes. Network waits occur outside SQL transactions and the listener bounds concurrent setup and message handling across scopes. GitHub can still throttle credentials and management requests. [Reference protocol](https://github.com/actions/scaleset/tree/v0.5.0)

An owner that loses an acquisition reply reconciles the first replay against the current set statistics when the session and message disagree. A worker that exits before GitHub reports it started work triggers per-specification creation backoff. A lost upload reply is recovered using the original Box and JIT delivery intent.

## Label capacity scheduling

Hosted API and standalone Listener Boxes use the same label-count scheduler.
Signed `queued`, `in_progress` and `completed` observations update aggregate demand
and minimal job facts atomically. Repository-scoped ingress transactions serialize
the counter and wake, including their initial insertion. Duplicate or out-of-order
transitions cannot increment demand twice or resurrect locally known completed
jobs. A first-seen historical queued replay can still look new, so these counters
are wake hints rather than permission to add capacity.
`job-fact.runner` records GitHub's actual assignment; it does not lock the job to a
runner provisioned because of that job.

An authoritative scan records each job's contribution and generation in its
job fact. The label counter stores the generation. Later arrivals join it. If a scan includes only B,
a late completion for A leaves B counted. Replaying either completion has no
effect. Historical counters with uncertain membership request a fresh scan.
Pinned PAT repositories use installation ID zero for scans and incremental events.
A scan superseded during a GitHub read can be queued again immediately. Transport failures and rate limits retain their retry delays.

Demand groups retain their BoxLite organization, original execution scope and
compatible routing labels. Installation, binding generation, repository/group
membership and visibility still constrain eligibility. Matching labels alone
cannot transfer capacity across these boundaries.

```text
missing = max(0, queued - starting - idle)
new reservations <= remaining organization/host quota

A queues -> R is provisioned -> GitHub assigns B to R
R is busy -> A remains queued -> provision matching capacity for A
```

Busy and closing resources retain quota until original Box absence is confirmed,
but do not count as available supply. Unknown creation outcomes retain their
reservation and never repeat create POST. Pending registrations count
conservatively as starting supply. Repository revisions and proof deadlines fence reservations against newer
observations; short quota updates serialize without holding a lock over GitHub
or Box network calls.

The Listener schedules scope planning and allocation execution independently.
Each reservation enters execution as soon as it commits; neither the remaining
reservations nor a previous allocation's create/JIT response is a batch barrier.
The in-process budgets are eight scope planners and 32 allocation consumers per
owner, independently of organization/host quota. Credentials remain isolated by
allocation, with original effect ordering and lease checks.

### Asynchronous allocation queue

`Listener` assembles four keyed `WorkQueue` indexes. Scope keys coalesce capacity
planning, allocation keys coalesce resource execution, scope/repository/run keys
coalesce job verification across eight lanes, and scope/repository keys coalesce
complete queue reconciliation across two background lanes. One key has at most one
active consumer, and changed work received during execution runs once afterward
with its latest revision. Hosted uses the PostgreSQL journal; standalone uses the
same protocol in SQLite. These are logical queues within the existing state
store, with no additional broker or deployment unit.

The indexes each retain at most 4096 pending/active keys. Rejected submissions
remain durable; planning and execution rotate past rejected positions on a later wake instead of always favoring the first page. Pending consumers
count against quota as starting supply. The queue reads each allocation again
when execution starts, and each effect retains its lease and version checks.

Queue errors back off for one and then two seconds; a third failure yields to
periodic recovery for 60 seconds. Version conflicts reload without consuming that remote-failure budget. A newer
revision received during a conflicting operation remains queued; allocation work
revisions include their admission/retirement proof, so refreshed guards replace
stale pending work. A retry reconciles the original intent: it does not
repeat an uncertain create, runner registration or JIT configuration upload.

A confirmed creation refusal returns quota immediately and delays replacement
admission at the stable scope/resource-label boundary: one second, then two,
then sixty seconds for the third and later refusals. New allocation keys and
completion wakes do not reset this delay. Other labels and resource cleanup
remain eligible. A successful persisted create clears its label's refusal
history. This bounded history belongs to the pool in the current owner session;
it is not a persisted cooldown across owner restarts.

`queue-revision/<installation>/<repository>` is an ingress-owned observation
fence. Webhook observations and changed authoritative snapshots advance it in
the same transaction as their facts/counters. Unchanged snapshots retain their
versions, so polling cannot continually invalidate waiting consumers. A scan
captures the revision before HTTP and verifies it on commit, including when a
wake was acknowledged during the request. Queued idle retirement checks captured repository revisions and proof deadlines
in the same transaction as its original intent. The deadline is checked against
the database clock after possible lock waits; asynchronous execution cannot reuse
an expired snapshot. An undispatched reservation with no Box, runner, delivery
or effect intent can return quota through allocation CAS without external cleanup.
Issued or uncertain creation is never released on that basis. Pending retirement
intents are reconsidered against current demand after restart.

Stop or lease loss rejects new queue work and cancels cooperative requests.
The owner waits for actual active operations; an uncancellable call can still
delay shutdown. Backend closure also rejects late authorization results and
prevents new worker credential providers from appearing after the close snapshot.
Persisted uncertain operations remain recoverable by the next execution owner.

When invoking `WorkerPool` directly without the Listener's executor, its existing
awaited `tick`/`balance` interface remains available. Both production hosts use
the Listener's asynchronous assembly.

Rollout must drain older webhook writers before enabling this queue protocol:
older binaries do not advance the repository observation fence. This is a writer
compatibility requirement, not a database migration or permission to clear CI
state. Admission and cleanup continue to enforce current host authority.

### Notification admission and background correction

A current notification identifies its repository, run and job. The owner pump
fairly submits at most 32 notices at a time, grouped by scope, repository and run,
to an independent verification queue. It does not await a submitted batch. Different
runs in the same scope can verify concurrently, and each completion wakes planning.
A pending run lookup does not block another run from reserving and creating workers.
Verification tracks each notice version separately. For a run with 64 notices,
verifying the second group of 32 preserves the first group's remaining lifetime.
Scope planning reads accumulated evidence without awaiting job-query HTTP. Each
planning pass uses a fixed starting cursor so it visits each scope at most once.
Jobs in one run share its first jobs page; notified jobs missing from that page
use direct job requests. Each repository batch owns one credential borrow and
retains repository identity/visibility checks. Compatible backends without batch
reads use point-job reads. Runner inventory is read after fresh verification,
without an initial unverified inventory pass.

Verified queued jobs accumulate across turns in the owner's memory, with a
30-second lifetime starting before HTTP and a total budget of 4096 jobs. For example, 64 one-job runs
can contribute 32 verified jobs in each of two turns; the second turn deducts
existing starting/idle supply from the combined demand. Each repository ingress
transaction revalidates accumulated `job-fact` versions and accepts new HTTP
observations through the same monotonic state rules as webhooks. Recorded progress
or completion cannot be replaced by a stale queued response. Reservations and
create intents check the resulting repository revision and earliest proof deadline.
An owner restart rebuilds this evidence; persisted counters remain hints.

For each label, the pool subtracts workers already starting or available from
verified demand before choosing which unissued reservations may create a Box.
With one queued job, two unissued reservations and no started workers, only one
reservation may create. The other waits for new demand or a complete surplus check.
If the execution queue rejects the first reservation during retry backoff, the
next eligible reservation for that label can use the same grant.

Queued notices remain pending while their jobs are eligible. GitHub-confirmed
non-queued jobs or complete background snapshots settle captured notice versions.
A duplicate webhook does not add another counted job or reservation. Custom
backends without supply inventory retain the job-driven fallback.

Two background lanes coordinate complete scope scans, with at most four repository
reads per scope and isolated credential providers. The queued status is sampled
before the other four active statuses overlap, preserving queued-to-running transitions; a failure
aborts and drains sibling requests before credential retirement. Each status keeps
its pagination and completeness checks. Failed credential cleanup remains owned
and must succeed before a replacement reader opens.

Background scans retain the five-minute cadence. New dirty counter versions can
request immediate correction; uncertain surplus requests are bounded separately.
The existing compensation scanner continues publishing missed-job notices on
replicas. A complete scan rebuilds persisted counts behind captured wake and
repository revisions. Snapshot correction and admission reads share a repository
lock while invalidating cached demand and committing the corrected counts. GitHub
requests run outside that lock. Planning uses database time to check whether
every repository's 30-second proof remains live. Early completions retain their
original deadlines.
For example, three 35-second reads start together rather than requiring a second wave.
When scan skew exceeds the freshness window, or a scope exceeds 100 proof checks,
`surplus-retirement-deferred` reports the reason and retries at the periodic cadence.
New dirty versions can request correction sooner. Admission and stopped-resource
recovery continue while physical surplus retirement waits. If both targeted
verification and the background scan fail, the pool can still clean up stopped Boxes.
If expansion would replace a newly busy runner without an assignment record,
planning drops the cached snapshot and requests fresh job verification.
Invalidated reads cannot repopulate evidence or publish a verification timestamp. This covers missed assignment notifications
without treating an older queued observation as a new capacity grant.

A matching result from targeted job verification wakes the scope planner even when
its webhook and a dirty aggregate have the same versions as the previous pass.
A queued job with incompatible labels retains its scope-specific verification
deadline. A new notice version or expiry makes it eligible for another check.

When an unassigned runner becomes busy, the planner cancels that scope's in-flight
scan. A cancelled correction rolls back at the repository transaction boundary.
The planner checks cancellation again before publishing the complete snapshot.

An allocation accepted by the execution queue counts against its label's create
budget until it leaves the queue or its durable create intent accounts for it.
For one job, if B is queued while A is backing off, A becoming eligible cannot
start a second Box. Routine recovery of the same allocation version preserves
an outstanding idle retirement. If verified jobs need an idle runner of that
label, a positive-only plan replaces its queued retirement with ordinary recovery.
The consumer rechecks the request before submitting the GitHub deletion.
Surplus runners keep their existing retirement requests. Starting a retirement
requires complete queue evidence; execution checks its proof and runner identity.

Each run verifier owns its credential handles. If token issuance has an unknown
outcome, replacement readers share a 60-second retry delay for that repository
and purpose. Many small runs increase issuance and retirement traffic. Deployment
latency and shared GitHub rate limits still need workload measurements.

Every repository in a scope must have a matching proof before physical surplus
retirement, including cancellation of an unissued reservation. Partial positive
evidence can add capacity but cannot establish surplus. More than 100 retirement checks defer retirement before the point lookup while bounded
admission and stopped-resource recovery continue.

```mermaid
flowchart LR
  W[Webhook / compensation notices] --> D[(State journal)]
  D --> J[Job / run verification: 8 lanes]
  J --> C[Versioned positive evidence]
  C --> P[Scope planning: 8 lanes]
  P --> I[Runner inventory and slot reservation]
  I --> E[Allocation execution: 32 lanes]
  E --> B[Create / JIT / original-resource cleanup]
  R[Complete reconciliation: 2 lanes] --> G[Repository queue enumeration]
  G --> D
  D --> F[Complete revision proof]
  F --> P
```

Reused runner IDs do not reject job observations. Ambiguous assignment observations request background queue correction. A repository whose complete scan races new observations cannot authorize physical
retirement; independently verified positive jobs can still add capacity.
Queue and inventory failures still allow known stopped/absent resource cleanup,
but cannot dispatch an existing unsent reservation. A known
runner missing from inventory or offline retains starting supply during the existing
300-second bootstrap budget from its persisted `runner.registeredAt`; older records
fall back to allocation creation time. A delayed registration therefore receives
its own startup grace. After that budget it enters cleanup without releasing quota
until the original Box is absent.
An offline runner still reported busy is excluded from idle supply without
stopping its running job solely because of the inventory status.

Reservations use rotating counter windows within the database's 100-check budget,
including scope and host-policy fences. Only fenced counters add demand and all
compatible supply is deducted. Wide repository sets can therefore underfill while
compatible idle runners cover every individual window, even when total queued
demand is larger. Rotation admits later repositories as that supply becomes busy;
it does not guarantee filling the entire queue across windows. The window does
not cap runners represented by one counter or replace organization quota.

### Transaction and lock budget

Worker recovery validates the scope once per membership page. Ordinary state
reads use parameterized batches of at most 100 keys. Each worker batch rechecks
up to 32 original allocations with their membership and deduplication links in
one fenced snapshot; missing workers require missing memberships too.

Queue rebuilding reads job facts and counters in bounded batches and inserts
missing facts in groups of at most 100. All groups share the existing repository
ingress transaction, wake-version check and execution lease. A later conflict
rolls back earlier batches; partial snapshots cannot authorize capacity changes.

Consecutive expected-absent ordinary records can share an insert statement.
The inserted count must match the complete batch or the transaction rolls back.
Versioned updates, deletes, sorted mutation order and policy locks retain their
existing contracts.

Optional batch storage methods have a point-operation fallback; reads preserve caller order and duplicate ingress keys.

Hosted transactions still serialize on the namespace's `@owner` row, and SQLite
still uses `BEGIN IMMEDIATE`. Batching reduces repeated transactions and queries;
it does not remove these locks or establish a production throughput guarantee.
GitHub and Box requests execute outside state transactions. PostgreSQL statement
and lock timeouts do not bound the total duration of a multi-statement transaction.

### Surplus idle retirement

Retirement uses the complete authoritative label aggregate, including counters
outside the rotating reservation window. It cancels undispatched surplus first.
An online, nonbusy runner whose JIT delivery is `requested` or `done` becomes a
candidate only after 300 seconds from registration. This is a startup grace, not
evidence of continuous idle time. Busy workers and capacity still needed by the
queue remain.

A lost JIT upload acknowledgement can leave a runner at `requested`. A Hosted
Box with a recoverable delivery uses its original allocation, Box and platform
runner identities. A recorded job claim or a matching online or busy runner
proves startup. Otherwise the native record determines the next action.

| Native JIT record | Recovery |
| --- | --- |
| Delivery unclaimed or configuration upload in progress | Seal the operation with a versioned write, then close the original allocation. A delayed upload cannot authorize ready after the seal. |
| Configuration acknowledged and ready authorized | Recheck current authority and original Box placement, then write only the fixed ready marker. |
| Historical single-attempt marker | Keep observing the runner through its startup grace. |

The guest consumes the configuration once and removes both files before running
the job. Repeating the ready marker can never supply another configuration.
The scheduler checks current queued demand when it replaces a closed allocation.

A newly busy runner without an assignment claim triggers a demand refresh even
when it has a pending retirement. Replacing a retirement invalidates its running
callback before GitHub DELETE. A later retirement must validate its own queue proof.

Before unregistering, the scheduler persists a distinct `runner-retire` intent
under the original allocation, identity and execution lease. `retireIdle()` reads
the original runner again and uses the classic repository/organization REST DELETE.
Only exact HTTP 204 followed by complete original-runner absence permits recording
retirement and stopping its original Box. Existing cleanup then deletes that Box;
physical quota returns only after confirmed Box absence.

| Result | Recovery |
| --- | --- |
| Runner busy, offline or already missing | Keep the Box; absence alone cannot authorize idle retirement. |
| Busy refusal (422), 404, unexpected 2xx or lost acknowledgement | Preserve the intent and quota; retry eligible online-idle runners at most once per minute in that process. |
| Confirmation write fails after unregistering | Keep the durable unconfirmed intent, including after restart; do not infer that stopping is safe. |
| Original Box actually stops or disappears | Continue ordinary original-resource cleanup regardless of pending retirement. |

Pending retirement suppresses the older missing/offline bootstrap forced-stop
path. A lost acknowledgement can therefore need operator investigation instead
of automatic Box stop. Restart resets local retry timing, not the durable intent.
This deliberately favors preserving a possibly assigned job over reclaiming quota.

The busy-refusal fence follows
[legacy ARC's classic REST protocol](https://github.com/actions/actions-runner-controller/blob/89f34c4f782d4b488e6aecb66146407fee8eb3af/controllers/actions.summerwind.net/runner_graceful_stop.go#L403).
[GitHub's endpoint documentation](https://docs.github.com/en/rest/actions/self-hosted-runners#delete-a-self-hosted-runner-from-a-repository)
does not formally guarantee atomic rejection against concurrent assignment.
Disposable classic-runner boundary validation remains necessary before deployment;
unit checks do not establish that remote guarantee. ScaleSet runner APIs are a
different protocol and are not used here.

`runner-retire` extends the persisted effect discriminator without changing SQL
tables. Older decoders fail closed on these records, including API state readers.
Upgrade all readers sharing a namespace. Before rolling back, drain or explicitly
recover pending retirement records; do not erase the journal or rewrite an
uncertain retirement as ordinary cleanup.

Only current counted scopes verify and settle repository notices. Queued notices
remain pending for future capacity releases. Retired scopes recover existing
resources while leaving admission to the current scope.

A fallback replaces or removes a malformed aggregate only after a version-fenced
queue snapshot. Terminal job observations prevent stale scans from recreating
completed demand. Rejected ingress changes leave receipts, facts and counters
uncommitted.

The label-count upgrade preserves an existing version-2 journal and outstanding
resources. It adds no state-table DDL and requires no journal reset. Legacy
allocations recover through original identifiers and job-label fallback. Hosted
deployment handoff follows the eligibility protocol above.

## Independent repository compensation

Every Listener replica runs two compensation lanes alongside the single execution
scheduler. A lane claims only work it can start immediately. The existing state
table holds repository tasks, immutable scope references and ordered due keys; PostgreSQL uses short transactions
and SKIP LOCKED candidate selection, while SQLite uses its existing serialized
write transaction. Neither keeps a database lock during GitHub requests.

Each successful binding catalog activates its own completed snapshot. A failing
installation does not block another binding's scans, and a failed catalog read is
not an empty catalog. An authoritative installation index retires removed bindings.
Repeated discovery preserves existing task deadlines. Directory staging records
its committed batch offsets, so a canceled publication resumes without rereading
already written tasks and activates only after all batches complete. Old snapshot memberships and
expired credential metadata are removed in bounded pages, without scanning retained
execution history.

A task has an owner, epoch and 60-second lease; the full scan has a 45-second
abort deadline. Different installations can run concurrently, while one App's
installation has at most one effective scan lease across replicas. Busy repository
candidates move out of the due head. Successful scans become eligible again after
five minutes; failures use capped backoff. A 429 or rate-limited 403 with a retry
header also persists an installation-wide retry deadline. Other 403 responses
remain repository failures rather than being guessed to mean rate limiting.

The scanner has GitHub jobs-read capabilities only. It reuses credential issuance
intents and retirement, but its lease cannot create allocations or change cap.
Cleanup may conditionally remove its own original credential record after lease
expiry; it cannot delete another owner's operation or issue another credential.
Unknown issuance metadata expires after two hours, beyond the maximum App token
lifetime accepted by the transport. Tokens themselves are never stored.

Publication checks the task lease, active binding snapshot and exact job identity.
Hosted publication checks the original binding generation and owner in the same
PostgreSQL transaction. Standalone publication checks its captured backend and
binding record versions. A deleted connection or superseded snapshot rejects late
results. Repeated jobs converge with webhook ingress; repository, run, account or
installation conflicts fail closed.

Scanned jobs enter the ordinary pending-notice queue. They do not reserve slots
or query Commerce. The execution scheduler rechecks current authority, job state
and cap before creating a Box. A waiting notice can therefore resume after worker
cleanup releases a slot without waiting for the five-minute scan interval.
Stopping the Listener cancels and awaits both lanes and retires their credentials;
failed retirement retains its handle for retry and reports the cleanup failure.

## Worker recovery and logs

`ci-worker-reserved` records the completed reservation. Pending resource work
emits `ci-worker-execution-started` with `queueWaitMs` and
`ci-worker-execution-settled` with `durationMs`. These are management timings,
not proof that a GitHub job started or that an external mutation succeeded.
Healthy running allocations do not emit these timing events on every poll.

The scheduler rotates through eight active scopes per recovery metadata page;
this is pagination, not a management concurrency limit. The label-capacity path
reads each pool's allocations once per round in 32-record pages, counts compatible
supply from a complete GitHub inventory, and enqueues independent resources
without awaiting their completion. It does not rescan the pool before every reservation. Custom
backends without inventory retain their clean-round and membership-version
admission guard. Unknown resources retain their original identity and quota.

The native API records a definitive creation refusal for any failure before
`onPersist` begins, including throttling, placement, image policy and prerequisite
lookups. It stores the original scope and creation-operation UUID in the same
ledger key that would hold a Box ID;
an expected-null CAS makes those outcomes mutually exclusive. Only this durable
fact yields `ConfirmedWorkerCreationRejected`. Hosted authority revocation can
use the same fence before dispatch or after a rejected native persistence
transaction rolls back. The optional `ExecutionHost.rejectUndispatchedCreate`
capability binds that proof to the exact original effect before reporting refusal;
hosts without it retain uncertain reservations. A committed original Box ID wins
over refusal and remains available for cleanup. Restart can recover the fact through
the original worker lookup. The kernel checks the original pending operation and
atomically retires its allocation and scope reference, leaving queued demand pending.
It emits `ci-worker-create-rejected`; a later attempt gets a new allocation/name.

Native lookup also corrects historical pending creates after five minutes from
reservation. It verifies the original operation and absence of a Box/ledger before
conditionally recording that refusal. A delayed Box transaction must acquire the
same ledger key and rolls back if correction wins. Time alone is not absence proof;
known IDs and unexpected same-name Boxes retain their existing ownership checks.

Ordinary HTTP errors, timeouts, failed proof persistence and uncertain persistence
outcomes keep the reservation. The standalone REST adapter does not infer this
proof from a 429 or an error-body property. Unknown creates are never repeated.
The general resource state machine still forbids requested-to-absent transitions;
the explicit refusal path is limited to an unmaterialized Box with no runner.

When Hosted has already persisted the original Box and confirms destruction,
the adapter returns the Box ID and creation effect for the requested allocation.
The pool saves that ID, then follows ordinary known-Box recovery. A restart
between those writes resumes at the same ID. A stale synchronization error
cannot overwrite a later destroy callback. Standalone keeps a requested slot
when only a REST 404 and a filtered public inventory are available.

Stopped/error Boxes are deleted by their original IDs; a lookup error retains
capacity. Confirmed absence releases physical
capacity even when GitHub registration cleanup must retry. Other allocations
still get reconciled after an ordinary per-worker error. Lease loss, corrupt or
conflicting state, abort and unretired credential handles stop further work.

If soft deletion frees a Hosted worker's name but the runner fails to confirm
destruction, the Box manager retries on the original runner. It matches the
Box ID, original name and organization in the configured Hosted App's ledger.
If a V2 Box still says destroying after its last destroy job failed on that runner,
the manager submits a replacement once no incomplete job remains. A late failure
from an earlier attempt preserves a confirmed destroyed Box.
Stale-error cleanup retains the row while destruction is pending. The 24-hour
cleanup keeps a destroyed Box while a charged allocation still needs its receipt.
If historical cleanup already pruned a failed destruction, recovery keeps the
slot reserved. A destroy job on a previous runner can refer to an older copy of
the same Box ID.
A change to the primary Hosted App ID requires draining its old namespace first.

An absent Box's allocation remains in the journal until runner cleanup is confirmed.
A new supply allocation does not exclusively reserve its trigger job.
Unknown Box creation still occupies capacity and is never repeated. Cleanup debt
survives restart and remains in the paged active indexes. Runner-only cleanup debt
does not charge physical capacity or prevent matching demand from receiving new
capacity. Final release removes memberships and allocation identity without
decrementing capacity a second time.

Both production hosts write the same structured `WorkerEvent` facts: standalone
JSON on stderr, hosted API `Logger.log`/`warn`. Each includes binding/generation,
organization, installation/account, allocation, original Box/runner IDs, effect
and phases. `trigger` identifies the repository/run/job that requested capacity;
it is not an assertion that this Box executed that exact job.

| Event                         | Meaning                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `ci-worker-exited`            | Observed stopped/error and available exit code; clean exit 0 is informational |
| `ci-worker-box-absent`        | Original Box absence persisted; unexpected disappearance is a warning         |
| `ci-worker-recovery-deferred` | Cleanup/query failed; durable state remains retryable; error type only        |
| `ci-worker-released`          | Both original resources are absent; allocation record removed                 |

Logs contain no token, PEM, JIT configuration or upstream error message. Missing
exit codes remain unknown. These logs report infrastructure facts, do not cancel
a workflow and do not write to GitHub's job log or predict its final conclusion.
They are diagnostic output, not a durable audit stream: a crash after a state
commit can omit a line, while the journal still retains the recovery state.

`GitHubExecutionBackend` binds one original scope to the credential owner, job
reader, runner registry and host execution adapter. It rejects mismatched App
installations or PAT repositories before issuing credentials. Admission and
cleanup have separate host checks; each check also validates the current lease
and the known scope/allocation references by ID. This permits original-resource cleanup after admission is
revoked without permitting new runner registration or JIT delivery. Native hosts
must additionally fence Box persistence in their storage transaction. The backend
is an internal building block used by the standalone host. The API host uses the same backend.

`Listener` exposes `run(signal)` and `receive(verifiedNotification)`. It owns the
execution lease, renews it while GitHub/Box operations wait, pages active
allocations for recovery, and drives the shared worker pools. The
host supplies an authoritative scope directory, bound execution adapters and an
ingress transaction that checks the current binding. Receiving a notification
stores its receipt, observed phase and aggregate demand before waking the
scheduler; it needs no execution lease. Resource and scope task completion do
not gate the next demand read. Notifications grant no authority: actual
effects still check the original scope and host policy. Settlement uses the captured notice version, so a concurrent
delivery stays pending.

The job-driven fallback selects by platform tenant, then GitHub account, then job; a
large repository list earns no extra turns. Selection continues rotating across
tenants and accounts until it selects 32 candidates or exhausts the current input.
An account can supply multiple distinct candidates in one batch; a short batch
returns immediately without waiting to fill. Admission still checks each job's
capacity and recovery readiness separately; the Listener queues the resource
operations independently from subsequent job admission.
Capacity exhaustion retains the
notice and skips admission-time GitHub job reads while the durable account or
tenant quota is full. Independent compensation scans continue recording pending
jobs without reading or reserving capacity. Other tenants can still admit jobs;
the final reservation rechecks the same usage atomically.
A fallback recovery error blocks that scope's new admissions while other accounts
can proceed; corrupt shared journal state still blocks admission. Invalid discovered
scope definitions withhold that binding without restoring old authority or blocking
healthy bindings. Known
credential handles survive failed shutdown retirement, and another session cannot
start until retirement succeeds.

Idle ticks read local state rather than scanning every GitHub repository. The
default directory refresh and successful compensation interval is five minutes.
Independent lanes scan leased repositories with a 45-second deadline and record
discovered jobs durably before dispatch. Large inventories need multiple tasks;
the interval is not a guaranteed maximum recovery latency. Normal workflow-job
webhooks persist an exact job ID, so their admission does not wait for that scan.

`InstallationCatalog` enumerates a complete, bounded installation inventory using
a metadata-only token. Personal accounts receive one repository scope per eligible
repository. Organization accounts share a configured selected, non-inherited
runner group managed by BoxLite. Hosted scopes always permit installed Public
repositories and additionally permit Private repositories only with explicit
`allowPrivate` consent. Standalone retains its Public switch and permits Private
repositories independently. Both hosts authorize and journal each group write
before the catalog creates or synchronizes the configured group. Membership is
exactly the eligible installed set; public access is enabled only after membership
converges. Existing default or inherited groups cannot be adopted, and other group
names are untouched. The configured name is reserved for BoxLite to manage.

The catalog reads back policy and complete membership before publishing scopes.
Provider failures withhold admission and retry from actual GitHub state, including
after an uncertain create response. No eligible repositories clears an existing
group but does not create a missing one. Correct groups require no mutation.
Standalone intents use SQLite; hosted intents use the current binding generation,
owner authority, execution lease and existing PostgreSQL state. Callers without a
mutation-authority callback can inspect matching groups but cannot provision or
repair them. Lease checks cannot fence an already-dispatched GitHub request;
subsequent reconciliation repairs drift. Existing runner identities remain usable
for original cleanup; group access changes may affect queued or unassigned jobs.

`InstallationDirectory` runs complete installation-index reads and individual
catalog refreshes in one background slot per App. The scheduler keeps processing
known scopes while catalog requests wait. Successful installations publish
independently; a failed catalog withholds that installation's admission and keeps
its durable hints. An index failure withholds new admission until a complete
index succeeds. Failed reads never count as an empty inventory or a removal.

Cold installations with durable hints take priority over unhinted catalog work.
After at most three hinted catalogs, one due background catalog gets a turn;
selection within each category remains round-robin. When eligible catalog work
exists, repeated inventory events cannot schedule two index reads consecutively.
Retry deadlines apply before either priority, so new hints cannot bypass cooldowns.
These rules allocate the single directory slot; they do not guarantee wall-clock
latency or serialize requests made by execution adapters.

Refresh requests coalesce by installation. A captured wake UUID can be settled
only after its corresponding refresh; a newer delivery remains pending. Waiting
for a retry occupies no catalog slot. Retries start at one minute and increase
to five minutes, while a later GitHub retry deadline takes precedence. Periodic
index refreshes and repeated webhooks do not clear that deadline. Installation
indexes are bounded to 10,000 entries, and the combined admitted repository cache
is bounded to 100,000 repositories. These are protective limits, not throughput
or recovery-latency guarantees.

Standalone ingress checks the configured App root and the current complete
installation/account index inside each storage transaction. A matching signed
job may be stored before its repository catalog is ready. Hosted ingress applies
the same distinction using connected installation/account bindings and current
platform authority. Notification storage grants no worker capability: admission
still requires the original repository scope, actual GitHub job and labels, and
live authorization at the execution boundary.

An installation not yet discovered by the standalone host can request only
inventory work. Its endpoint returns a failure and stores no job receipt or
notice, so that request is not acknowledged as an accepted job. Compensation
may find the queued job later, or redelivery can submit it after discovery.
In hosted use, an unconnected job is rejected without inbox writes; the connect
transaction supplies the authoritative binding and inventory wake. App delivery
recovery can request replay after target authority becomes available. Bad signatures
and mismatched known account identities cannot enqueue inventory through this path.

See [the directory protocol](src/directory.ts), [the shared inbox](src/webhook.ts),
and [the scheduler](src/listener.ts) for the implementation.

Runtime recovery covers records created by this implementation. The Node standalone
entry and image build are available. Standalone App webhook execution and multi-job
artifact transfer have [live playground evidence](https://github.com/DefeatMan/boxlite-ci-playground/actions/runs/41820205537/attempts/1).
Live organization-group and deployed hosted API acceptance remain pending.

The native API adapter is implemented in `api/src/ci/ci-native-state.ts` and
`ci-native-workers.ts`. It uses the same PostgreSQL record table for original Box
IDs and delivery attempts. `BoxService` persists the Box and its ledger atomically;
the callback rechecks the execution lease and original binding/owner before commit.
Cleanup retains the original resource identity after binding removal. Closing
allocations cannot create or receive JIT. Every JIT HTTP request checks authority
again after asynchronous Box lookup, and a durable delivery claim prevents replay.
`ci-native-host.ts` builds scopes from stored connect bindings, retaining their
original platform organization and actor. Its shared inbox checks the live binding
and owner inside every ingress read/write transaction. GitHub credentials reuse
`CiGitHubService.appSource()` and the same configured private App key as connect.
These adapters are registered as the API's runtime providers. `CiListenerService`
starts the shared controller when the platform App is configured; all replicas use
one PostgreSQL lease, with no CI state volume or worker execution API Key.

## Architecture and authentication

These diagrams describe the current code, rather than deployed acceptance.
Each host instantiates the shared controller with its own adapters.

```mermaid
flowchart TB
  GitHub[GitHub App and Actions]
  CLI[boxlite ci connect]
  subgraph Cloud[Hosted API process]
    Connect[Connect and existing BoxLite authentication]
    NativeHost[CiNativeHost and native execution adapters]
    HostedCore[Shared TypeScript Listener]
    NativeBoxes[Internal BoxService]
    PG[(Existing PostgreSQL)]
    Connect -->|binding and inventory wake in one transaction| PG
    NativeHost --- HostedCore
    HostedCore -->|state, inbox, lease and allocation journal| PG
    NativeHost -->|stored organization and actor| NativeBoxes
  end
  subgraph Standalone[Self-deployed Listener Box]
    NodeHost[Node host and REST execution adapters]
    SelfCore[Shared TypeScript Listener]
    SQLite[(Persistent private SQLite directory)]
    NodeHost --- SelfCore
    SelfCore -->|state, inbox, lease and allocation journal| SQLite
  end
  CLI --> Connect
  GitHub -->|signed webhook| NativeHost
  GitHub -->|signed webhook with an App| NodeHost
  NativeHost -->|App API credentials| GitHub
  NodeHost -->|App API credentials or single-repository PAT| GitHub
  NativeBoxes --> Worker[Ephemeral CI Box with official GitHub runner]
  NodeHost -->|BoxLite REST API with own API Key| REST[BoxLite API]
  REST --> Worker
  Worker <-->|job steps, logs and results| GitHub
```

The hosted service uses the connected binding's original organization and actor;
it does not retain a user's API Key for worker execution. Self-deployment uses
its own BoxLite API Key. The App private key and webhook secret belong to the
host. Worker Boxes receive only their JIT configuration from the Listener.

Sources: [native host](../../api/src/ci/ci-native-host.ts),
[native workers](../../api/src/ci/ci-native-workers.ts),
[standalone host](../../github-ci-runner/src/self-host.ts), and
[standalone workers](../../github-ci-runner/src/boxlite-workers.ts).

### Hosted connect

```mermaid
sequenceDiagram
  actor User
  participant CLI as BoxLite CLI
  participant API as Hosted connect API
  participant GitHub
  participant PG as PostgreSQL
  participant Listener as Shared Listener
  User->>CLI: ci connect ACCOUNT
  CLI->>API: Start with existing BoxLite authentication
  API->>PG: Check current BoxLite owner or admin authority
  API->>GitHub: Start App device authorization with client ID
  GitHub-->>API: Device code, user code and verification URL
  API->>PG: Store encrypted device code and attempt deadline
  API-->>CLI: Show verification URL and user code
  User->>GitHub: Sign in and approve device authorization
  loop Until authorized, failed or expired
    CLI->>API: Poll the original connect attempt
    API->>GitHub: Poll device authorization
  end
  API->>GitHub: Verify user authority over the target account
  API->>GitHub: Verify this App's installation and account identity
  Note over API,PG: One transaction and conflicting installation ownership is rejected
  API->>PG: Recheck current BoxLite authority and save binding
  API->>PG: Persist installation inventory wake
  API->>PG: Final clock-time checks, mark done and commit
  API-->>CLI: connected
  Listener->>PG: Read committed inventory wake on a scheduler cycle
  Listener->>GitHub: Discover eligible repositories and runner scopes
  Listener->>PG: Persist scopes and mark binding ready
  Note over CLI,Listener: connected is saved identity and ready is initialized catalog, not available capacity
```

Sources: [connect service](../../api/src/ci/ci-connect.service.ts),
[GitHub account verification](../../api/src/ci/ci-github.service.ts),
[inventory wake](../../api/src/ci/ci-native-state.ts), and
[controller cycle](src/listener.ts).

### GitHub credentials

```mermaid
sequenceDiagram
  participant Host as Hosted API or standalone Box
  participant Credentials as ListenerCredentials
  participant State as PostgreSQL or SQLite
  participant GitHub
  Host->>Credentials: Borrow credentials for one purpose
  Credentials->>State: Persist issuance intent and original scope
  alt GitHub App
    Credentials->>Host: Read App private key
    Host->>Host: Sign RS256 App JWT with five-minute expiry
    Host->>GitHub: Verify installation using App JWT
    Host->>GitHub: Issue installation token with purpose-specific permissions
    GitHub-->>Credentials: Token, granted scope and expires_at
    Credentials->>Credentials: Validate grant and limit local use window
    Credentials->>GitHub: Perform scoped metadata, job or runner request
    Credentials->>GitHub: Revoke installation token when borrow closes
    Credentials->>State: Complete retirement after revocation succeeds
    Note over Credentials,GitHub: The next operation issues a fresh purpose-scoped token
  else Self-deployed single-repository PAT
    Host-->>Credentials: Configured repository token
    Credentials->>GitHub: Perform allowed request for the pinned repository
    Credentials->>Credentials: Close local handle without revoking the user's PAT
  end
  Note over Host,State: State contains issuance metadata, not token values or private keys
```

Sources: [credential owner](src/credentials.ts),
[App tokens](src/github-app.ts), and [JWT signer](src/github.ts).
The webhook HMAC secret is independent from these API credentials.

### App delivery recovery

This is the working-tree recovery path. Hosted deployment acceptance remains
separate; replay metadata is not a CI result or an execution grant.

```mermaid
sequenceDiagram
  participant Host as Listener host and shared recovery
  participant State as PostgreSQL or SQLite
  participant GitHub
  participant Ingress as Existing signed webhook
  Host->>State: Verify original App root and current lease
  Host->>GitHub: GET App delivery page with App JWT
  GitHub-->>Host: Exact IDs, GUIDs, outcomes and next cursor
  Host->>State: Persist GUID records before advancing checkpoint
  Host->>Host: Select due pending GUID and check target authority
  alt Unconnected, revoked or suspended
    Host->>State: Preserve pending item and defer retry
  else Eligible target
    Host->>Host: Recheck authority immediately before mutation
    Host->>State: Persist intent UUID and retry deadline
    Host->>GitHub: POST delivery attempts with App JWT
    GitHub-->>Host: 202 request accepted
    GitHub->>Ingress: Original signed webhook with the same GUID
    Ingress->>Ingress: Verify raw HMAC and event structure
    Ingress->>State: Authorize binding and atomically store applicable inbox work
    Ingress-->>GitHub: 2xx accepted or legitimately ignored
    Host->>State: Look for a matching durable receipt
    opt No local receipt
      Host->>GitHub: Read a later delivery page
      GitHub-->>Host: Observe successful delivery for the GUID
    end
    Host->>State: Stop transport retries, retain outcome until expiry
  end
  Note over Host,State: Replay never settles a job notice or releases worker quota
```

Sources: [recovery controller](src/replay/recovery.ts),
[standalone authority](../../github-ci-runner/src/self-host.ts),
[native authority](../../api/src/ci/ci-native-host.ts), and
[signature verification and inbox](src/webhook.ts).

### One CI job from notification to cleanup

```mermaid
sequenceDiagram
  participant GitHub as GitHub Actions and App API
  participant Ingress as Host webhook endpoint
  participant State as PostgreSQL or SQLite
  participant Listener as Shared Listener
  participant Verifier as Run verification queue
  participant Boxes as Native BoxService or BoxLite REST API
  participant Runner as Official runner in CI Box
  GitHub->>GitHub: Commit, PR or release queues a matching workflow job
  GitHub->>Ingress: workflow_job queued, raw body and HMAC signature
  Ingress->>Ingress: Verify signature, delivery UUID and supported job hint
  Ingress->>State: Check host authority and atomically persist receipt, notice and wake
  State-->>Ingress: Commit succeeds, or identical delivery is already stored
  Ingress-->>GitHub: Success response after durable acceptance
  Note over Ingress,State: Invalid signature is rejected and failed persistence does not acknowledge acceptance
  Listener->>State: Acquire or renew execution lease and recover existing allocations
  Listener->>State: Read pending job notice and original scope
  opt Repository scope is not ready yet
    Listener->>GitHub: Refresh the installation catalog in the background
    Listener->>State: Publish successful scopes and settle only captured wake versions
  end
  Listener-->>Verifier: Fairly enqueue by scope, repository and run; continue pumping
  Verifier->>GitHub: Fetch actual jobs with scoped Actions-read credential
  GitHub-->>Verifier: Original IDs, status, assignment and complete labels
  Verifier->>State: Merge effective facts and retain versioned positive evidence
  Verifier-->>Listener: Wake capacity planning as each run completes
  Listener->>GitHub: Read current compatible runner supply
  Listener->>State: Reserve quota and journal Box-create intent
  Listener->>Boxes: Create worker with official runner image and waiting bootstrap
  Boxes-->>Listener: Original Box ID
  Listener->>State: Persist known original Box identity
  Note over State,Boxes: Native persistence is atomic and uncertain REST creates retain quota and are not repeated
  Listener->>Boxes: Observe original Box running
  Listener->>State: Journal runner-registration intent
  Listener->>GitHub: Generate JIT configuration for original repository or organization group
  GitHub-->>Listener: Runner ID and private JIT configuration
  Listener->>State: Save runner ID and one-shot delivery intent
  Listener->>Boxes: Write private JIT content, recheck authority, then write ready marker
  Boxes-->>Listener: Confirm file operations
  Listener->>State: Record delivery completion without storing JIT content
  Runner->>Runner: Read JIT into environment, remove files and exec run.sh
  Runner->>GitHub: Authenticate using its JIT runner identity
  GitHub-->>Runner: Assign an authorized matching job and its steps
  Note over GitHub,Runner: Demand does not reserve an exclusive job-to-Box assignment
  Runner->>Runner: Execute workflow steps
  Runner->>GitHub: Stream logs and report job result
  GitHub->>GitHub: Publish job conclusion in Actions
  Runner->>Runner: Ephemeral runner exits after its job
  Boxes-->>Listener: Original Box observed stopped
  Listener->>State: Journal original-resource cleanup intents
  Listener->>Boxes: Delete known original stopped Box and confirm absence
  Listener->>State: Return physical Box capacity, retain original runner cleanup debt
  Listener->>GitHub: Confirm or remove original runner and confirm absence
  Listener->>State: Remove allocation after both resources are absent
  Note over Listener,State: Completion webhooks alone do not stop a Box or release quota
```

The host returns HTTP 204 for hosted webhook acceptance and HTTP 202 for the
standalone endpoint. When a delivery never reaches durable acceptance,
App-wide delivery recovery can request a signed replay; bounded REST compensation
can also discover pending jobs later through independent, leased repository tasks.
Each replica has two scan lanes; installations are serialized across replicas.
There is no fixed recovery-latency guarantee.

Sources: [webhook verification and inbox](src/webhook.ts),
[controller](src/listener.ts), [worker pool and bootstrap](src/execution/pool.ts),
[allocation journal](src/execution/journal.ts), and
[JIT registration](src/runners.ts).
The runner's GitHub connection is described in GitHub's
[self-hosted runner documentation](https://docs.github.com/en/actions/reference/runners/self-hosted-runners#communication).

## Build and test

Build and test from the repository root:

```sh
make build:apps:ci-listener
make test:apps:ci-listener
```

Run under Node 24. SQLite tests always run. PostgreSQL contracts follow other API
tests: set `DB_HOST`, `DB_PORT` (default 5432), `DB_USERNAME`, `DB_PASSWORD` and
`DB_DATABASE` for the existing local test database. With `DB_HOST` unset, only
the PostgreSQL suites skip. Tests create and drop isolated schemas and reject
remote hosts. `FILTER` selects test names as on other Make
test targets. These checks do not establish real hosted or standalone CI acceptance.
When changing the optional PostgreSQL environment, use `NX_SKIP_NX_CACHE=true`
to execute the contracts rather than reuse a cached run from a different environment.

Workspace hosts import the shared pool from `@boxlite-ai/ci-listener`; SQLite uses
the separate `@boxlite-ai/ci-listener/sqlite` path, keeping its Node-only adapter out
of the hosted entry. Cross-project test fixtures use the scoped `/testing` alias.
Standalone shutdown attempts every owned resource and reports combined cleanup
failures; extracting that cleanup operation preserves failure precedence.
Cursor and label validators retain their existing ASCII-control rejection ranges.

Compensation scans can race a verified webhook inserting the same queued notice.
On an insertion conflict, the Listener rereads that notice and accepts it only if
installation, account, repository and run still match; identity conflicts remain
errors. This keeps ordinary duplicate delivery from aborting the cleanup cycle.

## Interactive repository metadata

`InstallationRepositoryReader` owns metadata-only credentials for bounded UI page
reads. Unlike execution controllers, it reserves in-memory ownership before
issuance, independent of scheduler leases and worker capacity. Its 32-slot bound
includes in-flight issuance and failed retirement. A returned invalid handle is
still revoked; cancellation cannot skip finally cleanup. Uncertain issuance waits
60 seconds before another attempt for that installation. Failed retirement is
retained for retry and shutdown, and only verified expiry permits forgetting a
known handle. Shutdown refuses new reads and drains late issuance before retirement.

Scopes carry explicit Public and Private decisions. Standalone configuration keeps
its Public switch and always permits Private, while hosted policy always permits
Public and requires explicit Private consent. Existing scope hashes are incompatible:
finish cleanup with the old Listener and start a fresh journal before upgrading.
