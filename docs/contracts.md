# Contracts

Three programs, two wires. Everything here is normative for the prototype.

```
 coding agent ──(CLI: boxlite-app)──▶ control plane (CP) ──(BoxLite /v1 REST)──▶ app Box
                                           ▲   │                                   │
                                           │   └──(HTTP via Box tunnel, control secret)──▶ supervisor
                                           └──────(supervisor → CP, box token)────────────┘
 end user ──▶ app env origin https://<port>-d-<hex>…/ (a CP listener, §3) ──▶ supervisor gateway :8080 ──▶ service (PORT)
```

## 0. Shared vocabulary

- **App** `name` (`^[a-z][a-z0-9-]{1,30}$`), one **App key** `bxl_app_<32 base32>` created with the App.
- **Environment** `main` by default. Each env owns: one Box (created lazily on first deploy), one Neon branch, N volumes, a Spec version history, a deployment counter.
- **Spec** = JSON produced from `boxlite.toml` merged with `[env.<name>]` plus platform-assigned values. Versions are integers starting at 1, immutable.
- **Deployment** `#N` per env, monotonically increasing. Statuses: `queued | uploading | building | migrating | starting | live | failed | cancelled | superseded | rolled_back`.
- **Source snapshot** `snap_<sha256 of manifest>`; a manifest is `[{path, size, mode, sha256}]`.
- **Release**: in the prototype a release is a directory on the env's Box: `/home/boxlite/app/releases/<deployment N>/`. Rollback switches the `current` symlink. No release leaves the Box.

### boxlite.toml → Spec JSON

```jsonc
{
  "app": "crm", "environment": "main", "version": 3, "deployment": 7, "base_version": 2,
  "runtime": { "image": "node", "size": "small", "build": ["npm ci", "npm run build"], "output": null },
  "services": [
    { "name": "web", "command": "node server.js", "port": true, "health": "/healthz" },
    { "name": "worker", "command": "node worker.js" },
    { "name": "site", "static": "dist/" }
  ],
  "schedules": [ { "name": "daily-summary", "cron": "0 9 * * *", "target": "web:/jobs/daily-summary" } ],
  "database": { "migrations": "migrations/", "applied": [ { "file": "0001_init.sql", "sha256": "…", "deployment": 2 } ] } | null,
  "volumes": [ { "name": "uploads", "mount": "/data/uploads", "mode": "rw", "from": null, "path": null } ],
  "auth": { "providers": ["google", "github"], "protect": ["/app/*"] } | null,
  "domains": { "builtin": "crm", "custom": [] },
  "access": "private" | "org" | "public",
  "variables": { "LOG_LEVEL": "info" },
  "secrets": { "OPENAI_API_KEY": "org/openai" },
  "assigned": { "box_id": "aB3cD4eF5gH6", "box_url": "https://8080-…proxy.dev.boxlite.ai", "db_host": "ep-….neon.tech", "db_branch": "br-…", "app_url": "https://10001-d-<cp hex>.proxy.dev.boxlite.ai" }
}
```

Rules the CLI enforces locally (`check`) and the CP re-checks:

- `[runtime].image` ∈ `base | python | node` (dev allowlist: `ghcr.io/boxlite-ai/boxlite-agent-<image>:v0.1.0`). `size` ∈ `nano|small|medium|large` → cpus/mem `1/1024, 1/2048, 2/4096, 4/8192`.
- Exactly one service is **exposed**: the first with `port = <int>` or `static`. Its `port` value is a hint only; the supervisor sets `PORT`.
- `static` services: no `command`; path relative to project root (after build).
- `health` defaults to `/` for exposed command services. 2xx within 60 s = healthy.
- migrations: `NNNN_name.sql`, 4+ digits, unique, ascending; applied files' sha256 must not change.
- `[[schedule]].target` = `<service>:<path>`; service must be exposed.

## 1. CLI ↔ Control plane (`/v1`)

Auth: `Authorization: Bearer <App key>`. The App key identifies the App, so `{app}` in paths must match the key or → 403.
Errors: `{"error": {"code": "<snake>", "message": "<human>", "next": "<what to do>"}}`. CLI exit codes map from `code`:

| code | exit | meaning |
|---|---|---|
| `unauthenticated` | 2 | bad/missing key |
| `not_found_app` / `not_found_env` | 3 | |
| `not_found` | 4 | resource |
| `forbidden` | 5 | out of key scope |
| `unavailable` | 6 | CP or BoxLite down |
| `invalid_manifest` | 7 | check failed (body carries `errors[]` like `check --json`) |
| `deploy_failed` | 8 | body carries `step`, `log_tail` |
| `stale_base` | 9 | `base_version` < latest |
| `rate_limited` | 6 | 429, retryable: wait `Retry-After` seconds (also `error.retry_after`) and rerun; see "Limits" in 4.1 |

Endpoints (prototype subset; all JSON unless noted):

```
GET    /v1/apps/{app}                                 → App + envs summary (status, url, latest deployment)
GET    /v1/apps/{app}/context                         → everything an agent needs, {format: markdown|json}
GET    /v1/apps/{app}/activity?limit=
GET    /v1/apps/{app}/envs                            → [EnvSummary]
POST   /v1/apps/{app}/envs            {name, from?, with_data?}
GET    /v1/apps/{app}/envs/{env}
DELETE /v1/apps/{app}/envs/{env}
GET    /v1/apps/{app}/envs/{env}/spec?version=        → Spec (latest by default)
POST   /v1/apps/{app}/envs/{env}/plan {manifest, base_version, upload?: {files, bytes, warnings}}
                                                      → {latest_version, stale, changes:[{kind:"+|~|-|online_only", path, from, to}], errors:[], warnings:[]}
POST   /v1/apps/{app}/uploads         {manifest:[{path,size,mode,sha256}]}
                                                      → {upload_id, missing:[sha256…]}
PUT    /v1/apps/{app}/uploads/{id}/files/{sha256}     body = raw bytes (application/octet-stream)
POST   /v1/apps/{app}/uploads/{id}/complete            → {snapshot_id, files, bytes}
POST   /v1/apps/{app}/envs/{env}/deployments
         {kind:"deploy"|"apply", snapshot_id?, manifest, base_version, message?, force?}   (Idempotency-Key header)
         {kind:"rollback", to: N, with_database?: bool}
                                                      → Deployment {number, status, …} (202)
GET    /v1/apps/{app}/envs/{env}/deployments?limit=
GET    /v1/apps/{app}/envs/{env}/deployments/{n}      → Deployment incl. steps[], log tail, spec_version, changes
GET    /v1/apps/{app}/envs/{env}/deployments/{n}/events   SSE: event: step|log|done, data: JSON
POST   /v1/apps/{app}/envs/{env}/deployments/{n}/cancel
GET    /v1/apps/{app}/envs/{env}/deployments/{n}/source   → tar.gz of the snapshot
GET    /v1/apps/{app}/envs/{env}/services              → [{name, state, restarts, last_exit_code, health, pid}]
POST   /v1/apps/{app}/envs/{env}/services/{name}/restart
POST   /v1/apps/{app}/envs/{env}/schedules/{name}/run
GET    /v1/apps/{app}/envs/{env}/logs?source=&since=&limit=&follow=1   (follow → SSE event: log)
GET|PUT /v1/apps/{app}/envs/{env}/access               {access}
GET    /v1/apps/{app}/envs/{env}/db                    → {status, host, database, user, branch, size_bytes}
GET    /v1/apps/{app}/envs/{env}/db/schema[/{table}]
GET    /v1/apps/{app}/envs/{env}/db/rows/{table}?where=&limit=&offset=
POST   /v1/apps/{app}/envs/{env}/db/sql               {query, write?: bool, explain?: bool} → {columns, rows, elapsed_ms, row_count}
GET    /v1/apps/{app}/envs/{env}/db/migrations         → [{file, status: applied|pending|changed, deployment?}]
GET|POST /v1/apps/{app}/envs/{env}/db/snapshots        POST {message}
POST   /v1/apps/{app}/envs/{env}/db/restore            {to?: iso8601, snapshot?: id}
```

