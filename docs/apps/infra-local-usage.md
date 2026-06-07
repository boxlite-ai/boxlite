# infra-local — usage guide

## 0. TL;DR — 8 wrapper commands

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

## 1. First-time startup (brand-new machine, one-time)

### 1.1 Prereqs

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

### 1.2 One-command bring-up

```bash
cd boxlite-cloud-mvp/apps/infra-local
make stack-up       # does everything; see the self-heal steps below
make stack-status   # one-screen health
```

Cold-start time: ~5-7 minutes on first run (most of it is pulling the
`ubuntu:22.04` default snapshot into the local registry). Subsequent
`stack-up` runs reuse the image cache and complete in ~30 s to 1 min.

✅ `stack-up.sh` is **self-healing** — a single `make stack-up` works
from a fresh checkout, after a reboot, or after `make stack-down`,
because it automatically:
1. Installed the orchestrator package (`make install`) if `boxlite_local` wasn't importable yet
2. Brought up L1 boxes (`make up-with-schema`) if they weren't running; `load-schema` is idempotent so it's a no-op when the schema is already present (e.g. the PG data volume survived a reboot)
3. Built the native binaries (`stack-build.sh`) if `/tmp/boxlite-runner` / `/tmp/boxlite-proxy` were missing (e.g. `/tmp` cleared on reboot)
4. Created the two symlinks NestJS needs (`apps/.env`, `apps/apps`)
5. Started api → runner → proxy → dashboard in dependency order, waiting for each to be healthy before the next
6. Detected ports already in use and freed them first (prevents EADDRINUSE)
7. Written PIDs to `apps/infra-local/.logs/<comp>.pid` and logs to `<comp>.log`

> You can still run `make install` / `make stack-build` explicitly — e.g.
> to force a binary rebuild after changing runner/proxy source — but
> `make stack-up` doesn't require it. To rebuild a running component use
> `make stack-restart COMPONENTS=runner` (rebuilds + restarts).

### 1.3 First-time dashboard login

Open <http://localhost:3000> and log in via Dex with one of the
preseeded accounts (see [`apps/infra-local/CONNECTIONS.md` §4](../../apps/infra-local/CONNECTIONS.md)):

- `admin@boxlite.dev` / `password` (admin user)
- `test01@boxlite.dev` / `password` (normal user)

Then click **+ Create Sandbox** → pick region `us` → **Create** → open
the **Terminal** tab → **Connect** → you should see `root@boxlite:~#`.

## 2. Day-to-day dashboard development loop

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

## 3. API development loop

```bash
# nx serve api runs in watch mode — edit apps/api/src/**/*.ts → auto rebuild + restart
# But there are 2 exceptions:
```

| Change | How to handle it |
|---|---|
| Edit `*.entity.ts` (DB schema) | Write a migration at `apps/api/src/migrations/<ts>-name-migration.ts`; the restart runs it automatically |
| Edit `.env` | Ctrl-C + re-run `set -a; source .env; set +a; corepack yarn nx serve api` |
| Edit OpenAPI (controller `@Api*` decorators) | `yarn nx run api:openapi` regenerates `dist/apps/api/openapi.json` → SDK client regenerates → restart dashboard |

## 4. Runner development loop

```bash
# Runner is a native Go binary with no watch mode
pkill -9 -f boxlite-runner
cd apps/runner && go build -o /tmp/boxlite-runner ./cmd/runner && cd -
# Re-run it (use the cheatsheet in the status doc)
```

Runner holds state in memory (box handles, heartbeat state, etc.) — restarting **briefly loses it**. The user's sandboxes are reclaimed ~10 s later by the API reconcile cron.

## 5. Database reset (common during development)

```bash
# Wipe PG entirely and reload the prod schema
cd apps/infra-local && make load-schema  # equivalent to drop-schema + apply
cd -

# Or just truncate user data, preserving schema / migrations state
PGPASSWORD=boxlite psql -h 127.0.0.1 -p 25432 -U boxlite -d boxlite -c "
  TRUNCATE TABLE sandbox, snapshot, snapshot_runner, runner, region, 
                 organization, organization_user, organization_role, 
                 api_key, audit_log CASCADE;
"

# Then restart the API so it re-seeds default region + default runner
```

