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

User sandboxes (L3) are spawned by the L2 Runner as libkrun microVMs
under `~/.boxlite-runner/` — see
[`docs/apps/milestones/2026-05-25-milestone-infra-local-v0.1.0.md`](../../docs/apps/milestones/2026-05-25-milestone-infra-local-v0.1.0.md)
for the executive summary.

**Status:** `milestone/infra-local/v0.1.0` (2026-05-25). Cold-start to
working sandbox + browser terminal in ~80 s. Daily dev workflow
documented in [`docs/apps/infra-local-usage.md`](../../docs/apps/infra-local-usage.md).
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

### Make targets

L1-only (just the BoxLite boxes):

```text
  install            install the package + test extras
  up                 bring L1 services up (runs doctor preflight first)
  down               stop + remove L1 services
  wipe               stop + remove + wipe data dir
  ps                 list running boxlite-local-* boxes
  doctor             run preflight checks (SDK + runtime + port conflicts)
  load-schema        load sql/schema-baseline.sql into local pg (after `make up`)
  up-with-schema     make up + make load-schema (one-shot for a fresh stack)
  seed-init-data     ensure dashboard-required base data (admin org, default region, wait snapshot)
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
  stack-reset-hard         like stack-reset, but also re-applies prod schema baseline
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

See [`docs/apps/infra-local-usage.md`](../../docs/apps/infra-local-usage.md)
for the full day-to-day workflow and the tiered cleanup decision tree.

---

## What runs

After `make stack-up` you have 10 L1 daemon boxes + 1 one-shot bootstrap
+ 4 L2 native processes. Direct host-side access:

### L1 — BoxLite boxes

| Service       | Host endpoint                                          | Notes                       |
|---|---|---|
| postgres      | `postgresql://boxlite@127.0.0.1:25432/boxlite`         | trust auth (local dev only); prod schema baseline pre-loaded |
| redis         | `redis://127.0.0.1:26379`                              |                             |
| minio (S3)    | `http://127.0.0.1:29000`                               | user/pass `minioadmin`      |
| minio console | `http://127.0.0.1:29001`                               |                             |
| registry      | `http://127.0.0.1:25000/v2/`                           | OCI registry v2             |
| dex (OIDC)    | `http://127.0.0.1:25556/dex/.well-known/openid-configuration` | `admin@boxlite.dev` / `password` (also `test01@boxlite.dev`) |
| jaeger UI     | `http://127.0.0.1:26686/`                              | in-memory storage           |
| pgadmin       | `http://127.0.0.1:25051/`                              |                             |
| registry-ui   | `http://127.0.0.1:25052/`                              |                             |
| otel HTTP     | `http://127.0.0.1:24318/v1/traces`                     | OTLP receiver (debug exporter) |
| otel gRPC     | `127.0.0.1:24317`                                      |                             |
| otel health   | `http://127.0.0.1:23133/`                              |                             |
| **caddy**     | `http://127.0.0.1:28080/`                              | reverse proxy to all of the above + sandbox port-preview |

### L2 — native application processes

| Service        | Host endpoint              | Notes                                    |
|---|---|---|
| Dashboard (Vite) | `http://127.0.0.1:3000/`   | React + OIDC login flow                  |
| API (NestJS)     | `http://127.0.0.1:3001/api`| Reads `apps/.env`; auto-seeds admin org + default region |
| Proxy (Go)       | `http://127.0.0.1:4000`    | Sandbox port-preview `<port>-<token>.localhost:28080` reverse-proxy target |
| Runner (Go)      | `http://127.0.0.1:3003`    | Native arm64; spawns L3 microVMs in `~/.boxlite-runner/` |

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
BOXLITE_DATA_DIR=~/.boxlite-local/data   # persistent volume mounts root
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

The stock `otel/opentelemetry-collector:latest` in the current spec only
has a debug exporter — useful to validate the stack works, not a real
collector.

### 3. SDK gotchas worked around (file these as feedback)

This codebase contains workarounds for ~9 distinct SDK behaviours that
are worth filing back to the BoxLite team. They're all noted in the
relevant source files. Summary:

