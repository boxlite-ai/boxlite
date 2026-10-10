# BoxLite console

The web console at `app.boxlite.ai`. A Vite + React app, built and tested
through Nx as the `dashboard` project.

## Commands

Run these from `apps/`:

| Command | What it does |
| --- | --- |
| `yarn nx run dashboard:dev` | Dev server on `:3000`, proxying `/api` to `http://localhost:3001` |
| `yarn nx run dashboard:build` | Production build, with a typecheck pass |
| `yarn nx run dashboard:test` | Vitest suite |
| `yarn nx run dashboard:test --coverage` | Same, writing lcov to `target/coverage/dashboard` |

`DASHBOARD_API_PROXY_TARGET` points the dev server at a remote API
(`https://dev.boxlite.ai`) through the same-origin proxy, so the browser never
makes a CORS-gated request.

The `test` target is inferred by `@nx/vite` from the `test` block in
`vite.config.mts`. Removing that block removes the target, and with it every
signal CI has about this app — see [the workflows
README](../../.github/workflows/README.md) for how its coverage is reported.

## Finding your way around

Navigation is the sidebar plus the tables. There is one route per resource, and
each resource's table is the place you act on it — filter, sort, select, and run
per-row or bulk actions from there.

There is deliberately **no command palette**. The console had a `Ctrl/Cmd-K`
palette that re-listed the sidebar's routes, re-implemented each table's search
against a different data source, and exposed row actions a second time through
per-table command providers. Every command in it was a second, drifting copy of
an affordance the page already had, and keeping the two in step was a standing
cost paid on every table change. Search belongs to the table that owns the data;
actions belong to the row. If an action is hard to reach, fix the page.


## Two histories of the same thing go on tabs, not on top of each other

Invoices and credit activity both answer "where did my money go", so stacking
them made the Wallet tab a long scroll in which the second list was easy to miss
entirely. They are sibling tabs now, and each is paged rather than rendered
whole — an account with hundreds of documents must not decide how tall this page
is.

## A choice says what it does, and shows which one is picked

The quickstart offers two paths, so each card names its outcome ("Build an app
online — get a public URL" against "Run untrusted code — an isolated box") and
the picked one is drawn, not merely implied. The prompt it hands out carries the
endpoint the reader will actually use: `getRestApiUrl` resolves production's
origin even when the console itself is running against a mock, because the
prompt is pasted into someone's shell, not into this app.

## Selection follows the action, not the row count

A table's checkbox column exists to arm a bulk action, so a row that no bulk
action can touch is not selectable. `VolumeTable` is the worked example: delete
is its only bulk action, so `enableRowSelection` asks
`isVolumeDeletable(row.original)` and the checkbox renders disabled for volumes
already deleted or on their way out.

Gating only the count instead — leaving the row selectable and filtering later —
produces a toast that offers "Delete 0" and a confirmation for "these 0 selected
volumes". If a new bulk action arrives with a different eligibility rule, the
predicate becomes the union of them; it must never go back to a bare boolean.

## Empty states carry the first action

A resource table with no rows is not a blank page and not a takeover: it keeps
the page's own chrome and puts the first useful action inside the table's empty
state. The Boxes page is the worked example — an account with no boxes gets the
table's empty state with a button into the onboarding guide, rather than the
page being replaced by a separate panel.

The rule this follows: an empty list still has to say what the page is about and
what to do next, and any dialog it opens must be the same one the rest of the UI
opens. A second entry point to the same guide is a bug, not a convenience —
mounting one twice has already caused duplicate API keys to be minted
(issue #1491).

## Every invitee joins as an owner

An organization has no finer roles yet, so inviting asks only for an email
address: a role picker would offer choices the product does not have. For the
same reason a pending invitation can be cancelled but not edited, and a member
can be removed but not given another role. The member whose personal
organization this is has no remove action, because the API refuses that
removal.
