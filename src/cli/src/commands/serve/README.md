# boxlite serve — REST API Server

`boxlite serve` starts a long-running HTTP server that exposes the full BoxLite runtime over a REST
API. SDK clients connect to it via `Boxlite.rest()` — the server holds a single `BoxliteRuntime` and
translates HTTP requests into runtime calls, WebSocket connections into bidirectional attach
sessions.

## Quick Start

```bash
boxlite serve                      # listen on 127.0.0.1:8100 (permissive)
boxlite serve --port 9090          # custom port
boxlite serve --api-key dev-key    # require Bearer dev-key (else 401)
boxlite serve --host 0.0.0.0 --api-key "$KEY"  # expose on the network (key required)
```

Ctrl-C triggers graceful shutdown (`runtime.shutdown` with a 10 s timeout).

Connect from an SDK:

```rust
let rt = BoxliteRuntime::rest(BoxliteRestOptions::new("http://localhost:8100"))?;
```

## Startup Call Graph

```
execute(ServeArgs, GlobalFlags)
  │
  ├─ GlobalFlags::resolve_runtime_options() — resolve local runtime settings
  ├─ GlobalFlags::create_runtime_with_options()
  │                                          — build local BoxliteRuntime
  │
  ├─ Arc::new(AppState { runtime, boxes, executions,
  │                      api_key, lifecycle, last_activity })
  │                                          — shared state for all handlers
  ├─ tokio::spawn(reaper_loop(state))       — orphan reaper + lifecycle sweep
  │                                            (30 s tick)
  │
  ├─ build_router(state)                    — register the REST routes on axum::Router
  │
  ├─ TcpListener::bind(host:port)           — bind TCP socket
  │
  └─ axum::serve(listener, app)             — start serving requests
       └─ .with_graceful_shutdown(ctrl_c)
            └─ runtime.shutdown(Some(10))   — stop all boxes on exit
```

## Architecture

### Local host port publication

This serve deployment supports a local extension to the shared cloud API.
`GET /v1/config` advertises `capabilities.local_port_publication_enabled: true`.
Create a box with TCP publication requests:

```json
{
  "image": "your-registry/agentbox:latest",
  "ports": [{"guest_port": 30141, "host_port": null, "host_ip": "0.0.0.0", "protocol": "tcp"}],
  "detach": true,
  "auto_stop": 0,
  "auto_delete": 0
}
```

An omitted, null, or zero `host_port` asks the OS to bind an available port.
A non-zero `host_port` requests a fixed port. The box's local runtime owns
the listener; concurrent automatic allocations use OS binding instead of
probing and releasing a port. No separate proxy daemon is required.

Call `POST /v1/boxes/{id}/start`, then read `GET /v1/boxes/{id}`.
The creation response can precede binding. Get/list/start responses expose
the runtime's current `network.published_ports`, for example:

```json
{"network":{"published_ports":[{"guest_port":30141,"host_ip":"0.0.0.0","host_port":40141,"protocol":"tcp"}]}}
```

Use `http://<serve-host>:40141` for a guest HTTP service. `host_ip` is a bind
address, not a public URL; `0.0.0.0` must be replaced by a reachable host address.
Read metadata again after a restart: an automatically allocated port can change.
An empty list means no active publications; an omitted field means unknown.
Stopped/deleted boxes release their listeners through the runtime's lifecycle.
On Linux, stopping snapshots the sandbox process tree before terminating its
launcher. Descendants in separate sessions receive SIGTERM, followed by a
bounded wait, cgroup cleanup when available, and SIGKILL for survivors. This
also releases gvproxy listeners when cgroup controller delegation is unavailable.
If tracked processes survive a stop, BoxLite keeps their identities on disk.
Later stop or removal attempts retry those processes even after the launcher
exits. If the record cannot be written, BoxLite still attempts teardown and
keeps any surviving identities in memory for retries in the same runtime.
Removal preserves the box record and files until cleanup succeeds.
Boxes created without `ports` have no mapping to recover; this API does not
add publications to existing boxes. Preserve their data before explicitly
recreating them with publication options.

