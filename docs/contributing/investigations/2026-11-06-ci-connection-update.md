## TL;DR

Add Registries-style UPDATE for a CI connection's public-repository policy without deleting its binding or stopping a running job.

## Problem and scope

Connects currently offers only connect and delete. A saved active binding rejects a different policy during another connect attempt.
Update must preserve its verified GitHub identity, binding ID, original actor, shared quota and existing worker records.
Use current React/Nest/PostgreSQL; add no dependencies, schema, background process or deployment.

## Approach

Add PATCH /api/v1/{prefix}/ci/connections/{bindingId}, also the authenticated-organization form.
Accept only a required boolean `allow_public_repositories`; reject unknown identity, generation or policy fields.
Use the same current-owner and delegated Box write/delete checks as existing CI settings.
Lock authority rows, then the organization/App-scoped binding FOR UPDATE. Unknown or foreign IDs return 404; disabled bindings return 409.
A changed boolean advances generation once, sets provisioning and writes the existing durable installation inventory wake in the same transaction. A repeated same-value update is a no-op returning 204.
Recheck delegated key expiry before commit. Do not cancel connect attempts, change original actor, modify quota, delete scopes, stop Boxes, or call GitHub mutation APIs.
The listener discovers the changed generation and verifies the existing GitHub installation and runner-group restrictions before readiness.
Organization runner-group public access must still match the selected policy; the UI must explain the GitHub-side prerequisite.

Generation fencing prevents new creation/JIT operations under the previous policy. A previously admitted external effect may finish before commit.
Already delivered JIT jobs continue running: WorkerPool recovery queries existing Boxes without new admission; cleanup retains original durable identity.
Workers that have not received JIT may be retired on fresh admission denial. This is not a promise of zero interruption for all startup phases.
No new demand may use a stale allow-public catalog. Existing backend generation and policy comparisons remain strict.

Each connection row gets the same `AsciiButton size=sm`, uppercase Update, and adjacent trash layout as Registries.
The dialog fixes account/type identity and edits only public-repository permission.
Capture the original organization, prevent duplicate writes, retain failed edits, and refresh only its settings after acknowledgment.
No Refresh button or polling is added to Connects.

## Options and sources

| Option | Decision | Reason |
| --- | --- | --- |
| Delete and reconnect | Reject | Removes admission authority and is unnecessary for a policy edit. |
| Patch without changing generation | Reject | Discovery caches need an explicit revision; original scopes also pin policy. |
| Patch policy and increment generation | Adopt | Reuses native admission fencing and historical cleanup identities. |
| Stop/restart all workers | Reject | Delivered jobs need no new admission to continue. |

Read before implementation: RegistriesPanel Update action and dialog; ci-native-state.ts admit; ci-native-host.ts index/catalog; InstallationCatalog group policy checks; WorkerPool reconcile after delivery; ci-settings.service.ts authority/expiry handling.
[RFC 5789 PATCH](https://www.rfc-editor.org/rfc/rfc5789#section-2) supports partial resource modification.
[TanStack Query v5 invalidation](https://tanstack.com/query/v5/docs/framework/react/guides/invalidations-from-mutations) supports scoped refetch after mutation.

## Validation plan

Real PostgreSQL: owner update/no-op, immutable binding/actor/attempt/quota/worker identities, other tenant, disabled binding, revoked owner/key and rollback on expiry.
Boundary tests: an admission lock serializes before update; old generation fails afterward.
Actual native Box/HTTP and WorkerPool: delivered running jobs are not stopped by update, and original cleanup still works afterward.
HTTP tests: UUID/strict boolean DTO/scopes/owner/aliases, no service call for invalid input.
UI tests: open/cancel/prepopulated policy/save/error/double submission and organization switch; API client sends only boolean to original organization/binding.
Make tests/build/format plus local browser inspection of UPDATE placement and policy changes.

## Research log

Known items: RFC PATCH, Query v5 invalidation, local Registries, strict CI generation fencing and existing original-resource cleanup.
Date 2026-11-06; web search/open, one exact query per source:
- arXiv: `site:arxiv.org updating authorization policy in flight requests revocation`.
- OpenAlex: `site:openalex.org authorization policy update revocation in flight`.
- GitHub engine: `site:github.com policy update existing running jobs configuration change`.
- npm engine: `site:npmjs.com tanstack react query mutation invalidation`.
No paper or extra project established a better local solution; none is asserted as qualified SOTA.
Official RFC/Query originals and actual source were checked. Existing installed APIs are reused without upgrades.
Stop: the round added no alternative that changed the generation/cleanup decision. Validation above is planned, not yet claimed passed.

Research follow-up: [When Does Authorization End?](https://arxiv.org/abs/2609.02866), submitted September 2026, distinguishes an acknowledged policy change from the completion of previously authorized effects.
Adopt that boundary distinction in the contract above; retain native admission locks and operation ledgers rather than introduce its analysis framework.
The [Kubernetes CronJob source](https://github.com/kubernetes/website/blob/main/content/en/docs/concepts/workloads/controllers/cron-jobs.md) was opened as an exploratory example of applying configuration to future jobs; it is not asserted as a qualified project SOTA choice.

## Independent design review

Auditor: PASS, with delivered-worker continuity, cleanup, admission ordering, strict input and expiry checks required.
Advisor: no blocker; same-value updates must still recheck key expiry, preserve checkbox state on failure and keep original-organization invalidation.
The Organization runner-group prerequisite belongs only on Organization dialogs. The startup caveat remains explicit.

## Observed validation

Implementation and checks are in `feat/ci-gh-runner-rebase-main-20261105`, based on `5ee36c315e04f9ce5bf84ae05e3ef95cd086ac71`.
CI API: 261 tests in 11 suites passed, including PostgreSQL scope/expiry/lock/no-op checks and actual native Box/JIT/WorkerPool continuity plus original cleanup.
Dashboard: 810 tests in 101 files passed, including update confirmation, retained errors, duplicate suppression and organization switching.
API and Dashboard builds and `git diff --check` passed.
The local mock browser check changed the same connection row from Excluded to Allowed, retained the account, and measured its uppercase UPDATE at 28px high with the existing 12px IBM Plex Mono styling.
The existing durable inventory wake is written only for a policy change, alongside generation/provisioning, and the same-value path preserves its version.
These checks establish local implementation behavior, not deployed hosted acceptance. No deployment was initiated.
