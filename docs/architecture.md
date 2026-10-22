# Architecture

Read this first if you are changing the code. The wire formats are in `contracts.md`, why things are the way
they are in `decisions.md`, open and fixed findings in `polish-backlog.md`.

## The pieces and where they run

```
 user's laptop                      BoxLite dev (one org)
 ┌───────────────────┐              ┌──────────────────────────── Box "microcloud-cp" ─────────────────────┐
 │ coding agent       │  HTTPS       │ control plane (Node 22, one process, sqlite in $HOME/cp/data)        │
 │  └ boxlite-app CLI │─────────────▶│   :8080 API origin   /v1 /sv /admin /auth /agent.md /cli            │
 │ browser            │─────────────▶│   :8081 console origin /console (React build of the dashboard)      │
 └───────────────────┘               │   :10001+ one origin per app env → reverse proxy to that env's Box  │
                                     └─────────────┬──────────────────────────────┬───────────────────────────┘
                                                   │ BoxLite /v1 REST (org key)   │ Neon API (org key)
                                     ┌─────────────▼──────────────┐      ┌────────▼──────────────┐
                                     │ Box per app env            │      │ Neon project per App,  │
                                     │  supervisor (Go, root)     │◀────▶│ branch per env         │
                                     │   gateway :8080 (tunnel)   │ SQL  └───────────────────────┘
                                     │   services as `boxlite`    │
                                     │  /home/boxlite/app/releases│
                                     │  volumes (BoxLite Volumes) │
                                     └────────────────────────────┘
```

- **Every origin is a separate BoxLite tunnel port of the CP Box.** The listener a request arrived on decides
  what it is (`origins.ts`); paths and Host never do. Apps live at `/` of their own origin.
- **The CP never runs user code.** Builds and services run in the env's Box under the supervisor; the CP tells
  it what to do over the gateway (`X-BoxLite-Control`) and forwards end-user traffic (`X-BoxLite-Gateway`).
- **One deployment at a time per env**, every change (code, infra, variables, access, rollback) is a deployment.

## Control plane (`control-plane/src`)

A directory groups the parts of one responsibility, and each file in it starts with a one-line comment
saying what it owns; a file of the same name next to it (`orchestrator.ts`, `resources.ts`) is the entry point.