The guest service must listen on its guest interface (for example `0.0.0.0`),
and outbound networking must be enabled. UDP and invalid bind IPs are rejected.
Local publication is separate from the cloud proxy's inbound policy and
private tunnel authentication: the published service enforces its own auth.
The shared OpenAPI and cloud REST SDKs continue to use cloud service tunnels;
this extension is for direct HTTP callers of this local serve deployment.

When serve runs in Docker, its listeners are in that container's network
namespace. Use Linux `network_mode: host` to make dynamically allocated ports
reachable on the host; publishing only the management port 8100 is insufficient.


```
┌───────────────────────────────────────────────────────┐
│                    SDK Clients                         │
│   (Boxlite.rest() → ApiClient → reqwest / WebSocket)  │
└────────────────────────┬──────────────────────────────┘
                         │ HTTP / WebSocket
                         ▼
┌───────────────────────────────────────────────────────┐
│                boxlite serve  (axum)                   │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │                AppState (Arc)                     │  │
│  │                                                   │  │
│  │  ┌─────────────────┐                              │  │
│  │  │ BoxliteRuntime  │    core runtime              │  │
│  │  └─────────────────┘                              │  │
│  │  ┌──────────────────────────────────────────┐     │  │
│  │  │ boxes: RwLock<HashMap<String, Arc<LiteBox>>>   │  │
│  │  └──────────────────────────────────────────┘     │  │
│  │  ┌──────────────────────────────────────────────┐ │  │
│  │  │ executions: RwLock<HashMap<String,           │ │  │
│  │  │                     Arc<ActiveExecution>>>    │ │  │
│  │  └──────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  Handlers:  config · boxes · executions                │
│             files · metrics · snapshots · ssh          │
│             advanced                                    │
│                                                        │
│  Background:  reaper_loop  (orphans + lifecycle sweep)  │
└───────────────────────────────────────────────────────┘
                         │
                         ▼
┌───────────────────────────────────────────────────────┐
│               BoxliteRuntime  (core)                   │
│     LiteBox → ShimController → Guest VM                │
└───────────────────────────────────────────────────────┘
```

`AppState.boxes` is a lazy cache — `get_or_fetch_box()` populates it from `runtime.get()` on first
access. `AppState.executions` maps execution IDs to `Arc<ActiveExecution>` for the active-session
registry. `AppState.lifecycle` holds the AutoStop/AutoDelete deadlines the sweep acts on — the
engine accepts neither on a local runtime — and `AppState.last_activity` is the idle clock, stamped
by the request middleware and by client data frames on an attach.

## Handler Reference

| Module       | File                     | Purpose                                                       |
|--------------|--------------------------|---------------------------------------------------------------|
| `config`     | `handlers/config.rs`     | Capability discovery (snapshots, clone, export, import)       |
| `me`         | `handlers/me.rs`         | Identity of the calling credential (`GET /v1/me`)             |
| `boxes`      | `handlers/boxes.rs`      | Box CRUD and lifecycle                                        |
| `executions` | `handlers/executions.rs` | Lifecycle: start, status, signal, kill, resize, attach        |
| `files`      | `handlers/files.rs`      | Tar-based file upload / download into / from boxes            |
| `metrics`    | `handlers/metrics.rs`    | Runtime-level and per-box metrics                             |
| `snapshots`  | `handlers/snapshots.rs`  | Snapshot CRUD + restore                                       |
| `ssh`        | `handlers/ssh.rs`        | Guest SSH configure / enable / status / disable                    |
| `advanced`   | `handlers/advanced.rs`   | Clone, export, import                                         |

## Route Reference

All paths are relative to the server root (e.g. `http://localhost:8100`).

### Auth & Config

| Method | Path                 | Handler               | Description                        |
|--------|----------------------|-----------------------|------------------------------------|
| GET    | `/v1/config`         | `config::get_config`  | Capability discovery (always public) |
| GET    | `/v1/me`             | `me::get_me`          | Identity of the calling credential |

