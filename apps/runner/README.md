# BoxLite Runner

The runner is the Go HTTP server that fronts a single `BoxliteRuntime` (the
Rust SDK in [`sdks/go/`](../../sdks/go/) via FFI) and exposes a REST + WebSocket
API for SDK clients and the control-plane API. One runner process hosts many
boxes; each box hosts many executions; each execution can be attached to at
most one client at a time.

Production deployment runs on bare EC2 (see
[`apps/infra/sst.config.ts`](../infra/sst.config.ts)), listening on `:3003`
behind the NestJS API service.

For the system-wide context (CDN, load balancers, where the runner fits in
the request path), see [`docs/architecture/README.md`](../../docs/architecture/README.md).

---

## What this README covers

- The runner's overall process model — what the HTTP server handles, what the
  background goroutines do, and how they share the embedded BoxLite runtime.
- Every major workflow the runner exposes:
  - **Sandbox lifecycle** — create / start / stop / destroy / resize /
    recover / network-settings / info / backup
  - **Snapshot management** — async pull, async build, log streaming,
    info-or-error, removal, tag, registry inspect
  - **Execution + attach** — the long-lived stdio bridge (in depth, with
    wire protocol and reaping policy)
  - **File I/O** — tar-framed upload and download
  - **Per-box metrics** — CPU / memory / net / exec counters
  - **Runner info** — host CPU / memory / disk + service health
  - **Toolbox proxy** — browser xterm.js over WebSocket
  - **SSH gateway** — public-key SSH on a separate TCP port
- The background services spawned at startup — sandbox state sync,
  metrics collector, v2 job poller, v2 healthcheck.
- The complete REST surface (one consolidated table).

If you want the SDK side, see
[`src/boxlite/src/rest/litebox.rs`](../../src/boxlite/src/rest/litebox.rs).
If you want the formal API schema, see
[`openapi/rest-sandbox-open-api.yaml`](../../openapi/rest-sandbox-open-api.yaml).

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              CLIENT SIDE                                  │
│                                                                          │
│   Python / Node / Rust SDKs            NestJS API (control plane)        │
│   • interactive boxes                  • issues jobs to runner via       │
│   • /attach WebSockets                   v2 long-poll                    │
│   • file I/O, snapshots, metrics       • collects healthchecks          │
└─────────────────────┬───────────────────────────────────┬────────────────┘
                      │                                   │
        HTTPS / WS    │                                   │ HTTP polling
        ──────────────┼───────────────────────────────────┼─────────────────
                      ▼                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                       RUNNER (this crate, Go)                            │