| # | What | Workaround in |
|---|---|---|
| 1 | `host.boxlite.internal` failed on first run | Env (Docker Desktop) — not SDK |
| 2 | brew postgres collided on default ports | Use non-default host ports (§3.8) |
| 3 | `r-x` dir layers (RHEL UBI base) break rootfs merge | `_ensure_image_cache_writable` chmod |
| 4 | First pull's freshly-extracted layers also need chmod | `_start_with_perm_retry` |
| 5 | SDK rejects file volume mounts (must be dirs) | inline scripts via `cmd=sh -c '...'` |
| 6 | `ServiceSpec` lacked `entrypoint` field; SDK has it | `entrypoint=["sh"]` for image-overriding |
| 7 | `list_info().state.status` stays "running" after init exits | exec-probe in `_wait_one_shot_exit` |
| 8 | `runtime.remove()` rejects "running" VM after init exits | `runtime.remove(name, force=True)` |
| 9 | `runtime.get(name)` returns None (not raises) for missing | `if box is None: return False` |
| 10 | EXPOSE 443 (or other privileged) silently breaks ALL port forwards for that box | Map every EXPOSE'd port explicitly |
| 11 | `box.exec` race during box startup (`InitReady vs IntermediateReady`) | `_wait_healthy_exec` retries on any exception |

---

## Repo layout

```
apps/infra-local/
├── Makefile                          # convenience wrappers (L1 + stack-* L2)
├── README.md                         # this file
├── CONNECTIONS.md                    # endpoint / credential / env-var reference per service
├── pyproject.toml                    # package definition
├── goal.md                           # original "why we built this"
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
│   ├── apply-schema.sh               # load sql/schema-baseline.sql into local pg
│   ├── seed-init-data.sh             # wait for API self-seed + default snapshot
│   ├── stack-build.sh                # build runner + proxy binaries
│   ├── stack-up.sh / stack-down.sh / stack-restart.sh
│   ├── stack-status.sh / stack-logs.sh
│   └── stack-reset.sh                # tiered: soft / --hard / --nuke
├── sql/                              # production schema baseline (loaded into L1 pg)
│   ├── REFRESH.md
│   └── schema-baseline.sql
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
add `BOXLITE_<NAME>_HOST_PORT` to `.load()`, run `make up`. Don't forget
to map ALL of the image's `EXPOSE`'d ports explicitly (the SDK auto-bind
silently breaks ALL forwards for that box if any EXPOSE'd port can't be
bound — see SDK gotcha #10 above).

**Restart one L2 component** (90 % of daily iteration):
`make stack-restart COMPONENTS=runner` (or `api`, `proxy`, `dashboard`;
multiple as `COMPONENTS="api proxy"`). `runner` includes an automatic
rebuild.

**Rebuild one L1 box** (when a stateful service goes weird — typical
symptoms: dex returns stale tokens, registry pull hangs):
`make stack-rebuild-l1-box BOX=dex` (or `registry`, `pgadmin`, ...).

**Debug a stuck service:** `make stack-status` first → identify the red
component → use the lightest possible cleanup. `python -m boxlite_local ps`
shows L1 box state; `boxlite logs boxlite-local-<name>` shows guest
logs; `make stack-logs COMPONENT=<name>` tails L2 logs from
`apps/infra-local/.logs/`.

**Reset DB to clean state** (most-common scenario): `make stack-reset &&
make stack-up` — truncates PG user data and clears
`~/.boxlite-runner/`, preserves schema + L1 boxes + image cache. Use
`stack-reset-hard` to also re-apply the prod schema baseline. Use
`stack-nuke` only when you want a full cold rebuild (~3-5 min).

**Run integration tests:** `make itest`. Takes ~30 s on warm cache. The
test skips itself if any `boxlite-local-*` box is already running
(safety guard to avoid destroying live dev state).

For the full tiered cleanup decision tree, see
[`docs/apps/infra-local-usage.md §5.5`](../../docs/apps/infra-local-usage.md).
