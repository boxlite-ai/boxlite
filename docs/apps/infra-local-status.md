# infra-local — current state overview

> Snapshot: **2026-05-25** (milestone/infra-local/v0.1.0 — full L1+L2+L3 end-to-end working)
> Branch: `feat/cloud-mvp`
> Platform: **Apple Silicon M5 (arm64), all native, no Lima**
> Entry point: `cd apps/infra-local && make stack-up` (L1 + L2 in one command — see [infra-local-usage.md](./infra-local-usage.md))

## 🟢 Real services, really running (18 processes, M5 native)

### L1 — infra-local 10 boxes (BoxLite microVMs, libkrun on M5 HVF)

| Box | Image | Ports | Real role |
|---|---|---|---|
| `postgres` | `postgres:17-alpine` | 25432 | Real PG, **prod schema pre-loaded** (27 tables, 88 migrations) |
| `redis` | `redis:7-alpine` | 26379 | Real cache + signed-url token store + lock provider |
| `minio` | `minio/minio` | 29000 / 29001 | Real S3, bucket `boxlite` created |
| `registry` | `registry:2` | 25000 | Real OCI registry — actually stores snapshot images |
| `dex` | `dexidp/dex:v2.42.0` | 25556 | Real OIDC — browser actually walks the OAuth2 flow |
| `jaeger` | `jaegertracing/all-in-one:1.67.0` | 26686 | Real trace UI |
| `otel` | `otel/opentelemetry-collector:latest` | 24317 / 24318 / 23133 | Real OTLP receiver |
| `caddy` | `caddy:2-alpine` | 28080 / 12019 | Real reverse proxy, including wildcard `*-*.localhost` routing to proxy |
| `pgadmin` | `dpage/pgadmin4:9.2.0` | 25051 | Real DB management UI |
| `registry-ui` | `joxit/docker-registry-ui` | 25052 | Real registry browse UI |

Start with: `cd apps/infra-local && make stack-up` (automatically runs `up-with-schema` + L2 native processes — see [infra-local-usage.md](./infra-local-usage.md))

### L2 — application control plane (4 native processes, on the host)

| Service | Port | Real role |
|---|---|---|
| **NestJS API** | 3001 | Real, full 88 migrations + 6 PostHog flags bootstrapped to `true` |
| **Go Runner** (M5 native — no Lima) | 3003 | Real, M5 arm64 cgo + libkrun; registered with the API, heartbeat every 5 s |
| **Go Proxy** | 4000 | Real, all sandbox port-preview traffic flows through here (`*-*.localhost:28080` → `:4000`) |
| **Dashboard Vite dev** | 3000 | Real React, real OIDC, MSW removed |

### L3 — sandbox microVMs (user-created)

| | |
|---|---|
| Count | Create N on demand; each = real libkrun arm64 microVM with a live `boxlite-shim` PID |
| Terminal | Real — browser → Caddy → Proxy → Runner → microVM shell (`root@boxlite:~#`) |

---

## 🟡 Still mock / stub / bootstrap-default

| Item | Current state |
|---|---|
| **PostHog service** | Not wired (SaaS, needs real key). **6 feature flags use bootstrap defaults = `true`** (bootstrapped on both the local side and the dashboard side) |
| **Billing (Stripe / in-house)** | Not wired. The dashboard's billing pages (invoices / wallet / tier) call `BILLING_API_URL=http://localhost:3000/api/billing` which routes inside dashboard itself; backed by leftover MSW mock data (the remaining billing handlers still live in `handlers.ts` because the billing sub-path uses a different host) |
| **Svix Webhooks** | Not wired. `SVIX_AUTH_TOKEN` is empty → webhook module reports disabled; console shows cosmetic 500 / 404 |
| **PostHog analytics reporting** | Unused (same PostHog story) |
| **PostHog SaaS control plane** | Not wired |

---

## 🔴 Completely missing (deferrable)