**Auth.** With `--api-key <KEY>` (or `$BOXLITE_SERVE_API_KEY`) set, every
route except `GET /v1/config` requires `Authorization: Bearer <KEY>`
(constant-time match) and returns `401` otherwise. Without it the server is
permissive (accepts any/no bearer) — the zero-config local-dev default. A
permissive server only binds to loopback: `serve` refuses to start on any
other `--host` (e.g. `0.0.0.0`) unless an API key is set.

### Box CRUD & Lifecycle

| Method | Path                                  | Handler             | Description                    |
|--------|---------------------------------------|----------------------|-------------------------------|
| POST   | `/v1/boxes`                   | `boxes::create_box`  | Create a new box              |
| GET    | `/v1/boxes`                   | `boxes::list_boxes`  | List all boxes                |
| GET    | `/v1/boxes/{box_id}`          | `boxes::get_box`     | Get box info                  |
| HEAD   | `/v1/boxes/{box_id}`          | `boxes::head_box`    | Check box exists (204 / 404)  |
| DELETE | `/v1/boxes/{box_id}`          | `boxes::remove_box`  | Remove box (`?force=true`)    |
| POST   | `/v1/boxes/{box_id}/start`    | `boxes::start_box`   | Start a stopped box           |
| POST   | `/v1/boxes/{box_id}/stop`     | `boxes::stop_box`    | Stop a running box            |

### Guest SSH

| Method | Path                       | Handler              | Description                                  |
|--------|----------------------------|----------------------|----------------------------------------------|
| POST   | `/v1/boxes/{box_id}/ssh`   | `ssh::configure_ssh` | Replace SSH configuration; returns status    |
| POST   | `/v1/boxes/{box_id}/ssh/enable` | `ssh::enable_ssh` | Enable saved configuration on a running box |
| GET    | `/v1/boxes/{box_id}/ssh`   | `ssh::status_ssh`    | Read SSH status without starting the box     |
| DELETE | `/v1/boxes/{box_id}/ssh`   | `ssh::disable_ssh`   | Disable SSH idempotently on a running box; otherwise `409 invalid_state`; never starts it |

`POST /ssh` takes the direct `SshConfig` JSON body (not a wrapper) with
`Content-Type: application/json` and answers with `SshStatus`; every accepted
configure fully restarts the guest listener, so neither server nor client
retries it. A wrong content type, malformed JSON, a missing required field, or an
unknown field at any level — configuration, account, or CA — is rejected with the
fixed sanitized `400 invalid_argument` message before box resolution. `POST /ssh`
resolves through the resume resolver (like exec); `GET` and
`DELETE` and `POST /ssh/enable` resolve through the fetch resolver and never start the box. Only
`POST /ssh` stamps the idle clock: after authentication succeeds, the common
middleware records box activity before the body is parsed, so a rejected
configure still counts. The
[SSH guide](../../../../../docs/guides/ssh.md) owns the full contract.

### Command Execution

| Method | Path                                                            | Handler                       | Description                 |
|--------|-----------------------------------------------------------------|-------------------------------|-----------------------------|
| GET    | `/v1/boxes/{box_id}/attach`                             | `executions::attach_box`      | WebSocket attach to init    |
| POST   | `/v1/boxes/{box_id}/exec`                               | `executions::start_execution` | Start a new command         |
| GET    | `/v1/boxes/{box_id}/executions/{id}`                    | `executions::get_execution`   | Get status + exit code      |
| DELETE | `/v1/boxes/{box_id}/executions/{id}`                    | `executions::kill_execution`  | SIGKILL + evict             |
| GET    | `/v1/boxes/{box_id}/executions/{id}/attach`             | `executions::attach_execution`| WebSocket attach (bidi)     |
| POST   | `/v1/boxes/{box_id}/executions/{id}/signal`             | `executions::send_signal`     | Send cooperative signal     |
| POST   | `/v1/boxes/{box_id}/executions/{id}/resize`             | `executions::resize_tty`      | Resize PTY                  |

