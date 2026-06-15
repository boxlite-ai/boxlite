# `apps/infra-local/` — BoxLite-Based Local Dev Stack

`apps/infra-local/` orchestrates the full cloud-MVP control plane on a
single Apple Silicon Mac. It owns two layers:

- **L1 — 10 BoxLite microVM boxes** providing postgres / redis / minio /
  registry / dex / jaeger / pgadmin / registry-ui / otel-collector / caddy
  (plus a one-shot minio bucket bootstrap). Driven by the `boxlite_local`
  Python orchestrator. Replaces the previous `docker-compose` based
  `apps/local-dev/` setup — "eat your own dogfood" per the project
  principle.
- **L2 — 4 native macOS processes** for the application control plane:
  NestJS API (`:3001`), Go Runner (`:3003`), Go Proxy (`:4000`), Vite
  Dashboard (`:3000`). Driven by `make stack-*` wrapper scripts under
  [`scripts/`](scripts/).

User boxes (L3) are spawned by the L2 Runner as libkrun microVMs
under `<repo>/.apps-local/boxlite-runner/`.

ALL generated state lives under one gitignored repo-root dir:

```
<repo>/.apps-local/
├── bin/             native runner + proxy binaries (stack-build.sh)
├── logs/            L2 process logs + pid files
├── data/            L1 service volumes (pg / redis / minio / registry)
├── boxlite/         SDK home for the L1 boxes (BOXLITE_HOME)
└── boxlite-runner/  runner home for L3 user boxes (BOXLITE_HOME_DIR)
```

