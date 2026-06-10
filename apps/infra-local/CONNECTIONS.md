# infra-local Connection Reference

This document summarizes endpoints, credentials, and environment variables for every service brought up by `apps/infra-local/`.
**Single source of truth**: the `InfraConfig` dataclass in [boxlite_local/config.py](boxlite_local/config.py).
If a port or credential here disagrees with `config.py`, `config.py` wins.

Last reviewed: 2026-05-25 (milestone/infra-local/v0.1.0).

---

## 0. Important prerequisite: host hub vs host port

Services run inside **BoxLite microVM boxes**. Their exposed ports are addressed from two different perspectives:

| Who is reaching in | Address to use | Notes |
|---|---|---|
| **Process on the host (Mac)** — your `yarn dev` api/dashboard, `psql`, curl, etc. | `127.0.0.1:<host_port>` | Goes through BoxLite's host→box port mapping |
| **Process inside a box** (e.g. the dex box wants to reach the postgres box) | `host.boxlite.internal:<host_port>` | DNS shim provided by gvproxy — **only resolvable inside a box**; the port itself is still `host_port` |

⚠ **Common pitfall**: `host.boxlite.internal` cannot be resolved from the Mac host; `127.0.0.1` inside a box points at the box itself. URLs below default to the **host perspective** unless noted.

The environment variable `BOXLITE_HOST_HUB` overrides the host-hub name (default `host.boxlite.internal`).

---

## 1. PostgreSQL

