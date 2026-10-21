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

| module | owns |
|---|---|
| `main.ts`, `server.ts` | process start, listeners, route mounting by origin role |
| `origins.ts` | port allocation per env, tunnel registration, which listener means what |
| `auth.ts` | App keys (hashed), admin token, box tokens |
| `db.ts` | the CP's sqlite schema (append-only migrations) and typed queries |
| `spec.ts`, `routes/plan.ts` | manifest → Spec, diffs, online checks, the effective spec version |
| `orchestrator.ts` | the deployment state machine: database → Box → build → migrate → activate → live |
| `resources.ts` | Boxes, volumes, Neon branches for an env; wake/sleep; status cache |
| `supervisor.ts`, `routes/sv.ts` | the CP↔supervisor wire, both directions |
| `blobs.ts`, `routes/uploads.ts` | content-addressed source per App, snapshots as tar.gz |
| `appdb.ts`, `dbreader.ts`, `sqlguard.ts`, `routes/db.ts` | SQL against the App's Neon branch: reader login, read-only transactions, libpg-query classification |
| `enduser-auth.ts`, `oauth-providers.ts` | end-user sign-in: login → API-origin `/auth/start` → provider → handoff code → app-origin session; identity headers + JWT |
| `routes/proxy.ts` | app-origin traffic: Bearer key / ticket / cookie gate, `/.boxlite/*` blocking, forwarding, starting page |
| `lifecycle.ts` | soft delete, restore, purge after 7 days |
| `limits.ts` | rate limits, SSE caps, log ingest caps, queue cap |
| `scheduler.ts` | `[[schedule]]` cron → request through the app origin (wakes the Box) |
| `agent-context.ts`, `routes/cli-extras.ts` | what `boxlite-app app context`, `doctor`, `whoami`, `app curl` need |
| `console-*.ts`, `routes/console.ts` | the console API under `/console/api`; maps CP state to the dashboard's types |

Rules that keep it safe:

- Platform cookies are `__Host-bxl_*` on https and never reach apps; apps cannot set `bxl_*` cookies.
- No App key in URLs. Agents send it as `Authorization: Bearer`; the proxy checks and strips it.
- Reads never run as the database owner. Writes need `--write`; DDL on `main` only through migrations.
- A failed or cancelled deployment never changes "the env's state" (`effectiveSpecVersion`).
- Observing an app must not wake it: probes only talk to Boxes the status cache says are running.

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