Cold-start to
working box + browser terminal in ~80 s (box boot / image resolution is
mid-rewrite upstream and unverified here — see limitation #4). Daily dev workflow
documented in the [Usage guide](#usage-guide) below.
Known limitations: see [§Known limitations](#known-limitations).

---

## Quick start

Prereqs: macOS Apple Silicon, BoxLite SDK installed
(`pip install -e ../../sdks/python` from the boxlite repo), Python 3.10+,
Go 1.25+, Node + yarn (for L2).

```bash
cd apps/infra-local

# Bring up the full L1 + L2 stack. Idempotent + self-healing: on a fresh
# checkout it auto-runs `make install` (orchestrator package) and builds
# the native binaries; on a restart it skips straight to bringing things
# up. Safe to run from zero, after a reboot, or after `make stack-down`.
make stack-up

# One-screen health check across L1 + L2
make stack-status

# Tail logs (api | runner | proxy | dashboard | all)
make stack-logs COMPONENT=api

# Tear down L2 only (L1 boxes stay up)
make stack-down
# ...or tear down L1 too
make stack-down ARGS=--all
```

> `make stack-up` is the single entry point. You can still run
> `make install` / `make stack-build` explicitly (e.g. to force a
> rebuild after pulling new code), but you don't have to — stack-up
> runs them automatically when they're needed.

### Migrating from the pre-`.apps-local` layout

Older checkouts kept state in `~/.boxlite` (L1 boxes),
`~/.boxlite-local/data` (volumes), `~/.boxlite-runner/` (runner home),
`/tmp/boxlite-{runner,proxy}` (binaries) and `apps/infra-local/.logs/`.
One-time cleanup:

```bash
cd apps/infra-local
BOXLITE_HOME=$HOME/.boxlite make down        # stop L2 + remove OLD L1 boxes
rm -rf ~/.boxlite-local ~/.boxlite-runner    # old volumes + runner home
rm -f /tmp/boxlite-runner /tmp/boxlite-proxy # old binaries
# optional — only if nothing else on this machine uses BoxLite:
# rm -rf ~/.boxlite

make stack-up                                # cold start under <repo>/.apps-local/
```

### Make targets

L1-only (just the BoxLite boxes):

```text
  install            install the package + test extras
  up                 bring L1 services up (runs doctor preflight first)
  down               stop + remove L1 services
  wipe               stop + remove + wipe data dir
  ps                 list running boxlite-local-* boxes
  doctor             run preflight checks (SDK + runtime + port conflicts)
  migrate            build local pg schema by running all TypeORM migrations from scratch
  seed-init-data     ensure dashboard-required base data (admin org, default region, wait runner)
```

L2 stack wrappers (L1 + native API/Runner/Proxy/Dashboard):

```text
  stack-build              build native runner + proxy binaries + yarn install
  stack-up                 ensure L1 up + start all L2 native processes (idempotent)
  stack-down               stop all L2 native processes (ARGS=--all also stops L1)
  stack-restart            restart one or more L2 components (COMPONENTS="api proxy")
  stack-status             one-screen health check across L1 + L2
  stack-logs               tail logs (COMPONENT=api|runner|proxy|dashboard|all)
  stack-reset              wipe L2 runtime state (PG user data + runner home; L1 + schema preserved)
  stack-reset-hard         like stack-reset, but also drops + rebuilds the schema via migrations
  stack-nuke               absolute nuke: L1 boxes destroyed + data wiped + logs cleared
  stack-rebuild-l1-box     destroy + recreate one L1 box (BOX=dex|registry|...) — for stuck stateful services
```

Tests:

```text
  test          run unit tests (no BoxLite required)
  itest         run integration smoke test (~30 s)
  e2e           run comprehensive E2E suite (~60 s)
  itest-all     run BOTH integration suites (~90 s)
```

See the [Usage guide](#usage-guide) below
for the full day-to-day workflow and the tiered cleanup decision tree.

---

## What runs

After `make stack-up` you have 10 L1 daemon boxes + 1 one-shot bootstrap
+ 4 L2 native processes. Direct host-side access:

### L1 — BoxLite boxes

| Service       | Host endpoint                                          | Notes                       |
|---|---|---|
| postgres      | `postgresql://boxlite@127.0.0.1:25432/boxlite`         | trust auth (local dev only); schema built by API migrations on boot |
| redis         | `redis://127.0.0.1:26379`                              |                             |
| minio (S3)    | `http://127.0.0.1:29000`                               | user/pass `minioadmin`      |
| minio console | `http://127.0.0.1:29001`                               |                             |
| registry      | `http://127.0.0.1:25000/v2/`                           | OCI registry v2             |
| dex (OIDC)    | `http://127.0.0.1:25556/dex/.well-known/openid-configuration` | `admin@boxlite.dev` / `password` (also `test01@boxlite.dev`) |
| jaeger UI     | `http://127.0.0.1:26686/`                              | in-memory storage           |
| pgadmin       | `http://127.0.0.1:25051/`                              |                             |
| registry-ui   | `http://127.0.0.1:25052/`                              |                             |
| otel HTTP     | `http://127.0.0.1:24318/v1/traces`                     | OTLP receiver → forwards traces to Jaeger |
| otel gRPC     | `127.0.0.1:24317`                                      |                             |
| otel health   | `http://127.0.0.1:23133/`                              |                             |
| **caddy**     | `http://127.0.0.1:28080/`                              | reverse proxy to all of the above + box port-preview |

### L2 — native application processes

| Service        | Host endpoint              | Notes                                    |
|---|---|---|
| Dashboard (Vite) | `http://127.0.0.1:3000/`   | React + OIDC login flow                  |
| API (NestJS)     | `http://127.0.0.1:3001/api`| Reads `apps/.env` (→ `apps/api/.env`, seeded on first `stack-up` from `configs/api.env`); auto-seeds admin org + default region |
| Proxy (Go)       | `http://127.0.0.1:4000`    | Box port-preview `<port>-<token>.localhost:28080` reverse-proxy target |
| Runner (Go)      | `http://127.0.0.1:3003`    | Native arm64; spawns L3 microVMs in `.apps-local/boxlite-runner/` |

See [`CONNECTIONS.md`](CONNECTIONS.md) for full credentials, env vars,
and per-service env override surface.

All reverse-proxy routes via Caddy (`http://127.0.0.1:28080/`):

```text
  /pgadmin/        -> pgadmin
  /jaeger/         -> jaeger
  /dex/            -> dex (OIDC)
  /minio/          -> minio S3 API
  /minio-console/  -> minio console UI
  /registry-ui/    -> registry UI
  /registry/       -> docker registry v2
```

---

## Configuration

All ports + credentials come from `InfraConfig` (in `boxlite_local/config.py`)
with `BOXLITE_*` env-var overrides. Common knobs:

```bash
BOXLITE_PG_HOST_PORT=25432       # postgres host port
BOXLITE_PG_USER=boxlite          # postgres user
BOXLITE_PG_PASSWORD=boxlite      # postgres password (only used by image entrypoint)
BOXLITE_PG_DB=boxlite            # postgres database
BOXLITE_REDIS_HOST_PORT=26379
BOXLITE_MINIO_HOST_PORT=29000
BOXLITE_MINIO_USER=minioadmin
BOXLITE_MINIO_PASSWORD=minioadmin
BOXLITE_REGISTRY_HOST_PORT=25000
BOXLITE_DEX_HOST_PORT=25556
BOXLITE_JAEGER_HOST_PORT=26686
BOXLITE_PGADMIN_HOST_PORT=25051
BOXLITE_PGADMIN_EMAIL=admin@boxlite.dev
BOXLITE_PGADMIN_PASSWORD=boxlite
BOXLITE_REGISTRY_UI_HOST_PORT=25052
BOXLITE_OTEL_GRPC_PORT=24317
BOXLITE_OTEL_HTTP_PORT=24318
BOXLITE_OTEL_HEALTH_PORT=23133
BOXLITE_CADDY_HTTP_PORT=28080
BOXLITE_CADDY_HTTPS_PORT=28443   # currently mapped but TLS not enabled
BOXLITE_DATA_DIR=<repo>/.apps-local/data      # persistent volume mounts root
BOXLITE_HOME=<repo>/.apps-local/boxlite       # SDK home for the L1 boxes
```

`BOXLITE_HOME` is exported by the Makefile and `scripts/_stack-common.sh`,
so every `make` target and stack script sees the same L1 boxes. To inspect
them from a plain shell (`boxlite ls`, `boxlite logs ...`), export it
yourself first:

```bash
export BOXLITE_HOME=<repo>/.apps-local/boxlite
```

Hostname inside boxes for reaching the host machine:
`host.boxlite.internal` (resolves to gvproxy's `192.168.127.254` via
BoxLite's HOST_IP).

---

## Architecture

- **Flat package, plain async functions, no Orchestrator class.** The CLI
  (`cli.py`) is a thin argparse layer over `orchestrator.py`'s `up`/`down`/
  `ps` / `doctor` functions. Tests bypass the CLI and call those functions
  directly.
- **Explicit `SERVICES` dict** (`services.py`). Adding a service = one new
  `ServiceSpec` plus one dict entry.
- **Topological start order via `graphlib.TopologicalSorter`.** Each layer
  runs in parallel via `asyncio.gather`.
- **Doctor preflight (`doctor.py`) runs before every `up`.** Hard-fails on
  port conflicts. Easy to extend with more checks.
- **Three healthcheck shapes:** in-box `exec`, host-side `http_url`, and
  reserved `tcp_port` (not implemented yet — no caller needs it).
- **`one_shot=True` services** (currently only `minio-init`) run their
  command, then the orchestrator polls until the container's init process
  exits, then `runtime.remove(force=True)`s the box. Re-runs on every `up`.

---

## Known limitations

### 1. TLS via Caddy is not enabled

Caddy serves plain HTTP on port 28080 only. The `tls internal` issuer
can't mint certs for raw IP addresses (`127.0.0.1`), and we don't have
DNS hijack yet (no `*.boxlite.test → 127.0.0.1`). To enable TLS:

1. Install mkcert CA into your system trust store (one time, needs sudo):
   ```bash
   mkcert -install
   ```
2. Set up DNS hijack for `*.boxlite.test` (needs sudo). Options:
   - macOS-native resolver: write `/etc/resolver/boxlite.test` with
     `nameserver 127.0.0.1` and run a small DNS server on port 53
     answering `*.boxlite.test → 127.0.0.1`.
   - Or just add explicit entries to `/etc/hosts` for the subdomains you
     actually use:
     ```
     127.0.0.1 pgadmin.boxlite.test
     127.0.0.1 jaeger.boxlite.test
     # ... etc
     ```
3. Update the Caddyfile in `services.py` (`_caddyfile()` function) to use
   `*.boxlite.test:443 { tls internal ... }` instead of `:80`.

### 2. otel-collector uses the stock image, not `apps/otel-collector/`

The `apps/otel-collector/Dockerfile` builds a custom Go binary
(`boxlite-otel-collector`) that includes the project's `boxlite_exporter`
plugin. BoxLite SDK doesn't support building OCI images directly
(only `pull`), so to use the custom binary you'd need:

1. `docker build -t 127.0.0.1:25000/boxlite-local/otel-collector:dev -f apps/otel-collector/Dockerfile .`
2. `docker push 127.0.0.1:25000/boxlite-local/otel-collector:dev`
   (the stack's own registry on port 25000)
3. Change `SPEC_OTEL.image` to `127.0.0.1:25000/boxlite-local/otel-collector:dev`

The stock `otel/opentelemetry-collector:latest` in the current spec
forwards traces to Jaeger (and logs everything to stdout via the debug
exporter), so the Jaeger UI works — but it lacks the project's
`boxlite_exporter` (no ClickHouse / api push-back). Fine for local
trace debugging; swap in the custom build above for exporter parity.

### 3. SDK gotchas worked around (file these as feedback)

This codebase contains workarounds for several SDK behaviours that
are worth filing back to the BoxLite team. They're all noted in the
relevant source files. Summary:

| # | What | Workaround in |
|---|---|---|
| 1 | `host.boxlite.internal` failed on first run | Env (Docker Desktop) — not SDK |
| 2 | brew postgres collided on default ports | Use non-default host ports (§3.8) |
| 3 | SDK rejects file volume mounts (must be dirs) | inline scripts via `cmd=sh -c '...'` |
| 4 | `list_info().state.status` stays "running" after one-shot init exits | exec-probe in `_wait_one_shot_exit` |
| 5 | `runtime.remove()` rejects "running" VM after init exits | `runtime.remove(name, force=True)` |
| 6 | `box.exec` race during box startup (`InitReady vs IntermediateReady`) | `_wait_healthy_exec` retries on any exception |
| 7 | microVM↔host transport can wedge a PG connection mid-query | server-side `statement_timeout` + `tcp_keepalives_*` (SPEC_PG) — root fix belongs in the transport |
| 8 | SDK has no typed "already running" error | message-substring sniff in `_is_already_running_error` |

Fixed upstream and removed from this codebase:
- `r-x` dir-layer rootfs-merge chmod workarounds (SDK #607/#697).
- EXPOSE'd-privileged-port auto-bind trap — the SDK no longer auto-binds
  image-EXPOSE'd ports, so placeholder mappings are gone (verified by
  rebuilding boxes without them).
- `runtime.get()` returning `Option` is the documented API contract now,
  not a gotcha.

### 4. Box boot / image resolution is mid-rewrite upstream (unverified here)

The migration squash removed the box-template/snapshot subsystem, then
`#755`/`#758` reintroduced an **image-keyed** boot path (the box-start
`UNKNOWN` handler now calls `runnerAdapter.createBox` —
`apps/api/src/box/managers/box-actions/box-start.action.ts`) and restricted
creation to supported pinned images. What's still *not* rebuilt is image
**resolution** — see the `TODO(image-rewrite)` markers in
`apps/api/src/box/services/box.service.ts:136,:155` (and ~20 more across
`apps/api`/`apps/dashboard` for the removed template webhooks, metrics, and
the dashboard image/template picker — e.g. `CreateBoxSheet.tsx:138,:228`).

Net: a box with no image fails fast (`'Box has no image to create from'`),
and the dashboard's image picker is gone, so end-to-end "Create Box" from
the UI is incomplete. We have **not** verified a successful box boot on this
stack since the rebase (it also needs a rebuilt `libboxlite.a` for the
runner). Everything else — L1 services, API, runner registration, auth,
dashboard — works.

---

## Repo layout

```
apps/infra-local/
├── Makefile                          # convenience wrappers (L1 + stack-* L2)
├── README.md                         # this file
├── CONNECTIONS.md                    # endpoint / credential / env-var reference per service
├── pyproject.toml                    # package definition
├── boxlite_local/                    # the L1 orchestrator package
│   ├── __init__.py
│   ├── __main__.py                   # python -m boxlite_local entry
│   ├── cli.py                        # argparse → orchestrator/doctor
│   ├── types.py                      # ServiceSpec / HealthCheck / Doctor*
│   ├── config.py                     # InfraConfig dataclass + .load()
│   ├── doctor.py                     # preflight (SDK / runtime / port lsof)
│   ├── execwrap.py                   # exec_collect helper
│   ├── orchestrator.py               # topo_sort + up/down/ps + healthcheck loops
│   └── services.py                   # SPEC_* + SERVICES registry
├── scripts/                          # L2 stack wrappers (called by `make stack-*`)
│   ├── _stack-common.sh
│   ├── seed-init-data.sh             # wait for API self-seed + registered runner
│   ├── stack-build.sh                # build runner + proxy binaries
│   ├── stack-up.sh / stack-down.sh / stack-restart.sh
│   ├── stack-status.sh / stack-logs.sh
│   └── stack-reset.sh                # tiered: soft / --hard / --nuke
├── configs/                          # legacy: minio init script (now inlined)
│   └── minio/init.sh
└── tests/
    ├── unit/                         # pure-logic tests (no BoxLite needed)
    │   ├── test_config.py            # 12: InfraConfig + env overrides
    │   ├── test_doctor_lsof.py       # 5: lsof -F parsing + boxlite-owner predicate
    │   ├── test_orchestrator.py      # 8: _http_probe, _is_already_running, callable cmd/exec
    │   └── test_topo.py              # 6: topo_sort layering + cycle detection
    └── integration/                  # gated on BOXLITE_INTEGRATION=1 (~90s total)
        ├── test_multi_service.py     # smoke: 11-service round-trip with health endpoints
        └── test_e2e_full.py          # comprehensive E2E (10 tests, module-scoped stack):
                                      #   - pg SQL roundtrip (CREATE/INSERT/SELECT)
                                      #   - redis SET/GET/INCR
                                      #   - minio S3 PUT/GET via mc client box
                                      #   - registry v2 catalog API
                                      #   - dex JWKS keys
                                      #   - jaeger query API
                                      #   - otel OTLP HTTP receiver accepts trace
                                      #   - caddy all 6 reverse-proxy routes
                                      #   - stack stays healthy after 30s idle
                                      #   - total memory under 8 GiB budget
```

---

## Common tasks

**Add a new L1 service:** define a `ServiceSpec` in `services.py`, add an
entry to the `SERVICES` dict, add the host port default to `InfraConfig`,
add `BOXLITE_<NAME>_HOST_PORT` to `.load()`, run `make up`. Map only the
ports you actually use — the SDK no longer auto-binds image-`EXPOSE`'d
ports.

**Restart one L2 component** (90 % of daily iteration):
`make stack-restart COMPONENTS=runner` (or `api`, `proxy`, `dashboard`;
multiple as `COMPONENTS="api proxy"`). `runner` includes an automatic
rebuild.

**Rebuild one L1 box** (when a stateful service goes weird — typical
symptoms: dex issues already-expired tokens after the Mac slept (clock
drift — see [§Common issues](#7-common-issues)), registry pull hangs):
`make stack-rebuild-l1-box BOX=dex` (or `registry`, `pgadmin`, ...).

**Debug a stuck service:** `make stack-status` first → identify the red
component → use the lightest possible cleanup. `python -m boxlite_local ps`
shows L1 box state; `boxlite logs boxlite-local-<name>` shows guest
logs; `make stack-logs COMPONENT=<name>` tails L2 logs from
`.apps-local/logs/`.

**Reset DB to clean state** (most-common scenario): `make stack-reset &&
make stack-up` — truncates PG user data and clears
`.apps-local/boxlite-runner/`, preserves schema + L1 boxes + image cache. Use
`stack-reset-hard` to also drop + rebuild the schema via migrations. Use
`stack-nuke` only when you want a full cold rebuild (~3-5 min).

**Run integration tests:** `make itest`. Takes ~30 s on warm cache. The
test skips itself if any `boxlite-local-*` box is already running
(safety guard to avoid destroying live dev state).

For the full tiered cleanup decision tree, see
the [tiered cleanup decision tree](#55-tiered-cleanup--rebuild-decision-tree) in the Usage guide.

---

## Usage guide

### 0. TL;DR — 8 wrapper commands

```bash
cd apps/infra-local

# First-time AND day-to-day: one command. stack-up is self-healing — on a
# fresh checkout it auto-runs `make install` + builds the native binaries;
# on a restart it skips straight to bringing the stack up.
make stack-up

# Health check
make stack-status
# Tail logs (any of: api / runner / proxy / dashboard / all)
make stack-logs COMPONENT=api
# Restart one component (runner also rebuilds)
make stack-restart COMPONENTS=runner
# Same thing when you change .env:
make stack-restart COMPONENTS="api proxy"
# Stop all native processes (L1 boxes stay up)
make stack-down
# Soft reset: stop native + clear runner home + truncate user data (schema preserved)
make stack-reset
# Hard reset: also re-apply the schema
make stack-reset-hard
# Full nuke: destroy L1 boxes + logs too (next stack-up is a true cold start)
make stack-nuke
```

Every wrapper is idempotent — safe to run repeatedly. Component-level control is via the `COMPONENTS=` variable (empty = all).

---

### 1. First-time startup (brand-new machine, one-time)

#### 1.1 Prereqs

| Tool | Required version | Why |
|---|---|---|
| macOS | Apple Silicon (M1/M2/M3/M4/M5) | Platform target |
| Docker Desktop | ≥ 4.30, **running** | BoxLite host runtime depends on it |
| Go | 1.25+ | Builds the runner + proxy binaries |
| Node + yarn (via corepack) | 22+ | Runs the api + dashboard |
| Python | 3.10+ (conda env recommended) | Runs the `boxlite_local` orchestrator |
| `boxlite` Python SDK | installed in the active Python | `import boxlite` must work — install from `sdks/python/` if missing: `pip install -e <repo>/sdks/python` |
| `boxlite` CLI | in `$PATH` | L1 box lifecycle (`boxlite ls`, `boxlite rm`, etc.) |

Quick check before continuing:

```bash
python -c "import boxlite; print('boxlite SDK OK:', boxlite.__file__)"
which boxlite                     # CLI must be on PATH
docker info >/dev/null            # Docker Desktop must be running
```

#### 1.2 One-command bring-up

```bash
cd boxlite-cloud-mvp/apps/infra-local
make stack-up       # does everything; see the self-heal steps below
make stack-status   # one-screen health
```

Cold-start time: ~5-7 minutes on first run (most of it is pulling the
10 L1 service images). Subsequent
`stack-up` runs reuse the image cache and complete in ~30 s to 1 min.

✅ `stack-up.sh` is **self-healing** — a single `make stack-up` works
from a fresh checkout, after a reboot, or after `make stack-down`,
because it automatically:
1. Installed the orchestrator package (`make install`) if `boxlite_local` wasn't importable yet
2. Brought up L1 boxes (`make up`) if they weren't running; the API then runs all TypeORM migrations on boot against the pg box (a no-op when the schema is already present, e.g. the PG data volume survived a reboot)
3. Built the native binaries (`stack-build.sh`) if `.apps-local/bin/boxlite-runner` / `boxlite-proxy` were missing (fresh checkout or wiped state dir)
4. Created the `apps/.env` symlink NestJS needs
5. Started api → runner → proxy → dashboard in dependency order, waiting for each to be healthy before the next
6. Detected ports already in use and freed them first (prevents EADDRINUSE)
7. Written PIDs to `.apps-local/logs/<comp>.pid` and logs to `<comp>.log`

> You can still run `make install` / `make stack-build` explicitly — e.g.
> to force a binary rebuild after changing runner/proxy source — but
> `make stack-up` doesn't require it. To rebuild a running component use
> `make stack-restart COMPONENTS=runner` (rebuilds + restarts).

#### 1.3 First-time dashboard login

Open <http://localhost:3000> and log in via Dex with one of the
preseeded accounts (see [`apps/infra-local/CONNECTIONS.md` §4](CONNECTIONS.md)):

- `admin@boxlite.dev` / `password` (admin user)
- `test01@boxlite.dev` / `password` (normal user)

Then click **Create Box** → pick region `us` → **Create** → open
the **Terminal** tab → **Connect** → you should see `root@boxlite:~#`.

> ⚠️ Box creation is mid-rewrite upstream and unverified on this stack: image
> **resolution** isn't rebuilt yet and the dashboard's image picker was
> removed, so "Create Box" from the UI is incomplete. See
> [Known limitations](#known-limitations) #4. The rest of the stack works.

### 2. Day-to-day dashboard development loop

**This is the 99 % path** (only dashboard code changes):

```bash
# Vite is already running → edit apps/dashboard/src/**/*.tsx → save → browser HMR refreshes
# API + Runner + Proxy + infra-local all keep running, no need to touch them
```

| Change type | Restart needed |
|---|---|
| `.tsx` / `.ts` / `.css` | None — Vite HMR |
| `apps/dashboard/.env` | Ctrl-C + `corepack yarn nx serve dashboard` |
| New npm package | `yarn install` + restart Vite |
| API schema changed (`@boxlite-ai/api-client`) | `yarn nx run api:openapi` regen + restart Vite |

### 3. API development loop

```bash
# nx serve api runs in watch mode — edit apps/api/src/**/*.ts → auto rebuild + restart
# But there are 2 exceptions:
```

| Change | How to handle it |
|---|---|
| Edit `*.entity.ts` (DB schema) | Write a migration at `apps/api/src/migrations/<ts>-name-migration.ts`; the restart runs it automatically |
| Edit `.env` | Ctrl-C + re-run via `make stack-restart COMPONENTS=api` (or copy the `nx serve api` invocation from `scripts/stack-up.sh`) |
| Edit OpenAPI (controller `@Api*` decorators) | `yarn nx run api:openapi` regenerates `dist/apps/api/openapi.json` → SDK client regenerates → restart dashboard |

### 4. Runner development loop

```bash
# Runner is a native Go binary with no watch mode
pkill -9 -f boxlite-runner
cd apps/runner && go build -o ../../.apps-local/bin/boxlite-runner ./cmd/runner && cd -
# Re-run it (use the cheatsheet in the status doc)
```

Runner holds state in memory (box handles, heartbeat state, etc.) — restarting **briefly loses it**. The user's boxes are reclaimed ~10 s later by the API reconcile cron.

### 5. Database reset (common during development)

```bash
# Wipe PG entirely and rebuild the schema from the repo's TypeORM migrations
cd apps/infra-local && make stack-reset-hard  # drop schema + `make migrate`
cd -

# (Just apply any pending migrations against the existing schema: `make migrate`)

# Or just truncate user data, preserving schema / migrations state
PGPASSWORD=boxlite psql -h 127.0.0.1 -p 25432 -U boxlite -d boxlite -c "
  TRUNCATE TABLE box, job, volume, runner, region,
                 organization, organization_user, organization_role,
                 api_key, audit_log CASCADE;
"

# Then restart the API so it re-seeds default region + default runner
```

`.apps-local/boxlite-runner/` must also be cleared, otherwise the runner still thinks the old boxes exist:

```bash
pkill -9 -f boxlite-runner
rm -rf .apps-local/boxlite-runner/{db,boxes,images,rootfs}/
# Restart runner
```

> The above is the raw SQL/shell approach — **do not use it directly** day-to-day. Use the tiered wrappers below.

### 5.5 Tiered cleanup / rebuild decision tree

Five tiers ordered by "how much do you blow away" — **start with the lightest, stop when it's enough**.

| # | Scope | Command | Duration |
|---|---|---|---|
| ① | Restart 1 L2 native process | `make stack-restart COMPONENTS=runner` | ~10 s |
| ② | 1 L1 box stuck → rebuild | `make stack-rebuild-l1-box BOX=registry` | ~3 s |
| ③ | Clear DB user data, preserve schema | `make stack-reset && make stack-up` | ~60 s |
| ④ | Also re-align schema (reload prod baseline) | `make stack-reset-hard && make stack-up` | ~90 s |
| ⑤ | Destroy everything, cold-start from zero | `make stack-nuke && make stack-up` | 3-5 min |

#### Scenario 1: **Full rebuild** (tier ⑤)

```bash
cd apps/infra-local
make stack-nuke && make stack-up
```

What it does:
- Stops the 4 L2 native processes
- Deletes all 10 L1 boxes (microVM kernels + rootfs)
- Clears data volumes + `.apps-local/logs/`
- Re-pulls the 10 images + reloads the prod schema
- Starts L2; the API self-seeds (admin org / default region); the runner re-registers

**When to use it:** new-hire onboarding / schema upgrade / "I did a bunch of weird stuff and want to go back to a clean state".

#### Scenario 2: **Reset + re-up** (tier ③ — most common)

```bash
cd apps/infra-local
make stack-reset && make stack-up
```

Differences from ⑤ — this one **preserves**: L1 boxes, PG schema, image cache, historical logs. It only clears PG **user data** + `.apps-local/boxlite-runner/` runtime state.

**When to use it:** mid-iteration the data got dirty and you want to clear box/org/user; testing "fresh DB" behavior.

#### Scenario 3: **Partial reset → partial up** (tiers ①②, 90 % of daily work)

```bash
# Native code change
make stack-restart COMPONENTS=runner             # runner rebuilds automatically
make stack-restart COMPONENTS=api                # changed .env / file
make stack-restart COMPONENTS="api proxy"        # multiple at once

# L1 box stuck (typical: dex returns 401 on login / registry pull hangs)
make stack-rebuild-l1-box BOX=dex
make stack-rebuild-l1-box BOX=registry

# Inspect + tail
make stack-status                                # one-screen full status
make stack-logs COMPONENT=runner                 # single component
make stack-logs COMPONENT=all                    # everything
```

**When to use it:** 99 % of daily iteration.

#### One-sentence decision rule

**Start with `stack-status` → find what's red / stuck → fix it with the lightest tier that works. Never default to `stack-nuke`.**

### 6. Testing techniques

#### 6.1 Browser (primary test path)

```
http://localhost:3000  → pick admin / user to log in (dex static users)
```

#### 6.2 curl the API (SDK testing / scripts / CI)

```bash
# Use the admin key (skips OIDC, suitable for scripts)
curl -sS \
  -H "Authorization: Bearer local-dev-admin-key" \
  -H "X-BoxLite-Organization-ID: <org-uuid>" \
  http://localhost:3001/api/box/paginated | jq

# Use an OIDC token (simulates a user)
# 1. Log in via the browser, then grab access_token from DevTools sessionStorage
# 2. curl -H "Authorization: Bearer <token>" ...
```

#### 6.3 SDK testing

```bash
# Python SDK against the local API
cd sdks/python
BOXLITE_API_URL=http://localhost:3001/api \
BOXLITE_API_KEY=<api-key-via-dashboard-or-curl> \
pytest tests/

# Go SDK is the same: set BOXLITE_API_URL + BOXLITE_API_KEY env vars
```

#### 6.4 Direct DB queries (read-only — won't collide with the runner's lock)

```bash
# Inspect box state
sqlite3 .apps-local/boxlite-runner/db/boxlite.db -header -column \
  "SELECT id, image, status FROM boxes WHERE status='running';"

# Inspect the API primary DB
PGPASSWORD=boxlite psql -h 127.0.0.1 -p 25432 -U boxlite -d boxlite -c "
  SELECT s.name, s.state, r.name as runner FROM box s
  LEFT JOIN runner r ON r.id = s.\"runnerId\" 
  ORDER BY s.\"createdAt\" DESC LIMIT 10;
"
```

#### 6.5 Reading logs

```bash
# API stdout: redirected to the terminal where `nx serve` was launched
# Runner stdout: redirected to the terminal where the runner was launched
# Proxy stdout: same

# Box-internal logs (the 10 infra-local boxes)
# (plain shells need: export BOXLITE_HOME=<repo>/.apps-local/boxlite)
boxlite logs boxlite-local-postgres
boxlite logs boxlite-local-caddy

# Box microVM-internal logs (managed by the runner)
ls -lt .apps-local/boxlite-runner/boxes/<id>/logs/
```

### 7. Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| All API calls return 401 | `SSH_GATEWAY_API_KEY` or `PROXY_API_KEY` not set | Check `apps/api/.env` — both must be non-empty |
| "Create Box" from the dashboard is incomplete / box doesn't boot | Expected: image resolution is mid-rewrite upstream and the dashboard image picker was removed (`TODO(image-rewrite)`) | See [Known limitations](#known-limitations) #4 — the rest of the stack is unaffected |
| Box reaches STARTED but the terminal is blank + `Connection closed` | image is amd64 but runner runs an arm64 microVM | Already fixed (`runner/registry.go` uses `runtime.GOARCH`) — clear the old image cache and re-pull |
| "Create Box" missing in the dashboard | Expected: PostHog isn't configured locally, so flag-gated UI stays hidden (no local flag bootstrap) | Use `POST /api/box` directly, or set `POSTHOG_API_KEY`/`POSTHOG_HOST` in `apps/api/.env` with the flags enabled in PostHog |
| `POST /api/regions` → 404 "Cannot POST" | Expected: same — flag-gated admin routes stay hidden without a configured PostHog | Same as above; the seed path (`seed-init-data.sh`) doesn't need these routes |
| Boxlite-runner hits `Another BoxliteRuntime is already using directory` | Another runner process is holding `.apps-local/boxlite-runner/.lock` | `lsof .apps-local/boxlite-runner/.lock` to find the PID; decide whether to kill it or that you've used the wrong home dir |
| Terminal `Connection closed` and won't reconnect | signed-url expired (default 300 s) | Click Connect again; the dashboard re-fetches a fresh URL |
| Dashboard loads `Unauthorized` / `401` even just after OIDC login | **The dex box's clock has drifted behind the host.** Long-running L1 microVMs freeze their clock while the Mac sleeps (observed ~37h behind after a few days), so dex stamps every token's `iat`/`exp` from its own past clock — the token is *born expired* by the host's time and the API rejects it on `exp`. (Passport-jwt logs nothing for an expired token, so the API log looks like the token never arrived.) Diagnostic: `boxlite exec boxlite-local-dex -- date -u` vs host `date -u`; or decode the token — `iat`/`exp` are hours/days old. NOT a stale session-db grant and NOT a browser-storage problem. | `make stack-rebuild-l1-box BOX=dex` (fresh clock at boot) + clear browser storage / re-login (the cached token is genuinely expired) |
| Box `pulling` is stuck for several minutes | **Registry box TCP still listens but the internal registry process is hung** (SIGKILL side-effect). Confirm: `curl http://127.0.0.1:25000/v2/_catalog` times out after 5 s | `make stack-rebuild-l1-box BOX=registry`; the stuck pull recovers automatically |
| Any L1 box (pgadmin / jaeger / minio / ...) behaves weirdly | Same as above — the box's stateful internal process is broken | `make stack-rebuild-l1-box BOX=<name>` blows it away and rebuilds in one shot |

### 8. Local "release" workflow (MVP internal demo / self-test)

There is no real "release" locally, but you can **freeze a known-good state** for a team demo:

```bash
# 1. Commit all changes
git add -A && git commit -m "demo: snapshot for <date>"

# 2. Export the infra-local box images via the BoxLite SDK (optional, ~5 GB, for a real backup)
for s in postgres redis minio registry dex caddy; do
  boxlite export boxlite-local-$s -o demos/$s-$(date +%Y%m%d).tar
done

# 3. README for team members:
#    git clone + checkout this commit
#    Follow §1's "First-time startup" instructions
#    Point at §6 for testing
```

For a customer demo, **expose only the dashboard on :3000**; do not forward any other ports — the terminal goes through Caddy :28080 and needs the Host header bound, which requires extra DNS config for remote access (use dns-shim, parked).

### 9. Full stop

```bash
# Stop the 4 native processes
pkill -9 -f "nx.*serve.*(api|dashboard)"
pkill -9 -f "boxlite-runner"
pkill -9 -f "boxlite-proxy"

# Stop the 10 infra boxes (preserve data)
export BOXLITE_HOME="$(git rev-parse --show-toplevel)/.apps-local/boxlite"
for b in caddy registry-ui pgadmin otel jaeger dex registry minio redis postgres; do
  boxlite stop boxlite-local-$b
done

# Or wipe everything (data lost too)
cd apps/infra-local && make down
```

### One-liner

**Editing `.tsx` + Vite HMR is the default development rhythm.** API / Runner / Proxy are stable infrastructure that run in the background and you don't touch day-to-day. To wipe state: `make stack-reset-hard` + clear `.apps-local/boxlite-runner/`. To demo: freeze a commit and run §1 once.
