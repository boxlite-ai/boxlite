# Milestone: `apps/infra-local/v0.9.0`

**Tag:** `apps/infra-local/v0.9.0` at commit `0a71bb5b`
**Date:** 2026-05-25
**Branch:** `feat/cloud-mvp` (70 commits ahead of `origin/main`)
**Scope:** +16,858 / −831 lines, 114 files changed

This milestone delivers a fully self-hosted local development stack on
Apple Silicon (M5). A developer can run a single command to bring up
the entire BoxLite cloud-MVP control plane on their laptop and create
real microVM sandboxes through the dashboard — no AWS, no Lima, no
Docker daemon for the application boxes.

---

## Executive summary

| Layer | What it is | Where it runs |
|---|---|---|
| **L1 — infra-local** | 10 BoxLite microVM boxes providing PostgreSQL, Redis, MinIO, OCI registry, Dex (OIDC), Caddy, Jaeger, pgAdmin, registry-ui, OpenTelemetry collector | Inside libkrun microVMs on macOS Hypervisor |
| **L2 — application control plane** | 4 native processes: NestJS API (`:3001`), Go Runner (`:3003`), Go Proxy (`:4000`), Vite Dashboard (`:3000`) | Directly on macOS host, all `arm64` native |
| **L3 — user sandboxes** | N user-created Ubuntu/Alpine sandboxes | libkrun microVMs spawned by the L2 Runner |

End-to-end verified: from `make stack-nuke` (cold) to creating a sandbox
via the dashboard and getting `root@boxlite:~#` in the in-browser
terminal — **~80 seconds total, no manual intervention**.

---

## Operate-by-make surface

All lifecycle operations are exposed as `make` targets under
`apps/infra-local/`:

```bash
cd apps/infra-local

# bring up
make stack-up                                  # L1 + L2 + init-data wait
make stack-up COMPONENTS="api dashboard"       # subset

# inspect
make stack-status                              # one-screen health (L1 + L2)
make stack-logs COMPONENT=runner               # tail -F one component
make stack-logs COMPONENT=all                  # multiplex tail

# iterate
make stack-restart COMPONENTS=runner           # native restart (runner = rebuild + restart)
make stack-rebuild-l1-box BOX=registry         # destroy + recreate one L1 box

# tear down
make stack-down                                # L2 only
make stack-down ARGS=--all                     # L2 + L1
make stack-reset                               # truncate user data (schema preserved)
make stack-reset-hard                          # re-apply prod schema baseline
make stack-nuke                                # destroy L1 boxes + wipe data + .logs
```

A tiered cleanup decision tree is documented at
[`docs/apps/infra-local-usage.md` §5.5](../infra-local-usage.md).

---

## What's working end-to-end (verified)

| Capability | Mechanism |
|---|---|
| Cold-start from zero | `make stack-nuke && make stack-up` boots all 14 services + auto-seeds + waits for default snapshot — ~80 s |
| OIDC login via Dex | `admin@boxlite.dev` / `password`; API auto-creates user + Personal org + organization_user owner row on first login |
| Sandbox lifecycle | create → start → stop → destroy through dashboard or `POST /api/sandbox` |
| Live terminal | dashboard "Terminal" tab → Connect → real interactive shell inside the microVM via WebSocket through Caddy → Proxy → Runner |
| Snapshot pull | API auto-creates `ubuntu:22.04` default snapshot; runner pulls `arm64` layer from local registry and unpacks for libkrun |
| Region + Runner management | dashboard pages for shared/custom regions and BYO custom runners |
| API key management | full CRUD; admin API key auto-seeded at API boot |

---

## Architecture changes

### L1 — `apps/infra-local/` (Python orchestrator)

A new Python package (`boxlite_local`) dogfoods the BoxLite Python SDK
to orchestrate 10 service boxes:

- **`services.py`** — declarative `ServiceSpec` definitions for every
  service (image, ports, env, volumes, healthcheck, dependencies)
- **`orchestrator.py`** — topological dependency resolution + parallel
  start within layers + exec-based and HTTP-based healthcheck waits
- **`config.py`** — `InfraConfig` dataclass; every port / credential /
  data path is env-overridable
- **`doctor.py`** — preflight checks (SDK installed, libkrun runtime
  reachable, ports free)
- **`cli.py` / `__main__.py`** — `python -m boxlite_local {up,down,ps,doctor}`

PostgreSQL is pinned to `17-alpine` and pre-loaded with the production
schema baseline (`apps/infra-local/sql/schema-baseline.sql`: 27 tables,
76 indexes, 88 migrations) so `RUN_MIGRATIONS=true` is a no-op on first
boot.

### L2 — application control plane (native processes)

- **API** (NestJS, `apps/api/`) — runs as `nx serve api`, watches for
  changes. Reads `.env` from `apps/.env` (symlinked to
  `apps/api/.env`).
- **Runner** (Go, `apps/runner/`) — native arm64 binary built with
  `go build`, links against `libboxlite.{a,dylib}` v0.9.5. Auto-pulls
  images for the host architecture (`runtime.GOARCH`) — fix avoids
  `ENOEXEC: Exec format error` on Apple Silicon.
- **Proxy** (Go, `apps/proxy/`) — built and wired into Caddy with a
  host-regexp matcher that forwards `<port>-<token>.localhost:28080`
  sandbox-preview URLs to the proxy's `:4000`.
- **Dashboard** (React + Vite, `apps/dashboard/`) — launched with
  `VITE_API_URL=/api` so the SDK uses Vite's dev-proxy to reach the
  local API instead of falling back to the prod default
  `https://app.boxlite.io/api`.

Wrapper scripts under `apps/infra-local/scripts/` orchestrate everything:

