# `apps/infra-local/` — BoxLite-Based Local Dev Stack

Brings up the full cloud-MVP control plane on one Apple Silicon Mac, dogfooding
BoxLite. One Python orchestrator (`compose`) drives both layers:

- **L1 — 11 BoxLite microVM boxes**: postgres, redis, minio (RustFS S3),
  registry, dex, jaeger, pgadmin, registry-ui, maildev, otel-collector, caddy —
  via the BoxLite SDK (`orchestrator.py` / `services.py`).
- **L2 — 5 native macOS processes**: API (NestJS, `:3001`), registry proxy (Go,
  `:4100`), Runner (Go, `:3003`), Proxy (Go, `:4000`), Dashboard (Vite, `:3000`) —
  via `subprocess` supervision (`native.py`).

Generated data, binaries, logs, and registry secrets live under the gitignored
`<repo>/.apps-local/`. Socket-bearing SDK homes use `~/.bl/<worktree-hash>/h`
(L1) and `/r` (runner), keeping macOS socket paths short and checkouts isolated.
`BOXLITE_LOCAL_STATE_ROOT` overrides that short parent directory.

## Quick start

Prereqs: macOS Apple Silicon; Go 1.25+; Node + yarn (corepack); Python 3.10+.
Make creates `.venv-infra` and installs the package; `up` builds the local SDK.
An interrupted package installation is retried on the next command.

```bash
cd apps/infra-local
make up        # idempotent + self-healing: installs deps, builds binaries, brings up L1+L2
make status    # one-screen health across L1 + L2
make down      # stop L2 (add ARGS=--all to also stop L1)
```

