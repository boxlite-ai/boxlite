## TL;DR

Add Images-style name filtering to CI Runners, applying a literal case-insensitive substring before pagination while leaving account capacity unchanged.

## Problem and scope

Runners currently paginates its original CI Box inventory without a name filter.
Use the existing Images toolbar position and exact search container classes, beneath the capacity strip and fourteen pixels above the table.
Reuse the brand search glyph, dashed border, responsive 36/44px height and 380px desktop width; add no dependencies, persistence or deployment.

## Approach

Add optional `name` to GET CI runners, bounded to 128 characters with strict string validation.
Trim outer whitespace and match a literal case-insensitive substring of the Box name using bound PostgreSQL `strpos(lower(name),lower($parameter))`.
Apply the same predicate to count and page reads, preserving original hosted-namespace/organization/ledger constraints.
Empty name matches all runners. Percent, underscore, quotes and backslashes remain literal search characters.
The independent capacity read receives only the original organization, so filtering cannot change used slots or the cap.

Keep the controlled input immediate, like Boxes. Reset to page one on input changes and include the normalized name in the query key.
Use Query v5 `keepPreviousData` during fetches so the capacity strip and search field do not jump when changing filters/pages.
Only clamp an out-of-range page after non-placeholder data arrives; retain existing socket invalidation and automatic refresh.
Organization changes unmount the panel and clear its filter and page as before.
Show a specific no-matches message for a non-empty name, and restore the normal inventory when cleared.

## Research and alternatives

Known references: local ImageCatalog toolbar, Boxes filters/useBoxes pagination, installed Query v5 placeholder data, native CI inventory SQL.
Adopt local layout/interaction and server filtering. Reject current-page-only filtering because it would omit matching workers on other pages.
Choose literal substring over unescaped LIKE patterns so user input cannot become wildcard syntax.
[Query v5 paginated queries](https://tanstack.com/query/v5/docs/framework/react/guides/paginated-queries) describes retaining previous data during page changes.
[PostgreSQL string functions](https://www.postgresql.org/docs/16/functions-string.html) defines strpos and lower.
No new algorithm or framework is selected; all existing isolation and quota contracts remain unchanged.

Search log, 2026-11-06: web search/open, one query each for arXiv, OpenAlex, GitHub and npm, plus direct official Query/PostgreSQL sources.
Queries: `site:arxiv.org paginated resource name substring filtering`; `site:openalex.org paginated resource name filtering`;
`site:github.com TanStack query pagination filtering keepPreviousData`; `site:npmjs.com tanstack query pagination filter`.
Stop after this round: none establishes a better solution than existing repository patterns; no external project is asserted as qualified SOTA.

## Validation plan

Real PostgreSQL verifies matches outside the first page, case-insensitivity, empty/literal special characters and foreign/destroyed/spoofed exclusions.
HTTP validates length, repeated-name arrays and unknown parameters. Client tests verify encoded organization, explicit name query and compatibility without name.
UI tests cover typing from a later page, clearing/no matches, preserved capacity and automatic refresh with the filter.
Local browser compares the search field's position/dimensions/font with Images and checks filtering/clearing.
Run Make tests/builds/format and capture terminal exit codes. Update the requested branch PR only after concrete diff/size and disclosure checks.

## Independent design review

Auditor: PASS. Advisor: proceed with shared count/page predicate, normalized query identity and existing organization invalidation prefix.
Both require skipping page clamping and no-match announcements while data is placeholder, and keeping capacity organization-wide.

## Observed validation

Before integrating newer main, CI API passed 261 tests; Dashboard passed all 812 tests after an unrelated SSH proxy test failed once and passed on its targeted rerun.
API and Dashboard builds passed. Shared Listener and standalone tests/builds also passed.
A local browser measured Runners and Images search fields identically: x=40, y=226.703125, width=380px, height=36px, 13px IBM Plex Mono, 19.5px line height and dashed borders.
Typing an uppercase substring reduced two demo runners to one while capacity stayed at two of three; clearing restored both rows.
These are local mock and automated results, not deployed acceptance.

## Final rebase validation

The requested branch was rebased onto main `95768eb4e2f7490b3ea373d424a2c9d20fd5ea0f`, preserving a linear feature history.
CI API tests and both app builds passed after refreshing main dependencies; Dashboard passed 812 tests.
Shared Listener PostgreSQL contracts were executed with cache disabled, and standalone tests/builds passed.
Workspace lint passed with zero errors after using scoped project imports and preserving existing control-character checks and resource-cleanup failure precedence.
CI management routes were also added to the API hub documentation. Hosted dual-App deployment acceptance remains pending.
