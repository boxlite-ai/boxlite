# boxlite serve — REST API Server

`boxlite serve` starts a long-running HTTP server that exposes the full BoxLite runtime over a REST
API. SDK clients connect to it via `Boxlite.rest()` — the server holds a single `BoxliteRuntime` and
translates HTTP requests into runtime calls, WebSocket connections into bidirectional attach
sessions.

## Quick Start

```bash
boxlite serve                      # listen on 0.0.0.0:8100
boxlite serve --port 9090          # custom port
boxlite serve --host 127.0.0.1    # bind localhost only
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
  ├─ GlobalFlags::create_runtime()          — build local BoxliteRuntime
  │
  ├─ Arc::new(AppState { runtime, boxes, executions })
  │                                          — shared state for all handlers
  ├─ tokio::spawn(reaper_loop(state))       — background orphan reaper (30 s tick)
  │
  ├─ build_router(state)                    — register 26 routes on axum::Router
  │
  ├─ TcpListener::bind(host:port)           — bind TCP socket
  │
  └─ axum::serve(listener, app)             — start serving requests
       └─ .with_graceful_shutdown(ctrl_c)
            └─ runtime.shutdown(Some(10))   — stop all boxes on exit
```

## Architecture

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
│  Handlers:  auth · config · boxes · executions         │
│             files · metrics · snapshots · advanced     │
│                                                        │
│  Background:  reaper_loop  (orphan cleanup)            │
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
registry.

## Handler Reference

| Module       | File                     | Purpose                                                       |
|--------------|--------------------------|---------------------------------------------------------------|
| `auth`       | `handlers/auth.rs`       | OAuth2 token endpoint (local passthrough, always succeeds)    |
| `config`     | `handlers/config.rs`     | Capability discovery (snapshots, clone, export, import)       |
| `boxes`      | `handlers/boxes.rs`      | Box CRUD: create, list, get, head, start, stop, remove        |
| `executions` | `handlers/executions.rs` | Lifecycle: start, status, signal, kill, resize, attach        |
| `files`      | `handlers/files.rs`      | Tar-based file upload / download into / from boxes            |
| `metrics`    | `handlers/metrics.rs`    | Runtime-level and per-box metrics                             |
| `snapshots`  | `handlers/snapshots.rs`  | Snapshot CRUD + restore                                       |
| `advanced`   | `handlers/advanced.rs`   | Clone, export, import                                         |

## Route Reference

All paths are relative to the server root (e.g. `http://localhost:8100`).

### Auth & Config

| Method | Path                 | Handler               | Description                        |
|--------|----------------------|-----------------------|------------------------------------|
| POST   | `/v1/oauth/tokens`   | `auth::oauth_token`   | Get bearer token (always succeeds) |
| GET    | `/v1/config`         | `config::get_config`  | Capability discovery               |

### Box CRUD & Lifecycle

| Method | Path                                  | Handler             | Description                    |
|--------|---------------------------------------|----------------------|-------------------------------|
| POST   | `/v1/default/boxes`                   | `boxes::create_box`  | Create a new box              |
| GET    | `/v1/default/boxes`                   | `boxes::list_boxes`  | List all boxes                |
| GET    | `/v1/default/boxes/{box_id}`          | `boxes::get_box`     | Get box info                  |
| HEAD   | `/v1/default/boxes/{box_id}`          | `boxes::head_box`    | Check box exists (204 / 404)  |
| DELETE | `/v1/default/boxes/{box_id}`          | `boxes::remove_box`  | Remove box (`?force=true`)    |
| POST   | `/v1/default/boxes/{box_id}/start`    | `boxes::start_box`   | Start a stopped box           |
| POST   | `/v1/default/boxes/{box_id}/stop`     | `boxes::stop_box`    | Stop a running box            |

### Command Execution

| Method | Path                                                            | Handler                       | Description                 |
|--------|-----------------------------------------------------------------|-------------------------------|-----------------------------|
| POST   | `/v1/default/boxes/{box_id}/exec`                               | `executions::start_execution` | Start a new command         |
| GET    | `/v1/default/boxes/{box_id}/executions/{id}`                    | `executions::get_execution`   | Get status + exit code      |
| DELETE | `/v1/default/boxes/{box_id}/executions/{id}`                    | `executions::kill_execution`  | SIGKILL + evict             |
| GET    | `/v1/default/boxes/{box_id}/executions/{id}/attach`             | `executions::attach_execution`| WebSocket attach (bidi)     |
| POST   | `/v1/default/boxes/{box_id}/executions/{id}/signal`             | `executions::send_signal`     | Send cooperative signal     |
| POST   | `/v1/default/boxes/{box_id}/executions/{id}/resize`             | `executions::resize_tty`      | Resize PTY                  |

