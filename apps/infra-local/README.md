# `apps/infra-local/` — BoxLite-Based Local Dev Stack

Brings up the full cloud-MVP control plane on one Apple Silicon Mac, dogfooding
BoxLite. One Python orchestrator (`compose`) drives both layers:

- **L1 — 11 BoxLite microVM boxes**: postgres, redis, minio (+ a one-shot bucket
  init), registry, dex, jaeger, pgadmin, registry-ui, otel-collector, caddy —
  via the BoxLite SDK (`orchestrator.py` / `services.py`).
- **L2 — 4 native macOS processes**: API (NestJS, `:3001`), Runner (Go, `:3003`),
  Proxy (Go, `:4000`), Dashboard (Vite, `:3000`) — via `subprocess` supervision
  (`native.py`).

All generated state lives under one gitignored dir, `<repo>/.apps-local/`
(`data/` volumes, `boxlite/` L1 SDK home, `boxlite-runner/` L3 home, `bin/`
binaries, `logs/`).

## Quick start

Prereqs: macOS Apple Silicon; the BoxLite Python SDK (`pip install -e
../../sdks/python`); Go 1.25+; Node + yarn (corepack); Python 3.10+.

```bash
cd apps/infra-local
make up        # idempotent + self-healing: installs deps, builds binaries, brings up L1+L2
make status    # one-screen health across L1 + L2
make down      # stop L2 (add ARGS=--all to also stop L1)
```

First run pulls 11 images (~5–7 min); later runs reuse the cache (~30–60 s). Log
in at <http://localhost:3000> through Dex (`admin@boxlite.dev` / `password`).

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
| otel (OTLP HTTP) | `http://127.0.0.1:24318/v1/traces` | — |
| caddy (unified entry) | `http://127.0.0.1:28080/` | reverse-proxies all of the above |
| Dashboard / API | `http://localhost:3000` / `:3001/api` | login via Dex |

Inside a box, reach the host via `host.boxlite.internal:<port>` (gvproxy DNS —
only resolvable in a box). `InfraConfig` in `compose/config.py` is the source of
truth; `BOXLITE_*` env vars override credentials/paths only — **host ports are
fixed** as the `ServiceSpec.ports` literals in `services.py`.

## Validating it works

There is no infra-local test suite — the stack is its own smoke test:

```bash
make up && make status   # every L1 + L2 row green
```

The app's browser E2E (`npm run e2e:local` from `apps/`) covers the SDK → API →
runner path against a separate Docker stack. The direct-SDK capability this stack
relies on — read-write host volumes + host port mapping — is pinned by
`sdks/python/tests/test_volume_port_persistence.py`.

### Stripe Sandbox Billing

Stripe tests use test-mode credentials only. Start the API with
`BILLING_PAYMENT_PROVIDER=stripe`, `STRIPE_SECRET_KEY=sk_test_...`, and the
webhook secret printed by `stripe listen --print-secret`. From `apps/`, use one
shell for the API and listener:

```bash
export STRIPE_SECRET_KEY=sk_test_...
export STRIPE_WEBHOOK_SECRET="$(stripe listen --skip-update --print-secret --color off)"
set -a; source infra-local/api.env; set +a
export BILLING_PAYMENT_PROVIDER=stripe
(cd infra-local && make restart COMPONENTS="api dashboard")
yarn billing:stripe:listen
```

While the listener is running, use a second shell:

```bash
yarn e2e:billing:stripe      # replaces the local test card and adds a $5 test top-up
```

The E2E refuses non-loopback PostgreSQL, verifies `cus_` / `pm_` setup, and
requires exactly one wallet ledger credit. Credentials stay in environment
variables; do not add them to `api.env` or Git.

To verify prepaid enforcement against a real local Box, start the API with
`BILLING_ENFORCEMENT_ENABLED=true`, then run:

```bash
yarn e2e:billing:enforcement:local
```

The test temporarily zeroes the local wallet, verifies Create/Start return 402
and the minute sweep stops the running Box, then restores the wallet and removes
the test Box. It refuses non-loopback Dashboard and PostgreSQL endpoints.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Dashboard `Unauthorized` / `401` right after login | dex box clock drifted behind the host after the Mac slept → tokens are born expired | `make restart COMPONENTS=dex` + clear browser storage |
| Box `pulling` stuck for minutes | registry box's process hung (TCP still listens) | `make restart COMPONENTS=registry` |
| All API calls `401` | `SSH_GATEWAY_API_KEY` / `PROXY_API_KEY` empty in `apps/api/.env` | set them non-empty |
| Runner: `Another BoxliteRuntime is already using directory` | a stale runner holds `.apps-local/boxlite-runner/.lock` | `lsof` the lock, kill the stale PID |
| Any L1 box misbehaving | its stateful in-box process is wedged | `make restart COMPONENTS=<box>` |
| "Create Box" from the UI is incomplete | image resolution is mid-rewrite upstream + the picker is PostHog flag-gated | known limitation; use `POST /api/box` directly |

> **Box boot is unverified on this stack** — image resolution is mid-rewrite
> upstream (`TODO(image-rewrite)` in `apps/api/src/box/services/box.service.ts`)
> and the dashboard image picker was removed. L1 services, API, runner, auth, and
> the dashboard all work.

## Layout

Everything is the `compose` package + four root files (no `scripts/`, no `configs/`):

```text
apps/infra-local/
├── Makefile          # thin aliases → python -m compose <cmd>
├── README.md
├── pyproject.toml
├── api.env           # API .env template (copied to apps/api/.env on first `up`)
└── compose/
    ├── __main__.py   # the `python -m compose` CLI (up/down/status/logs/restart/reset/nuke)
    ├── config.py     # InfraConfig (single source of truth)
    ├── services.py   # the L1 ServiceSpec registry + SERVICES
    ├── orchestrator.py  # L1 box lifecycle (BoxLite SDK)
    ├── native.py     # L2 native-process supervision (subprocess/pidfiles/signals)
    ├── doctor.py     # preflight checks
    └── _sdk.py       # BoxLite SDK import shim
```

**Add an L1 service**: one `ServiceSpec` + a `SERVICES` entry in `services.py`;
its host port is the literal in `ServiceSpec.ports`.
