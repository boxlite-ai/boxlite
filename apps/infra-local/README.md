# `apps/infra-local/` — BoxLite-Based Local Dev Stack

Brings up the full cloud-MVP control plane on one Apple Silicon Mac, dogfooding
BoxLite. One Python orchestrator (`compose`) drives both layers:

- **L1 — 12 BoxLite microVM boxes**: postgres, redis, minio (+ a one-shot bucket
  init), registry, dex, jaeger, pgadmin, registry-ui, maildev, otel-collector, caddy —
  via the BoxLite SDK (`orchestrator.py` / `services.py`).
- **L2 — 4 native macOS processes**: API (NestJS, `:3001`), Runner (Go, `:3003`),
  Proxy (Go, `:4000`), Dashboard (Vite, `:3000`) — via `subprocess` supervision
  (`native.py`).

Data volumes, binaries, logs, and the L1 BoxLite home live under
`<repo>/.apps-local/`; the L1 home defaults to `.apps-local/.bl/h`, including
its ext4 image cache. The runner's separate home defaults to `~/.bl/<worktree-hash>/r`.

## Quick start

Prereqs: macOS Apple Silicon; the BoxLite Python SDK (`pip install -e
../../sdks/python`); Go 1.25+; Node + yarn (corepack); Python 3.10+.

```bash
cd apps/infra-local
make up        # idempotent + self-healing: installs deps, builds binaries, brings up L1+L2
make status    # one-screen health across L1 + L2
make down      # stop L2 (add ARGS=--all to also stop L1)
```

On `make up`, infra-local checks the ext4 cache for each L1 service image.
It builds the project-internal `boxlite-infra-image` tool from this checkout;
the tool is separate from the public Python SDK.
Missing disks are built from OCI in a short-lived `sudo` process; cached disks
need no root access. The resulting disks are installed in the developer's cache,
and the L1 boxes and L2 processes continue under the developer's account.
A cold start invokes `sudo` once, even when several image disks are missing.
Log in at <http://localhost:3000>
through Dex (`admin@boxlite.dev` / `password`).

