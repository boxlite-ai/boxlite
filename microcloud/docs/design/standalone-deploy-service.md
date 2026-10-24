# Design: a standalone, provider-neutral deployment service for agents

Status: proposal (2026-10-23). Nothing here is built yet.

Goal: lift the micro-cloud prototype out of BoxLite into its own product, a deployment service that
coding agents use through one CLI and one guide, with **no `boxlite` keyword anywhere in its code**,
that runs on any cloud VM, and that talks to BoxLite (or anything else) only through a sandbox
connector layer.

## 1. What is coupled today

Measured on the current tree (`grep -rn boxlite`, 1 560 lines across the control plane, shared,
CLI, supervisor and the agent guide). The coupling falls into six families:

| family | where | examples |
|---|---|---|
| **Sandbox provider** | `control-plane/src/boxlite.ts` (`BoxliteClient`, 9 methods), `resources/boxes.ts`, `resources/wake.ts`, `origins.ts` | create/start/stop/delete Box, `tunnel(port)`, volumes; BoxLite's auto-stop after 15 min; its tunnel URL shape `<port>-d-<id>.proxy…`; the Box `cmd` that downloads the supervisor; `/home/boxlite` paths; idmapped virtiofs volume ownership in the supervisor (`fsowner_linux.go`) |
| **Database provider** | `neon.ts` (`NeonClient`, 5 methods), `resources/database.ts`, `dbreader.ts`, `orchestrator/rollback.ts` | project per App, branch per environment (schema-only or with data), restore to a timestamp |
| **Brand and wire names** | everywhere | CLI `boxlite-app`, `boxlite.toml`, `.boxlite/`, keys `bxl_app_…`, `BOXLITE_API_URL/KEY/APP/ENV`, headers `X-BoxLite-User-*`, `X-BoxLite-Control`, cookies `bxl_session`, the `boxlite.users` schema, `/.boxlite/auth/*` paths, `agent.md` wording |
| **Console** | the Apps pages live inside the BoxLite dashboard repo (`boxlite-micro-cloud-app/apps/dashboard/src/components/apps`) and use its UI kit, routing, session and org model | |
| **Console sign-in** | `console-signin.ts` | GitHub only, org model mirrors BoxLite's |
| **Operations** | `deploy/deploy-cp.sh` | the control plane itself runs in a BoxLite Box, reached through per-port tunnels |

Everything else (manifest, spec diffing, orchestrator steps, supervisor protocol, deploy
diagnosis, logs, end-user sign-in, access gate, secrets, schedules, CLI, agent guide, console
views) is already provider-neutral in behaviour; only its names are not.

## 2. Target shape

```
┌──────────────── coding agent ────────────────┐      ┌────── people ──────┐
│  <cli> deploy / logs / sql / curl / …         │      │  console (web)     │
└───────────────┬───────────────────────────────┘      └─────────┬──────────┘
                │ HTTPS, App key                                 │ session
┌───────────────▼─────────────────────────────────────────────────▼──────────┐
│  deployment service (one process; Node)                                    │
│   routes · orchestrator · spec · secrets · schedules · end-user auth       │
│   app reverse proxy + access gate · logs · console API                     │
│   ┌───────────────────────┐  ┌───────────────────────┐  ┌───────────────┐  │
│   │ SandboxProvider       │  │ DatabaseProvider      │  │ IngressRouter │  │
│   │ (connector interface) │  │ (connector interface) │  │ (service's)   │  │
│   └──┬───────┬───────┬────┘  └──┬─────────┬──────────┘  └───────────────┘  │
└──────┼───────┼───────┼──────────┼─────────┼────────────────────────────────┘
   boxlite   docker   ssh-vm   neon   local-postgres   (each in providers/<name>/)
   (today)   (any VM) (fleet)  (today) (any VM)
         │
   ┌─────▼──────────────────────────────┐
   │ sandbox: image + supervisor (Go)   │  unchanged protocol: build, start,
   │ services · health · gateway · logs │  health, gateway, files, logs
   └────────────────────────────────────┘
```

