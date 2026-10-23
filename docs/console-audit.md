# Console audit (human console, Apps screens)

Run 2026-10-21 against a local CP (`ADMIN_TOKEN=t`, fake BoxLite API running the real supervisor in
`/tmp/mc-local/`, real Neon), console built with `deploy/build-console.sh`, driven by headless
Chromium. App `ks1` deployed from `e2e/fixtures/kitchen-sink` with the real CLI. Every finding below
was seen on screen or in the CP's answer, not read from code.

Verification: `e2e/console.spec.mjs` (21 checks, all passing on the local stand-in) drives the
fixed behaviour end to end and compares every tab with the CP's `/v1` answers; screenshots in
`docs/console-shots/v2/`.

Legend for the check columns: **CP** shown value matches CP truth · **L/E/E** loading, empty and
error states present · **Copy** clear and actionable · **Kbd** keyboard and focus · **Does** the
action really happens (verified in CP state) · **IF** matches the best comparable console or better.
✔ ok · ✖ gap · – not applicable. **Status** is the state after the fix pass.

## List

| # | State | Control | Shows | CP | L/E/E | Copy | Kbd | Does | IF | Gap → fix | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| L1 | empty | table | "No apps yet" + New App | ✔ | ✔ | ✔ | ✔ | – | ✔ | – | ok |
| L2 | any | row | name, URL, access, status, last deployment | ✔ | ✔ | ✔ | ✖ | ✔ | ✔ | rows are click-only divs; not reachable by Tab → rows are links | fixed |
| L3 | failed (newer deploy failed, old live) | status cell | RUNNING + red "#3 failed at start…" | ✔ | – | ✔ | – | – | ✔ | – | ok |
| L4 | deploying | status cell | DEPLOYING, no step | ✔ | – | ✖ | – | – | ✔ | says nothing about which step → step and elapsed under the status | fixed |
| L5 | deleted | list | app vanishes, no trace, no restore | ✖ | ✖ | ✖ | – | ✖ | ✖ | no "Recently deleted" → section with purge date and Restore | fixed |
| L6 | any | ⋮ Delete | dialog says "This cannot be undone" | ✖ | – | ✖ | ✔ | ✔ | ✖ | delete is soft (7 days, restorable); copy was wrong → says what is kept and until when | fixed |
| L7 | any | Open app ↗ | `/console/open/:app` link | ✔ | – | ✔ | ✔ | ✔ | ✔ | moving to one-time ticket → one `openApp()` that prefers `POST …/open-ticket` | fixed |
| L8 | any | filter | client-side name/URL filter | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | – | ok |
| L9 | error (CP down) | table | spinner rows forever | ✖ | ✖ | ✖ | – | – | ✖ | no error state → inline error with message and Retry | fixed |

## New app

| # | State | Control | Shows | CP | L/E/E | Copy | Kbd | Does | IF | Gap → fix | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| N1 | – | name field | live validation, URL preview | ✔ | – | ✔ | ✔ | – | ✔ | – | ok |
| N2 | – | Create | prompt with full key, Copy prompt | ✔ | ✔ | ✔ | ✔ | ✔ (key works with CLI) | ✔ | – | ok |
| N3 | name taken | Create | toast "an app named … already exists" | ✔ | ✔ | ✔ | ✔ | – | ✔ | – | ok |
| N4 | name of a deleted app | Create | conflict toast without saying it is deleted | ✖ | – | ✖ | – | – | – | CP `createApp` only checks live apps, insert then fails on UNIQUE → console checks deleted names and says "restore it or wait for the purge" | fixed |

## Overview