`/attach` is the box's **main command session** — the container's init, which
`run IMAGE COMMAND` replaces with COMMAND (docker semantics). It mirrors
docker's `POST /containers/{id}/attach`, distinct from exec-attach: the client
has no id for init, because init's execution id is the container id. The first
attach opens that session and registers it alongside tenant execs; the upgrade
response returns its id in `X-Boxlite-Execution-Id`, so signal/resize/kill and
reconnect then go through the `/executions/{id}/…` routes above. A second
client on an attached main session gets 409, same as for an exec.

### Files

| Method | Path                                 | Handler                | Description                       |
|--------|--------------------------------------|------------------------|-----------------------------------|
| PUT    | `/v1/boxes/{box_id}/files`   | `files::upload_files`  | Upload tar, extract into box      |
| GET    | `/v1/boxes/{box_id}/files`   | `files::download_files`| Download path as tar              |

Both directions stream tar chunks between HTTP and the box backend, with
backpressure and no intermediate archive or extraction directory on the server:

```text
PUT body -> copy_in_stream -> guest extraction
GET body <- copy_out_stream <- guest packing
```

The archive's first entry determines upload landing, matching the runner.
For example, `tree/a.txt` with a leading `tree/` directory entry becomes
`/dst/a.txt` when `/dst` is missing, or `/dst/tree/a.txt` when `/dst` is a directory.
A `./` root places the contents directly inside the destination; an empty tar
does not change existing files or their ownership.

Missing sources and refused paths return an HTTP error before response headers.
A failure after headers terminates the body, so clients must read to
EOF and check transport errors even after receiving a valid tar end marker.
Dropping a transfer releases its source; blocking extraction exits when its
bounded input channel closes.

Copies are not transactional: files written before a failure remain. Guest
ownership adjustment happens after successful extraction, so a failed upload
can leave files owned by root. Payload buffering is bounded by chunks; extraction
metadata still grows with the number of entries, and older peers may buffer.

Downloads preserve symbolic links as link entries rather than reading their
targets. A guest chooses the target, so dereferencing it on the host could read
host files into the response; clients extracting the downloaded tar must apply
the usual safeguards for untrusted archives.

### Metrics

| Method | Path                                        | Handler                  | Description               |
|--------|---------------------------------------------|--------------------------|---------------------------|
| GET    | `/v1/metrics`                       | `metrics::runtime_metrics`| Runtime-wide counters     |
| GET    | `/v1/boxes/{box_id}/metrics`        | `metrics::box_metrics`   | Per-box metrics + boot timing |

Serving per-box metrics boots a box that is not running, and a scrape is not
counted as use — so on a box with an AutoStop deadline it would only be stopped
again on the next tick. `box_metrics` answers 409 rather than start that cycle.
A box with no deadline still boots on scrape, as it always has.

### Snapshots

| Method | Path                                                        | Handler                       | Description          |
|--------|-------------------------------------------------------------|-------------------------------|----------------------|
| POST   | `/v1/boxes/{box_id}/snapshots`                      | `snapshots::create_snapshot`  | Create snapshot      |
| GET    | `/v1/boxes/{box_id}/snapshots`                      | `snapshots::list_snapshots`   | List snapshots       |
| GET    | `/v1/boxes/{box_id}/snapshots/{name}`               | `snapshots::get_snapshot`     | Get snapshot info    |
| DELETE | `/v1/boxes/{box_id}/snapshots/{name}`               | `snapshots::delete_snapshot`  | Delete snapshot      |
| POST   | `/v1/boxes/{box_id}/snapshots/{name}/restore`       | `snapshots::restore_snapshot` | Restore snapshot     |

### Advanced (Clone, Export, Import)

| Method | Path                                        | Handler               | Description                    |
|--------|---------------------------------------------|-----------------------|--------------------------------|
| POST   | `/v1/boxes/{box_id}/clone`          | `advanced::clone_box` | Clone a box                    |
| POST   | `/v1/boxes/{box_id}/export`         | `advanced::export_box`| Export box as archive          |
| POST   | `/v1/boxes/import`                  | `advanced::import_box`| Import box from archive body   |