`~/.boxlite-runner/` must also be cleared, otherwise the runner still thinks the old sandboxes exist:

```bash
pkill -9 -f boxlite-runner
rm -rf ~/.boxlite-runner/{db,boxes,images,rootfs}/
# Restart runner
```

> The above is the raw SQL/shell approach — **do not use it directly** day-to-day. Use the tiered wrappers below.

## 5.5 Tiered cleanup / rebuild decision tree

Five tiers ordered by "how much do you blow away" — **start with the lightest, stop when it's enough**.

| # | Scope | Command | Duration |
|---|---|---|---|
| ① | Restart 1 L2 native process | `make stack-restart COMPONENTS=runner` | ~10 s |
| ② | 1 L1 box stuck → rebuild | `make stack-rebuild-l1-box BOX=registry` | ~3 s |
| ③ | Clear DB user data, preserve schema | `make stack-reset && make stack-up` | ~60 s |
| ④ | Also re-align schema (reload prod baseline) | `make stack-reset-hard && make stack-up` | ~90 s |
| ⑤ | Destroy everything, cold-start from zero | `make stack-nuke && make stack-up` | 3-5 min |

### Scenario 1: **Full rebuild** (tier ⑤)

```bash
cd apps/infra-local
make stack-nuke && make stack-up
```

What it does:
- Stops the 4 L2 native processes
- Deletes all 10 L1 boxes (microVM kernels + rootfs)
- Clears data volumes + `.logs/`
- Re-pulls the 10 images + reloads the prod schema
- Starts L2; the API self-seeds (region / admin / snapshot pulled to active)

**When to use it:** new-hire onboarding / schema upgrade / "I did a bunch of weird stuff and want to go back to a clean state".

### Scenario 2: **Reset + re-up** (tier ③ — most common)

```bash
cd apps/infra-local
make stack-reset && make stack-up
```

Differences from ⑤ — this one **preserves**: L1 boxes, PG schema, image cache, historical logs. It only clears PG **user data** + `~/.boxlite-runner/` runtime state.

**When to use it:** mid-iteration the data got dirty and you want to clear sandbox/org/user; testing "fresh DB" behavior.

### Scenario 3: **Partial reset → partial up** (tiers ①②, 90 % of daily work)

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

### One-sentence decision rule

**Start with `stack-status` → find what's red / stuck → fix it with the lightest tier that works. Never default to `stack-nuke`.**

## 6. Testing techniques

### 6.1 Browser (primary test path)

```
http://localhost:3000  → pick admin / user to log in (dex static users)
```

### 6.2 curl the API (SDK testing / scripts / CI)

```bash
# Use the admin key (skips OIDC, suitable for scripts)
curl -sS \
  -H "Authorization: Bearer local-dev-admin-key" \
  -H "X-BoxLite-Organization-ID: <org-uuid>" \
  http://localhost:3001/api/sandbox/paginated | jq

# Use an OIDC token (simulates a user)
# 1. Log in via the browser, then grab access_token from DevTools sessionStorage
# 2. curl -H "Authorization: Bearer <token>" ...
```

### 6.3 SDK testing

```bash
# Python SDK against the local API
cd sdks/python
BOXLITE_API_URL=http://localhost:3001/api \
BOXLITE_API_KEY=<api-key-via-dashboard-or-curl> \
pytest tests/

# Go SDK is the same: set BOXLITE_API_URL + BOXLITE_API_KEY env vars
```

### 6.4 Direct DB queries (read-only — won't collide with the runner's lock)

