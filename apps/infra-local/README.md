# `apps/infra-local/` — BoxLite-Based Local Dev Stack

`boxlite_local` is a Python orchestrator that brings up a 10-service local
development stack as BoxLite microVM boxes (postgres / redis / minio /
registry / dex / jaeger / pgadmin / registry-ui / otel-collector / caddy)
plus a one-shot minio bucket bootstrap. It replaces the previous
`docker-compose` based `apps/local-dev/` setup — "eat your own dogfood"
per the project principle.

**Status:** Phase 3c complete (2026-05-21). 11 boxes wired end-to-end,
integration test green, ready for daily dev use with two known limitations
(see [§Known limitations](#known-limitations)).

---

## Quick start

Prereqs: macOS Apple Silicon, BoxLite SDK installed
(`pip install -e ../../sdks/python` from the boxlite repo), Python 3.10+.

```bash
cd apps/infra-local

# One-time install of the orchestrator package
make install

# Bring everything up (waits for healthchecks, idempotent if already up)
make up

# Inspect what's running
make ps

# Tear down + wipe data
make wipe
```

The full make target list:

```text
  help         show this help
  install      install the package + test extras
  up           bring all services up (runs doctor preflight first)
  down         stop + remove all services
  wipe         stop + remove + wipe data dir
  ps           list running boxlite-local-* boxes
  doctor       run preflight checks (SDK + runtime + port conflicts)
  test         run unit tests (no BoxLite required)
  itest        run integration test (requires BoxLite runtime, ~30s)
```

---

## What runs

After `make up` you have 10 daemon boxes + 1 one-shot bootstrap. Direct
host-side access:

| Service       | Host endpoint                                          | Notes                       |
|---|---|---|
| postgres      | `postgresql://boxlite@127.0.0.1:25432/boxlite`         | trust auth (local dev only) |
| redis         | `redis://127.0.0.1:26379`                              |                             |
| minio (S3)    | `http://127.0.0.1:29000`                               | user/pass `minioadmin`      |
| minio console | `http://127.0.0.1:29001`                               |                             |
| registry      | `http://127.0.0.1:25000/v2/`                           | OCI registry v2             |
| dex (OIDC)    | `http://127.0.0.1:25556/dex/.well-known/openid-configuration` | admin@boxlite.dev / password |
| jaeger UI     | `http://127.0.0.1:26686/`                              | in-memory storage           |
| pgadmin       | `http://127.0.0.1:25051/`                              |                             |
| registry-ui   | `http://127.0.0.1:25052/`                              |                             |
| otel HTTP     | `http://127.0.0.1:24318/v1/traces`                     | OTLP receiver (debug exporter) |
| otel gRPC     | `127.0.0.1:24317`                                      |                             |
| otel health   | `http://127.0.0.1:23133/`                              |                             |
| **caddy**     | `http://127.0.0.1:28080/`                              | reverse proxy to all of the above |

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

See `docs/superpowers/specs/2026-05-2[01]-infra-local-phase[2-3]*.md` for
the full design history (Phase 2 walking skeleton + Phase 3a/3b/3c
service additions).

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
├── Makefile                          # convenience wrappers
├── README.md                         # this file
├── pyproject.toml                    # package definition
├── goal.md                           # original "why we built this"
├── boxlite_local/                    # the package
│   ├── __init__.py
│   ├── __main__.py                   # python -m boxlite_local entry
│   ├── cli.py                        # argparse → orchestrator/doctor
│   ├── types.py                      # ServiceSpec / HealthCheck / Doctor*
│   ├── config.py                     # InfraConfig dataclass + .load()
│   ├── doctor.py                     # preflight (SDK / runtime / port lsof)
│   ├── execwrap.py                   # exec_collect helper
│   ├── orchestrator.py               # topo_sort + up/down/ps + healthcheck loops
│   └── services.py                   # SPEC_* + SERVICES registry
├── configs/                          # legacy: minio init script (now inlined)
│   └── minio/init.sh
├── poc/                              # Phase 1 PoC code (still works, kept as a reference)
└── tests/
    ├── unit/                         # pure-logic tests (no BoxLite needed)
    │   ├── test_config.py
    │   ├── test_doctor_lsof.py
    │   ├── test_orchestrator.py
    │   └── test_topo.py
    └── integration/
        └── test_multi_service.py     # 11-service round-trip, gated on BOXLITE_INTEGRATION=1
```

---

## Common tasks

**Add a new service:** define a `ServiceSpec` in `services.py`, add an
entry to the `SERVICES` dict, add the host port default to `InfraConfig`,
add `BOXLITE_<NAME>_HOST_PORT` to `.load()`, run `make up`. Don't forget
to map ALL of the image's `EXPOSE`'d ports explicitly (the SDK auto-bind
silently breaks ALL forwards for that box if any EXPOSE'd port can't be
bound — see SDK gotcha #10 above).

**Debug a stuck service:** `python -m boxlite_local ps` to see status,
`boxlite logs boxlite-local-<name>` for guest logs, `boxlite exec
boxlite-local-<name> -- sh` to drop into the box (if the image has a
shell — minio's `otel/opentelemetry-collector` doesn't).

**Reset to clean state:** `make wipe`. This stops + removes all
`boxlite-local-*` boxes and deletes `~/.boxlite-local/data/`.

**Run integration tests:** `make itest`. Takes ~30s on warm cache. The
test skips itself if any `boxlite-local-*` box is already running
(safety guard to avoid destroying live dev state).