`Deployment` object:

```jsonc
{ "number": 7, "kind": "deploy", "status": "building", "message": "Drag deals", "by": "key:…a91f",
  "created_at": "…", "finished_at": null, "spec_version": 3, "base_version": 2, "snapshot_id": "snap_…",
  "steps": [ {"name":"upload","status":"done","ms":1200}, {"name":"build","status":"running"} ],
  "changes": [ {"kind":"+","path":"database","to":"neon branch main"} ],
  "error": null | {"step":"build","message":"…","log_tail":["…"]}, "url": "https://10001-d-…proxy.dev.boxlite.ai" }
```

Events on `/events` (SSE, `id:` = seq):

```
event: step   data: {"name":"build","status":"running"|"done"|"failed","ms"?:n}
event: log    data: {"ts":"…","source":"build","line":"…"}
event: done   data: {"status":"live"|"failed","deployment":{…}}
```

## 2. Supervisor ↔ Control plane

### 2.1 Box bootstrap

CP creates the Box with:

```jsonc
{ "name": "app-<app>-<env>", "image": "ghcr.io/boxlite-ai/boxlite-agent-<image>:v0.1.0",
  "cpus": n, "memory_mib": n, "disk_size_gb": 10, "auto_stop": 900, "auto_resume": true,
  "network": { "inbound": { "mode": "enabled" } },
  "env": { "BOXLITE_CP_URL": "https://<cp>", "BOXLITE_BOX_TOKEN": "bxt_…", "BOXLITE_ENV_ID": "env_…", "SV_TRUST_USER_HEADERS": "1" },
  "cmd": ["sh", "-c", BOOT, "microcloud-boot", ROOT] }
```

then `POST /v1/boxes/{id}/network/tunnel?port=8080` → `uri` stored as `assigned.box_url`. `cmd` re-runs as PID 1, as the image user `boxlite` (uid 1001), on every start/wake, so the supervisor always comes back. The source of truth for `BOOT` and `ROOT` is `control-plane/src/platform.ts` (`BOX_CMD`); the supervisor's root e2e test runs them from there:

```sh
# BOOT, as boxlite
L=/usr/local/sbin/microcloud-sv;
if [ -x "$L" ] && sudo -n -l "$L" >/dev/null 2>&1;
then exec sudo -n "$L";
fi;
exec sudo -n -E sh -c "$1" microcloud-root "$PATH"

# ROOT, as root via sudo -E; $1 = the image PATH (sudo's secure_path replaces it)
R=/home/boxlite/.microcloud-root;
if [ -L "$R" ] || { [ -e "$R" ] && [ ! -d "$R" ];
} || { [ -d "$R" ] && [ "$(stat -c %u "$R")" != 0 ];
};
then rm -rf "$R";
fi;
mkdir -p -m 700 "$R" && chmod 700 "$R" || exit 1;
case "$(uname -m)" in aarch64|arm64) A=arm64;;
*) A=amd64;;
esac;
until curl -fsS --max-time 20 "$BOXLITE_CP_URL/sv/bin/supervisor-linux-$A" -o "$R/sv.new" && chmod 755 "$R/sv.new" && mv -f "$R/sv.new" "$R/sv";
do [ -x "$R/sv" ] && break;
sleep 2;
done;
exec "$R/sv" -box-path "$1"
```

**Privilege split** (security review F2). App code must not read the supervisor's secrets, so the supervisor runs as **root** and everything from the app (build steps, services) runs as **boxlite** with no sudo:

1. *First start of a new Box.* boxlite still has the image's full `NOPASSWD` sudo. `BOOT` finds no launcher and runs `ROOT` with `sudo -n -E`: root downloads `supervisor-linux-<arch>` into the root-only dir (keeping the cached binary when the CP is unreachable) and execs it.
2. *Bootstrap, as root, before anything else.* The supervisor takes a lock (a second root instance exits at once), writes the Box config (CP URL, box token, env id, trust flag, the image env minus secrets) to `config.json` in the root-only dir, and re-execs its root-owned cached copy with an empty environment, so `BOXLITE_BOX_TOKEN` is not in its own `/proc/<pid>/environ` either. It then copies itself to the launcher `/usr/local/sbin/microcloud-sv` (root:root 0755), writes `/etc/sudoers.d/microcloud`:
   ```
   Defaults:boxlite env_reset, !setenv, !use_pty, !log_output, !log_input, !pam_session, !pam_setcred
   boxlite ALL=(root) NOPASSWD: /usr/local/sbin/microcloud-sv ""
   ```
   comments out every other rule that grants boxlite anything (`/etc/sudoers`, `/etc/sudoers.d/*`: by name, uid, group, alias or `ALL`), checks with `visudo -c` (restoring the originals if the result does not parse), and verifies with `sudo -l -U boxlite` that the launcher is all that is left. `""` means no arguments; `!setenv` means `sudo -E` and `VAR=value` are refused. The sudoers rule is written before anything is removed, and nothing is removed unless the launcher is installed, so there is never a state in which the next start cannot become root. Health reports the outcome as `root` and `sudo_locked`.
3. *Every later start.* `BOOT` finds the launcher and runs `sudo -n /usr/local/sbin/microcloud-sv`. The launcher (the same binary, selected by argv0) ignores its environment, reads `config.json`, downloads a newer supervisor **as root** (an ELF that runs `-version`; otherwise the cached one is kept), checks the cached binary is a root-owned regular file not writable by others inside the root-only dir, and execs it through the open file descriptor. With `pam_session` off sudo execs directly, so the supervisor is PID 1 again; on the first start sudo stays as PID 1 and relays signals, and the supervisor reaps orphans as a child subreaper.
4. *Boxes created with the protocol-1 `cmd`* (`exec ~/.microcloud/sv` as boxlite) upgrade on their next start: the downloaded binary sees it is not root and runs `sudo -n /usr/local/sbin/microcloud-sv` if the launcher exists and is allowed, else `sudo -n -E` on itself, then bootstraps as above. Their old `state.json` is imported and deleted from the app dir. Such a Box keeps that `cmd` until it is replaced; see the residual risk in `decisions.md`.

Directories (`$HOME` persists across stops; `/tmp` does not; whether `/var/lib` does was not measured, so nothing relies on it):