| # | State | Control | Shows | CP | L/E/E | Copy | Kbd | Does | IF | Gap → fix | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| O1 | draft | hand-off | masked prompt + Rotate key | ✔ | – | ✔ | ✔ | ✔ | ✔ | – | ok |
| O2 | deploying (first) | page | still the hand-off; Open app is offered although nothing is live | ✖ | – | ✖ | – | ✖ (503 no_release) | – | Open app hidden until a release is live; overview shows the live progress | fixed |
| O3 | live | URL, deployment, details | URL, #N summary, by, box | ✔ | – | ✔ | ✔ | – | ✔ | – | ok |
| O4 | live | Services | name, port, state, health; restarts/pid/exit/command hidden in a fold | ✔ | – | ✖ | ✔ | ✔ | ✔ | requirement: all columns visible, last stderr lines when crashed → table with restarts, last exit, pid, port, command; stderr tail for crashed/unhealthy | fixed |
| O5 | live | Schedules | not shown at all | ✖ | ✖ | – | – | ✖ | – | kitchen-sink `tick` runs every minute, invisible → Schedules section: cron, human text, next run UTC + local, last result, Run now | fixed |
| O6 | failed (newer) | failure panel | "failed at start: service web failed its health check" + Roll back to #1 | ✔ | – | ✖ | ✔ | ✔ | ✔ | no classified cause; offers rollback although #2 still serves → diagnosis from `shared/diagnose.ts` (health_404: add GET /nope or fix health); "#2 keeps serving"; rollback only when nothing healthy serves | fixed |
| O7 | sleeping | services | STOPPED, "No health check", port :20001 | ✖ | – | ✖ | – | – | – | wording and stale port → "Asleep", no port, Restart replaced by note "the next request wakes it" | fixed |
| O8 | sleeping | status line | "Asleep: the Box stops after 15 idle minutes…" also after Sleep now | ✖ | – | ✖ | – | – | – | reason is wrong when slept by hand → "Asleep · the next request wakes it (about 6 s)" | fixed |
| O9 | any | metrics | hidden without traffic | ✔ | ✔ | ✔ | – | – | ✔ | – | ok |

## Header (status, environment switcher, access, ⋮, open app)

| # | State | Control | Shows | CP | L/E/E | Copy | Kbd | Does | IF | Gap → fix | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| H1 | deploying | status | "#1 · Deploying" + "Deploying #2 · migrate (…)", no elapsed | ✖ | – | ✖ | – | – | – | runtime word says Deploying although #1 still runs; no elapsed → `#1 · Running` + `Deploying #2 · migrate · 0:12` ticking | fixed |
| H2 | deploying → live | other tabs | stale until their own refetch (DB tables, variables) | ✖ | – | – | – | – | – | on completion every app query is invalidated | fixed |
| H3 | any | Access dropdown | three options, check mark, source | ✔ | – | ✖ | ✔ | ✔ | – | options have no reason text → each says who gets in | fixed |
| H4 | any | Access → public | confirm dialog | ✔ | – | ✔ | ✔ | ✔ (`PUT access` override) | – | – | ok |
| H5 | any | ⋮ Sleep now | toast, status sleeping | ✔ | – | ✔ | ✔ | ✔ (Box stopped) | – | – | ok |
| H6 | any | ⋮ Delete app | type-to-confirm; "cannot be undone" | ✖ | – | ✖ | ✔ | ✔ (soft) | – | copy → soft-delete wording with purge date | fixed |
| H7 | live private | Open app | `/console/open/ks1` → 302 → app (200 after wake) | ✔ | – | ✔ | ✔ | ✔ | ✔ | swap to ticket behind `openApp()` | fixed |
| H8 | sleeping | Open app | "Starting ks1…" page, then app (6 s) | ✔ | – | ✔ | – | ✔ | ✔ | – | ok |
| H9 | error (non-404) | page | "Loading app…" forever | ✖ | ✖ | ✖ | – | – | ✖ | → error with CP message, next, Retry | fixed |

## Deployments and deployment detail

| # | State | Control | Shows | CP | L/E/E | Copy | Kbd | Does | IF | Gap → fix | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| D1 | empty | list | "No deployments yet" | ✔ | ✔ | ✖ | – | – | ✔ | → exact command `boxlite-app deploy` | fixed |
| D2 | deploying | row | spinner status, running step | ✔ | – | ✔ | – | – | ✔ | no elapsed; refresh 2.5 s → elapsed per row, poll 1.5 s | fixed |
| D3 | any | row click | inline fold: steps without start times, right-aligned in a dotted SpecRow, changes as raw lines, last 500 log lines | ✖ | ✔ | ✖ | ✖ | – | ✔ | not a traceable timeline → full detail view `?deployment=N`: steps with start, duration, status; build log with level colour; changes grouped infra/config/code (+/~/- file counts); spec version; who; failure banner with classified cause, fix, "Copy fix instructions for your agent"; Download source; Roll back; View in Logs | fixed |
| D4 | failed | row | error line | ✔ | – | ✔ | – | – | ✔ | cause is not classified → `classifyFailure` summary | fixed |
| D5 | any | Roll back | confirm, new deployment | ✔ | – | ✔ | ✔ | ✔ (rollback deployment live, previous `rolled_back`) | ✔ | – | ok |
| D6 | any | Download source | tar.gz | ✔ | – | ✔ | ✔ | ✔ | ✔ | – | ok |
| D7 | any | link to logs | none | ✖ | – | – | – | – | – | → "View in Logs" opens Logs filtered to the deployment | fixed |