[config.py:34-37](boxlite_local/config.py#L34-L37) / [services.py:13-40](boxlite_local/services.py#L13-L40)

| Field | Value |
|---|---|
| Host port | `25432` (env `BOXLITE_PG_HOST_PORT`) |
| User | `boxlite` (env `BOXLITE_PG_USER`) |
| Password | `boxlite` (env `BOXLITE_PG_PASSWORD`) — note: dev only, `POSTGRES_HOST_AUTH_METHOD=trust`, password is ignored |
| Database | `boxlite` (env `BOXLITE_PG_DB`) |
| Image | `postgres:17-alpine` |
| Data volume | `~/.boxlite-local/data/pg/` |

**Connection URL (host)**:
```
postgresql://boxlite:boxlite@127.0.0.1:25432/boxlite
```

**Connection URL (in-box)** (e.g. for the api box):
```
postgresql://boxlite:boxlite@host.boxlite.internal:25432/boxlite
```

The `config.pg_url` property returns the in-box form (uses `host_hub`) — [config.py:107-108](boxlite_local/config.py#L107-L108).

**psql one-liner**:
```bash
PGPASSWORD= psql -h 127.0.0.1 -p 25432 -U boxlite -d boxlite
```

### Existing DB user rows (2026-05-25 snapshot)

| user.id | name | email | platform role | personal org | org role |
|---|---|---|---|---|---|
| `boxlite-admin` | BoxLite Admin | _(empty)_ | `admin` | Personal | `owner` |
| `CgQxMjM0EgVsb2NhbA` | admin | admin@boxlite.dev | `user` | Personal | `owner` |
| `CgQ1Njc4EgVsb2NhbA` | test01 | test01@boxlite.dev | `user` | Personal | `owner` |

`boxlite-admin` is the system row seeded by the API on boot and **never participates in login**.
`CgQxMjM0EgVsb2NhbA` (admin) and `CgQ1Njc4EgVsb2NhbA` (test01) are the OIDC `sub`s issued by dex (each is base64 of a protobuf-encoded `{userID, connectorID:'local'}`). Both rows are **auto-written on first login via the dashboard** — see §4 for the two seeded dex accounts.

---

## 2. Redis

[config.py:39-40](boxlite_local/config.py#L39-L40) / [services.py:43-57](boxlite_local/services.py#L43-L57)

| Field | Value |
|---|---|
| Host port | `26379` (env `BOXLITE_REDIS_HOST_PORT`) |
| Auth | **none** (dev only) |
| Image | `redis:7-alpine` |
| Data volume | `~/.boxlite-local/data/redis/` |

**Connection URL (host)**:
```
redis://127.0.0.1:26379
```

**Connection URL (in-box)**:
```
redis://host.boxlite.internal:26379
```

**redis-cli one-liner**:
```bash
redis-cli -h 127.0.0.1 -p 26379 PING
```

---

## 3. MinIO (S3-compatible)

[config.py:42-46](boxlite_local/config.py#L42-L46) / [services.py:59-79](boxlite_local/services.py#L59-L79)

| Field | Value |
|---|---|
| S3 API port | `29000` (env `BOXLITE_MINIO_HOST_PORT`) |
| Console port | `29001` (hardcoded, not parameterized) |
| Access key | `minioadmin` (env `BOXLITE_MINIO_USER`) |
| Secret key | `minioadmin` (env `BOXLITE_MINIO_PASSWORD`) |
| Image | `minio/minio:latest` |
| Data volume | `~/.boxlite-local/data/minio/` |
| Region | `us-east-1` (MinIO default) |

**S3 endpoint (host)**: `http://127.0.0.1:29000`
**S3 endpoint (in-box)**: `http://host.boxlite.internal:29000`
**Web Console**: `http://127.0.0.1:29001/` (log in with the same `minioadmin/minioadmin`)

**aws-cli example**:
```bash
aws --endpoint-url http://127.0.0.1:29000 \
    --region us-east-1 \
    s3 ls \
  AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin
```

The minio-init one-shot container ([services.py:93-108](boxlite_local/services.py#L93-L108)) automatically creates a few buckets once minio is ready — no manual setup needed.

---

## 4. Dex (OIDC IdP)

[config.py:50-51](boxlite_local/config.py#L50-L51) / [services.py:135-186](boxlite_local/services.py#L135-L186)

| Field | Value |
|---|---|
| Host port | `25556` (env `BOXLITE_DEX_HOST_PORT`) |
| Image | `dexidp/dex:v2.42.0` |
| Data volume | dex's built-in SQLite at `/var/dex/dex.db` inside the box (not persisted) |

**Issuer URL** (**special case: deliberately published as localhost, not host_hub**) — [config.py:118-128](boxlite_local/config.py#L118-L128):
```
http://localhost:25556/dex
```
Reason: the dashboard runs the OIDC flow in the browser, and the browser cannot resolve `host.boxlite.internal`, so the issuer must be browser-reachable.

**Discovery URL**:
```
http://localhost:25556/dex/.well-known/openid-configuration
```

### Built-in login accounts

Defined in the `staticPasswords` block of the dex config in
[services.py](boxlite_local/services.py). Both are seeded automatically
by every `make stack-up` / `make stack-nuke && make stack-up` cycle.

| Email | Password | Username | Dex userID | OIDC sub (after login) | API platform role |
|---|---|---|---|---|---|
| `admin@boxlite.dev` | `password` | admin  | `1234` | `CgQxMjM0EgVsb2NhbA` | `user` (regular org owner) |
| `test01@boxlite.dev` | `password` | test01 | `5678` | `CgQ1Njc4EgVsb2NhbA` | `user` (regular org owner) |

Both accounts get an auto-created `user` row + `Personal` organization
+ `organization_user` owner row on first login, via the API's
`JwtStrategy.validate()` → `userService.create()` →
`OrganizationService.handleUserCreatedEvent` chain.

Note: the platform-admin user `boxlite-admin` is a separate
system-seeded row (no OIDC, no password) used by the admin API key
and internal flows. It does NOT participate in login.

### OAuth clients

The dex config defines one static client (id `boxlite`) used by the
dashboard. To add a third login account, append to `staticPasswords` in
[services.py](boxlite_local/services.py) and run
`make stack-rebuild-l1-box BOX=dex` to pick up the new config.

---

## 5. Local OCI Registry

[config.py:47-48](boxlite_local/config.py#L47-L48) / [services.py:114-130](boxlite_local/services.py#L114-L130)

| Field | Value |
|---|---|
| Host port | `25000` (env `BOXLITE_REGISTRY_HOST_PORT`) |
| Auth | **none** |
| Image | `registry:2` |
| Data volume | `~/.boxlite-local/data/registry/` |

**API root**:
```
http://127.0.0.1:25000/v2/
```

**docker push example**:
```bash
docker tag my-image:dev 127.0.0.1:25000/my-image:dev
docker push 127.0.0.1:25000/my-image:dev
```

⚠ Pushing from docker requires `insecure-registries: ["127.0.0.1:25000"]` in the docker daemon config (HTTP, not HTTPS).

---

## 6. Jaeger (Tracing UI)

[config.py:53-54](boxlite_local/config.py#L53-L54) / [services.py:193-208](boxlite_local/services.py#L193-L208)

| Field | Value |
|---|---|
| Host port (UI) | `26686` (env `BOXLITE_JAEGER_HOST_PORT`) |
| Host port (OTLP gRPC) | `26687` (fed by the OTel Collector via host-as-hub) |
| Image | `jaegertracing/all-in-one:1.67.0` (`COLLECTOR_OTLP_ENABLED=true`) |
| Storage | in-memory (cleared on restart) |
| Auth | none |

**UI**: `http://127.0.0.1:26686/`
**Trace ingestion**: the OTel Collector (§8) forwards traces here over OTLP gRPC (`26687` → box `:4317`), so the Jaeger UI shows traces sent to the collector.

---

## 7. pgAdmin (Postgres GUI)

[config.py:56-59](boxlite_local/config.py#L56-L59) / [services.py:210-234](boxlite_local/services.py#L210-L234)

| Field | Value |
|---|---|
| Host port | `25051` (env `BOXLITE_PGADMIN_HOST_PORT`) |
| Login email | `admin@boxlite.dev` (env `BOXLITE_PGADMIN_EMAIL`) |
| Login password | `boxlite` (env `BOXLITE_PGADMIN_PASSWORD`) |
| Image | `dpage/pgadmin4:9.2.0` |

**UI**: `http://127.0.0.1:25051/`
**First launch**: after logging in, manually Add Server using the PG details in §1.

---

## 8. OpenTelemetry Collector

[config.py:68-71](boxlite_local/config.py#L68-L71) / [services.py:296-330](boxlite_local/services.py#L296-L330)

| Field | Port | env override |
|---|---|---|
| OTLP gRPC | `24317` | `BOXLITE_OTEL_GRPC_PORT` |
| OTLP HTTP | `24318` | `BOXLITE_OTEL_HTTP_PORT` |
| Health check | `23133` | `BOXLITE_OTEL_HEALTH_PORT` |
| Image | `otel/opentelemetry-collector:latest` | — |

**OTLP endpoint for SDKs**:
- gRPC: `127.0.0.1:24317` (host) / `host.boxlite.internal:24317` (in-box)
- HTTP: `http://127.0.0.1:24318/v1/traces` (host)

Downstream config: the **traces** pipeline exports to both `debug`
(stdout) and `otlp/jaeger` (`host.boxlite.internal:26687`), so traces
sent to the collector show up in the Jaeger UI. **metrics** and
**logs** pipelines export to `debug` only (Jaeger doesn't ingest them).

---

## 9. Registry UI

[config.py:61-62](boxlite_local/config.py#L61-L62) / [services.py:240-254](boxlite_local/services.py#L240-L254)

| Field | Value |
|---|---|
| Host port | `25052` (env `BOXLITE_REGISTRY_UI_HOST_PORT`) |
| Image | `joxit/docker-registry-ui:main` |
| Auth | none |

**UI**: `http://127.0.0.1:25052/`

---

## 10. Caddy reverse proxy (unified entry)

[config.py:64-66](boxlite_local/config.py#L64-L66) / [services.py:341-372](boxlite_local/services.py#L341-L372)

| Field | Value |
|---|---|
| HTTP port | `28080` (env `BOXLITE_CADDY_HTTP_PORT`) |
| HTTPS port | `28443` (env `BOXLITE_CADDY_HTTPS_PORT`) (no certs, not enabled) |
| Admin API (in-box) | `2019` (not normally exposed on the host) |

**Unified entry**: `http://127.0.0.1:28080/`

| Route | Target |
|---|---|
| Host `^<port>-<token>.…` (regexp) | Proxy (`host:4000`) — sandbox port-preview URLs |
| `/pgadmin/*` | pgAdmin (25051) |
| `/jaeger/*` | Jaeger UI (26686) |
| `/dex/*` | Dex (25556) |
| `/minio-console/*` | MinIO Console (29001) |
| `/minio/*` | MinIO S3 API (29000) |
| `/registry-ui/*` | Registry UI (25052) |
| `/registry/*` | Registry v2 API (25000) |
| `/` (catch-all) | Static help text listing the routes above (not a proxy) |

Note: the `_caddyfile()` builder in `boxlite_local/services.py` is the
source of truth. `/` returns a static help page; the **Proxy** (`:4000`)
is reached only by the signed port-preview Host matcher
(`<port>-<token>.localhost:28080`), not by path `/`. Caddy reverse-proxies
to host service ports via `host_hub` (`host.boxlite.internal`) because
Caddy itself runs inside a box.

---

## 11. L2 application processes (orchestrated by `make stack-up`)

These run as **native macOS processes** (not inside boxes) and are
started + supervised by the `stack-*` Makefile targets under
[`apps/infra-local/`](.). PID files + logs land under
`apps/infra-local/.logs/<component>.{pid,log}`.

| Service | Process | Host port |
|---|---|---|
| Dashboard (React + Vite) | `corepack yarn nx serve dashboard` | `3000` |
| API (NestJS) | `corepack yarn nx serve api --buildTargetOptions.generatePackageJson=false --buildTargetOptions.skipTypeChecking=true` (CWD: `apps/`; flags explained in `scripts/stack-up.sh`) | `3001` |
| Proxy (Go) | `/tmp/boxlite-proxy` | `4000` |
| Runner (Go) | `/tmp/boxlite-runner` (native arm64; spawns sandbox microVMs in `~/.boxlite-runner/`) | `3003` (API_PORT) |

Lifecycle wrappers — see [README.md](README.md#make-targets) for the full surface:

```bash
make stack-up                                    # start L1 (if down) + L2
make stack-restart COMPONENTS="api proxy"        # restart subset
make stack-logs COMPONENT=runner                 # tail one log
make stack-status                                # one-screen health
make stack-down                                  # stop L2 (L1 stays up)
make stack-down ARGS=--all                       # stop L2 + L1
```

### Dev-only runner-score overrides (set automatically by `stack-up.sh`)

The Go runner reports **system-wide** CPU / memory / disk usage to the
API — not just what the runner + its boxes actually own. On a real EC2
runner host that's a correct signal. On a dev MacBook sharing RAM with
VS Code, Chrome, Docker Desktop, and the L1 dev stack itself, those
metrics easily exceed prod's 75 % penalty threshold and drag the
runner's `availabilityScore` below 10, at which point the API rejects
sandbox creates with `"No available runners"` — even though the runner
is idle.

`stack-up.sh` exports the following overrides before booting the API so
the dev runner stays schedulable:

| Env var | M5-dev value | Prod default |
|---|---|---|
| `RUNNER_AVAILABILITY_SCORE_THRESHOLD` | `5`  | `10` |
| `RUNNER_MEMORY_PENALTY_THRESHOLD`     | `95` | `75` |
| `RUNNER_DISK_PENALTY_THRESHOLD`       | `95` | `75` |

These are safe in this context because there's only one runner and no
autoscaler is in play. If you set them yourself in `apps/api/.env`,
your values win (the script's `export` happens before `.env` is
sourced; `set -a` lets `.env` override).

The right structural fix is to make the runner report only its own /
boxes-owned resources, not the host total — tracked as a follow-up
outside this milestone.

Dashboard login credentials are in §4: `admin@boxlite.dev` / `password`
(or `test01@boxlite.dev` / `password` for a non-admin user).
After logging in, the effective identity is the OIDC `sub` user with
`owner` role in their own personal org (see the table in §1).

---

## 12. Data directories and reset

| Path | Contents |
|---|---|
| `~/.boxlite-local/data/pg/` | PostgreSQL data |
| `~/.boxlite-local/data/redis/` | Redis dumps |
| `~/.boxlite-local/data/minio/` | MinIO object storage |
| `~/.boxlite-local/data/registry/` | OCI image layers |
| `~/.boxlite/images/extracted/` | BoxLite image cache (managed by the BoxLite SDK, not part of infra-local) |

`BOXLITE_DATA_DIR` overrides the data root in one shot.

**Reset commands**:
```bash
cd apps/infra-local
make wipe       # stop + remove boxes + clear data_dir
make up         # bring everything back up
```

---

## 13. Quick reference card (host perspective, drop into `.env`)

```bash
# Postgres
DATABASE_URL=postgresql://boxlite:boxlite@127.0.0.1:25432/boxlite

# Redis
REDIS_URL=redis://127.0.0.1:26379

# MinIO / S3
S3_ENDPOINT=http://127.0.0.1:29000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_REGION=us-east-1

# Dex (OIDC; note this is localhost, not host_hub)
OIDC_ISSUER=http://localhost:25556/dex
OIDC_DISCOVERY=http://localhost:25556/dex/.well-known/openid-configuration

# Local OCI Registry
DOCKER_REGISTRY=127.0.0.1:25000

# OpenTelemetry
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:24318
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:24318/v1/traces

# Unified entry (for the frontend proxy)
CADDY_GATEWAY=http://127.0.0.1:28080

# Dashboard login (dex)
DEX_TEST_USER=admin@boxlite.dev
DEX_TEST_PASSWORD=password
```

---

## Appendix: env variable cheat sheet

All variables are read in `InfraConfig.load()` at [config.py:74-103](boxlite_local/config.py#L74-L103):

| Env | Default |
|---|---|
| `BOXLITE_HOST_HUB` | `host.boxlite.internal` |
| `BOXLITE_PG_HOST_PORT` | `25432` |
| `BOXLITE_PG_USER` | `boxlite` |
| `BOXLITE_PG_PASSWORD` | `boxlite` |
| `BOXLITE_PG_DB` | `boxlite` |
| `BOXLITE_REDIS_HOST_PORT` | `26379` |
| `BOXLITE_MINIO_HOST_PORT` | `29000` |
| `BOXLITE_MINIO_USER` | `minioadmin` |
| `BOXLITE_MINIO_PASSWORD` | `minioadmin` |
| `BOXLITE_REGISTRY_HOST_PORT` | `25000` |
| `BOXLITE_DEX_HOST_PORT` | `25556` |
| `BOXLITE_JAEGER_HOST_PORT` | `26686` |
| `BOXLITE_PGADMIN_HOST_PORT` | `25051` |
| `BOXLITE_PGADMIN_EMAIL` | `admin@boxlite.dev` |
| `BOXLITE_PGADMIN_PASSWORD` | `boxlite` |
| `BOXLITE_REGISTRY_UI_HOST_PORT` | `25052` |
| `BOXLITE_CADDY_HTTP_PORT` | `28080` |
| `BOXLITE_CADDY_HTTPS_PORT` | `28443` |
| `BOXLITE_OTEL_GRPC_PORT` | `24317` |
| `BOXLITE_OTEL_HTTP_PORT` | `24318` |
| `BOXLITE_OTEL_HEALTH_PORT` | `23133` |
| `BOXLITE_DATA_DIR` | `~/.boxlite-local/data` |