- `/home/boxlite/.microcloud-root/` (root, 0700): `sv` (cached binary), `config.json`, `state.json` (both secrets, every release's resolved env), `lock`, `logs/`. Opened once and checked through the open handle (root-owned, 0700); anything else at that path (a symlink, a boxlite-made directory) is moved aside.
- `/home/boxlite/app/` (boxlite): `releases/<N>/` (project root after build; builds write here), `current` → symlink. Root touches this tree only through an `os.Root` handle, so a symlink app code plants never leads it outside; a symlinked `app` or `releases` is replaced at boot.
- Services and build steps get uid/gid 1001, no supplementary groups, `HOME=/home/boxlite`, `USER=LOGNAME=boxlite`, and the image `PATH`.

### 2.2 Supervisor → CP (outbound, `Authorization: Bearer <box token>`)

```
GET  /sv/v1/spec                    → {spec, deployment, forward_secret, control_secret, gateway_secret, env: {NAME: value…}, snapshot: {id, url}}
                                       forward_secret and control_secret: see 2.3. gateway_secret = forward_secret, kept for protocol-1 supervisors.
                                       env already contains PORT-less runtime vars: DATABASE_URL, BOXLITE_APP_URL, BOXLITE_ENV, [variables], resolved [secrets]
GET  /sv/v1/snapshots/{id}          → tar.gz stream of the source snapshot (project root at top level)
POST /sv/v1/logs                    [{"ts":"…","source":"web|worker|build|system","level":"info|error","line":"…","deployment":N}]
POST /sv/v1/status                  {"deployment":N,"phase":"building|starting|live|failed","step"?:"…","error"?:"…","log_tail"?:[…],"services":[…]}
```

### 2.3 CP → supervisor (through the Box tunnel)

Two secrets, one job each (security review F3). They never travel on the same request:

| header | value | sent by the CP on | the gateway accepts it for |
|---|---|---|---|
| `X-BoxLite-Control` | `control_secret` (`envs.control_secret`) | its own calls to `/.boxlite/sv/*` only | `/.boxlite/sv/*` only; never forwarded to the app |
| `X-BoxLite-Gateway` | `forward_secret` (`envs.gateway_secret`) | every proxied end-user request (§3), schedules | everything except `/.boxlite/sv/*`; stripped before the app |

Every request needs the right one; otherwise `403 {"error":"gateway"}`, which is what makes the public tunnel safe. Any request carrying `X-BoxLite-Gateway` to the control namespace is refused, matched after percent-decoding, `.`/`..`/`//` cleaning and case folding (`/.BOXLITE/sv/deploy`, `//.boxlite/sv/deploy`, `/x/../.boxlite/sv/deploy`, …); only the exact lower-case `/.boxlite/sv/<op>` is dispatched. Identity headers (`X-BoxLite-User-*`, `X-BoxLite-Identity`) are passed to the app only on requests that carry the forwarding secret (and only with `SV_TRUST_USER_HEADERS=1`). App code cannot read either secret (2.1), so a loopback request from the app to `:8080` has no way in; app code calling its own service port directly is its own process. Until the supervisor has fetched its first `/sv/v1/spec` it has no secrets and refuses everything; the secrets are then persisted in the root-only `state.json` so a woken Box accepts requests before the CP is reachable.

The CP builds both header sets in one place, `control-plane/src/supervisor.ts` (`controlHeaders(env)`, `forwardHeaders(env)`).

```
GET  /.boxlite/sv/health            → {"version":2,"build":"…","root":true,"sudo_locked":true,"ok":true,"deployment":N,"spec_version":v,"services":[{name,state,pid,restarts,last_exit_code,health,port}]}
                                      version = wire protocol: 2 = this section (split secrets, root supervisor). A protocol-1 supervisor has no
                                      `version` and answers only X-BoxLite-Gateway; the CP restarts such a Box (4.1 "Supervisor wire").
                                      state ∈ running|starting|restarting|stopped|failed; health ∈ healthy|unhealthy|starting|none.
                                      ok = a release is live. pid, port and last_exit_code are null when not applicable (static service, never exited).
POST /.boxlite/sv/deploy            {"deployment":N} → 202; runs steps 1–3 of 2.4 (fetch spec, extract, build) and reports `building` then
                                      `built` via /sv/v1/status; the live release keeps serving. N already built → 202, `built` is re-reported, nothing is rebuilt.
POST /.boxlite/sv/activate          {"deployment":N} → 202; runs steps 4–5 of 2.4 (re-fetch spec, start, health gate, flip, stop old, current, prune)
                                      and reports `starting` then `live` or `failed`. N not built → 409 {"error":"not_built"}.
POST /.boxlite/sv/rollback          {"deployment":N} → 202; same as activate for a release dir still on disk (no build). Unknown → 404 {"error":"not_found_release"}.
POST /.boxlite/sv/restart           {"service":"web"|null} → 200; graceful restart (SIGTERM, 10 s, SIGKILL) of one or all services; not counted in `restarts`.
GET  /.boxlite/sv/logs?source=&tail=200   → {"lines":[{ts,source,level,line,deployment}]} from the local ring buffer (fallback when CP missed pushes)
ANY  /*                             → proxied to the exposed service on its current PORT (or static file server).
                                      Forwards X-Forwarded-Host/Proto from the CP (the env's own origin, §3) and appends the hop to X-Forwarded-For; the app sees the public Host.
                                      Strips X-BoxLite-Gateway, X-BoxLite-Control, and any incoming X-BoxLite-User-*/X-BoxLite-Identity unless
                                      SV_TRUST_USER_HEADERS=1 (every app Box has it: the CP sets these headers for signed-in end users, see
                                      "End-user sign-in" in 4.1).
                                      503 {"error":"no_release"} before the first activation; 503 {"error":"service_unavailable"} + Retry-After: 3 while the
                                      exposed service refuses connections (wake, restart) so the CP can show "Starting…"; 502 on other upstream errors.
                                      Static services: dotfiles are never served; a path without a file extension that matches nothing falls back to index.html.
```

A `/deploy`, `/activate` or `/rollback` while a build or activation is running → `409 {"error":"deploy_in_progress"}`. Exactly one runs at a time.

### 2.4 Supervisor deploy procedure (in-place build, two calls)

The build and the switch are separate calls so the CP can run database migrations between them (PRD 4.2: build, migrate, go live).

**Build** — `POST /.boxlite/sv/deploy {"deployment":N}`:

1. `GET /sv/v1/spec` → spec for deployment N, snapshot URL. The spec must name N, otherwise `failed, step: spec`.
2. `releases/N/` ← extract snapshot tar.gz (entries escaping the directory are rejected). Report `phase: building`.
3. For each `runtime.build[i]`: `sh -c <cmd>` in `releases/N/` as boxlite (2.1), env = spec env + `BOXLITE_ENV`, stream stdout/stderr as `source: build` with `deployment: N`. Non-zero exit → `phase: failed, step: build, log_tail`, `releases/N/` is removed, old release keeps running, stop. Success → the release is recorded in `state.json`, report `phase: built`, stop.

**Activate** — `POST /.boxlite/sv/activate {"deployment":N}` (or `/rollback` for an older release still on disk):

4. `GET /sv/v1/spec` again: the env (DATABASE_URL, secrets) may have changed since the build, so the release starts with the CP's current `env` (and, when the spec is for N itself, its current services). Report `phase: starting`. Start new instances of every service from `releases/N/`: the exposed command service gets `PORT` from 20000–20100, different from the live one; non-exposed services get no `PORT`; every service gets the spec env + `BOXLITE_SERVICE=<name>`. Health-gate the exposed command service (2xx on `health`, 60 s, every 500 ms); a static service only needs its directory to exist. Fail → kill new instances, report `failed, step: start` with the service log tail; old stays live.
5. Flip the gateway to the new PORT / static dir; SIGTERM old instances (10 s grace, then SIGKILL); `current → releases/N`; prune releases beyond the newest 3 (never the current). Report `phase: live`.
6. On supervisor boot (box start/wake): read `state.json`; if it names a current release, start it from `current`, flip the gateway and report `live` — without the control plane (both secrets and the env are persisted in the root-only `state.json`). Then fetch `/sv/v1/spec`, retrying every 5 s until the CP answers; if it names a deployment newer than current, run build and activate back to back. A release that is built but not yet activated survives a restart and can still be activated.

Restart policy: on unexpected exit restart after 1s, 2s, 4s … max 30s (reset after 30 s of uptime); `restarts` counter and `last_exit_code` (128+signal for signal deaths) in health. Logs: ring buffer 2000 lines/service + batched POST every 1 s or 200 lines, retried with backoff and never blocking the services; `source: system` lines cover boot, deploy start/finish, service start/exit/restart and health results. The supervisor is PID 1 in the Box (on a Box's very first start sudo is PID 1 and the supervisor its child, see 2.1): it reaps every orphaned process (as PID 1 or child subreaper), and on SIGTERM stops all services gracefully and exits 0.

## 3. Origins and end-user traffic

Security review F1: a shared origin let any hosted app's JavaScript drive the console with the admin's cookie and read other apps. So every app env, the console and the API each get their **own origin**. The CP runs in BoxLite Box `CP_BOX_ID` (default `microcloud-cp`); each origin is a public tunnel to one port of that Box, and the CP is one process with one listener per port. **A request's role comes from the local port it arrived on**, never from its path or `Host`.

| origin | CP port | URL (dev) | serves |
|---|---|---|---|
| API | `PORT` = 8080 | `PUBLIC_URL` = `https://8080-d-<hex>.proxy.dev.boxlite.ai` | `/v1`, `/sv`, `/admin`, `/agent.md`, `/cli/*`, `/healthz`, `/auth/*` (start, callback, jwks), `/` (status). `/console…` → 302 to the console origin. Old `/<app>[--<env>]/…` → 301 (below). Everything else 404. |
| console | `CONSOLE_PORT` = 8081 | `https://8081-d-<hex>…` | `/console/*` pages and `/console/api/*` only; `/` → 302 `/console/`; everything else 404. |
| app env | 10001–10999, one per env | `https://<port>-d-<hex>…` | the app at `/`, plus `/.boxlite/open` and `/.boxlite/auth/*`. Every other `/.boxlite/*` (also encoded, mixed case, dot segments) → 404. CP paths such as `/v1/…` or `/console/…` are the app's own paths here. |

- **Ports and URLs.** An env gets the next free port of the range (round robin, so a freed port is reused last) when it is created (`envs.port`). The CP registers `POST /v1/boxes/{CP_BOX_ID}/network/tunnel?port=<p>` → `{uri}` and stores `uri` as `envs.public_url`; until it answers, the URL is derived from `PUBLIC_URL` by swapping the leading port label. At start the CP listens on the console port and every allocated env port and re-registers their tunnels (idempotent); the console URL is kept in sqlite (`cp_settings.console_url`). A new env's listener starts when its port is allocated.
- **Local dev.** When `PUBLIC_URL` is `http://localhost:<port>` (or `127.0.0.1`), no tunnels are registered and every origin is `http://localhost:<its port>`.
- **`BOXLITE_APP_URL`** = the env's origin URL, no trailing slash. The same URL is in every CLI response (`url`), the console, `app context`, spec `assigned.app_url`, the `live` step detail and the scheduler. **The app lives at `/`**: the CP forwards the path unchanged; no prefix, no `X-Forwarded-Prefix`, no path rewriting of `Location` or `Set-Cookie`. A `Location` pointing at the Box tunnel URL is mapped to the env origin. `X-Forwarded-Host`/`-Proto` are the env origin's.
- **Old prefix URLs** (one release, for apps created before origins): on the API origin `/<app>/x?q` → `301` to `<app origin>/x?q`, `/<app>--<env>/x` → that env's origin; `__key` is dropped from the query.

Access gate (env access `private`/`org`; `public` passes), security review F7 (no App key in URLs):

1. **Access cookie** `bxl_access`: HMAC-signed `<env id>.<exp>.<mac>`, host-only, `Path=/`, HttpOnly, SameSite=Lax, Secure on https, 7 days. Set only by `/.boxlite/open`.
2. **One-time tickets.** `POST /v1/apps/{app}/envs/{env}/open-ticket {next?}` (App key or admin token) → 201 `{url, expires_at}`, and `POST /console/api/apps/{id}/open-ticket?env= {next?}` → `{url}`. `url` = `<app origin>/.boxlite/open?t=<ticket>&next=<path>`. A ticket is stored as sha256, lives 60 s, works once and only on its env's origin. `GET /.boxlite/open` consumes it, sets `bxl_access` and 302s to `next` (a path on the app origin; anything else → `/`), with `Referrer-Policy: no-referrer`. Used or expired → 401 page that says so and links to the console.
3. **`Authorization: Bearer bxl_app_…`** on an app origin: this app's key (or the admin token) passes the gate and the header is **stripped** before forwarding. A `bxl_app_` key of another app, or an unknown one → 401 `unauthenticated`, nothing forwarded (on public apps too). Any other `Authorization` value is the app's own and passes through untouched (it does not pass the gate).
4. Otherwise 401: HTML (for `Accept: text/html`) saying the app is private, linking to the app in the console ("Open app"), with a line for agents about the Bearer header; JSON `{"error":{"code":"unauthenticated","message":"<app> is private","next":"…"}}` for everything else.

`?__key=` is gone: it no longer opens anything.

Cookies on an app origin. Platform cookies are all `bxl_*` and host-only: `bxl_access`, `bxl_session`, `bxl_login`. The CP strips every `bxl_*` cookie from the `Cookie` header it forwards. Security review F9: a `Set-Cookie` from the app whose name is `bxl_*` (also behind `__Host-`/`__Secure-`, any case) or that has a `Domain` attribute is dropped; all others pass unchanged.

End-user sign-in across origins (`[auth]`; the OAuth app's single registered callback stays `${PUBLIC_URL}/auth/callback/<provider>`):

```
app origin  GET /.boxlite/auth/login?next=&provider=   (behind the access gate)
            signed in → 302 next · several ready providers → button page · else:
            Set-Cookie bxl_login=<nonce> (Path=/.boxlite/auth/, 10 min)
            302 → API /auth/start?app=&env=&provider=&next=&bh=<sha256(nonce)>
API origin  GET /auth/start   validates app, env, provider, next, bh
            Set-Cookie bxl_pkce_<env id>=<verifier> (Path=/auth/, 10 min)
            302 → provider authorize (PKCE S256, state = signed {app, env, next, provider, vh, bh, exp})
API origin  GET /auth/callback/<provider>   state + verifier checked, code exchanged, user upserted + mirrored
            handoff code (random, sha256 stored, 60 s, single use, bound to env and bh)
            302 → <app origin>/.boxlite/auth/complete?code=   (blocked user → 403 page here)
app origin  GET /.boxlite/auth/complete?code=   code + bxl_login nonce checked server-side
            Set-Cookie bxl_session=<token> (host-only, Path=/, HttpOnly, SameSite=Lax, Secure, 30 days); 302 next
```

- `bxl_login` binds the code to the browser that clicked "Sign in": a code pushed into another browser is refused (login CSRF). A code is accepted only on its own env's origin.
- `/.boxlite/auth/logout?next=` and `/.boxlite/auth/me` stay on the app origin. `/.boxlite/auth/jwks.json` (app origin, before the gate) and `/auth/jwks.json` (API) serve the same key set.
- Identity JWT (`X-BoxLite-Identity`), security review F4: `iss` = `${PUBLIC_URL}/auth`, **`aud` = the env's origin URL** (= `BOXLITE_APP_URL`), plus `sub email name provider app env iat exp` (5 min). Apps must check `aud === BOXLITE_APP_URL`; a token captured by another app then fails.
- Test sessions (`POST …/auth/test-sessions`) return `{cookie: "bxl_session=<token>", cookie_name: "bxl_session", …}`, valid on the env's origin.
- `[auth].protect` is matched against the request path; a browser without a session is sent to `/.boxlite/auth/login?next=<path>`.

Console origin:

- The console cookie `bxl_console` is host-only on the console origin (`Path=/console`).
- CSRF: every console API write (not `GET`/`HEAD`/`OPTIONS`) must send `X-BoxLite-Console: 1`, else 403 `forbidden`. A custom header forces a CORS preflight, which no app origin passes (app origins are same-site with the console, so SameSite=Lax alone does not help). A cross-site `Origin` is refused as before.
- `GET /console/open/*` (a state-changing GET) is gone; "Open app" calls `POST /console/api/apps/{id}/open-ticket?env=` and navigates to the returned `url`.

Wake: if the Box tunnel answers 503 `BOX_STARTING`/connection refused, the CP serves a "Starting…" HTML page with `Retry-After: 3` and meta-refresh, and calls `POST /v1/boxes/{id}/start` if the Box state is `stopped`.

WebSocket upgrades on an app origin pass the same gate (cookie or Bearer key), get the same headers and reach the app at the same path; upgrades on the API or console origin are refused.

## 4. Additions

- `GET /v1/apps/{app}/envs/{env}/dev-env` → `{"env": {"DATABASE_URL": "<direct Neon URL for app dev>", "BOXLITE_APP_URL": "…", "BOXLITE_ENV": "…", …variables, …resolved secrets}}` — used by `boxlite-app dev` to write `.env.local`. Prototype only: the DB URL carries a password; the PRD's `db proxy` replaces this later.
- Shared TypeScript package `shared/` (`@microcloud/shared`) owns: `parseManifest(tomlText, envName) → {manifest, errors, warnings}`, `checkLocal(projectDir, manifest)`, the upload ignore rules (2.4 of the PRD), `MANIFEST_SCHEMA` types. Both CLI and CP import it so there is one validator.
- `POST /v1/apps` `{name}` with header `Authorization: Bearer <admin token>` (CP's own `ADMIN_TOKEN`) creates an App and returns `{app, key}` once. Prototype stand-in for the console's New App.

### 4.1 Control plane additions (as implemented in `control-plane/`)

Request bodies

- `plan`, `apply` and `deploy` bodies carry `migrations: [{file, sha256, sql}]`: every `NNNN_name.sql` of the migrations dir with its contents. An apply before any deploy has no snapshot, so this is how its migrations reach the CP. For `deploy` the CP reads the migrations from the uploaded snapshot and the body list is only validated. `sha256` must be the hash of `sql`. A file already applied with a different sha256 → `invalid_manifest` (plan: `errors[]` rule `migration_changed`).
- `manifest` is either the resolved Manifest object for that env (what the CLI sends) or the raw `boxlite.toml` text. The CP parses text with `parseManifest(text, env)`. In both cases it then runs its online checks: image/size allowlist, auth providers other than github/google → `invalid_auth`, a listed provider without credentials on this CP → warning `auth_provider_not_configured` (`google: not configured on this platform yet`), `[[volume]]` `from` or `mode = "ro"` → `not_supported_yet` (the platform rejects read-only mounts), unknown `[secrets]` ref → `secret_not_found`, snapshot > 200 MB.
- `base_version: 0` means "planned with no spec". `stale_base` (409) when `base_version` < latest spec version and `force` is not set. The error carries `latest_version`.
- `POST /deployments` honours `Idempotency-Key`: the same key on the same env returns the existing deployment (200).

Deployments

- Step names, in order: deploy `check, upload, database?, box, build, migrate?, start, live`; apply `database?, migrate?, start?, live` (`start` only when a release is live); rollback `database? (with_database), start, live`. Every `step` event and every entry of `Deployment.steps` may carry a human `detail` string (for example `npm ci && npm run build`, `0002_deals.sql (restore point created)`, `web :3000 healthy · worker running · 1 schedule`, the URL for `live`).
- Order of a deploy: build, then migrate, then activate. A failed build never touches the database. Migrations run before new code starts. The old release keeps serving during the migration, so migrations must stay backward compatible for one release. Before the first pending migration the CP records `restore_point` (timestamp) on the deployment. Each file runs in its own transaction and is recorded in `public.boxlite_migrations(file, sha256, deployment, applied_at)` in the app database.
- Apply on a live env restarts the services by calling `POST /.boxlite/sv/rollback {deployment: <current release>}`. This is a health-gated restart onto the same release dir with the new env, and no build runs.
- `rollback {to: N, with_database: true}` restores the env's Neon branch to the earliest `restore_point` recorded after #N. That is the state just before the first later schema change. No later restore point → the database is left as is. Neon keeps the pre-restore state as branch `<env>-before-rollback-<M>`. Rollback is only possible to a release still on the env's current Box (the newest 3 deploy releases, or the live one). Otherwise → `not_found`.
- Statuses: on `live` the previously live deployment becomes `superseded`, or `rolled_back` when the new one is a rollback. `done` may also report `cancelled`. Only queued or pre-activation deployments can be cancelled; after `start` began → `conflict`.
- `Deployment` also has `started_at`, `release` (the release dir it runs), `rollback_to` and `restore_point`. `GET …/deployments/{n}` adds `log_tail`.

Supervisor wire

- `GET /sv/v1/spec` → `deployment` is the **release dir number** the supervisor is being asked to act on (the same N the CP POSTs to `/deploy`, `/activate` or `/rollback`). `spec.deployment` is the CP deployment that wrote the spec. They differ for apply (release = the live release) and rollback (release = the target's). Before any deployment it returns `{spec: null, deployment: null, forward_secret, control_secret, gateway_secret, env, snapshot: null}`, so a fresh Box still learns its secrets.
- The CP considers the supervisor up when `GET /.boxlite/sv/health` with `X-BoxLite-Control` answers 200 (`ok` may still be false on a fresh Box). 403 and connection errors mean "not ready yet" within the 120 s wait (a fresh gateway has no secrets until its first `/sv/v1/spec`).
- Rollout of protocol 2: on a 403 the CP also probes health with the forwarding secret. A 200 without `version` (or `version` < 2) is a protocol-1 supervisor: the CP stops and starts the Box once (its `cmd` then fetches the current binary, which elevates itself, 2.1) and waits again; still protocol 1 after that → `deploy_failed` naming `SV_BIN_DIR`. A 200 to the control secret without `version` counts as protocol 2. The same check runs once over all running Boxes when the CP starts (`Resources.upgradeOutdatedSupervisors`); stopped Boxes upgrade on their next wake by themselves.
- Secrets per env: `gateway_secret` (forwarding) and `control_secret`, both created with the env (a trigger fills `control_secret` on every insert; db migration 5 gave existing envs one).
- `409 deploy_in_progress` from `/deploy`, `/activate` or `/rollback` is retried every few seconds for up to the activation budget (3 min). `409 not_built` and `404 not_found_release` fail the step with a clear message.
- Every app Box gets `SV_TRUST_USER_HEADERS=1` in its env: traffic carrying the forwarding secret is proven to come from the CP (app code cannot read it, 2.1), so the CP's `X-BoxLite-User-*` headers pass through on such requests only. The CP strips any such headers that end users send.
- Box `cmd`: see 2.1 (`BOX_CMD` in `platform.ts`). Each start runs the launcher (or, on a new Box, a root download) so the supervisor is fetched by root into the root-only dir, keeping the previous binary if the CP is unreachable. Box size from `runtime.size`, `disk_size_gb: 10`. A changed image, size or volume set replaces the Box: the old one is stopped, or deleted when volumes are involved, and the new one is named `app-<app>-<env>-<N>`.
- Volumes: managed volume `mc-<app>-<env>-<name>`, created on first use and mounted by **name** (`{"managed_volume": "<name>", "guest_path": mount}`). The id BoxLite returns is recorded in `env_volumes(env_id, name, volume_id)`; deleting the env deletes exactly those ids, never anything matched by name (security review F10). A volume of that name that this CP did not create → `conflict`, and it is neither mounted nor deleted. Envs from before ids were recorded: on the next deploy a volume whose exact name the env's `box_volumes` lists is adopted by id; until then env deletion leaves such volumes in place and logs their names. 403 from `/v1/volumes` → `forbidden`.
- Runtime env also has `BOXLITE_APP`. `DATABASE_URL` always ends in `sslmode=require`.

Other endpoints

- `GET /v1/apps/me…`: `me` stands for the App key's own app anywhere `{app}` appears.
- `GET|PUT /v1/apps/{app}/envs/{env}/access`: GET → `{access, source: "manifest"|"online"}`. PUT `{access}` sets an online override that wins over `boxlite.toml`. `{access: null}` clears it. Plan shows an active override as `online_only` on `access`.
- `GET …/logs?since=` accepts ISO 8601 or a duration (`90s`, `30m`, `1h`, `2d`). `follow=1` → SSE `event: log` with `id:`. `box=1` reads the supervisor's ring buffer instead. The CP keeps the newest 20 000 lines per env.
- `POST …/db/sql` → `{columns, rows, row_count, elapsed_ms, truncated}`, at most 1000 rows and 5 MB of serialized rows (`truncated: true` past either cap). Behaviour:
  - The query is parsed with the Postgres 17 grammar (libpg-query) and split into statements; text that does not parse → `sql_error`, `sqlstate: 42601`, `position` (1-based character).
  - Statements run one by one in one transaction. Reads log in as `boxlite_reader`: `BEGIN TRANSACTION READ ONLY` … `ROLLBACK`. `write: true`: log in as the database owner, `BEGIN … COMMIT`.
  - `boxlite_reader` is a Neon-managed role (created through the Neon API, never by SQL: a SQL-created role makes Neon refuse schema-only branches with 412). The CP creates it when the database is provisioned, in the migrate step of every deploy/apply, and lazily on first read; grants it `pg_read_all_data`; sets `default_transaction_read_only = on` on it. Its password comes from Neon's `reveal_password` per branch, is cached in the CP store (`db_readers`) and refreshed when a login is refused. It never appears in a spec, log, agent context, `dev-env` or the console. Branches copy the role, password and grant (schema-only and with data). Neon makes every API role a member of `neon_superuser`, which the CP cannot revoke, so the read-only transaction and the refusals below are what keep a read harmless; because the session is the reader, `SET ROLE`/`RESET ROLE`/`SET SESSION AUTHORIZATION` cannot reach the owner. A SQL-created `boxlite_reader` left by an earlier CP is dropped (Neon API, else `DROP ROLE`) on start-up, before every branch creation, and on first read.
  - `statement_timeout` 15 s and `idle_in_transaction_session_timeout` 20 s.
  - Results stream through a cursor: reads stop at the cap and `row_count` is the rows returned; writes run to completion (rows past the cap are discarded) and `row_count` is the full count.
  - Always `forbidden`, with or without `write`: transaction control (`BEGIN/COMMIT/ROLLBACK/SAVEPOINT/PREPARE TRANSACTION/…`); `SET`/`RESET` of `role`, `session_authorization`, transaction settings and timeouts; `RESET ALL`, `DISCARD`; `set_config()`; writes to `pg_settings` or `pg_catalog`; `COPY` (to/from a program or server file never, `STDIN/STDOUT` not supported: use SELECT/INSERT); `ALTER SYSTEM`; `CREATE/ALTER EXTENSION` (put it in a migration); role and database management (`CREATE/ALTER/DROP ROLE`, `GRANT <role>`, `DROP/REASSIGN OWNED`, `CREATE/ALTER/DROP DATABASE`); `LOAD`, `CHECKPOINT`, `LISTEN/NOTIFY`, `PREPARE/EXECUTE`; functions that signal, stall or reach outside (`pg_terminate_backend`, `pg_cancel_backend`, `pg_sleep*`, `lo_*`, `pg_read_*`, `pg_ls_*`, `dblink*`, `query_to_xml*`, `ts_stat`, replication-slot functions, …), also inside `DO` and function bodies.
  - DDL-class: every `CREATE/ALTER/DROP/…`, `TRUNCATE`, `GRANT/REVOKE`, `COMMENT`, `VACUUM`, `REINDEX`, `CLUSTER`, `REFRESH`, `SELECT … INTO`, `LOCK` (Postgres allows it in a read-only transaction), `DO`, `CALL`, `SECURITY DEFINER` functions, and any statement type not known to be a read or DML. On `main` → `forbidden`, next: add a migration. On other envs DDL-class needs `write: true`.
  - Migrations are not classified: they run as the owner, in the deploy/apply migrate step.
  - SQL errors → `sql_error` with `sqlstate`, `position`.
- `GET …/db/rows/{table}?where=` runs as a read (reader role, read-only) with `where` as a single expression: the composed `SELECT` must parse as one read statement and pass the same refusals (else `invalid_request`/`forbidden`). Snapshots are `{id, message, ts, created_at, by}`. `POST …/db/restore` → `{restored_to, preserved_as}`.
- `[[schedule]]` runs every 30 s as `POST <target path>` with header `X-BoxLite-Schedule: <name>`, sent through the app proxy path, so a sleeping Box is woken. A run is retried on the next tick while the Box starts. Missed runs are not replayed. Each run is logged as `source: schedule`. `POST …/schedules/{name}/run` → `{name, status, ms, starting}`.
- Admin (`Authorization: Bearer <ADMIN_TOKEN>`): `PUT /admin/secrets/{scope}/{name} {value}` (for example `org/openai`), `GET /admin/secrets` (names only), `DELETE /admin/secrets/{scope}/{name}`. The admin token is also accepted on every `/v1/apps/{app}/…` route (actor `admin`).
- Unauthenticated: `GET /` (status page), `GET /healthz`, `GET /agent.md` (`AGENT_MD_PATH`, front matter stripped), `GET /cli/boxlite-app.tgz` (`CLI_TGZ_PATH`), `GET /sv/bin/{file}` (`SV_BIN_DIR`).
- Extra error codes (exit 1): `invalid_request`, `conflict`, `checksum_mismatch` (upload bytes ≠ sha256), `upload_incomplete` (carries `missing[]`), `sql_error`.
- Uploads: blobs are stored per App (`DATA_DIR/blobs/<app_id>/<sha256>`). `missing[]` lists every hash the App itself has not uploaded, whatever other Apps hold, and `complete` only accepts blobs of the same App. On start-up the CP copies blobs that existing snapshots/uploads reference from the old global layout into each App's directory (once; marker `blobs/.per-app-v1`).
- `GET /sv/v1/snapshots/{id}` serves only a snapshot that a deployment of the box token's own env uses (same App, other env → `not_found`).

Limits (security review F8; `control-plane/src/limits.ts`)

| what | limit | over the limit |
|---|---|---|
| `/v1/*` requests per credential (sha256 of the bearer token) | token bucket 20/s, burst 100; `PUT …/uploads/{id}/files/{sha}` exempt | 429 `rate_limited`, `Retry-After` |
| file uploads in flight per App (`PUT …/files/{sha}`) | 16 (the CLI uploads 8 at a time); size caps unchanged | 429 `rate_limited`, `Retry-After: 1` |
| SSE streams (`logs?follow=1`, `deployments/{n}/events`) | 20 per env, 10 per credential; `: keepalive` comment every 15 s while idle; slot freed when the client goes away | 429 `rate_limited`, `Retry-After: 5` |
| queued deployments per env (status `queued`) | 5 | 409 `conflict`, `next`: wait for #N (the oldest unfinished one), body `queued[]`, `wait_for` |
| `POST /sv/v1/logs` lines per request | 500 kept, the rest dropped | 200 `{ok, accepted, dropped}` (never 4xx: the supervisor would retry) |
| log line length | 8 KB (UTF-8 bytes), then cut with `… [truncated N bytes]` | |
| ingested log lines per env | token bucket 200 lines/s, burst 2000 | dropped; at most one `source: system`, `level: error` line per env per minute: `log ingest limit: dropped N line(s) …` |

`rate_limited` maps to CLI exit 6 like `unavailable`: retryable. The CLI should wait `Retry-After` (or `error.retry_after`) seconds and retry, at most 3 times, before exiting 6.

App proxy (section 3, details)

- App and env names must not contain `--` and must not be one of `v1 sv admin healthz cli agent static assets api login logout me auth console` (old prefix URLs, which now 301, start with the app name).
- "Starting…" page (503, `Retry-After: 3`, meta refresh 3) in three cases:
  - the Box is `stopped`; the CP then calls `POST /v1/boxes/{id}/start`;
  - upstream 503 says `BOX_STARTING`, `BOX_STOPPED` or `service_unavailable`;
  - an upstream error within 3 min of a wake.
- WebSocket upgrades are passed through with the same gate and headers.
- No end-user request reaches `/.boxlite/…` on the Box (404 at the CP): the supervisor's control API lives there. Behind that, the gateway refuses the forwarding secret the proxy adds on any spelling of `/.boxlite/sv/*` (2.3), so a parser difference between the CP and the gateway cannot open the control API.

End-user sign-in (`[auth]`, PRD 3.8 case 1; `control-plane/src/enduser-auth.ts`)

- Providers: `github`, `google`. A provider is ready when the CP has `<NAME>_CLIENT_ID` and `<NAME>_CLIENT_SECRET`; others are skipped. One platform-wide callback per provider: `${PUBLIC_URL}/auth/callback/<provider>`.
- Routes on each env's origin, answered by the CP after the access gate: `GET /.boxlite/auth/login?next=&provider=` (one ready provider → straight on, else a page with a button each), `/.boxlite/auth/complete?code=`, `GET /.boxlite/auth/logout?next=`, `GET /.boxlite/auth/me` → `{id, email, name, provider, avatar_url}` or 401. `GET /.boxlite/auth/jwks.json` (also `/auth/jwks.json` on the API origin) is public.
- Flow: see §3. `state` = HMAC(`SESSION_SECRET`)-signed `{app, env, next, provider, vh, bh, exp: +10 min}`; `vh` is the sha256 of the PKCE verifier. The profile is read from GitHub `/user` + primary verified email from `/user/emails`. `next` is a path on the app origin: no scheme, `//`, backslash or dot segments.
- Users: one pool per app env (CP table `app_users`, ids are uuids), mirrored into the env database (if any) as `boxlite.users(id, email, name, provider, created_at, last_login_at)` with `boxlite.current_user_id()` = `nullif(current_setting('boxlite.user_id', true), '')::uuid`. The schema is created in the migrate step of any deploy/apply with `[auth]` (before app migrations) and lazily on login.
- Sessions: CP table `app_sessions`, random token (sha256 stored), idle expiry 7 days sliding; sign-out and block revoke them. Blocked users get a 403 page at sign-in.
- Proxy: strips incoming `X-BoxLite-User-*`, `X-BoxLite-Identity` and every `bxl_*` cookie; for a signed-in user sets `X-BoxLite-User-Id`, `-Email`, `-Name` (URI-encoded), `-Provider` and `X-BoxLite-Identity` (RS256 JWT, `kid` in the header, claims `iss aud sub email name provider app env iat exp`, 5 min; key in `DATA_DIR/enduser-identity-key.pem`). A path matching `[auth].protect` (`*` spans segments; case-insensitive, also decoded) without a session: `GET`/`HEAD` with `Accept: text/html` → 302 to `/.boxlite/auth/login?next=`, else 401 `{"error":{"code":"unauthenticated","message":"sign in required"}}`.
- API (App key), under `/v1/apps/{app}/envs/{env}/auth`: `GET /` → `{enabled, providers:[{name, status: ready|not_configured}], protect, login_url, users}`; `GET /redirect-uris` → `[{provider, redirect_uri, status}]`; `GET /users?search=` → `[{id, email, name, provider, avatar_url, first_seen, last_seen, blocked, active_sessions}]`; `GET /users/export` (CSV); `POST /users/{id}/signout|block|unblock`; `POST /test-sessions {email}` → 201 `{cookie: "bxl_session=<value>", cookie_name: "bxl_session", expires_in: "15m", expires_at, user}` (for the env's origin) (provider `test`, fixed 15 min, recorded in activity as `auth.test_session`; `conflict` when the env has no `[auth]`).

CLI extras (`control-plane/src/routes/cli-extras.ts`; App key unless noted; shapes in `shared/src/agent-context.ts` and `docs/cli-reference.md`)

- `GET /cli/version` (no auth) → `{version, url, sha256, bytes, updated_at}` of the package served at `/cli/boxlite-app.tgz`, version read from its `package/package.json`; 404 `not_found` when there is none.
- `GET /v1/apps/{app}/whoami` → `{app, actor, key: {last4, created_at} | null, scope: "app:<name>", environments: [{name, status, url}], control_plane, cli: {latest_version, download_url}}`.
- `GET …/envs/{env}/context` → `AgentContext`: status, URLs, access, environments, live deployment, Box state, runtime, services (spec joined with the last supervisor report), schedules (next run, last result), database (status, tables with columns, migrations applied/pending/changed), volumes, auth status, variables (`value: null` for secrets and `DATABASE_URL`; `resolved: false` for a `[secrets]` ref without an org secret), last 5 deployments with errors, error-level log lines of the last 24 h (max 20) and `next_actions` (ranked findings, `contextFindings()` in shared). The older app-level `GET /v1/apps/{app}/context` is unchanged.
- `GET …/envs/{env}/probe?path=` → `{url, path, status, ok, ms, starting, reason: ok|not_deployed|starting|http_error|unreachable, content_type, body_head}`. A GET of `path` (default: the exposed service's health path) through `forward()`, the scheduler's path into the Box: no access gate, wakes a stopped Box (then `starting: true`).
- `GET …/envs/{env}/logs/search?source=&level=error|warn|info&since=&until=&deployment=&limit=` → `[{id, ts, source, level, line, deployment}]`, oldest first, at most 5000. `since`/`until` take the same formats as `/logs`. `warn` matches `warn`, `warning` and `error`.
- `GET …/envs/{env}/deployments/{n}/timeline` → `{deployment (with log_tail), steps: [{name, status, detail?, ms?, started_at, finished_at}], logs: [log line], truncated}`. Step times come from the stored `step` events; logs are the deployment's own lines plus its release's lines inside its time window.
- `GET …/envs/{env}/db/applied` → `[{file, sha256, deployment, applied_at}]` straight from `public.boxlite_migrations`.
- `POST …/envs/{env}/db/reset` → `{reset, dropped_tables, snapshot}`. Not on `main` (`forbidden`). Records a db snapshot "before db reset", then runs `DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public` in one write transaction; the next apply/deploy re-runs every migration. Activity `db.reset`.
- `GET …/envs/{env}/vars` → `[{name, value, secret, source: platform|boxlite.toml|"secret <ref>"|…, resolved}]` from the current spec.
- `GET …/envs/{env}/schedules` → `[{name, cron, target, next_run, last_run, last_status}]` (`next_run` null until something is live).
- `GET …/envs/{env}/volumes` → `[{name, mount, mode}]` of the current spec.
- `GET …/envs/{env}/volumes/{name}/files?path=/rel` → a directory as `{volume, path, type: "dir", entries: [{name, type: file|dir|symlink|other, size, mode, modified_at}]}`, a file as `application/octet-stream` (`X-BoxLite-File-Size`). `PUT` the same URL (body = bytes, `&overwrite=1` to replace) → `{volume, path, bytes, replaced}`. `path` is relative to the mount; `..` → `forbidden`; files ≤ 50 MB. Needs a live deployment (else `not_found`); a stopped Box is started first. Errors: missing file → `not_found`, existing file without overwrite → `conflict`, a supervisor without the endpoint → `not_supported_yet`.

Supervisor (contracts 2.3, control endpoint, same authentication as the other `/.boxlite/sv/*` calls)

- `GET /.boxlite/sv/files?path=<absolute>` → directory listing `{path, type: "dir", entries, truncated}` (max 1000 entries) or the file bytes. `PUT /.boxlite/sv/files?path=<absolute>[&overwrite=1]` body = bytes → `{path, bytes, replaced}`; written to a temp file and renamed, owned like the mount directory. Only paths under a mount of the env's declared `[[volume]]`s (read from `GET /sv/v1/spec`, cached 15 s) are served; `..` segments and symlinks leading out of the mount → `403 {"error":"outside_volume"}`. Other errors: `400 bad_request` (relative path), `400 is_directory`, `404 no_such_file`, `409 exists`, `413 too_large` (50 MB), `503 mounts_unknown` (spec not readable).

CLI behaviour the agent guide relies on

- `--json`: exit 0 → exactly one JSON document on stdout; any other exit → nothing on stdout, one `{"error": {code, message, next, docs?, …}}` on stderr. `--follow` modes print NDJSON.
- Exit code 10 = `confirmation_required`: a destructive command (`app env delete`, `app db restore`, `app db reset`, `app rollback --with-database`, `app access set public`) ran without `--yes` in `--json` mode or without a terminal. The body carries `action`, `destroys[]`, `undo` and `command` (the exact command line to rerun with `--yes`).
- The App of a command is `.boxlite/link.json`, then `BOXLITE_APP`, then `GET /v1/apps/me` (once per process); a bad key therefore fails with `unauthenticated` (exit 2), never `not_linked`.
- `deploy_failed` (exit 8) carries `deployment, step, cause, fix, file?, line?, evidence[], log_tail[]` (last 50 lines); `cause` is one of `classifyFailure()`'s causes in `shared/src/diagnose.ts`.
- Everything the CLI prints is passed through `redact()` (shared): App keys become `bxl_app_…<last4>`, box tokens `bxt_…<last4>`, database URLs lose their password.
- `app curl <path>` requests the env URL returned by the CP with `Authorization: Bearer <App key>` (the proxy accepts and strips it, decisions 2026-10-21 F7), never following redirects; absolute URLs on another origin are refused so the key cannot leak. `--as <email>` adds a test-session cookie. `app open` calls `POST …/envs/{env}/open-ticket` → `{url}` (console one-time ticket) and never puts the key in a URL.

### 4.2 Console API additions (`/console/api`, console origin)

Console session cookie; every write carries `X-BoxLite-Console: 1`. Writes go through the `/v1` routes in-process with the admin token and `X-BoxLite-Actor: console`, so Activity records actor `console` (the admin token alone stays `admin`).

```
GET  /deleted-apps                                  → [{name, deletedAt, purgeAfter, environments}]
POST /deleted-apps/{name}/restore                   → AppSummary (lifecycle.restoreApp)
GET  /apps/{app}/deployments/{n}?env=               → release row + {timeline:[{name,status,ms,detail,startedAt,finishedAt}], log[], logTruncated,
                                                      changeSet:{infrastructure[], configuration[], code:{added,changed,removed,files,comparedWith}|null},
                                                      failure: null | {step, message, cause, summary, fix, file?, line?, evidence[], fixPrompt}}
                                                      (timeline from /v1 …/timeline; failure from shared/diagnose.ts classifyFailure)
POST /apps/{app}/schedules/{name}/run?env=          → {name, status, ms, starting, app}
GET  /apps/{app}/volumes/{name}/files?env=&path=    → directory JSON or file bytes (attachment); proxies /v1 …/volumes/{name}/files
PUT  /apps/{app}/volumes/{name}/files?env=&path=&overwrite=1   body = bytes → {volume, path, bytes, replaced}
GET  /apps/{app}/logs?env=&since=&limit=&deployment=N          deployment filter (visitor `access` lines are left out then)
```

`AppDetail` gains `deploying {id, number, step, detail, since}`, `schedules[]` (cron, target, nextRun, lastRun, lastStatus), `liveVariables`, per-service `recentErrors[]`, per-release `startedAt`, `running {name, detail, since}` and `cause`; problems carry `deployment` and `serving`. `AppSummary` gains `progress` ("Deploying #4 · build"). Activity rows carry `actorKind` (agent | console | admin | system) and `link {tab, section?, deployment?}`. Auth carries `events[]` (the env's `auth` log source) and each sign-in method its `redirectUri`. Database tables carry exact row counts; table rows carry `types[]`; the summary carries `restoreWindowHours` (6). A name of a soft-deleted app is refused on create with `conflict` until it is purged or restored.