```bash
# Inspect sandbox state
sqlite3 ~/.boxlite-runner/db/boxlite.db -header -column \
  "SELECT id, image, status FROM boxes WHERE status='running';"

# Inspect the API primary DB
PGPASSWORD=boxlite psql -h 127.0.0.1 -p 25432 -U boxlite -d boxlite -c "
  SELECT s.name, s.state, r.name as runner FROM sandbox s
  LEFT JOIN runner r ON r.id = s.\"runnerId\" 
  ORDER BY s.\"createdAt\" DESC LIMIT 10;
"
```

### 6.5 Reading logs

```bash
# API stdout: redirected to the terminal where `nx serve` was launched
# Runner stdout: redirected to the terminal where the runner was launched
# Proxy stdout: same

# Box-internal logs (the 10 infra-local boxes)
boxlite logs boxlite-local-postgres
boxlite logs boxlite-local-caddy

# Sandbox microVM-internal logs (managed by the runner)
ls -lt ~/.boxlite-runner/boxes/<id>/logs/
```

## 7. Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| All API calls return 401 | `SSH_GATEWAY_API_KEY` or `PROXY_API_KEY` not set | Check `apps/api/.env` — both must be non-empty |
| Sandbox stuck in PENDING | snapshot has not finished PULLING | Wait 30-60 s; if still stuck, check runner log for image-pull errors |
| Sandbox reaches STARTED but the terminal is blank + `Connection closed` | image is amd64 but runner runs an arm64 microVM | Already fixed (`runner/registry.go` uses `runtime.GOARCH`) — clear the old image cache and re-pull |
| "+ Create Sandbox" missing in the dashboard | PostHog feature-flag bootstrap didn't fire | Check `LOCAL_DEV_FEATURE_FLAG_DEFAULTS` in `PostHogProviderWrapper.tsx` for that flag |
| `POST /api/regions` → 404 "Cannot POST" | API server-side PostHog flag bootstrap didn't fire | Check `bootstrapFlags` config in `app.module.ts` |
| Boxlite-runner hits `Another BoxliteRuntime is already using directory` | Another runner process is holding `~/.boxlite-runner/.lock` | `lsof ~/.boxlite-runner/.lock` to find the PID; decide whether to kill it or that you've used the wrong home dir |
| Terminal `Connection closed` and won't reconnect | signed-url expired (default 300 s) | Click Connect again; the dashboard re-fetches a fresh URL |
| Dashboard loads `Unauthorized` / `401` even just after OIDC login | **Dex SQLite session db cached an old grant** and the new login reuses a stale token (common after a box SIGKILL or long idle). Diagnostic: decode the token; `accessTokenIat` is days old | `make stack-rebuild-l1-box BOX=dex` + `sessionStorage.clear()` in the browser + log in again |
| Sandbox `pulling` is stuck for several minutes | **Registry box TCP still listens but the internal registry process is hung** (SIGKILL side-effect). Confirm: `curl http://127.0.0.1:25000/v2/_catalog` times out after 5 s | `make stack-rebuild-l1-box BOX=registry`; the stuck pull recovers automatically |
| Any L1 box (pgadmin / jaeger / minio / ...) behaves weirdly | Same as above — the box's stateful internal process is broken | `make stack-rebuild-l1-box BOX=<name>` blows it away and rebuilds in one shot |

## 8. Local "release" workflow (MVP internal demo / self-test)

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

## 9. Full stop

```bash
# Stop the 4 native processes
pkill -9 -f "nx.*serve.*(api|dashboard)"
pkill -9 -f "boxlite-runner"
pkill -9 -f "boxlite-proxy"

# Stop the 10 infra boxes (preserve data)
for b in caddy registry-ui pgadmin otel jaeger dex registry minio redis postgres; do
  boxlite stop boxlite-local-$b
done

# Or wipe everything (data lost too)
cd apps/infra-local && make down
```

## One-liner

**Editing `.tsx` + Vite HMR is the default development rhythm.** API / Runner / Proxy are stable infrastructure that run in the background and you don't touch day-to-day. To wipe state: `make load-schema` + clear `~/.boxlite-runner/`. To demo: freeze a commit and run §1 once.