## Execution Lifecycle

### Start

```
POST /v1/boxes/{box_id}/exec
  │
  ├─ get_or_resume_box(state, box_id)         — resolve LiteBox; 409 if the box
  │                                             is down and AutoResume is off
  ├─ build_box_command(req)                    — JSON body → BoxCommand
  ├─ litebox.run(cmd)                          — start command (returns Execution)
  │
  ├─ execution.stdin()                         — take stdin handle
  │    └─ if req.stdin is Some:
  │         stdin.write_all(data) + close       — write inline stdin, discard handle
  │
  └─ ActiveExecution::new(box_id, execution, stdin)  — wrap in server-side state
       │
       ├─ execution.stdout() / .stderr()       — take single-consumer stream halves
       │
       ├─ BacklogBroadcast::new(256, 256 KiB)  — stdout_bus + stderr_bus
       │
       ├─ tokio::spawn(stdout pump)            — Stream → bus.send()
       ├─ tokio::spawn(stderr pump)            — Stream → bus.send()
       │
       └─ tokio::spawn(wait task)
            ├─ execution.wait()                — block until process exits
            ├─ stdout_handle.await             — barrier: wait for pump completion
            ├─ stderr_handle.await             — ensures all output is broadcast
            ├─ done.store(true)
            └─ done_tx.send(true)              — notify all observers
```

### BacklogBroadcast

`BacklogBroadcast` wraps `tokio::sync::broadcast` with a byte-capped `VecDeque` backlog (256 KiB).
When a new subscriber calls `subscribe()`, it receives the full backlog snapshot first, then
switches to live broadcast — no gap, no interleaving. Both the backlog append and the broadcast
`send()` happen under the same `Mutex`, preventing duplicates. This mirrors the Go runner's
`streamBus` pattern for late-attach replay.

### Attach (WebSocket)

```
GET /v1/boxes/{box_id}/executions/{id}/attach
  │
  ├─ AttachQuery::policy()                     — stdin=0|false → Refuse, absent|1|true → Allow,
  │                                              anything else → 400 (never falls open)
  ├─ mark_connected()                          — claim single-attach slot (409 if taken)
  ├─ WebSocketUpgrade → on_upgrade             — HTTP → WS handshake
  │    └─ on_failed_upgrade: mark_disconnected()
  │
  └─ run_attach_session(socket, active, state, stdin_policy)
       │
       ├─ stdout_bus.subscribe()               — BacklogReceiver (replay + live)
       ├─ stderr_bus.subscribe()
       ├─ done_rx = active.done_rx()
       ├─ socket.split() → (sink, stream)
       │
       ├─ tokio::spawn(reader)                 — client → server
       │    ├─ Binary frames  → Refuse: error frame + Close 1008; else stdin.write_all()
       │    ├─ Text {"type":"resize"}  → Refuse: error frame; else execution.resize_tty()
       │    ├─ Text {"type":"signal"}  → Refuse: error frame; else execution.signal()
       │    └─ Text {"type":"stdin_eof"}  → Refuse: error frame; else stdin.close() + drop
       │       (Refuse answers each kind once; the reader keeps draining so the
       │        writer can flush its close, and past that close until the peer
       │        answers it.)
       │
       ├─ tokio::spawn(writer)                 — server → client
       │    ├─ if already done → drain backlog only (fast path)
       │    ├─ select! loop:
       │    │    stdout_rx.recv() → Binary [0x01 | data]
       │    │    stderr_rx.recv() → Binary [0x02 | data]
       │    │    ctrl_rx.recv()   → Text (error frames), or Text + Close 1008
       │    │    ping_interval    → Ping (every 15 s)
       │    │    done_rx.changed()→ drain remaining, break
       │    └─ if done: Text {"type":"exit","exit_code":N} + Close
       │
       └─ select!(reader, writer)
            ├─ reader first → abort writer
            ├─ writer first, Close sent → wait up to ATTACH_PEER_CLOSE_WAIT
            │                 (5 s) for the reader to see the peer's, and abort
            │                 it only if that elapses. Cutting the reader off
            │                 here leaves the client's in-flight stdin unread,
            │                 and closing a socket with unread data sends RST —
            │                 which discards the exit frame.
            ├─ writer first, no Close (a send failed) → abort at once; there is
            │                 no handshake open to wait for.
            └─ mark_disconnected()
```