- `stack-build.sh` — `go build` runner + proxy + `yarn install`
- `stack-up.sh` / `stack-down.sh` / `stack-restart.sh` — process
  lifecycle with PID files + log files under
  `apps/infra-local/.logs/`
- `stack-status.sh` — one-screen health summary
- `stack-logs.sh` — tail one or all logs
- `stack-reset.sh` — tiered cleanup (soft / hard / nuke)
- `seed-init-data.sh` — verifies API self-seed completed and waits
  for the default snapshot to reach `active`

### L3 — user sandboxes (`~/.boxlite-runner/`)

Each sandbox is a separate libkrun microVM managed by the runner. The
runner's home directory is **deliberately separate** from infra-local's
`~/.boxlite/` so user state can't pollute infrastructure state.

---

## Key fixes that unblocked the milestone

| Fix | Symptom before |
|---|---|
| `runner/registry.go`: use `runtime.GOARCH` instead of hardcoded amd64 | Sandbox started but every exec failed with `ENOEXEC: Exec format error` because amd64 binaries can't run on arm64 kernel |
| `jwt.strategy.ts`: pass `personalOrganizationDefaultRegionId` to user create | First OIDC login created the user row but the async `UserCreatedEvent` listener silently failed → dashboard showed `Cannot read properties of undefined (reading 'id')` |
| API + dashboard PostHog `bootstrapFlags` | All server routes guarded by `@RequireFlagsEnabled([...])` returned 404 ("Cannot POST /api/regions") and dashboard hid "+ Create Sandbox" because PostHog wasn't configured locally |
| Caddy host-regexp matcher → Proxy `:4000` | Terminal iframe loaded `http://22222-<token>.localhost:28080` but had no route to forward through |
| `apps/.env` symlink to `apps/api/.env` | NestJS `ConfigModule` reads `.env` from `process.cwd()` which is `apps/`, not `apps/api/` |
| `SSH_GATEWAY_API_KEY` + `PROXY_API_KEY` required even when unused | `ApiKeyStrategy.validate()` calls `getOrThrow('sshGateway.apiKey')` at the top → every request returned 401 |

---

## Known limitations (intentional, not bugs)

| Mocked / missing | Impact | Workaround |
|---|---|---|
| PostHog | No real feature-flag service | 6 flags hard-defaulted to `true` via bootstrapFlags |
| Billing (Stripe) | Wallet / invoices / spending pages | MSW handlers still respond locally |
| Svix Webhooks | Webhook configuration page | Cosmetic 404/500 in console |
| Snapshot Manager | Can't build snapshots from a Dockerfile | Pull a ready-made OCI image as a snapshot instead |
| SSH Gateway | Dashboard "SSH" button | Use Terminal (WebSocket) instead |
| ClickHouse | Long-term sandbox metrics | Short-term metrics via OTel still visible |
| OpenSearch | Audit log durability | `AUDIT_PUBLISH_ENABLED=false` |
| SMTP | Org invite emails | Copy invite link manually |
| dns-shim + TLS | `*.boxlite.test` HTTPS | Parked (needs sudo) |

---

## Documentation produced

- [`docs/apps/infra-local-status.md`](../infra-local-status.md) — service inventory (real vs mock vs missing)
- [`docs/apps/infra-local-usage.md`](../infra-local-usage.md) — day-to-day workflow + tiered cleanup decision tree
- [`apps/infra-local/CONNECTIONS.md`](../../../apps/infra-local/CONNECTIONS.md) — endpoint + credential + env var reference for every L1 service
- [`apps/infra-local/README.md`](../../../apps/infra-local/README.md) — quick start + Makefile target overview
- [`CLAUDE.md`](../../../CLAUDE.md) "Documentation Language" — committed docs must be English; non-English drafts must be translated before `git add`

---

## Phase chronology

This milestone was built in four phases, each fully documented in
`docs/apps/`:

| Phase | Scope | Outcome |
|---|---|---|
| 1 — PoC | One-box smoke test | Confirmed BoxLite SDK can host long-running services |
| 2 — Walking skeleton | `boxlite_local` package + Postgres alone | Verified topological orchestration + healthcheck loop |
| 3a | + Redis, MinIO, OCI registry | 5-service round-trip integration test |
| 3b | + Dex, Jaeger, pgAdmin, registry-ui | 9-service round-trip |
| 3c | + OTel collector, Caddy reverse proxy | 11-service round-trip + HTTPS probe (HTTP-only after TLS limitations) |
| 3d | Wrap + comprehensive E2E suite (10 protocol-level tests) | L1 complete |
| L2 boot | API + Runner + Proxy + Dashboard native | First real microVM created via `POST /api/sandbox` |
| L2 hardening | Stack wrapper scripts, init-data lifecycle, terminal end-to-end | Operate-by-make for full lifecycle |

---

## Next milestone candidates

| Candidate tag | Scope |
|---|---|
| `ms/dashboard-mvp-ready` | All dashboard pages working against real backend, including billing/webhooks/snapshot-builder if scoped in |
| `ms/snapshot-manager-real` | Replace pull-only snapshot creation with the actual snapshot-manager service for Dockerfile builds |
| `ms/cloud-deploy-real` | Same control plane deployed to AWS via SST, parity-verified with local |
| `ms/multi-runner-byo` | Custom region + multiple custom runners (BYO infra) flow validated |

---

## How to return to this milestone

```bash
# Inspect the tag
git tag -n10 apps/infra-local/v0.9.0

# Check out the exact state
git checkout apps/infra-local/v0.9.0

# Bring the stack up at this snapshot
cd apps/infra-local && make stack-up
```