## Logs (runtime) and Activity

| # | State | Control | Shows | CP | L/E/E | Copy | Kbd | Does | IF | Gap → fix | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| G1 | live | source chips | sources that logged (web, build, schedule, system) | ✔ | – | ✔ | ✔ | ✔ | ✔ | auth/db/access hidden until they log; fine, chips are built from services + platform sources | ok |
| G2 | live | level / range / search | all work | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | – | ok |
| G3 | live | deployment filter | none | ✖ | – | – | – | – | ✖ | → deployment chooser, server-side `deployment=` | fixed |
| G4 | live | Live / Pause | polls 3 s, pause stops | ✔ | – | ✔ | ✔ | ✔ | ✔ | – | ok |
| G5 | live | line detail | time, source, level, deployment, box | ✔ | – | ✔ | ✔ | – | ✔ | deployment not linked → link to its detail | fixed |
| G6 | build | npm notices | red (stderr = error) | ✔ | – | – | – | – | – | CP stores stderr as error; unchanged (CP truth) | ok |
| A1 | any | rows | "agent (key …2pjx)", "admin" for console actions, raw JSON detail `{"name":"ks1"}` | ✖ | ✖ | ✖ | – | – | ✔ | console writes were recorded as `admin` → actor `console`; detail rendered as words; empty state | fixed |
| A2 | any | row → object | no link | ✖ | – | – | – | – | – | → deployment rows open the deployment, access/variables/db/auth rows open their tab | fixed |

## Auth

| # | State | Control | Shows | CP | L/E/E | Copy | Kbd | Does | IF | Gap → fix | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| U1 | no [auth] | page | prompt block for the agent | ✔ | ✔ | ✖ | – | – | ✔ | → exact `[auth]` snippet and `boxlite-app deploy` | fixed |
| U2 | [auth] | status panel | providers, protect, sign-in page | ✔ | – | ✔ | – | – | ✔ | – | ok |
| U3 | any | sign-in methods | GitHub ready, Google not configured | ✔ | – | ✖ | – | – | ✔ | no reason for Google, no redirect URI → explanation + redirect URI per provider | fixed |
| U4 | any | users | search, sign out, block, CSV | ✔ | ✔ | ✔ | ✔ | ✔ (via test session user) | ✔ | – | ok |
| U5 | any | recent sign-ins | none | ✖ | – | – | – | – | ✖ | → last sign-in events from the `auth` log source | fixed |

## Database