### Files

| Method | Path                                 | Handler                | Description                       |
|--------|--------------------------------------|------------------------|-----------------------------------|
| PUT    | `/v1/default/boxes/{box_id}/files`   | `files::upload_files`  | Upload tar, extract into box      |
| GET    | `/v1/default/boxes/{box_id}/files`   | `files::download_files`| Download path as tar              |

### Metrics

| Method | Path                                        | Handler                  | Description               |
|--------|---------------------------------------------|--------------------------|---------------------------|
| GET    | `/v1/default/metrics`                       | `metrics::runtime_metrics`| Runtime-wide counters     |
| GET    | `/v1/default/boxes/{box_id}/metrics`        | `metrics::box_metrics`   | Per-box metrics + boot timing |

### Snapshots

| Method | Path                                                        | Handler                       | Description          |
|--------|-------------------------------------------------------------|-------------------------------|----------------------|
| POST   | `/v1/default/boxes/{box_id}/snapshots`                      | `snapshots::create_snapshot`  | Create snapshot      |
| GET    | `/v1/default/boxes/{box_id}/snapshots`                      | `snapshots::list_snapshots`   | List snapshots       |
| GET    | `/v1/default/boxes/{box_id}/snapshots/{name}`               | `snapshots::get_snapshot`     | Get snapshot info    |
| DELETE | `/v1/default/boxes/{box_id}/snapshots/{name}`               | `snapshots::delete_snapshot`  | Delete snapshot      |
| POST   | `/v1/default/boxes/{box_id}/snapshots/{name}/restore`       | `snapshots::restore_snapshot` | Restore snapshot     |

### Advanced (Clone, Export, Import)

| Method | Path                                        | Handler               | Description                    |
|--------|---------------------------------------------|-----------------------|--------------------------------|
| POST   | `/v1/default/boxes/{box_id}/clone`          | `advanced::clone_box` | Clone a box                    |
| POST   | `/v1/default/boxes/{box_id}/export`         | `advanced::export_box`| Export box as archive          |
| POST   | `/v1/default/boxes/import`                  | `advanced::import_box`| Import box from archive body   |

## Execution Lifecycle

### Start

```
POST /v1/default/boxes/{box_id}/exec
  │
  ├─ get_or_fetch_box(state, box_id)          — resolve LiteBox from cache or runtime
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
GET /v1/default/boxes/{box_id}/executions/{id}/attach
  │
  ├─ mark_connected()                          — claim single-attach slot (409 if taken)
  ├─ WebSocketUpgrade → on_upgrade             — HTTP → WS handshake
  │    └─ on_failed_upgrade: mark_disconnected()
  │
  └─ run_attach_session(socket, active)
       │
       ├─ stdout_bus.subscribe()               — BacklogReceiver (replay + live)
       ├─ stderr_bus.subscribe()
       ├─ done_rx = active.done_rx()
       ├─ socket.split() → (sink, stream)
       │
       ├─ tokio::spawn(reader)                 — client → server
       │    ├─ Binary frames  → stdin.write_all()
       │    ├─ Text {"type":"resize"}  → execution.resize_tty()
       │    ├─ Text {"type":"signal"}  → execution.signal()
       │    └─ Text {"type":"stdin_eof"}  → stdin.close() + drop
       │
       ├─ tokio::spawn(writer)                 — server → client
       │    ├─ if already done → drain backlog only (fast path)
       │    ├─ select! loop:
       │    │    stdout_rx.recv() → Binary [0x01 | data]
       │    │    stderr_rx.recv() → Binary [0x02 | data]
       │    │    ctrl_rx.recv()   → Text (error frames from reader)
       │    │    ping_interval    → Ping (every 15 s)
       │    │    done_rx.changed()→ drain remaining, break
       │    └─ if done: Text {"type":"exit","exit_code":N} + Close
       │
       └─ select!(reader, writer)              — first to finish aborts the other
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
  └─ loop { ticker.tick(); run_reap_once(...) }

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
| `--host` | `0.0.0.0` | Address to bind          |

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

- [CLI Development Guide](../../../../../docs/development/cli.md) — building and testing the CLI
- [Architecture](../../../../../docs/architecture/README.md) — core runtime architecture
- [Rust Style Guide](../../../../../docs/development/rust-style.md) — coding standards
