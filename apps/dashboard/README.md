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