| Missing | Impact |
|---|---|
| **Snapshot Manager** (`apps/snapshot-manager`, Go binary) | Cannot build a custom snapshot from a Dockerfile; only pull an existing OCI image as a snapshot (this is the path we use with `ubuntu:22.04`) |
| **SSH Gateway** (`apps/ssh-gateway`, Go binary) | Dashboard cannot SSH into sandboxes (env var configured but service not started); Terminal / WS take a different path so they're unaffected |
| **dns-shim + TLS** (`*.boxlite.test` HTTPS) | Needs sudo, parked |
| **ClickHouse** | Not installed. Audit telemetry / sandbox metrics fall through the degraded path (`getClient() → null`, write silently skipped) |
| **OpenSearch** (long-term audit log) | Not installed, `AUDIT_PUBLISH_ENABLED=false` |
| **SMTP** (org invite emails) | Not installed |
| **Pylon** (in-app customer support) | Not installed, empty token disables it |

---

## One-liner

**L1 (infrastructure) + L2 (API / Runner / Proxy / Dashboard) + L3 (real microVM sandbox) = 100% real; PostHog / Billing / Webhooks / SSH Gateway / Snapshot Manager / ClickHouse — these 6 peripheral dependencies are absent, and their features are either skipped via bootstrap defaults or simply missing from the UI.**

The full sandbox lifecycle (create → start → terminal → stop → destroy), OIDC login, org management, API key CRUD, region creation, snapshot pull-and-mount — all run through the real path and are fully usable from the dashboard.

---

## Key commits (changes that got us to this state in this session)

| Commit | Description |
|---|---|
| `a5dd1319` | `feat(api): bootstrap PostHog feature flags for local-dev (mirror dashboard)` — unlocks Create Region / Runners list and other server-side flag-gated routes |
| `69a82bed` | `fix(runner): pull images for host architecture instead of hardcoded amd64` — lets M5 pull arm64 images, resolves `ENOEXEC` |
| `8dad81b5` | `feat(infra-local): wire Caddy → apps/proxy for sandbox port-preview URLs` — terminal / preview iframe full chain working |
| `3d5829aa` | `feat(dashboard): bootstrap PostHog feature flags for local-dev` — Create Sandbox button + other UI surfaces visible without PostHog |
| `11625a81` | `feat(L2): API booting + runner binary compiled` — L2 starting point |
| `f5a30940` | `feat(infra-local): pin PG to 17-alpine + load prod schema baseline` — L1 wrap-up |

## Startup / restart cheatsheet

**Day-to-day usage:** `cd apps/infra-local && make stack-up` (L1 + L2 in one command). The block below is the raw command expansion of `stack-up.sh`'s internals, kept only as a reference for debugging or unusual cases.

```bash
# L1: infra-local 10 boxes (with prod schema)
cd apps/infra-local && make up-with-schema

# L2-1: API
cd apps && set -a; source .env; set +a; corepack yarn nx serve api

# L2-2: Runner (M5 native arm64)
BOXLITE_API_URL=http://localhost:3001/api \
BOXLITE_RUNNER_TOKEN=local-shared-runner-token-aaaa1111 \
API_VERSION=2 API_PORT=3003 \
RUNNER_DOMAIN=127.0.0.1 \
BOXLITE_HOME_DIR=$HOME/.boxlite-runner \
INSECURE_REGISTRIES=127.0.0.1:25000 \
AWS_REGION=us-east-1 \
DYLD_LIBRARY_PATH=/Users/lilongen/github/boxlite-cloud-mvp/sdks/go \
/tmp/boxlite-runner

# L2-3: Proxy
PROXY_PORT=4000 PROXY_PROTOCOL=http \
PROXY_API_KEY=boxlite-proxy-key \
BOXLITE_API_URL=http://localhost:3001/api \
OIDC_CLIENT_ID=boxlite OIDC_AUDIENCE=boxlite \
OIDC_DOMAIN=http://localhost:25556/dex \
REDIS_HOST=127.0.0.1 REDIS_PORT=26379 \
SHUTDOWN_TIMEOUT_SEC=10 \
/tmp/boxlite-proxy

# L2-4: Dashboard
cd apps && corepack yarn nx serve dashboard
```

Entry URLs:

| Service | URL |
|---|---|
| Dashboard | http://localhost:3000 |
| API | http://localhost:3001/api |
| Dex (OIDC) | http://localhost:25556/dex |
| Jaeger | http://localhost:26686 |
| pgAdmin | http://localhost:25051 |
| Registry UI | http://localhost:25052 |
| MinIO Console | http://localhost:29001 |
| Caddy (unified entry) | http://localhost:28080 |