Three decisions make the rest follow:

1. **The service owns ingress.** Today every app environment has its own public origin because
   BoxLite gives one tunnel per port. In the standalone service, the reverse proxy that already
   exists (`proxy/`) routes by `Host`: `<app>-<env>.<base-domain>` (wildcard DNS) → the sandbox's
   private address and port. A provider only has to answer "how does the service reach port *p* of
   sandbox *s*" (`address(s, p)`); it may *also* hand out a public URL (BoxLite tunnels) and the
   router will use it, but nothing depends on it. One wildcard certificate (DNS challenge) or a
   fronting proxy (Caddy/Traefik) covers every app.
2. **The service owns the lifecycle policy.** Idle-stop after 15 min and wake-on-request are today
   BoxLite behaviours the service merely observes. They become the service's: the proxy already
   sees every request, so it stops a sandbox after N idle minutes through the provider and starts
   it on the next request (the `BoxWaker` and the "Just a moment" page already exist). Providers
   expose only `start/stop/status`.
3. **Branded names come from one module.** `shared/src/brand.ts` (and `supervisor/internal/brand`)
   holds the product name and every derived identifier; nothing else spells them. A CI check
   greps the tree for the old names and fails outside `providers/boxlite/`.

## 3. The connector interfaces

Sizes are from the methods the control plane uses today, so nothing speculative is added.

### SandboxProvider

```ts
interface SandboxProvider {
  readonly name: string;                     // 'boxlite' | 'docker' | 'ssh' | …
  readonly capabilities: {
    persistentVolumes: boolean;              // managed volumes that outlive the sandbox
    publicUrl: boolean;                      // the provider can expose a port itself
    idleStop: boolean;                       // the provider stops idle sandboxes on its own
  };
  create(spec: SandboxSpec): Promise<Sandbox>;      // image, cpus, memoryMib, diskGb, env, cmd, mounts
  get(id: string): Promise<Sandbox | null>;         // { id, state: 'running'|'stopped'|'starting'|'missing' }
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  address(id: string, port: number): Promise<string>;   // host:port reachable from the service
  publicUrl?(id: string, port: number): Promise<string>; // only with capabilities.publicUrl
  volumes: {                                           // only with capabilities.persistentVolumes
    create(name: string): Promise<Volume>;
    list(): Promise<Volume[]>;
    destroy(id: string): Promise<void>;
  };
}
```

What stays out of the interface on purpose: `exec` and `cp` into a sandbox. The service never
needs them at runtime; the supervisor bootstraps itself from the sandbox `cmd` (download the
binary from the service, verify its signature, run it) and everything after that is the
supervisor's HTTP protocol. That is what keeps the connector small enough to write in a day.

Provider notes:

- **boxlite/** — the existing `HttpBoxliteClient` and `origins.ts` tunnel logic move here, as the
  only place the word may appear. `publicUrl` = tunnel; `idleStop` = true (the service's own
  idle-stop stays off); volume ownership (idmapped virtiofs) is a provider detail the supervisor
  learns from its environment (`SANDBOX_VOLUME_OWNER=idmapped`), not a compile-time assumption.
- **docker/** — the one that makes "any VM" true: `docker run` with the same image, env, cmd and
  bind-mounted volumes under `/var/lib/<product>/volumes/<id>`; `address` = container IP:port on
  the service's bridge network; `idleStop` = false (the service does it). Also the local
  development provider, which removes the need for a dev Box.
- **ssh/** (later) — a pool of VMs reached over SSH for fleets that outgrow one host; same
  contract, `address` = VM IP.
- Firecracker/Fly Machines/E2B/Kubernetes fit the same seven methods when wanted.

### DatabaseProvider

```ts
interface DatabaseProvider {
  readonly name: string;                     // 'neon' | 'postgres'
  readonly capabilities: { dataBranches: boolean; restoreToTime: boolean; snapshots: boolean };
  provision(appId: string): Promise<Database>;                          // the App's primary database
  branch(db: Database, env: string, from: Branch | null, mode: 'schema-only' | 'with-data'): Promise<Branch>;
  destroyBranch(branch: Branch): Promise<void>;
  size(branch: Branch): Promise<number | null>;
  restore?(branch: Branch, toIso: string): Promise<void>;               // restoreToTime
  snapshot?(branch: Branch, label: string): Promise<Snapshot>;          // snapshots
  connection(branch: Branch, role: 'owner' | 'reader'): ConnectionInfo; // what the app and the SQL console use
}
```

- **neon/** — today's client, verbatim.
- **postgres/** — one Postgres server on the VM (container or system package): a database per App,
  environment branches as `CREATE DATABASE … TEMPLATE` (with data) or `pg_dump -s` + restore
  (schema-only); snapshots and rollback restore points via `pg_dump` files on disk; the two roles
  (owner, reader) the SQL guard already relies on are created per database. `restoreToTime` is
  false, and the console and CLI already show features by capability (they say "not available
  here" instead of failing).

### Everything else stays as it is

Metadata store (SQLite via `node:sqlite`), blobs (files on disk), logs ring, secrets, end-user
sign-in, access gate, scheduler: all already run inside the service process with local state, so
"deploy to a VM" is one process plus a data directory.

## 4. Naming: removing the brand from the code

A single table decides every identifier; the examples use a placeholder product name `relay`
(pick the real one once; the module makes the rename mechanical):

| today | becomes | from |
|---|---|---|
| `boxlite-app` CLI | `relay` | `brand.cli` |
| `boxlite.toml` | `relay.toml` | `brand.manifest` |
| `.boxlite/` | `.relay/` | `brand.dir` |
| `bxl_app_…` keys | `rl_app_…` | `brand.keyPrefix` |
| `BOXLITE_API_URL`, `_KEY`, `_APP`, `_ENV` | `RELAY_API_URL`, … | `brand.envPrefix` |
| `X-BoxLite-User-*`, `X-BoxLite-Control`, `X-BoxLite-Schedule`, `X-BoxLite-Identity` | `X-Relay-…` | `brand.headerPrefix` |
| `bxl_session`, `bxl_access`, `bxl_login`, `__Host-bxl_console` | `rl_…` | `brand.cookiePrefix` |
| `boxlite.users`, `boxlite.current_user_id()` | `relay.users`, `relay.current_user_id()` | `brand.sqlSchema` |
| `/.boxlite/auth/*`, `/.boxlite/open`, `/.boxlite/sv/*` | `/.relay/…` | `brand.reservedPath` |
| `agent.md` text, `SKILL.md`, prompt template | generated from the same module | |
| supervisor `X-BoxLite-Control`, `/home/boxlite` | `brand.go` constants; the home dir comes from the sandbox env | |

Rules that make it stick:

- `shared/src/brand.ts` and `supervisor/internal/brand/brand.go` are the only files with literal
  names; everything else composes them (`${brand.envPrefix}_API_KEY`).
- A test (`test/no-brand-leak.test.ts`, like today's `code-health.test.ts`) greps the source for
  `boxlite|bxl_` and fails on any hit outside `providers/boxlite/` and that provider's docs.
- The agent guide is a template rendered at build time, so an agent reading `agent.md` sees the
  product's own names, never two sets.

The `X-…-User-*` header contract for apps is the one rename users of existing apps would feel;
there are none outside our own test apps, so there is no compatibility layer to carry.

## 5. The console as its own app

The console pages (`components/apps/*`, tabs, hooks, `lib/apps`) are already a self-contained
feature; what they borrow from the dashboard is the UI kit (`components/ui/*`, shadcn-based),
the query client, the layout shell and the session/org provider. Plan:

- a `console/` package in the new repo (Vite + React), with a vendored copy of the UI kit (the
  components are MIT-licensed primitives; the visual language stays the one the product owner
  approved);
- its own shell: sign-in page, org switcher, Apps list, App page; routing by `react-router`;
- the service serves it at `/console/` as it does `console-dist/` today; the console API is
  unchanged;
- sign-in: the existing `console-signin.ts` generalised to any configured OAuth provider
  (GitHub, Google, Microsoft, OIDC); the org model (owner/members, app limits, suspension) is
  already in `orgs.ts` and is not BoxLite-specific.

## 6. Running it on a VM

`deploy/vm/` in the new repo:

```
docker compose:
  service       the deployment service (Node 22), data dir /var/lib/relay (SQLite, blobs, previews, volumes)
  postgres      metadata-free; the app databases (DatabaseProvider=postgres), volume for data
  caddy         TLS (wildcard via DNS challenge, or on-demand), *.apps.<domain> → service:8080, console.<domain> → service:8081
  docker.sock   mounted into `service` for SandboxProvider=docker
```

Requirements on the VM: Docker, a wildcard DNS record, and outbound HTTPS (sandboxes pull the
supervisor binary from the service and packages from npm/PyPI). The e2e suites (`run-live`,
`errors-live`, `console.spec`) run unchanged against a VM, because they only use the CLI and the
console; that is the acceptance test for "provider-neutral".

Sizing: one `small` sandbox today is 1 CPU / 2 GB; a 4 vCPU / 16 GB VM runs about six active apps
with idle-stop doing the rest.

## 7. Phases

| phase | work | result | size |
|---|---|---|---|
| 0 | `brand.ts`/`brand.go`, mechanical rename, leak test, agent guide templated | the same product under a neutral name; all suites green | 2 days |
| 1 | extract `SandboxProvider` from `BoxliteClient` + `BoxProvisioner` + `origins.ts`; `DatabaseProvider` from `NeonClient` + `DatabaseProvisioner`; capability flags wired into views and CLI hints; BoxLite and Neon become `providers/` | identical behaviour on BoxLite; connector boundary enforced by the type system | 3 days |
| 2 | `providers/docker` + host-based ingress + service-owned idle-stop; `providers/postgres`; `deploy/vm` compose; suites run against a VM | deployable on any VM | 5 days |
| 3 | console extracted into `console/` with its own shell and sign-in | the whole product in one repo | 4 days |
| 4 | optional: `providers/ssh` for multi-host, Postgres as metadata store for HA | fleet scale | later |

Phase 0 and 1 can land in the current repo behind the same tests; the new repo is created at the
end of phase 1 by moving the tree, so history is kept.

## 8. Risks and what settles them

- **Supervisor assumptions about the host** (`/home/boxlite`, idmapped volumes, the signed
  release download path): the supervisor already reads its sandbox path from a flag; the volume
  ownership mode and home directory become environment variables set by the provider. Covered by
  the gateway file tests on both modes.
- **Per-origin cookies and `__Host-` prefixes** assume one origin per environment; host-based
  ingress keeps that (one hostname per environment), so the cookie model is untouched.
- **Idle-stop by the service** must not stop a sandbox mid-deploy or mid-schedule: the
  orchestrator and scheduler already hold "busy" state the waker consults; the stop path reads the
  same.
- **Postgres provider without PITR**: rollback restore points become `pg_dump` snapshots taken
  before each migration (the console already explains a 6-hour restore window per provider; the
  text comes from capabilities).
- **Name changes break nothing external** today; the only consumer is our own agent guide.

## 9. What this does not change

The agent-facing contract: one prompt, `init → check → plan → deploy`, the error envelope with
`code/next`, the diagnosis causes, `app context`, test sessions, secrets, public paths, the
console's information architecture. Those are the product; the connector layer is what lets the
product leave the Box.