| module | owns |
|---|---|
| `main.ts`, `server.ts` | process start, listeners, route mounting by origin role; `server.ts` is the only module outside `routes/` that imports route files |
| `ctx.ts`, `config.ts` | the wiring every module gets (`Ctx`: store, clients, workers, timing) and the env-var settings |
| `origins.ts` | port allocation per env, tunnel registration, which listener means what |
| `auth.ts` | App keys (hashed), admin token, box tokens |
| `db.ts` | the CP's sqlite schema (append-only migrations) and typed queries |
| `spec.ts`, `routes/plan.ts` | manifest → Spec, diffs, online checks, the effective spec version |
| `orchestrator.ts` | the deployment queue and runner: one queue per env, cancel, CP-restart recovery, finishing a deployment as live or failed |
| `orchestrator/` | one module per deployment kind: `deploy.ts` (check → upload → database → box → build → migrate → start), `apply.ts` (config only, restart the live release), `rollback.ts` (switch to #N's release, and the rollback checks); `steps.ts` (database, spec, migrate steps shared by the kinds), `job.ts` (step bookkeeping, logs, cancellation), `supervisor-link.ts` (status reports in, control calls out, waiting for a phase) |
| `resources.ts` | `ctx.resources`: an env's URL, current spec, effective access and runtime env; delegates the rest to `resources/` |
| `resources/` | `boxes.ts` (create or replace an env's Box, its tunnel, waiting for its supervisor, self-heal), `database.ts` (Neon project per App, branch per env), `volumes.ts` (volume names, create or adopt for a new Box, delete by recorded id), `wake.ts` (Box status cache, sleep, wake once) |
| `supervisor.ts`, `routes/sv.ts` | the CP↔supervisor wire, both directions, including `SupervisorStatus` |
| `blobs.ts`, `routes/uploads.ts` | content-addressed source per App, snapshots as tar.gz |
| `appdb.ts`, `dbreader.ts`, `sqlguard.ts`, `routes/db.ts` | SQL against the App's Neon branch: connection pools (one per database + role, DISCARD ALL between callers), reader login, read-only transactions, libpg-query classification |
| `dbproxy/` | `app db proxy`: the `db/connect` WebSocket (dispatched from `main.ts`), the Postgres login to Neon done by the CP (SCRAM over TLS), the guard on every Query/Parse, cancel forwarding, Activity per proxy run |
| `dbtransfer.ts` | `app db export` (COPY TO STDOUT, the SQL dump) and `app db import` (COPY FROM STDIN), on dedicated connections |
| `enduser/`, `oauth-providers.ts` | end-user sign-in: login → API-origin `/auth/start` → provider → handoff code → app-origin session; identity headers + JWT. `oauth-flow.ts` (the API-origin half, with the flow diagram), `app-origin.ts` (the proxy hook, `/.boxlite/auth/*`, `[auth].protect`), `sessions.ts` (users and sessions), `identity.ts` (RS256 key, JWKS, identity JWT), `management.ts` (status, users, block, CSV, test sessions; for the CLI routes and the console), `mirror.ts` (`boxlite.users` in the app's database; the only part the orchestrator imports), `state.ts`, `paths.ts`, `config.ts`, `pages.ts` |
| `proxy/` | app-origin traffic: `app-origin.ts` (entry point per request), `gate.ts` (Bearer key, tickets, access cookie), `forward.ts` (wake, header and cookie filtering, Location rewriting; also used by the scheduler and `app curl`), `upgrade.ts` (WebSocket), `pages.ts` (starting, not running, 401) |
| `http/` | HTTP helpers for every origin: `cookies.ts` (`__Host-` names, Set-Cookie, reading), `signed-token.ts` (domain-tagged HMAC, `<subject>.<expiry>.<mac>`), `html.ts` (`escapeHtml`), `response.ts` (`isResponse`). `http.ts` is the outbound JSON client with retry |
| `services/` | logic both the CLI routes and the console call: `apps.ts` (create an App, rotate its key), `logs.ts` (log levels, a deployment's lines, `since`), `db.ts` (SQL the CP builds itself, db URL coordinates) |
| `lifecycle.ts` | soft delete, restore, purge after 7 days |
| `feedback.ts` | `boxlite-app feedback`: agents' reports about the platform, redacted, capped per hour, listed at `/admin/feedback` |
| `limits.ts` | rate limits, SSE caps, log ingest caps, queue cap |
| `scheduler.ts` | `[[schedule]]` cron → request through the app origin (`proxy/forward.ts`, wakes the Box) |
| `agent-context.ts`, `routes/cli-extras.ts` | what `boxlite-app app context`, `doctor`, `whoami`, `app curl` need |
| `routes/*.ts` | the `/v1` API (App key or admin token), `/admin`, `/sv`; `open-ticket.ts` (one-time links into an env's origin), `legacy.ts` (301s from old path-prefix URLs, to delete with M4) |
| `routes/console/` | the console: `index.ts` mounts login, `/console/api` and the static dashboard (`static.ts`); one file per tab (`apps.ts`, `deployments.ts`, `volumes.ts`, `variables.ts`, `auth.ts`, `logs.ts`, `database.ts`); `kit.ts` is what they share (the in-process `/v1` client as actor `console`, App and env lookup) |
| `console-*.ts` | what the console API returns: `console-views.ts` (app summary and detail), `console-releases.ts`, `console-prompt.ts`, `console-view-types.ts` (the dashboard's types), `console-deployment.ts` (timeline, failure), `console-enduser.ts` (Auth tab), `console-activity.ts`; plus `console-auth.ts` (console login) and `console-access.ts` (app proxy access log, metrics) |

Import layering:

- `routes/*` may import `services/*` and domain modules. Route files do not import each other, except
  the shared helpers (`routes/util.ts`, `routes/console/kit.ts`), `routes/console/index.ts` mounting its
  groups, and `routes/deployments.ts` → `routes/plan.ts` (`prepare`).
- `services/*` import domain modules only.
- Domain modules (everything outside `routes/` and `services/`) never import `routes/*`.
- No runtime import cycles: `npx madge --circular --extensions ts control-plane/src` reports only
  type-only cycles, all through `ctx.ts` (and `db.ts` ↔ `spec.ts`, `appdb.ts` ↔ `dbreader.ts`).

Rules that keep it safe:

- Platform cookies are `__Host-bxl_*` on https and never reach apps; apps cannot set `bxl_*` cookies.
- No App key in URLs. Agents send it as `Authorization: Bearer`; the proxy checks and strips it.
- Reads never run as the database owner. Writes need `--write`; DDL on `main` only through migrations.
- A failed or cancelled deployment never changes "the env's state" (`effectiveSpecVersion`).
- Observing an app must not wake it: probes only talk to Boxes the status cache says are running.
- Supervisor updates are signed with a key that never leaves the build machine; a compromised CP cannot push a supervisor (`make release-key`, `cmd/releasesign`).

## Supervisor (`supervisor/`)

`main.go` → `internal/privilege` (root bootstrap, sudo lockdown, launcher), `internal/cp` (spec, snapshots,
status, log shipping), `internal/deploy` (build / activate / rollback / boot state machine), `internal/proc`
(services as uid 1001, restart with backoff, PID-1 reaping), `internal/gateway` (secret checks, reverse proxy,
static files, `/.boxlite/sv/*` incl. volume files through `os.Root`), `internal/release` (safe tar extraction),
`internal/health`, `internal/state` (root-only `state.json`).

## CLI (`cli/`) and shared (`shared/`)

`shared` is imported by both CLI and CP: manifest parsing and checks, ignore rules, upload manifests,
migrations reader, error codes ↔ exit codes, deploy failure classification (`diagnose.ts`), redaction.
The CLI is one bundled file (`dist/boxlite-app.cjs`); `docs/cli-reference.md` and the embedded docs are
generated on every build from the command definitions and `agent/SKILL.md`.

## The agent guide

`agent/SKILL.md` is served as `<cp>/agent.md` and embedded in the CLI (`boxlite-app docs`). It is product:
every rule in it must be true of the code. A test parses its TOML examples.

## Verifying changes

| suite | what | command |
|---|---|---|
| unit | CP, CLI, shared, supervisor | `pnpm -r test`, `cd supervisor && make test` (+ `make test-linux` for the root tests) |
| live API e2e | 32 checks on real Boxes + Neon through the CLI | `node e2e/run-live.mjs` |
| live console e2e | 21 checks in headless Chromium | `CP_URL=… ADMIN_TOKEN=$(cat .cp-admin-token) node e2e/console.spec.mjs` |
| acceptance | fresh agents build apps from one sentence; independent verification | `node e2e/agent-acceptance.mjs && node e2e/verify-acceptance.mjs` |

Deploy: `deploy/deploy-cp.sh` (builds supervisor, CLI, CP and console; keeps the CP Box and its URLs).