### Attach Wire Format

```
Client                       WebSocket                        Server
  │                                                              │
  │── Binary(raw bytes) ───────────────────────────────────────▶│ stdin
  │── Text({"type":"resize","rows":N,"cols":N}) ──────────────▶│ resize_tty
  │── Text({"type":"signal","sig":N}) ─────────────────────────▶│ signal
  │── Text({"type":"stdin_eof"}) ──────────────────────────────▶│ close stdin
  │                                                              │
  │◀────── Binary([0x01 | stdout data]) ─────────────────────────│ stdout
  │◀────── Binary([0x02 | stderr data]) ─────────────────────────│ stderr
  │◀────── Text({"type":"exit","exit_code":N}) ──────────────────│ completion
  │◀────── Text({"type":"error","message":"..."}) ───────────────│ error
  │◀────── Ping ─────────────────────────────────────────────────│ keepalive
  │                                                              │
```

Only one WebSocket client may be attached to an execution at a time. `mark_connected()` returns
`false` (HTTP 409) if another client is already attached or the reaper has claimed a kill. On
reconnect, escalation flags reset — a fresh disconnect starts a fresh reap clock.

## Orphan Reaper

A background task (`tokio::spawn`) that ticks every 30 s, cleaning up executions whose attach
client disconnected and never came back.

### Escalation Timeline

```
Client disconnects
──────┬────────────────────────────────────────────────────────────
      │
      ├── 5 min (BOXLITE_RECONNECT_GRACE) ───────▶ SIGHUP
      │                                              │
      ├── + 30 s (BOXLITE_SHUTDOWN_GRACE) ─────────▶ SIGTERM
      │                                              │
      ├── + 30 s (BOXLITE_SHUTDOWN_GRACE) ─────────▶ SIGKILL + evict
      │
──────┴────────────────────────────────────────────────────────────

Hard cap:  24 h (BOXLITE_MAX_SESSION_LIFETIME) → immediate SIGKILL
Completed: 5 min after exit → evict from map
```

### Reaper Call Graph

```
reaper_loop(state)
  │
  ├─ resolve_duration("BOXLITE_RECONNECT_GRACE", 300 s)
  ├─ resolve_duration("BOXLITE_SHUTDOWN_GRACE",   30 s)
  ├─ resolve_duration("BOXLITE_MAX_SESSION_LIFETIME", 86400 s)
  │
  └─ loop { ticker.tick(); run_reap_once(...); run_lifecycle_once(...) }

run_reap_once(state, now, ...)
  │
  ├─ snapshot candidates from executions map  (read lock, then drop)
  │
  └─ for each (id, active):
       │
       ├─ is_done() + !should_retain(now)  → evict from map
       │
       ├─ lifetime > max_lifetime          → mark_reaping_kill + try_kill_and_evict
       │
       ├─ already reaping_kill             → try_kill_and_evict  (retry from prior tick)
       │
       ├─ try_escalate_hup()               — SIGHUP if reconnect_grace expired
       │    ├─ signal OK  → finish_escalation()
       │    └─ signal fail → escalation_failed_mark_doomed + try_kill_and_evict
       │
       ├─ try_escalate_term()              — SIGTERM if shutdown_grace expired after HUP
       │    ├─ signal OK  → finish_escalation()
       │    └─ signal fail → escalation_failed_mark_doomed + try_kill_and_evict
       │
       └─ try_escalate_kill()              — SIGKILL if shutdown_grace expired after TERM
            └─ try_kill_and_evict

try_kill_and_evict(state, id, active)
  ├─ timeout(10 s, execution.kill())
  ├─ success → executions.write().remove(id)
  └─ failure → leave in map (reaping_kill=true), retry next tick
```

