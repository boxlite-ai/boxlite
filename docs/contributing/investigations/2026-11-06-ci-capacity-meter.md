## TL;DR

Show CI slot occupancy beside its effective limit on Runners, and move the existing owner capacity editor out of Connects.

## Presentation update

Runners now follows Images’ compact inline usage summary: `CI slots used / limit`
beside the filter. The segmented meter and enclosing panel are removed; unlimited,
paused, quota coloring and owner editing retain their existing behavior.
The meter-specific presentation below records the original design.

## Problem

The current local CI implementation has a JIT Box inventory, but no capacity meter. Its capacity editor remains in Connects.
Users need occupancy and configuration beside the workers consuming that capacity.

## Scope and approach

Reuse Images' `Panel` and `SegmentedBar`, current React Query/socket invalidation, and the existing PATCH CI settings contract.
Do not add dependencies, migrations, scheduler writes, or deployment work.

Extend GET CI runners with a `capacity` object containing availability, occupied slots, configured maximum, Commerce ceiling and effective limit.
Read-only members use the existing organization resource guard; no installation identities or OAuth state are returned.
The owner-only settings write and delegated key checks stay unchanged.

Count durable active worker allocations for the original organization and hosted namespace, excluding confirmed Box absence.
Use the catalog and scope active references; include reserved/no-Box, requested creation and known/cleanup allocations.
This follows ExecutionJournal.load's worker filter, rather than table pagination or Box row count.
A stopped Box still occupies a slot until cleanup proves absence; runner-registration cleanup debt after Box absence does not.
Read counts and policy in a read-only repeatable-read transaction without acquiring or extending the execution leader lease.
Validate catalog/scope/active references with existing scope and allocation decoders; broken references are errors, not zero usage.
Retain ten-second refresh for stable workers, three-second refresh during transitions and five-second retry/socket-loss fallback, because journal-only changes emit no Box event.
Validate root/quota state and fail on provider/database failures rather than displaying a fabricated unlimited limit.

Place the meter directly above the Runners table. Finite positive limits use meter semantics, bounded segments and actual numeric labels.
If usage exceeds a lowered cap, clamp the visual/ARIA numeric range but retain the actual count in text.
Zero says Paused and preserves occupied count; null says Unlimited without implying a percentage.
The owner Edit text action opens the existing capacity dialog, with blank meaning inheritance and zero pausing admissions.
Capture organization per mounted panel, suppress duplicate saves, keep errors in the dialog, and invalidate only the original organization's runner/settings queries.
Remove the old capacity dialog, button and quota footer from Connects.

## Options and sources

| Option | Decision | Evidence and reason |
| --- | --- | --- |
| Reuse Images segmentation and current dialog | Adopt | ImageCatalog.tsx:142 and ascii.tsx SegmentedBar match the requested style without dependencies. |
| Count table rows or inventory total | Reject | ExecutionJournal.load excludes absent Boxes and counts reservation intents before Box persistence. |
| Add a new meter framework | Reject | Existing primitives and WAI meter semantics cover this bounded gauge. |
| Treat usage as task completion | Reject | WAI distinguishes scalar measurements from progress. |

Sources inspected before implementation: apps/libs/ci-listener/src/execution/journal.ts:33-88; ci-settings.service.ts existing policy decoding and account effective-limit logic; ci-management.controller.ts read/write guards; Images' quota panel; existing capacity dialog and tests.
[WAI meter semantics](https://www.w3.org/WAI/ARIA/apg/patterns/meter/#wai-ariaroles,states,andproperties) support an accessible scalar value and separate text.
[TanStack Query v5 mutation invalidation](https://tanstack.com/query/v5/docs/framework/react/guides/invalidations-from-mutations) supports refreshing the original organization's data after acknowledgment.

## Validation plan

Real PostgreSQL tests compare observed usage with actual ExecutionJournal reservations and confirmed absence, across organizations/namespaces and Apps.
Test default/inherited/zero/unlimited/over-limit values, unavailable CI and corrupt policy state.
HTTP tests prove members can read aggregate capacity and cannot write it; existing owner guards remain exercised.
UI tests cover ownership, moved controls, actual counts independent of page size, clamped meter semantics, save failure/double-submit and organization switches.
Run repository Make test/build/format targets and inspect local mock desktop/mobile rendering before reporting completion.
No deployment or GitHub workflow dispatch is authorized.

## Research log

Known references before searching: local Images meter, WAI meter pattern, TanStack Query v5 invalidation, Carbon and Radix primitives.
On 2026-11-06, web search/open inspected official sources. Exact queries, one each:
- arXiv: `site:arxiv.org resource capacity utilization meter dashboard`.
- OpenAlex: `site:openalex.org resource capacity utilization dashboard`.
- GitHub project engine: `site:github.com carbon-design-system carbon progress bar meter`.
- npm project engine: `site:npmjs.com @radix-ui react progress`.
No relevant paper changed this presentation decision. Carbon/Radix were exploratory examples, not qualified SOTA selections; neither warrants adoption here.
Official WAI and Query docs were opened; installed Query v5, React and existing repository primitives remain authoritative, without upgrades.
Repository source and working diff were inspected; no new concurrency mechanism is introduced.
Stop: this round found no decision-changing alternative to reuse. Tests and browser inspection remain planned until executed.

## Independent design review

The design auditor returned PASS and required catalog/active-reference validation, consistent reads, and event-free release testing.
The design advisor recommended bounded background refresh because journal occupancy and remote cap edits may lack Box events.
Both requirements are incorporated above; the parent dashboard design remains BUI-1471.

## Observed validation

Validated in branch `feat/ci-gh-runner-rebase-main-20261105`, based on `5ee36c315e04f9ce5bf84ae05e3ef95cd086ac71`.
Dashboard: 806 tests across 101 files passed. CI API: 253 tests across 11 suites passed, including real local PostgreSQL capacity reads.
Shared Listener: 403 tests across 17 suites passed. API and Dashboard builds passed; `git diff --check` passed.
The capacity tests use real journal transitions, expired leader authority, a second organization/namespace, confirmed absence and broken references.
A local mock browser check observed `2 of 3 slots`, saved a limit of one and observed `2 of 1 slots`, verified the removed Connects control, and confirmed a 390px viewport had no document overflow.
Mock presentation does not establish hosted runtime acceptance. Changes remain local; no deployment was initiated.

Presentation refinement: removed the visible capacity title and explanatory footer; Edit is a plain text action.
A 1440px browser comparison measured both CI and Images panels at 1349 × 43.390625px, with the same 12px font, 17.4px line height, 12px/14px padding and 16px gap.
The Edit control has zero border and transparent background. The 18 affected Dashboard tests and Dashboard build passed.
