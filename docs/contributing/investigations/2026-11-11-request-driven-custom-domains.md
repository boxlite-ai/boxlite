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
No publication or cloud deployment is part of this change; other API timers remain unchanged.
The capacity and toolbar amendment below removes the custom-domain minimum instance requirement while retaining its continuous CPU allocation.

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

### Capacity and toolbar amendment

Custom-domain configuration no longer sets a revision minimum of one; retain `cpuIdle: false` for existing instances.
The separate CI service-level minimum remains conditional on CI configuration.
This follows the independent [minimum-instance](https://docs.cloud.google.com/run/docs/configuring/min-instances) and
[CPU allocation](https://docs.cloud.google.com/run/docs/configuring/billing-settings) controls; it does not guarantee API timers run with zero instances.
Removing the domain-specific minimum is preferred over forcing all services to zero because CI retains its own capacity contract.

Reuse the All domains toolbar's muted monospace allowance display: `0 / 1 custom domains` or `1 / 1 custom domains`.
Count live configurations, including drafts; exclude `superseded` records, which the API retains for inspection after releasing their quota slot.
Do not show a fabricated zero while the list is loading or unavailable.
Remove the unavailable-subscription banner, quota explanation footer and empty-state description; retain the concise subscription-required notice and existing action authorization.
The add dialog also omits DNS instructions, apex/wildcard prose and repeated quota guidance; hostname validation and action errors are unchanged.
Setup dialogs omit the ownership-transfer explanation, provider issuance estimate and polling schedule explanation; the underlying ownership and advancement rules remain unchanged.
The counter replaces the existing toolbar explanation without adding a heading, component, dependency, or API field.

Validate resource arguments with domains enabled/disabled and CI enabled; CPU remains allocated while the domain-specific minimum disappears.
Validate empty, draft, ready and superseded allowance counts, absent removed copy, and unchanged subscription action restrictions.
Observe the assertions fail against the unchanged production code before implementing the amendment.

The baseline failed six Dashboard assertions and four deployment assertions with only test files changed.
After implementation, all 1,125 Dashboard tests and 525 deployment tests pass through the repository make targets.
Desktop empty/occupied states and a 390px-wide preview confirm the concise counter and removed copy without horizontal overflow.
Cloud configuration removal remains unverified until a subsequent deployment; this amendment makes no cloud changes.

`Get DNS configuration → prepare authorization → show three records → Confirm DNS → verify → claim → submit → advance certificate/map/TLS → ready`.

Preparation reserves one organization slot and stable challenge/IDs, but performs no DNS query or certificate creation.
Google authorization creation is itself asynchronous: bounded prepare requests may resume it before showing all three records together.
Opening an unconfirmed draft never initiates cloud work; the user can explicitly resume preparation.

Verification checks TXT, traffic CNAME/address and authorization CNAME, reporting record-specific errors and distinguishing unavailable queries.
Before cloud submission, persist confirmation, successful DNS checks, hostname ownership and submission intent.
Only an accepted operation or verified existing certificate, followed by a successful database save, permits the submitted message.
Unknown submission outcomes remain distinguishable and are recovered by reading deterministic resources before retrying.

Each invocation has a 25-second external-work budget, two-second workflow SQL statement limits, and cancellation propagated to DNS/TLS/cloud calls; it does not wait for issuance or continue after returning.
The page performs setup operations only on explicit clicks; list-only status reads follow the minute refresh amendment below.
Google issuance continues without API CPU; map creation and TLS readiness resume on an advance request or the next eligible API task round.

### Manual verification result amendment

The current dialog discards the verify response and starts timed advancement after confirmation, leaving the user without a final verification outcome.
Reuse the existing typed response and notification system; HTTP 202 alone cannot establish DNS success because workflow failures also return a configuration.
Cache the returned configuration directly, avoiding a list refresh overwriting the result with stale data.
While verifying, disable overlapping actions and dismissal; after persisted confirmation, notify the user and close the dialog.
Accepted certificate requests, unknown submission outcomes and requests not submitted receive different notifications; none implies HTTPS readiness.
Unconfirmed responses retain the three records and record errors for a manual retry; lease/backoff responses without an error remain explicitly pending.
Transport failures retain the dialog and show the request error without retrying automatically.
Remove the dialog timer, visibility tracking and preparation polling state; keep explicit preparation and DNS verification buttons.
Server startup/minute advancement, ownership checks, subscription controls and binding readiness remain unchanged.

Example: a missing authorization CNAME keeps the records open; correcting it and clicking verify again closes the dialog only after confirmation.
Tests cover delayed responses, DNS rejection followed by manual retry, unknown/unsubmitted certificates, transport errors and absence of timed requests.
The existing polling test is replaced because removing automatic advancement is an intentional contract change; result handling receives pre-fix failing coverage.
Observed baseline failures cover result dismissal, returned DNS errors, uncertain submission feedback and timed advancement/preparation.
A separate regression reproduces a completed verification waiting on an unrelated held-domain refresh; that refresh no longer blocks feedback.
After implementation, all 1,132 Dashboard tests pass and the production build succeeds through the repository make targets.
A browser run with mocked API responses confirms failure retains the records and a second explicit verification closes the dialog with a success notification.
These checks do not exercise live DNS or GCP issuance.

### Quiet minute status refresh amendment

The Custom domains list now needs current status while server-side setup proceeds after the dialog closes.
Reuse React Query's conditional 60-second refetch interval for the existing read-only list endpoint; do not call prepare, verify or advance automatically.
Enable the interval while the list has an incomplete, non-superseded configuration; an open dialog permits reads after DNS confirmation.
Stop when every configuration is ready or superseded, the list is empty, or custom domains are disabled; leaving the tab unmounts the list.
Pause new interval reads in hidden browser tabs, unconfirmed setup dialogs and pending mutations; explicit mutations cancel list reads before writing.
On returning to a visible tab or reconnecting, immediately read eligible incomplete setup even if its cached data is considered fresh.
Keep cached rows during a refresh or refresh failure, without a spinner, toast or refresh-error banner; initial-load failures retain Retry. Disable automatic request retries so a failed status read waits for the next minute tick.
React Query structural sharing and stable row keys retain the page and update changed status text without a reload.
The completion boundary is `ready`, independent of Box binding or subscription-dependent display labels (`Ready` versus `Setup completed`).
Tests will check the minute boundary, status-only DOM updates, failed reads retaining rows, terminal-state stopping, dialog pause and absence of automatic setup writes.
This intentionally replaces the previous no-list-polling contract; server work and explicit verification behavior are unchanged.
The unchanged implementation failed four minute-read assertions before the interval was added.
After implementation, all 1,139 Dashboard tests and the production build pass; tests retain the same row and toolbar DOM nodes while status changes.

### HTTPS detail refresh recovery

Opening a confirmed domain previously disabled its interval, so clicking Continue HTTPS setup once and remaining in the dialog left its status stale indefinitely.
Hidden-tab reads also paused without a catch-up read on return, leaving another minute of stale status possible.
Reuse the same eligibility predicate for the minute interval and focus/reconnect reads; only read state, never automatically invoke advance.
Track organization-scoped pending mutations with the existing React Query mutation cache so reads cannot restart during verification or other writes.
The server advance operation retains bounded, leased semantics; the Dashboard exposes it only for explicit failure retry after the amendments below.
Regression coverage must show an open confirmed dialog reaching success or failure, a fresh cached pending result updating on focus, and no interval reads during an outstanding mutation.
Browser validation repeats both complete mock flows, clicks Continue HTTPS setup before completion and leaves the details open through the two-minute outcome.
Five regression assertions fail against the prior implementation because expected status reads never occur.
The updated implementation passes all 1,143 Dashboard tests and the production build through make targets.
Browser tests run through a standalone make target: list outcomes appear after 120 seconds and open-detail outcomes after 121 seconds for both success and failure.
These local simulations verify UI updates, not live cloud issuance; the separately reported indefinitely stale visible list was not reproduced.

### Read-only HTTPS progress

After DNS confirmation, reopening a domain should show progress without asking the user to continue HTTPS setup again.
Remove the normal HTTPS continuation button; the API startup/minute task owns continued certificate and mapping work, with explicit retry after errors as described below.
Opening a confirmed, incomplete configuration performs one read-only list refresh, then retains the existing quiet interval and focus recovery.
Unconfirmed drafts still allow preparation and explicit DNS verification, including retries after a failed check.
Ready domains still allow Box binding; delete and unbind remain independent management operations.
Remove wording that instructs users to press a continuation action; failed HTTPS setup uses provider-neutral recovery guidance.
Tests cover accepted, unknown and unsubmitted healthy states without continuation controls, explicit failure retry, fresh state on reopen, and unchanged DNS retry and Ready binding.
This intentionally changes the UI contract; the server advance endpoint and SDK compatibility remain unchanged.
The prior implementation failed nine assertions covering continuation controls, fresh reads on reopening and removed-action wording.
After implementation, all 1,148 Dashboard tests and the production build pass through make targets.
The local browser preview test also runs through make and confirms both successful verification and failure-then-retry reopen with progress but no HTTPS continuation button.

### DNS preparation without an intermediate screen

The create response may contain a saved draft without DNS records; selecting it currently opens an empty management screen with a second continuation action.
Keep the hostname form until all three records are available, then display the existing DNS configuration directly.
For example, Get DNS configuration keeps loading through incomplete responses and opens the three records once preparation finishes.

Reuse the existing create/prepare endpoints and React Query mutation state; no new server workflow or dependency is needed.
The installed mutation implementation awaits its callbacks, so avoid awaiting an unrelated list refresh before displaying the operation result.
Cache the returned draft directly, appending new IDs and replacing existing IDs; cancel outstanding list reads before either preparation operation.
Create is explicit; incomplete responses schedule serial prepare requests with the same ID and locked hostname, respecting retryAfter with a three-second minimum.
The loading state covers both requests and their intervening delays. Leaving the page or changing organization cancels scheduled requests.
Opening an incomplete draft only displays this form and never creates resources or starts preparation automatically.

| Option | Outcome | Decision |
| --- | --- | --- |
| Keep the management screen | Requires the redundant continuation step | Reject |
| Require explicit retry for incomplete responses | Interrupts the requested continuous loading flow | Reject |
| Continue preparation after an explicit click | Keeps loading until records arrive, preserving bounded requests and draft identity | Pick |

While requesting, disable submission, hostname editing and dismissal.
An incomplete response keeps Get DNS configuration loading without a retry message; provider or transport failure stops loading and permits retry.
An incomplete response with dns_configuration_pending remains a waiting state, not a preparation failure.
Saved incomplete drafts retain deletion, including the existing confirmation, so they cannot strand the organization quota.
Deletion confirmation also blocks form submission by Enter.
If the first create response is lost before its ID arrives, retrying the same hostname uses the existing server-side create deduplication.
Confirmed, Ready and superseded domains retain their existing management behavior.
Remove the sentence “DNS is not checked until you confirm.” without changing when DNS verification runs.

Earlier regression checks cover complete responses with stale list data, pending requests, incomplete/failed drafts, retry without duplicate creation, deletion, subscription restrictions and ordinary browsing without writes.
Continuous preparation changes the earlier explicit-retry contract; its tests are not updated or run for this change at the user's request.
The existing tests that require Continue getting DNS configuration are superseded by the hostname-form contract.
Preparation does not promise immediate DNS records after a timeout and never treats an incomplete response as ready for verification.

### HTTPS failure retry

After DNS confirmation, an incomplete configuration with an error offers Retry and a support@boxlite.ai contact link beneath its error message.
Healthy pending setup stays read-only; Ready, superseded and unconfirmed configurations retain their existing actions.
Replace provider-specific certificate failure and renewal messages with HTTPS terminology; retain exact provider-issued DNS record values because users must configure them.
Retry calls the existing advance endpoint once and reuses the saved configuration; subscription permissions, leases, backoff and certificate replacement limits remain enforced by the API.
Disable the action while pending and retain the dialog; show returned progress without claiming HTTPS is ready unless the response says ready.
An error still present after a request may reflect a retry delay, so describe it as still needing attention, not proof that a new certificate attempt occurred.
If an error remains or the request itself fails, keep Retry and the support contact available; a healthy pending result removes Retry.
The primary status paragraph must not say HTTPS is proceeding normally when a confirmed setup error is present.
Tests cover absent vendor names, support contact, pending/failed/ready retry results, transport failure, duplicate-click prevention and subscription restrictions.

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

### Dashboard presentation

Use the current console's shared square buttons, neutral surfaces, segmented tabs and fixed-header/footer form dialog.
The Domains page keeps one primary title and switches between All domains and Custom domains; the all-domain list still includes every held hostname.
Custom setup shows a compact status row, the three DNS records together and one stage-appropriate primary action.
Detailed DNS help, issuance timing and certificate observations remain available through disclosure controls rather than repeated section headings.
Ready domains focus on Box binding; their retained DNS records remain accessible for renewal and troubleshooting.
The single-domain limit, subscription restrictions, exact DNS copies, uncertain submission state and explicit delete confirmation remain visible or actionable at the relevant stage.

`Domains → Custom domains → hostname + status → DNS records / current step → verify or bind`.

Reuse `ResourceLayout`, `AsciiButton`, `Input`, `Tabs` and `FormDialog` from the current Dashboard; avoid a separate visual system or new dependencies.
The reference implementations are `Domains.tsx`, `ImagesPage.tsx`, `Volumes.tsx` and the shared dialog primitives.
Preserve explicit mutations and confirmation boundaries; tab selection and help expansion only navigate or disclose content.
Validate navigation, exact copy feedback, verification/submission states, permission restrictions and binding/deletion with page tests, then inspect light/dark and narrow layouts locally.
This is an intentional presentation contract change, not a claim of a newly reproduced backend defect.

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

After rebasing onto main `27f47f9f0`, Dashboard presentation checks pass with 114 files and 1,117 tests; API domain/preview/configuration checks pass with 16 suites and 299 tests.
The deployment suite passes 523 tests, including CI capacity and the existing Cloud Run single-port object contract; API and Dashboard production builds pass.
Local browser checks with synthetic domain responses cover light/dark themes, creation, DNS records and Ready binding, including a 390-pixel viewport without horizontal overflow.
Full workspace lint still reports three module-boundary errors in the unchanged `apps/infra/deployment/release-audit-workflow.test.ts` imports on lines 10–12; this unrelated finding remains unresolved.