| # | State | Control | Shows | CP | L/E/E | Copy | Kbd | Does | IF | Gap → fix | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| B1 | none | page | prompt block | ✔ | ✔ | ✖ | – | – | ✔ | → "No database yet — add `[database]` … run `boxlite-app apply`" | fixed |
| B2 | ready | load | "Connecting…" 4–10 s on every visit | ✔ | ✔ | ✔ | – | – | – | slow (one Neon connection per query) → the four reads run side by side and counts are one UNION ALL; still one connection per query (pooling belongs in `appdb.ts`). 2026-10-24: 1.7 s end to end on dev, of which 1.4 s is the dev proxy (`/healthz` alone) | fixed |
| B3 | ready | Tables | "Rows (est.)" from pg_stat: ticks 4 when it had more | ✖ | ✔ | ✔ | ✔ | – | ✔ | estimates → exact counts | fixed |
| B4 | ready | Browse | paging, search, NULL | ✔ | ✔ | ✔ | ✔ | ✔ | ✖ | no column types, JSON cells as one long string → types under each header, JSON cells collapsed with expand | fixed |
| B5 | ready | SQL write confirm | "Run a write on main?" | ✔ | – | ✖ | ✔ | ✔ (row inserted) | – | does not name the statement → "Run INSERT on main?" | fixed |
| B6 | ready | SQL DDL on main | asks to confirm a write, then CP refuses | ✔ | – | ✖ | – | ✔ | – | refusal only after confirming → refused before running with the migration file name and `boxlite-app deploy` | fixed |
| B7 | ready | SQL write result | "0 rows · 0 columns" + empty header | ✖ | – | ✖ | – | – | – | → "1 row affected" | fixed |
| B8 | ready | SQL history | 5 entries, lost on reload | ✔ | – | ✔ | ✔ | – | – | → kept per app and env in localStorage | fixed |
| B9 | ready | Explain / Export CSV | work | ✔ | – | ✔ | ✔ | ✔ | ✔ | – | ok |
| B10 | ready | Migrations | file, deployment, applied, status | ✔ | ✔ | ✔ | – | – | ✔ | deployment not a link → link to deployment detail | fixed |
| B11 | ready | Backups | Back up now, restore with type-to-confirm | ✔ | ✔ | ✖ | ✔ | ✔ | ✔ | 6-hour window not explained; old backups offered → explained; backups older than 6 h marked and not restorable | fixed |
| B12 | ready | Connection | host/db/user, no password, `app dev` hint | ✔ | – | ✔ | – | – | ✔ | – | ok |

## Volumes

| # | State | Control | Shows | CP | L/E/E | Copy | Kbd | Does | IF | Gap → fix | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| V1 | none | page | prompt block | ✔ | ✔ | ✖ | – | – | – | → exact `[[volume]]` snippet + `boxlite-app deploy` | fixed |
| V2 | declared | panel | mount, BoxLite volume, id; "Files: not browsable here yet" | ✔ | – | ✔ | – | – | ✖ | no file browser → list, open folders, download, upload via `…/volumes/:name/files` (CLI extras); gated on a supervisor that has it ; delete a file or folder (confirm, Activity) since 2026-10-24 | fixed (console e2e uploads and deletes through the panel on a real Box) |

## Variables

| # | State | Control | Shows | CP | L/E/E | Copy | Kbd | Does | IF | Gap → fix | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| R1 | draft | page | "Nothing configured yet" | ✔ | ✔ | ✖ | – | – | ✔ | → exact `[variables]` snippet | fixed |
| R2 | live | rows | plain values, masked secrets with source, platform section | ✔ | – | ✔ | ✔ | – | ✔ | – | ok |
| R3 | deploying | rows | new value shown as if live while #N still runs | ✖ | – | ✖ | – | – | – | → "pending · takes effect when #N is live" on changed rows | fixed |
| R4 | live | Edit → Save and deploy | toast "deploying #2", header progress | ✔ | – | ✔ | ✔ (Enter/Esc) | ✔ (apply #2 live, GREETING in /api/env) | ✔ | – | ok |

## Environments

| # | State | Control | Shows | CP | L/E/E | Copy | Kbd | Does | IF | Gap → fix | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| E1 | any | switcher | envs with status, URL, box | ✔ | – | ✔ | ✔ | ✔ | – | – | ok |
| E2 | any | New environment | name, fork source schema/data | ✔ | – | ✔ | ✔ | ✔ | – | – | ok |
| E3 | non-main | Delete env | type-to-confirm | ✔ | – | ✔ | ✔ | ✔ | – | – | ok |
| E4 | non-main | every tab | env-scoped queries (`?env=`) | ✔ | – | – | – | ✔ | – | – | ok |

## Login

| # | State | Control | Shows | CP | L/E/E | Copy | Kbd | Does | IF | Gap → fix | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| I1 | signed out | form | admin token field, wrong-token error | ✔ | ✔ | ✔ | ✔ | ✔ | – | prototype login by design | ok |
| I2 | expired | API 401 | redirect to login with `next` | ✔ | – | – | – | ✔ | – | – | ok |

## Errors across screens

| # | Where | Finding | Status |
|---|---|---|---|
| X1 | toasts | `handleApiError` shows `message. Next: next` from the CP | ok |
| X2 | queries | Database, Auth, Logs, Volumes, app page and list: a failed query showed a spinner or nothing | fixed (inline error with the CP's message and next); the environment switcher still shows an empty menu on error |
| X3 | SQL | error shows the message, no position | fixed (line and column from `position`) |