│                                                                          │
│  cmd/runner/main.go boots:                                               │
│    • api.ApiServer            HTTP/WS listener on :3003                  │
│    • SandboxSyncService       every 10s, reconcile local→remote state    │
│    • metrics.Collector        rolling CPU + allocation snapshots         │
│    • sshgateway.Service       SSH listener (if SSH_GATEWAY_ENABLE=true)  │
│    • v2.poller / executor     long-poll API for jobs (if ApiVersion==2)  │
│    • v2.healthcheck           push health+metrics (if ApiVersion==2)     │
│                                                                          │
│  pkg/api/controllers/ (HTTP layer)                                       │
│    sandbox.go    Create, Start, Stop, Destroy, Resize, Recover, ...      │
│    snapshot.go   PullSnapshot, BuildSnapshot, RemoveSnapshot, ...        │
│    boxlite_exec.go         POST /exec, GET /executions/:id, ...          │
│    boxlite_exec_attach.go  GET /attach (WebSocket)                       │
│    boxlite_files.go        PUT/GET /files                                │
│    boxlite_metrics.go      GET /metrics                                  │
│    proxy.go                /toolbox/*path (xterm.js + WS)                │
│    info.go, health.go      /info, /                                      │
│                                                                          │
│  pkg/services/           SandboxService, SandboxSyncService              │
│  pkg/boxlite/            Client (FFI wrapper), ExecManager, registry     │
│  pkg/cache/              BackupInfoCache, SnapshotErrorCache             │
│  pkg/runner/v2/          poller, executor, healthcheck                   │
│  internal/metrics/       host + per-box metrics collection               │
└───────────────────────────────────┬──────────────────────────────────────┘
                                    │ Go SDK FFI (sdks/go/)
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│   RUST RUNTIME (linked in-process via cgo)                               │
│                                                                          │
│   BoxliteRuntime → libkrun → VM (KVM / Hypervisor.framework)             │
│                              │                                           │
│                              ▼                                           │
│                          Guest agent over vsock                          │
│                              │                                           │
│                              ▼                                           │
│                          User process (e.g. /bin/sh)                     │
└──────────────────────────────────────────────────────────────────────────┘
```

The HTTP server and every background service share **one** `boxlite.Client`
instance (FFI wrapper around the Rust runtime). State that needs to survive
request boundaries — backup progress, snapshot build/pull errors — lives in
the in-process TTL caches under `pkg/cache/`.

---

## Process model

`cmd/runner/main.go` brings up the process in this order:

1. **BoxLite runtime** is initialized via `boxlite.NewClient(...)`. This
   loads the Rust core, opens `~/.boxlite/`, and is the single shared
   handle to the VM hypervisor.
2. **Service singletons** are constructed and stashed on the
   `runner.GetInstance(...)` global: `SandboxService`, `BackupInfoCache`,
   `SnapshotErrorCache`, `metrics.Collector`. Controllers later read them
   via `runner.GetInstance(nil)`.
3. **Background goroutines** are spawned (each one inherits the root
   context, so SIGTERM unwinds them cleanly):
   - `SandboxSyncService.StartSyncProcess` — every 10 s, list local
     boxes, ask the API for sandboxes still marked STARTED upstream,
     and push any state mismatch to the API. One-way: **local state is
     authoritative**, the API is the replica being corrected.
   - `metrics.Collector.Start` — periodic CPU and allocation sampling
     for the `/info` and `/metrics` endpoints (see *Metrics*).
   - `sshgateway.Service.Start` — only if `SSH_GATEWAY_ENABLE=true`.
   - `healthcheck.Service.Start` and `poller.Service.Start` — only if
     `BOXLITE_API_VERSION=2`. These push health and pull jobs from the
     control plane.
4. **`api.ApiServer.Start`** registers routes and binds the HTTP
   listener. Synchronous; blocks the main goroutine until SIGTERM.

On `SIGTERM` the API server is given 5 s to drain (`Shutdown`), the
context cancels, every background loop returns, and `boxlite.Client.Close()`
tears down the Rust runtime.

---

## Workflows

### 1. Sandbox lifecycle

Path prefix: `/sandboxes`. Every endpoint here is a thin controller that
calls into `r.Boxlite` (the Go SDK / Rust core). State transitions and
crash handling live in the runtime, not the runner.

| Method | Path | Controller | Purpose |
| --- | --- | --- | --- |
| `POST` | `/sandboxes` | `Create` | Allocate box, pull/use snapshot, return daemon version |
| `POST` | `/sandboxes/:id/start` | `Start` | Boot a stopped box (optional auth token + metadata) |
| `POST` | `/sandboxes/:id/stop` | `Stop` | Graceful or `force` shutdown |
| `POST` | `/sandboxes/:id/destroy` | `Destroy` | Tear down completely |
| `POST` | `/sandboxes/:id/resize` | `Resize` | Adjust CPU / memory / disk |
| `POST` | `/sandboxes/:id/recover` | `Recover` | Bring an `error` sandbox back via a named strategy |
| `POST` | `/sandboxes/:id/is-recoverable` | `IsRecoverable` | Static check against `common.IsRecoverable(reason)` |
| `POST` | `/sandboxes/:id/network-settings` | `UpdateNetworkSettings` | Set block-all / allow-list |
| `POST` | `/sandboxes/:id/backup` | `CreateBackup` | Kick off async backup; updates `BackupInfoCache` |
| `GET` | `/sandboxes/:id` | `Info` | Combined state + backup state + daemon version |

`Info` is the only endpoint that fans out: it pulls live state from the
runtime *and* backup state from `BackupInfoCache`, then fetches the guest
daemon version only when the sandbox is `STARTED`. See
[`pkg/services/sandbox.go`](pkg/services/sandbox.go).

`CreateBackup` is fire-and-forget — the runtime starts the snapshot
upload asynchronously and the controller returns `201`. Failures detected
synchronously (e.g. the runtime rejected the request outright) write
`BackupStateFailed` into `BackupInfoCache` so that subsequent `Info`
calls surface the error reason. Per-stage progress comes from the
runtime side and is also reflected in the cache.

### 2. Snapshot management

Path prefix: `/snapshots`. Snapshots are OCI images cached at
`~/.boxlite/images/`. Pull and build are **async with an error-cache
sidecar**: the controller returns `202`, a goroutine runs the operation,
and the result is recorded in `SnapshotErrorCache` keyed by image ref
(or destination ref if pull is mirroring).

| Method | Path | Controller | Purpose |
| --- | --- | --- | --- |
| `POST` | `/snapshots/pull` | `PullSnapshot` | Mirror image; optional push to destination registry |
| `POST` | `/snapshots/build` | `BuildSnapshot` | Build from Dockerfile + context hashes |
| `GET` | `/snapshots/exists` | `SnapshotExists` | Yes/no local cache check |
| `GET` | `/snapshots/info` | `GetSnapshotInfo` | Size, entrypoint, hash — `422` if error cached |
| `POST` | `/snapshots/remove` | `RemoveSnapshot` | Delete local image + clear error cache |
| `POST` | `/snapshots/tag` | `TagImage` | Re-tag existing local image (deprecated) |
| `POST` | `/snapshots/inspect` | `InspectSnapshotInRegistry` | Remote digest + size lookup |
| `GET` | `/snapshots/logs` | `GetBuildLogs` | Tail build log file; `follow=true` polls until image exists |

**Why a separate error cache.** Pull/build are decoupled from the
request, so clients can't see failures via the HTTP response. They poll
`/snapshots/info`, which returns `422 Unprocessable Entity` with the
error text when `SnapshotErrorCache.GetError(ref)` is set. `200` means
the image is ready; `404` means neither image nor cached error exists
(the operation is still in flight or was never started).

`GetBuildLogs` with `follow=true` streams the build log file and
**polls `ImageExists()` every 250 ms** to detect completion, then
gives the file 1 s of grace to flush before returning. There's no
explicit "build done" signal from the runtime — the image appearing in
the local store *is* the signal.

### 3. Execution + attach

Path prefix: `/v1/boxes/:boxId/`. This is the runner's flagship workflow:
a long-lived bidirectional stdio channel between an SDK client and a
process inside a VM. The endpoints below split create / status / kill
(REST, idempotent) from stdio (`/attach` WebSocket, stateful).

| Method | Path | Controller | Purpose |
| --- | --- | --- | --- |
| `POST` | `exec` | `BoxliteExec` | Create execution; returns `{execution_id}` |
| `GET` | `executions/:id/attach` | `BoxliteExecAttach` | WebSocket upgrade; bidirectional stdio + control |
| `GET` | `executions/:id` | `BoxliteGetExecution` | Status (`running` / `completed`, `exit_code` when done) |
| `POST` | `executions/:id/signal` | `BoxliteExecSignal` | Send a cooperative signal (whitelist) |
| `POST` | `executions/:id/resize` | `BoxliteExecResize` | Resize TTY (cols, rows) — TTY-only |
| `DELETE` | `executions/:id` | `BoxliteExecKill` | Atomic kill + evict |

#### Call graph

Layered view: HTTP route → controller → `ExecManager` registry → SDK
handle. Indentation = "calls".

```
pkg/api/controllers/boxlite_exec.go
├─ BoxliteExec(ctx)                           POST /exec
│  └─ ExecManager.Start(ctx, bx, ...)         spawns process + Wait goroutine
├─ BoxliteGetExecution(ctx)                   GET /executions/:id (status)
│  └─ ExecManager.Get(id)                     select on Done → running|completed
├─ BoxliteExecKill(ctx)                       DELETE /executions/:id
│  └─ ExecManager.Kill(id)                    atomic kill + evict
├─ BoxliteExecSignal(ctx)                     POST /signal (whitelist enforced)
│  └─ ExecManager.Signal(id, sig)             execHandle.Signal
├─ BoxliteExecResize(ctx)                     POST /resize
│  └─ ExecManager.ResizeTTY(id, rows, cols)   TTY-only; 400 otherwise
pkg/api/controllers/boxlite_exec_attach.go
└─ BoxliteExecAttach(ctx)                     GET /attach   (WebSocket upgrade)
   ├─ ManagedExec.MarkConnected()             409 if slot already taken
   └─ runAttachLoop(parentCtx, conn, exec)    4 goroutines, fail-fast cancel
      ├─ conn.SetReadDeadline(now + 45s)      45s = 3 × Ping interval; trips ReadMessage on dead peer
      ├─ conn.SetPongHandler(reset deadline)  each received Pong pushes deadline forward
      ├─ pumpSubscriberChannel() × {1,2}      stdout 0x01 / stderr 0x02 frames (subscribed to ManagedExec broadcaster)
      ├─ readClientFrames()                   binary → stdin; text JSON → control
      │  └─ handleControlFrame()              resize | signal (whitelist) | stdin_eof
      ├─ runKeepalive()                       WS Ping every 15s
      └─ (on exec.Done) writeJSONFrame()      sends {"type":"exit",...} + Close

pkg/boxlite/exec_manager.go
├─ ExecManager (struct)                       map[id]*ManagedExec + cleanupLoop
│  ├─ Start(ctx, bx, ...)                     io.Pipe pair, bx.StartExecution
│  │  └─ go func() { handle.Wait(); ... }     records ExitCode/Err, closes Done
│  ├─ Get / WriteStdin / Signal / ResizeTTY / Kill
│  └─ cleanupLoop(30s)
│     └─ runCleanupOnce(now)                  snapshot map under RLock
│        └─ evaluateExec(e, ...)              4-stage reap policy
│           ├─ age > maxLifetime   → killAndEvict   (hard 24h cap)
│           ├─ Done && age > 5m    → evictExited    (no signal)
│           ├─ idle > reconnectGrace → escalate(SIGHUP)
│           ├─ idle > shutdownGrace  → escalate(SIGTERM)
│           └─ idle > shutdownGrace  → killAndEvict (SIGKILL)
├─ ManagedExec (struct)                       per-exec state; attachMu guards attach fields
│  ├─ MarkConnected / MarkDisconnected        single-attach slot
│  └─ AttachStdin / AttachResize / AttachSignal / AttachCloseStdin
├─ execHandle (interface)                     Signal | Kill | ResizeTTY | Wait | Close
└─ sdkExec (struct)                           adapter → *boxlite.Execution (FFI to Rust)
```

#### Execution lifecycle

An execution moves through four phases. The diagram below shows every
transition and which entry point triggers each.

```
                 ┌─────────────────────────────────────┐
                 │ 1. CREATE                           │
                 │    POST /exec  →  execution_id      │
                 │    server spawns process in VM      │
                 │    ManagedExec inserted into map    │
                 └──────────────┬──────────────────────┘
                                │
                                ▼
                 ┌─────────────────────────────────────┐
                 │ 2. ATTACH                           │
                 │    GET /attach (WebSocket upgrade)  │
                 │    MarkConnected: claim slot or 409 │
                 │    bidirectional pump runs          │
                 └─────┬─────────────────────────┬─────┘
                       │                         │
                       │ process exits           │ WS dies
                       ▼                         ▼
          ┌──────────────────────┐    ┌──────────────────────────┐
          │ 3a. CLEAN EXIT       │    │ 3b. DETACH               │
          │  Done fires          │    │  MarkDisconnected fires  │
          │  exit frame sent     │    │  attach slot released    │
          │  WS Close (normal)   │    │  process keeps running   │
          │  evict after 5m      │    │  reap clock starts       │
          └──────────────────────┘    └────────┬─────────────────┘
                                               │
                            ┌──────────────────┼──────────────────┐
                            │ within 5 min     │ past 5 min       │
                            ▼                  ▼                  │
                 ┌─────────────────┐   ┌──────────────────────┐   │
                 │ 4a. REATTACH    │   │ 4b. REAP             │   │
                 │  GET /attach    │   │  SIGHUP → 30s        │   │
                 │  reuse same id  │   │  SIGTERM → 30s       │   │
                 │  flags reset    │   │  SIGKILL + evict     │   │
                 │  back to (2)    │   │  (or 24h hard cap)   │   │
                 └─────────────────┘   └──────────────────────┘   │
                                                                  │
                          after 5m + escalation, exec is gone ────┘
```

##### Why this shape

- **Single-attach** keeps PTY semantics intact. Two clients reading from
  one PTY would race on stdin and split stdout output unpredictably.
- **Detach without kill** lets a client survive transient connection
  drops (LB idle timeout, network blip) without losing the running
  process. Matches the E2B / Daytona model.
- **Reap escalation (SIGHUP → SIGTERM → SIGKILL)** mirrors the standard
  Unix shutdown sequence used by systemd, Kubernetes, and Docker.
  Cooperative processes (`bash`, `python -i`, `psql`) clean up on SIGHUP.
- **24 h hard cap** prevents a forgotten session from holding resources
  forever. Configurable.

#### `/attach` wire protocol

`GET /v1/boxes/{box_id}/executions/{exec_id}/attach` upgrades to a
WebSocket carrying stdin, stdout, stderr, and control on one connection.

```
Client → Server                       Server → Client
─────────────────                     ─────────────────
Binary [stdin bytes]                  Binary [0x01 | stdout bytes]
                                      Binary [0x02 | stderr bytes]   (non-TTY only)
Text JSON {"type":"resize","cols","rows"}
Text JSON {"type":"signal","sig":N}   Text JSON {"type":"exit","exit_code":N}
Text JSON {"type":"stdin_eof"}        Text JSON {"type":"error","message":"..."}
                                      WS Ping every 15 s           ← keepalive
WS Pong (auto)                        WS Close on normal exit
```

Notable properties:

- **No SSE base64 bloat.** Stdout/stderr are raw bytes; the only
  framing overhead is the 1-byte channel prefix (~0.025% on 4 KB
  chunks).
- **No per-keystroke HTTPS round trip.** Stdin rides the same persistent
  connection — latency is one local-to-server WS frame, not one HTTP
  POST with auth handshake.
- **TTY mode merges stdout/stderr** in the kernel; the server only
  emits the `0x01` channel. Non-TTY mode emits both.
- **Server-driven keepalive.** Even with no application I/O, the server
  sends a WS Ping every 15 seconds, well under any reasonable
  intermediary's idle timeout (CloudFront default 30 s, ALB 60 s,
  Heroku 55 s).
- **Single-attach.** A second `/attach` to an already-attached exec
  returns HTTP 409 *before* the WS upgrade. The client should respect
  this and surface a "session busy" error rather than retry.

#### Reaping policy

The background `cleanupLoop` ticks every 30 s and applies the policy
below to each `ManagedExec`. All three timers are independently
configurable via environment variables.

| Trigger | Action | Default | Env var |
| --- | --- | --- | --- |
| Age since `created` > cap | atomic kill + evict | 24 h | `BOXLITE_MAX_SESSION_LIFETIME` |
| `Done` fired ≥ 5 min ago | evict (no signal) | 5 min | (not configurable) |
| `!Connected` and idle > grace | SIGHUP | 5 min | `BOXLITE_RECONNECT_GRACE` |
| After SIGHUP, idle > shutdown grace | SIGTERM | 30 s | `BOXLITE_SHUTDOWN_GRACE` |
| After SIGTERM, idle > shutdown grace | SIGKILL + evict | 30 s | `BOXLITE_SHUTDOWN_GRACE` |

Reattaching inside the reconnect grace resets `SignaledHUP` and
`SignaledTERM` so a subsequent disconnect starts a fresh clock.
Durations accept Go's `time.ParseDuration` syntax (e.g. `5m`, `30s`,
`24h`, `90s`).

If the underlying SDK can't deliver arbitrary POSIX signals,
`sdkExec.Signal` returns `ErrSignalUnsupported`; the reaper logs a
warning and falls through to `Kill()` immediately. Exercised in
[`exec_manager_test.go::TestExecManagerSignalUnsupportedFallsThroughToKill`](pkg/boxlite/exec_manager_test.go).

#### Signal whitelist

`POST /signal` accepts only cooperative signals. SIGKILL goes through
`DELETE /executions/:id` instead; the signal endpoint *needs* the
atomic kill+evict that DELETE provides.

| Allowed | Rejected with 400 |
| --- | --- |
| 1 (HUP), 2 (INT), 3 (QUIT), 6 (ABRT), 10 (USR1), 12 (USR2), 15 (TERM), 28 (WINCH) | 9 (KILL), 17/19/23 (STOP variants), 18 (CONT), anything else |

STOP/CONT are rejected because they bypass PTY line discipline (so a
PTY-aware program won't notice them) and because a stopped process
holds RAM forever while looking idle to the reaper — a footgun, not
a feature.

### 4. File I/O

| Method | Path | Controller | Purpose |
| --- | --- | --- | --- |
| `PUT` | `/v1/boxes/:boxId/files?path=<dest>` | `BoxliteFileUpload` | Stream tar body → temp file → `CopyInto(box, tmp, dest)` |
| `GET` | `/v1/boxes/:boxId/files?path=<src>` | `BoxliteFileDownload` | `CopyOut(box, src, tmpDir)` → walk dir, write `application/x-tar` |

Tar framing is used in both directions so a single endpoint can move
files, directories, and symlinks uniformly. Temp files live under
`os.TempDir()` and are cleaned up before the response returns.

### 5. Per-box metrics

`GET /v1/boxes/:boxId/metrics` returns the JSON shape in
[`pkg/api/controllers/boxlite_metrics.go`](pkg/api/controllers/boxlite_metrics.go):
CPU %, memory bytes, exec counts (`commands_executed_total`,
`exec_errors_total`), bytes shipped over `/attach`, VM create + boot
durations, and network counters. All values come from
`r.Boxlite.BoxMetrics(ctx, boxId)` and are not aggregated by the runner.

### 6. Runner info + Prometheus

| Method | Path | Controller | Purpose |
| --- | --- | --- | --- |
| `GET` | `/` | `HealthCheck` | Liveness + version (public) |
| `GET` | `/info` | `RunnerInfo` | Host metrics + service health + version |
| `GET` | `/metrics` | promhttp | Prometheus scrape endpoint |

`/info` combines:

- A snapshot from `metrics.Collector.Collect(ctx)` — host CPU load
  average, CPU/mem/disk %, summed allocated CPU/RAM/disk across running
  sandboxes, snapshot count, started sandbox count.
- `runner.InspectRunnerServices(ctx)` — pings the BoxLite runtime with
  a 2 s timeout and reports `boxlite: healthy|<err>`.

The Prometheus endpoint is the standard `promhttp.Handler()` and exposes
the counters maintained in `pkg/common/` (operation counts, etc.).

### 7. Toolbox proxy (browser terminal)

`Any /sandboxes/:sandboxId/toolbox/*path` — same controller serves two
modes:

- **HTTP GET** — returns the embedded xterm.js page (HTML + CDN links
  in `proxy.go`).
- **WebSocket** — bridges browser keystrokes to a fresh `/bin/sh`
  execution started via `r.Boxlite.StartExecution(...)`. Output frames
  are sent as WebSocket text messages; input is read from the same
  socket and written to the execution's stdin.

This is a convenience surface for the dashboard, not the supported
programmatic stdio channel — use `/attach` for that.

### 8. SSH gateway

When `SSH_GATEWAY_ENABLE=true`, the runner also listens on a configurable
TCP port (`pkg/sshgateway/config.go::GetSSHGatewayPort`). Clients
authenticate with a single shared public key configured on the runner
(`GetSSHPublicKey`), and the **SSH username is interpreted as the
sandbox ID**. Once authenticated, the handler opens an SSH client
connection from the runner to `<sandboxId>:22220` (the toolbox SSH
endpoint inside the box) and copies channels + requests bidirectionally.

Caveat: the inner client→box connection currently uses a hardcoded
password and `ssh.InsecureIgnoreHostKey`. That's safe only because the
inner connection never leaves the runner's network. Don't expose the
gateway port directly to untrusted clients without auditing this path.

---

## Background services

### Sandbox state sync

[`pkg/services/sandbox_sync.go`](pkg/services/sandbox_sync.go). Runs every
10 s (configurable in `main.go`). For each local box, fetches the
authoritative state from BoxLite, then asks the control-plane API for
all sandboxes currently `STARTED` and not under reconciliation, and
calls `UpdateSandboxState` whenever the two disagree. One-way: local
state wins.

Boxes that don't appear in the remote `STARTED` list are skipped — the
runner does not push state for sandboxes the API isn't tracking.

### Metrics collector

[`internal/metrics/collector.go`](internal/metrics/collector.go). Two
independent loops:

- **CPU usage snapshot** every `CPUUsageSnapshotInterval` — keeps a
  ring buffer of the last `WindowSize` samples so `/info` can return a
  smoothed CPU % without re-sampling on each request.
- **Allocated resources snapshot** every
  `AllocatedResourcesSnapshotInterval` — queries `Boxlite.ListInfo()`
  and sums the CPU/RAM/disk allocations across running sandboxes.

`Collect(ctx)` reads the current values with a short timeout and is
called from both `/info` and the v2 healthcheck.

### v2 job poller + executor

Only spawned when `BOXLITE_API_VERSION=2`. The poller
([`pkg/runner/v2/poller/poller.go`](pkg/runner/v2/poller/poller.go))
first drains anything left in `IN_PROGRESS` from a previous run, then
long-polls `JobsAPI.PollJobs` with `(timeout, limit)`. HTTP `408`
returns are treated as "no work yet" (normal long-poll behavior); any
other error backs off 5 s and retries.

Each job is dispatched to a goroutine and handled in
[`pkg/runner/v2/executor/executor.go`](pkg/runner/v2/executor/executor.go).
Supported job types:

```
CREATE_SANDBOX, START_SANDBOX, STOP_SANDBOX, DESTROY_SANDBOX,
RESIZE_SANDBOX, RECOVER_SANDBOX, UPDATE_SANDBOX_NETWORK_SETTINGS,
CREATE_BACKUP,
BUILD_SNAPSHOT, PULL_SNAPSHOT, REMOVE_SNAPSHOT, INSPECT_SNAPSHOT_IN_REGISTRY
```

After the handler returns, `updateJobStatus` reports `COMPLETED` or
`FAILED` to the API with exponential backoff. W3C trace context is
extracted from the job's `traceContext` map so the runner's spans chain
under the API-side trace.

This is the production path. The HTTP routes under `/sandboxes/` and
`/snapshots/` exist for direct/SDK use; v2 turns those into pull-based
job execution.

### v2 healthcheck

[`pkg/runner/v2/healthcheck/healthcheck.go`](pkg/runner/v2/healthcheck/healthcheck.go).
Periodic `POST RunnerHealthcheck` to the API with runner version,
domain, API + proxy URLs, BoxLite ping result, and the current metrics
snapshot. Failures are logged but never crash the runner — this is the
control plane's view of the runner's liveness, not a self-test.

---

## Complete REST surface

All routes are gated by `Bearer <BOXLITE_RUNNER_TOKEN>` except `/` and
the Swagger UI (development only).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Health check (public) |
| `GET` | `/info` | Runner metrics + service health |
| `GET` | `/metrics` | Prometheus scrape |
| `POST` | `/sandboxes` | Create sandbox |
| `GET` | `/sandboxes/:id` | Sandbox info (state + backup state + daemon version) |
| `POST` | `/sandboxes/:id/start` | Start |
| `POST` | `/sandboxes/:id/stop` | Stop (graceful or `force`) |
| `POST` | `/sandboxes/:id/destroy` | Destroy |
| `POST` | `/sandboxes/:id/resize` | Resize CPU / memory / disk |
| `POST` | `/sandboxes/:id/backup` | Async backup |
| `POST` | `/sandboxes/:id/recover` | Recover from error state |
| `POST` | `/sandboxes/:id/is-recoverable` | Check whether an error reason is recoverable |
| `POST` | `/sandboxes/:id/network-settings` | Update block-all / allow-list |
| `Any` | `/sandboxes/:id/toolbox/*path` | xterm.js page + WS terminal |
| `POST` | `/snapshots/pull` | Async pull (mirror + optional push) |
| `POST` | `/snapshots/build` | Async build |
| `GET` | `/snapshots/exists` | Local existence check |
| `GET` | `/snapshots/info` | Image info; `422` if cached error |
| `POST` | `/snapshots/remove` | Delete image + clear error cache |
| `POST` | `/snapshots/tag` | Re-tag (deprecated) |
| `POST` | `/snapshots/inspect` | Remote digest + size |
| `GET` | `/snapshots/logs` | Stream build log (`follow=true` polls until image exists) |
| `POST` | `/v1/boxes/:boxId/exec` | Create execution |
| `GET` | `/v1/boxes/:boxId/executions/:execId` | Execution status |
| `DELETE` | `/v1/boxes/:boxId/executions/:execId` | Kill + evict |
| `GET` | `/v1/boxes/:boxId/executions/:execId/attach` | WebSocket stdio + control |
| `POST` | `/v1/boxes/:boxId/executions/:execId/signal` | Cooperative signal (whitelist) |
| `POST` | `/v1/boxes/:boxId/executions/:execId/resize` | Resize TTY |
| `PUT` | `/v1/boxes/:boxId/files?path=<dest>` | Upload tar |
| `GET` | `/v1/boxes/:boxId/files?path=<src>` | Download tar |
| `GET` | `/v1/boxes/:boxId/metrics` | Per-box metrics |

---

## Building and running

```bash
# Build
make -C apps/runner build

# Run (uses BOXLITE_HOME_DIR for VM state)
BOXLITE_API_URL=http://localhost:3000/api \
BOXLITE_RUNNER_TOKEN=dev-secret \
API_PORT=3003 \
RUNNER_DOMAIN=localhost \
BOXLITE_HOME_DIR=/var/lib/boxlite \
  ./bin/boxlite-runner
```

Optional features are toggled by env vars:

- `BOXLITE_API_VERSION=2` — spawn the long-poll + healthcheck loops.
- `SSH_GATEWAY_ENABLE=true` — listen for SSH connections on the
  configured port.
- `BOXLITE_MAX_SESSION_LIFETIME`, `BOXLITE_RECONNECT_GRACE`,
  `BOXLITE_SHUTDOWN_GRACE` — exec reaping timers.

The runner is normally bootstrapped by the SST EC2 user-data script;
see `apps/infra/sst.config.ts:buildRunnerUserData`. For local
development against the Rust SDK directly, see `boxlite serve` at
[`src/cli/src/commands/serve/`](../../src/cli/src/commands/serve/)
(Rust REST server with parity coverage).

---

## Tests

```bash
# All runner tests
cd apps/runner && go test -tags boxlite_dev ./...

# Just the attach + exec_manager suites
cd apps/runner && go test -tags boxlite_dev ./pkg/api/controllers/... ./pkg/boxlite/...

# With race detector (recommended; cleanupLoop ticker + attach goroutines)
cd apps/runner && go test -tags boxlite_dev -race ./...
```

The `boxlite_dev` build tag is required because the Go SDK uses FFI
symbols that aren't in the released `libboxlite.a`. The dev tag links
against the local cargo-built version.

If you hit "libboxlite.a not found" or unresolved-symbol errors:

```bash
git submodule update --init --recursive
cargo build -p boxlite-c
scripts/build/fix-go-symbols.sh target/debug/libboxlite.a
```

---

## Related code

- **HTTP layer**:
  - [`pkg/api/server.go`](pkg/api/server.go) — route registration, middleware
  - [`pkg/api/controllers/sandbox.go`](pkg/api/controllers/sandbox.go) — lifecycle
  - [`pkg/api/controllers/snapshot.go`](pkg/api/controllers/snapshot.go) — pull/build/inspect
  - [`pkg/api/controllers/boxlite_exec.go`](pkg/api/controllers/boxlite_exec.go) — exec create / signal / resize / status / legacy I/O
  - [`pkg/api/controllers/boxlite_exec_attach.go`](pkg/api/controllers/boxlite_exec_attach.go) — `/attach` WebSocket
  - [`pkg/api/controllers/boxlite_files.go`](pkg/api/controllers/boxlite_files.go), [`boxlite_metrics.go`](pkg/api/controllers/boxlite_metrics.go), [`proxy.go`](pkg/api/controllers/proxy.go), [`info.go`](pkg/api/controllers/info.go)

- **Services / state**:
  - [`pkg/services/sandbox.go`](pkg/services/sandbox.go), [`sandbox_sync.go`](pkg/services/sandbox_sync.go)
  - [`pkg/boxlite/client.go`](pkg/boxlite/client.go) — Go SDK wrapper
  - [`pkg/boxlite/exec_manager.go`](pkg/boxlite/exec_manager.go) — `ManagedExec`, reaping
  - [`pkg/cache/`](pkg/cache/) — backup info and snapshot error caches
  - [`internal/metrics/collector.go`](internal/metrics/collector.go)

- **Background loops**:
  - [`pkg/runner/v2/poller/poller.go`](pkg/runner/v2/poller/poller.go)
  - [`pkg/runner/v2/executor/executor.go`](pkg/runner/v2/executor/executor.go)
  - [`pkg/runner/v2/healthcheck/healthcheck.go`](pkg/runner/v2/healthcheck/healthcheck.go)
  - [`pkg/sshgateway/service.go`](pkg/sshgateway/service.go)

- **Client side (Rust SDK)**:
  - [`src/boxlite/src/rest/litebox.rs::attach_ws_pump`](../../src/boxlite/src/rest/litebox.rs) — bidirectional WS pump
  - [`src/boxlite/src/rest/client.rs::connect_ws`](../../src/boxlite/src/rest/client.rs) — WS upgrade with OAuth2 Bearer + typed HTTP error mapping
  - [`src/boxlite/src/litebox/exec.rs::Execution`](../../src/boxlite/src/litebox/exec.rs) — public handle

- **Tests**:
  - [`pkg/api/controllers/boxlite_exec_attach_test.go`](pkg/api/controllers/boxlite_exec_attach_test.go) — WS protocol roundtrip
  - [`pkg/boxlite/exec_manager_test.go`](pkg/boxlite/exec_manager_test.go) — reaper escalation timeline
  - `src/boxlite/src/rest/litebox.rs::tests::ws_*` — SDK WS pump

- **Spec**:
  - [`openapi/rest-sandbox-open-api.yaml`](../../openapi/rest-sandbox-open-api.yaml) — formal API schema