The L2 runner has a separate image cache. If it must pull a new OCI image and
convert it to a filesystem at runtime, **start the runner with root privileges**
(or prebuild that image's disk as root in its cache). The L1 startup step does
not prepare arbitrary images requested later through the runner. Reusing an
already built runner image disk does not require root for this conversion.

## Commands

`make <verb>` is a thin alias for `python -m compose <verb>` (the CLI is the
source of truth — `python -m compose --help`):

| Command | What |
|---|---|
| `make up [COMPONENTS="api runner"]` | ensure L1 boxes + start L2 (self-healing: installs deps, builds missing binaries, seeds) |
| `make status` | one-screen L1 + L2 health |
| `make down [ARGS=--all]` | stop L2 processes (`--all` also stops/removes L1 boxes; data kept) |
| `make restart COMPONENTS="runner dex"` | restart L2 proc(s) (runner/proxy rebuild) **and/or** recreate L1 box(es) |
| `make logs COMPONENT=api` | tail a component log (`all` for everything) |
| `make reset [ARGS=--hard]` | wipe L2 runtime state (`--hard` also drops + rebuilds the schema) |
| `make nuke` | tear down **everything** — destroy L1 boxes + wipe data + logs (cold start) |

## Endpoints

| Service | Host endpoint | Credentials |
|---|---|---|
| postgres | `postgresql://boxlite:boxlite@127.0.0.1:25432/boxlite` | trust auth (local only) |
| redis | `redis://127.0.0.1:26379` | none |
| minio (S3 / console) | `http://127.0.0.1:29000` / `:29001` | `minioadmin` / `minioadmin` |
| registry | `http://127.0.0.1:25000/v2/` | none |
| dex (OIDC) | `http://localhost:25556/dex` | `admin@boxlite.dev` / `password` (also `test01@boxlite.dev`) |
| jaeger | `http://127.0.0.1:26686/` | — |
| pgadmin | `http://127.0.0.1:25051/` | `admin@boxlite.dev` / `boxlite` |
| registry-ui | `http://127.0.0.1:25052/` | — |
| maildev (caught mail) | `http://127.0.0.1:25053/` (UI) / SMTP `:25054` | none — accepts any sender |
| otel (OTLP HTTP) | `http://127.0.0.1:24318/v1/traces` | — |
| caddy (unified entry) | `http://127.0.0.1:28080/` | reverse-proxies all of the above |
| Dashboard / API | `http://localhost:3000` / `:3001/api` | login via Dex |

For example, Caddy forwards `3000-d-<hex-box-id>.localhost:28080` to the local
proxy with its Host header intact; the proxy decodes the box ID.

Inside a box, reach the host via `host.boxlite.internal:<port>` (gvproxy DNS —
only resolvable in a box). `InfraConfig` in `compose/config.py` is the source of
truth; `BOXLITE_*` env vars override credentials/paths only — **host ports are
fixed** as the `ServiceSpec.ports` literals in `services.py`.

## Validating it works

Run the image preparation and credential fallback tests, then smoke-test the stack:

```bash
make test
make up && make status   # every L1 + L2 row green
```

GHCR credentials come from explicit environment variables, then GitHub CLI, then
Docker's credential store. If GitHub CLI fails or times out, the lookup tries
Docker's credential store; unexpected programming errors remain visible.

The app's browser E2E (`npm run e2e:local` from `apps/`) covers the SDK → API →
runner path against a separate Docker stack. The direct-SDK capability this stack
relies on — read-write host volumes + host port mapping — is pinned by
`sdks/python/tests/test_volume_port_persistence.py`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Dashboard `Unauthorized` / `401` right after login | dex box clock drifted behind the host after the Mac slept → tokens are born expired | `make restart COMPONENTS=dex` + clear browser storage |
| Box `pulling` stuck for minutes | registry box's process hung (TCP still listens) | `make restart COMPONENTS=registry` |
| All API calls `401` | `PROXY_API_KEY` empty in `apps/api/.env` | set it non-empty |
| Runner: `Another BoxliteRuntime is already using directory` | a stale runner holds `~/.bl/<worktree-hash>/r/.lock` by default | `lsof` the lock, stop the stale runner process |
| Any L1 box misbehaving | its stateful in-box process is wedged | `make restart COMPONENTS=<box>` |
| "Create Box" from the UI is incomplete | image resolution is mid-rewrite upstream + the picker is PostHog flag-gated | known limitation; use `POST /api/box` directly |

> **Box boot is unverified on this stack** — image resolution is mid-rewrite
> upstream (`TODO(image-rewrite)` in `apps/api/src/box/services/box.service.ts`)
> and the dashboard image picker was removed. L1 services, API, runner, auth, and
> the dashboard all work.

## Layout

The internal `boxlite-infra-image` tool is built by `make infra-local-image-tool`.
Its `path` mode reports the ext4 cache path for each image; `prepare` creates
missing disks. `compose.image_prebuild` validates the tool's result before the
startup flow uses it. This tool is not part of the public BoxLite CLI or SDK.

The orchestrator is the `compose` package; its tests live alongside it:

```text
apps/infra-local/
├── Makefile          # thin aliases → python -m compose <cmd>
├── README.md
├── pyproject.toml
├── api.env           # API .env template (copied to apps/api/.env on first `up`)
├── compose/
│   ├── __main__.py   # the `python -m compose` CLI (up/down/status/logs/restart/reset/nuke)
│   ├── config.py     # InfraConfig (single source of truth)
│   ├── services.py   # the L1 ServiceSpec registry + SERVICES
│   ├── orchestrator.py  # L1 box lifecycle (BoxLite SDK)
│   ├── image_prebuild.py  # root-only OCI-to-ext4 preparation for L1
│   ├── registries.py  # image registry credentials for L1 and runner
│   ├── native.py     # L2 native-process supervision (subprocess/pidfiles/signals)
│   ├── doctor.py     # preflight checks
│   └── _sdk.py       # BoxLite SDK import shim
└── tests/            # image preparation and credential fallback tests
```

**Add an L1 service**: one `ServiceSpec` + a `SERVICES` entry in `services.py`;
its host port is the literal in `ServiceSpec.ports`.