First run pulls 11 images; later runs reuse their cache. Before the first login,
configure [local registration](#local-registration), then sign in at
<http://localhost:3000> through Dex (`admin@boxlite.dev` / `password`).

### Local registration

The API template includes Cloudflare's public test credentials so a fresh local
stack can start. These credentials cannot complete BoxLite registration:
[Cloudflare's dummy response](https://developers.cloudflare.com/turnstile/troubleshooting/testing/#validation-response)
reports `example.com` and omits `action`, while BoxLite requires the configured
hostname and `action=signup`.

To create local accounts, use a dedicated Managed Turnstile development widget
with `localhost` authorized (add `127.0.0.1` if you browse that address). Put its
sitekey and secret in the gitignored `apps/api/.env`:

```dotenv
TURNSTILE_SITEKEY=your-development-widget-sitekey
TURNSTILE_SECRET_KEY=your-development-widget-secret
TURNSTILE_EXPECTED_HOSTNAMES=localhost,127.0.0.1
TURNSTILE_TIMEOUT_MS=5000
```

Restart with `make restart COMPONENTS=api` and reload the Dashboard. Registration
requires access to Cloudflare and keeps the same hostname and action checks as
deployed environments. Existing local `.env` files are preserved: add these
settings when upgrading a checkout whose file predates Turnstile. Ordinary
access by existing accounts does not run a new challenge.

## Commands

`make <verb>` is a thin alias for `python -m compose <verb>` (the CLI is the
source of truth — `python -m compose --help`):

| Command | What |
|---|---|
| `make up [COMPONENTS="api runner"]` | ensure L1 boxes + start L2 (self-healing: installs deps, builds missing binaries, seeds) |
| `make status` | one-screen L1 + L2 health |
| `make down [ARGS=--all]` | stop L2 processes (`--all` also stops/removes L1 boxes; data kept) |
| `make restart COMPONENTS="runner dex"` | restart L2 proc(s) (the Go ones — runner, proxy, registry-proxy — rebuild) **and/or** recreate L1 box(es) |
| `make logs COMPONENT=api` | tail a component log (`all` for everything) |
| `make reset [ARGS=--hard]` | wipe L2 runtime state (`--hard` also drops + rebuilds the schema) |
| `make nuke` | tear down **everything** — destroy L1 boxes + wipe data + logs (cold start) |

## Endpoints

| Service | Host endpoint | Credentials |
|---|---|---|
| postgres | `postgresql://boxlite:boxlite@127.0.0.1:25432/boxlite` | trust auth (local only) |
| redis | `redis://127.0.0.1:26379` | none |
| minio (RustFS S3 / console) | `http://127.0.0.1:29000` / `:29001` | `minioadmin` / `minioadmin` |
| registry | `http://127.0.0.1:25000/v2/` | none |
| dex (OIDC) | `http://localhost:25556/dex` | `admin@boxlite.dev` / `password` (also `test01@boxlite.dev`) |
| jaeger | `http://127.0.0.1:26686/` | — |
| pgadmin | `http://127.0.0.1:25051/` | `admin@boxlite.dev` / `boxlite` |
| registry-ui | `http://127.0.0.1:25052/` | — |
| maildev (caught mail) | `http://127.0.0.1:25053/` (UI) / SMTP `:25054` | none — accepts any sender |
| otel (OTLP HTTP) | `http://127.0.0.1:24318/v1/traces` | — |
| caddy (unified entry) | `http://127.0.0.1:28080/` | reverse-proxies all of the above |
| Dashboard / API | `http://localhost:3000` / `:3001/api` | login via Dex |

Inside a box, reach the host via `host.boxlite.internal:<port>` (gvproxy DNS —
only resolvable in a box). `InfraConfig` in `compose/config.py` is the source of
truth; `BOXLITE_*` env vars override credentials/paths only — **host ports are
fixed** as the `ServiceSpec.ports` literals in `services.py`.

## Validating it works

```bash
make test               # deterministic SDK/process/HTTP boundary tests; no VMs
make test-storage       # isolated S3 VM on a free port; preserves another running stack
make test-storage-client # signed CRUD on existing S3; temporary object removed
make up && make status  # full-stack smoke when fixed ports are available
```

From the repository root, `make test:apps:infra-local` runs the same unit suite.
`test-storage` checks signed bucket initialization, object write/read/delete,
healthy-box reuse, and persistence after recreation with the same host directory.
These checks establish component behavior; full app startup and Box lifecycle
still require the full-stack smoke and API/runner end-to-end checks.

### Startup and recovery

`up` reconciles every L1 daemon in dependency order. Healthy running boxes stay;
failed, stopped, or unhealthy boxes are recreated once, retaining host volumes.
An unsuccessful replacement fails startup before native apps start.

The legacy `minio` service now uses pinned RustFS 1.0.4. Host-side Boto3 creates
and verifies the `boxlite` bucket, replacing the unavailable `minio/mc` image.
Only a missing bucket permits creation; authentication and other errors fail
startup. Storage lives in `data/rustfs`; existing `data/minio` remains untouched
and needs an explicit object migration if its contents matter.

RustFS runs as root inside its development VM to support a host-owned writable
directory without changing host ownership. The credentials and ports retain the
`BOXLITE_MINIO_*` names and defaults for compatibility.

Before linking the runner, startup asks the existing C build target to check
Rust inputs and prepares changed Go symbols. The archive digest becomes a cgo
input, preventing Go's cache from retaining a binary linked to an old archive.
Only requested native components are rebuilt. A requested stale runner stops
before rebuilding; API-only startup keeps the existing runner process running.

Native pidfiles record PID and process start time. Stops verify both and require
a detached process-group leader before signaling; legacy numeric records and
reused PIDs are unverified. Occupied ports fail with a conflict instead of
killing another checkout. After upgrading with old pidfiles, inspect the listener
and stop it explicitly before retrying. Start times have one-second precision;
this protects against accidental reuse, not hostile process replacement.

`status` exits nonzero for missing, failed, stopped, or unhealthy dependencies,
and uses HTTP probes for native services that expose them.

### Local MCP testing

Use an API key with `Authorization: Bearer <key>` at `http://localhost:3001/mcp`.
Dex remains the dashboard's login provider; Dex 2.42 lacks the MCP permission
scopes and client-metadata discovery needed for MCP browser sign-in.

Postgres intentionally retains `statement_timeout=30s`. Incident integration
tests compare the restored setting with the database's configured baseline.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Dashboard `Unauthorized` / `401` right after login | dex box clock drifted behind the host after the Mac slept → tokens are born expired | `make restart COMPONENTS=dex` + clear browser storage |
| Box `pulling` stuck for minutes | registry box's process hung (TCP still listens) | `make restart COMPONENTS=registry` |
| All API calls `401` | `PROXY_API_KEY` empty in `apps/api/.env` | set it non-empty |
| Runner: `Another BoxliteRuntime is already using directory` | a stale runner holds `.apps-local/boxlite-runner/.lock` | `lsof` the lock, kill the stale PID |
| Any L1 box misbehaving | its stateful in-box process is wedged | `make restart COMPONENTS=<box>` |
| Native port conflict after upgrade | another checkout owns the port, or an old numeric pidfile cannot establish ownership | inspect with `lsof -nP -iTCP:<port> -sTCP:LISTEN`; stop the identified process explicitly |

The API's image registry allowlist is separate from the runner's
`INSECURE_REGISTRIES`. Booting from `127.0.0.1:25000` requires explicitly allowing
that registry in `apps/api/.env`.

## Layout

The `compose` package owns orchestration; `tests/` holds boundary and VM checks:

```text
apps/infra-local/
├── Makefile          # thin aliases → python -m compose <cmd>
├── README.md
├── pyproject.toml
├── api.env           # API .env template (copied to apps/api/.env on first `up`)
├── tests/            # deterministic regressions + isolated storage smoke
└── compose/
    ├── __main__.py   # the `python -m compose` CLI (up/down/status/logs/restart/reset/nuke)
    ├── config.py     # InfraConfig (single source of truth)
    ├── services.py   # the L1 ServiceSpec registry + SERVICES
    ├── orchestrator.py  # L1 box lifecycle (BoxLite SDK)
    ├── native.py     # L2 native-process supervision (subprocess/pidfiles/signals)
    ├── _local_arm64.py  # SDK/bootstrap and native-archive preparation
    ├── doctor.py     # preflight checks
    ├── storage.py    # signed host-side S3 bucket initialization
    └── _sdk.py       # BoxLite SDK import shim
```

**Add an L1 service**: one `ServiceSpec` + a `SERVICES` entry in `services.py`;
its host port is the literal in `ServiceSpec.ports`.