### AttachState Machine

```
                mark_connected()                  mark_disconnected()
┌──────────┐ ──────────────────▶ ┌────────────┐ ──────────────────────┐
│   Idle   │                     │  Connected  │                       │
│  (disc.) │ ◀──────────────────────────────────────────────────────────┘
└──────────┘
     │
     │ reconnect_grace expired
     ▼
┌──────────┐  shutdown_grace    ┌────────────┐  shutdown_grace
│  HUP'd   │ ────────────────▶ │   TERM'd   │ ────────────────┐
└──────────┘                    └────────────┘                  │
                                                                ▼
                                                         ┌────────────┐
                                                         │   KILL'd   │
                                                         │  (doomed)  │
                                                         └────────────┘
```

TOCTOU safety: the `escalating` flag blocks `mark_connected()` during signal delivery so a late
attach cannot race the kill. `escalation_failed_mark_doomed()` atomically clears `escalating` and
sets `reaping_kill` under one lock acquisition.

## Configuration Reference

### Environment Variables

| Variable                        | Default  | Format    | Description                                         |
|---------------------------------|----------|-----------|-----------------------------------------------------|
| `BOXLITE_RECONNECT_GRACE`      | `300s`   | `Ns/Nm/Nh`| Grace period before SIGHUP after disconnect          |
| `BOXLITE_SHUTDOWN_GRACE`       | `30s`    | `Ns/Nm/Nh`| Grace between SIGHUP→SIGTERM and SIGTERM→SIGKILL    |
| `BOXLITE_MAX_SESSION_LIFETIME` | `86400s` | `Ns/Nm/Nh`| Hard cap: SIGKILL after this lifetime                |

### CLI Flags

| Flag     | Default   | Description              |
|----------|-----------|--------------------------|
| `--port` | `8100`    | TCP port to listen on    |
| `--host` | `127.0.0.1` | Address to bind; non-loopback requires `--api-key` |

### Internal Constants

| Constant                    | Value   | Description                                |
|-----------------------------|---------|--------------------------------------------|
| `REAPER_TICK`               | 30 s    | Reaper check interval                      |
| `REAPER_SIGNAL_TIMEOUT`     | 10 s    | Timeout for signal / kill delivery         |
| `COMPLETED_RETENTION_GRACE` | 5 min   | How long completed runs stay in map        |
| `ATTACH_BROADCAST_CAPACITY` | 256     | Broadcast channel buffer (chunks)          |
| `BACKLOG_BYTE_CAP`          | 256 KiB | Max backlog retained for late replay       |
| `ATTACH_KEEPALIVE_INTERVAL` | 15 s    | WebSocket ping interval                    |
| `ATTACH_WRITE_TIMEOUT`      | 20 s    | WebSocket write timeout                    |
| `ALLOWED_SIGNALS`           | 1, 2, 3, 6, 10, 12, 15, 28 | Cooperative signal whitelist |

## Error Handling

All handlers use `error_response(StatusCode, message, error_type)` to return a consistent JSON
shape:

```json
{
  "error": {
    "message": "box not found: abc123",
    "type": "NotFoundError",
    "code": 404
  }
}
```

`classify_boxlite_error()` maps `BoxliteError` to HTTP status:

| Error message contains | Status | Type               |
|------------------------|--------|--------------------|
| `"not found"`          | 404    | `NotFoundError`    |
| `"already"` / `"conflict"` | 409 | `ConflictError`   |
| `"unsupported"`        | 400    | `UnsupportedError` |
| anything else          | 500    | `InternalError`    |

## See Also

- [CLI Development Guide](../../../../../docs/contributing/development/cli.md) — building and testing the CLI
- [Architecture](../../../../../docs/contributing/architecture/README.md) — core runtime architecture
- [Rust Style Guide](../../../../../docs/contributing/development/rust-style.md) — coding standards
