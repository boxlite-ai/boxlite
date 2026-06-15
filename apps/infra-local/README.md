# `apps/infra-local/` — BoxLite-Based Local Dev Stack

Brings up the full cloud-MVP control plane on one Apple Silicon Mac, dogfooding
BoxLite. Two layers:

- **L1 — 11 BoxLite microVM boxes**: postgres, redis, minio (+ a one-shot bucket
  init), registry, dex, jaeger, pgadmin, registry-ui, otel-collector, caddy.
  Driven by the `boxlite_local` Python orchestrator.
- **L2 — 4 native macOS processes**: API (NestJS, `:3001`), Runner (Go, `:3003`),
  Proxy (Go, `:4000`), Dashboard (Vite, `:3000`). Driven by `make stack-*`.

All generated state lives under one gitignored dir, `<repo>/.apps-local/`
(`data/` volumes, `boxlite/` L1 SDK home, `boxlite-runner/` L3 home, `bin/`
binaries, `logs/`).

## Quick start

Prereqs: macOS Apple Silicon; the BoxLite Python SDK (`pip install -e
../../sdks/python`) + `boxlite` CLI on `$PATH`; Go 1.25+; Node + yarn (corepack);
Python 3.10+.

```bash
cd apps/infra-local
make stack-up        # idempotent + self-healing: installs deps, builds binaries, brings up L1+L2
make stack-status    # one-screen health across L1 + L2
make stack-down      # stop L2 (add ARGS=--all to also stop L1)
```

First run pulls 11 images (~5–7 min); later runs reuse the cache (~30–60 s). Log
in at <http://localhost:3000> through Dex (`admin@boxlite.dev` / `password`).

## Make targets

| Target | What |
|---|---|
| `stack-up` | ensure L1 up + start all L2 (idempotent, self-healing) |
| `stack-status` | health check across L1 + L2 |
| `stack-down [ARGS=--all]` | stop L2 (and L1 with `--all`) |
| `stack-restart COMPONENTS="api proxy"` | restart L2 components (runner also rebuilds) |
| `stack-logs COMPONENT=api` | tail a component log (`all` for everything) |
| `stack-reset` / `stack-reset-hard` / `stack-nuke` | tiered cleanup: light → schema rebuild → full cold start |
| `stack-rebuild-l1-box BOX=dex` | destroy + recreate one stuck L1 box |
| `up` / `down` / `ps` / `doctor` | L1-only (`python -m boxlite_local …`) |

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
| otel (OTLP HTTP) | `http://127.0.0.1:24318/v1/traces` | — |
| caddy (unified entry) | `http://127.0.0.1:28080/` | reverse-proxies all of the above |
| Dashboard / API | `http://localhost:3000` / `:3001/api` | login via Dex |

Inside a box, reach the host via `host.boxlite.internal:<port>` (gvproxy DNS —
only resolvable in a box). `InfraConfig` in `boxlite_local/config.py` is the
source of truth; `BOXLITE_*` env vars override credentials/paths only — **host
ports are fixed** as the `ServiceSpec.ports` literals in `services.py`.

## Validating it works

There is no infra-local test suite — the stack is its own smoke test:

```bash
make stack-up && make stack-status   # every L1 + L2 row green
```

The app's browser E2E (`npm run e2e:local` from `apps/`) covers the SDK → API →
runner path against a separate Docker stack. The direct-SDK capability this stack
relies on — read-write host volumes + host port mapping — is pinned by
`sdks/python/tests/test_volume_port_persistence.py`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Dashboard `Unauthorized` / `401` right after login | dex box clock drifted behind the host after the Mac slept → tokens are born expired | `make stack-rebuild-l1-box BOX=dex` + clear browser storage |
| Box `pulling` stuck for minutes | registry box's process hung (TCP still listens) | `make stack-rebuild-l1-box BOX=registry` |
| All API calls `401` | `SSH_GATEWAY_API_KEY` / `PROXY_API_KEY` empty in `apps/api/.env` | set them non-empty |
| Runner: `Another BoxliteRuntime is already using directory` | a stale runner holds `.apps-local/boxlite-runner/.lock` | `lsof` the lock, kill the stale PID |
| Any L1 box misbehaving | its stateful in-box process is wedged | `make stack-rebuild-l1-box BOX=<name>` |
| "Create Box" from the UI is incomplete | image resolution is mid-rewrite upstream + the picker is PostHog flag-gated | known limitation; use `POST /api/box` directly |

> **Box boot is unverified on this stack** — image resolution is mid-rewrite
> upstream (`TODO(image-rewrite)` in `apps/api/src/box/services/box.service.ts`)
> and the dashboard image picker was removed. L1 services, API, runner, auth, and
> the dashboard all work.

## Architecture

- **`boxlite_local/`** — flat async package: `services.py` (the `ServiceSpec`
  registry + `SERVICES`), `orchestrator.py` (topo-ordered `up`/`down`/`ps` +
  healthchecks), `doctor.py` (preflight), `config.py` (`InfraConfig`), `cli.py`.
- **`scripts/`** — the `make stack-*` wrappers that supervise the L2 native
  processes; `configs/api.env` seeds `apps/api/.env` on first `stack-up`.
- **Add a service**: one `ServiceSpec` + a `SERVICES` entry; its host port is the
  literal in `ServiceSpec.ports`.
