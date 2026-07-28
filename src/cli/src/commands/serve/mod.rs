//! `boxlite serve` — long-running REST API server.
//!
//! Holds a single BoxliteRuntime and exposes the full REST API
//! over HTTP so that `Boxlite.rest()` clients can connect.

mod handlers;
mod types;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::http::header::AUTHORIZATION;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use clap::Args;
use futures::StreamExt;
use tokio::sync::RwLock;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};

use boxlite::runtime::options::{NetworkConfig, NetworkMode};
use boxlite::{
    BoxCommand, BoxInfo, BoxOptions, BoxliteRuntime, ExecStdin, Execution, LiteBox, NetworkSpec,
    RootfsSpec,
};

use crate::cli::GlobalFlags;
use crate::defaults::{LOCAL_SERVE_HOST, LOCAL_SERVE_PORT};

use self::types::{BoxResponse, CreateBoxRequest, ErrorBody, ErrorDetail, ExecRequest};

// ============================================================================
// CLI Args
// ============================================================================

#[derive(Args, Debug)]
pub struct ServeArgs {
    /// Port to listen on. Defaults to `LOCAL_SERVE_PORT`.
    #[arg(long, default_value_t = LOCAL_SERVE_PORT)]
    pub port: u16,

    /// Host/address to bind to. Defaults to `LOCAL_SERVE_HOST`.
    #[arg(long, default_value_t = LOCAL_SERVE_HOST.to_string())]
    pub host: String,

    /// Optional expected API key. When set, every route except
    /// `GET /v1/config` requires `Authorization: Bearer <this>` (constant-time
    /// match) and returns 401 otherwise. Unset = permissive (accepts any/no
    /// bearer) — the zero-config local-dev default.
    #[arg(long, env = "BOXLITE_SERVE_API_KEY")]
    pub api_key: Option<String>,
}

// ============================================================================
// Shared State
// ============================================================================

struct AppState {
    runtime: BoxliteRuntime,
    /// Cached box handles (box_id -> Arc<LiteBox>).
    boxes: RwLock<HashMap<String, Arc<LiteBox>>>,
    /// Active executions (execution_id -> ActiveExecution). Holds an
    /// `Arc` so attach sessions can drop the map lock before doing
    /// long-running WS pumping while keeping the exec alive.
    executions: RwLock<HashMap<String, Arc<ActiveExecution>>>,
    /// Optional expected API key (`--api-key` / `$BOXLITE_SERVE_API_KEY`).
    /// `None` ⇒ permissive (no auth enforced).
    api_key: Option<String>,
}

/// Which stdio session an [`ActiveExecution`] fronts.
///
/// Both kinds live in the same `executions` registry, keyed by execution
/// id — but only an exec session can be *addressed* by that id: the main
/// session's id is the container id, which the guest assigns and `BoxInfo`
/// does not carry, so a client on `/boxes/{id}/attach` can only name the
/// box. Marking the kind at insert time is what lets `find_main_session`
/// recognize an already-open main session from the box id alone.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(in crate::commands::serve) enum SessionKind {
    /// A tenant exec — `POST /boxes/{box_id}/exec`.
    Exec,
    /// The box's main command session: the container's init (docker
    /// semantics — `run IMAGE COMMAND` runs COMMAND *as* init). The guest
    /// registers it under `execution_id == container_id`.
    Main,
}

/// Response header on the `/boxes/{box_id}/attach` upgrade carrying the
/// main session's execution id (the container id).
///
/// The client cannot know that id up front, but it needs one for every
/// *other* thing an `Execution` does — signal, resize, kill, status probe,
/// reconnect — all of which are addressed by execution id. Handing it back
/// on the 101 makes the main session an ordinary session from that point
/// on: no parallel control path, no second-class `Execution`. The client
/// half of this contract is `RestBox::attach` in
/// `src/boxlite/src/rest/litebox.rs`, which pins the same header name.
pub(in crate::commands::serve) const MAIN_SESSION_ID_HEADER: &str = "x-boxlite-execution-id";

/// Server-side state for one execution. The underlying `Execution`'s
/// stdout/stderr are consumed once at creation and tee'd into broadcast
/// channels so any number of attach sessions (over time) can subscribe.
/// The `Execution` itself is kept in the map so `wait()`, `kill()`,
/// `signal()`, `resize_tty()` and reattach all work.
pub(in crate::commands::serve) struct ActiveExecution {
    box_id: String,
    kind: SessionKind,
    execution: Execution,
    /// Stdin sink owned by the WS `/attach` session.
    stdin: tokio::sync::Mutex<Option<ExecStdin>>,
    /// Backlog-aware broadcast tees. Late subscribers see the backlog
    /// snapshot on subscribe, then live data — matching the Go runner's
    /// streamBus pattern.
    stdout_bus: Arc<BacklogBroadcast>,
    stderr_bus: Arc<BacklogBroadcast>,
    /// Single-attach + reaper state, all under one Mutex.
    attach: tokio::sync::Mutex<AttachState>,
    /// Whether the exec has been seen to complete (Done fired). Set by
    /// the wait task; checked by the reaper to skip already-exited execs.
    done: std::sync::atomic::AtomicBool,
    /// Watch-channel mirror of `done` for async observers. The wait task
    /// flips this to `true` after `Execution::wait()` returns; SSE and WS
    /// handlers `select!` on `done_rx.changed()` so they break out of their
    /// loops the instant the process completes (rather than waiting for the
    /// broadcast channel's receivers to see `Closed`, which they never do
    /// because `ActiveExecution` owns the master Senders for its lifetime).
    /// Pattern: Vector `RepairState` watch::channel<EnumState>
    /// (src/sinks/redis/sink.rs:130-135); ours is binary so bool suffices.
    done_tx: tokio::sync::watch::Sender<bool>,
    /// Final exit code, populated once Done fires. Read by the WS attach
    /// handler to send the `{"type":"exit", "exit_code":N}` text frame.
    exit_code: std::sync::atomic::AtomicI32,
    /// Stamped when the wait task fires. Used by the retention check so
    /// execs that ran longer than `COMPLETED_RETENTION_GRACE` are not
    /// evicted immediately on exit.
    done_at: std::sync::Mutex<Option<Instant>>,
    /// Used by the reaper to enforce the 24 h hard cap.
    created_at: Instant,
}

struct AttachState {
    connected: bool,
    /// Wall-clock instant when the single-attach slot last went idle.
    /// Initialized to the exec's creation time so a client that never
    /// calls `/attach` still escalates through SIGHUP→SIGTERM→SIGKILL
    /// at the reconnect_grace boundary. Cleared on successful
    /// `mark_connected()`, re-stamped on `mark_disconnected()`.
    last_disconnect_at: Option<Instant>,
    signaled_hup: bool,
    signaled_term: bool,
    /// Set by the reaper's final escalation (SIGKILL path). Once true,
    /// `mark_connected()` rejects so a late attach can't race the kill.
    reaping_kill: bool,
    /// True while the reaper is delivering a cooperative signal (HUP/TERM).
    /// `mark_connected()` rejects while set, closing the TOCTOU gap between
    /// `try_escalate_*` releasing the lock and `signal()` reaching the
    /// process. Cleared by `finish_escalation()` after delivery.
    escalating: bool,
}

/// Bounded buffer size for the stdout/stderr broadcast channels.
/// 256 chunks at ~4 KB each = ~1 MB of slack for a transiently slow
/// subscriber before it sees `RecvError::Lagged`.
const ATTACH_BROADCAST_CAPACITY: usize = 256;

/// Byte-capped backlog retained for replay on late (re)attach.
/// Matches the Go runner's `streamBusBacklogCap` (256 KiB).
const BACKLOG_BYTE_CAP: usize = 256 * 1024;

/// Broadcast sender with a bounded byte backlog for replay on subscribe.
///
/// Pattern mirrors Go runner's `streamBus` — `send()` appends to a
/// byte-capped backlog AND fans out via broadcast; `subscribe()` replays
/// the backlog snapshot then switches to live broadcast.
struct BacklogBroadcast {
    tx: tokio::sync::broadcast::Sender<Vec<u8>>,
    state: std::sync::Mutex<BacklogState>,
    cap: usize,
}

struct BacklogState {
    backlog: std::collections::VecDeque<Vec<u8>>,
    total_bytes: usize,
}

impl BacklogBroadcast {
    fn new(capacity: usize, backlog_cap: usize) -> Self {
        let (tx, _) = tokio::sync::broadcast::channel(capacity);
        Self {
            tx,
            state: std::sync::Mutex::new(BacklogState {
                backlog: std::collections::VecDeque::new(),
                total_bytes: 0,
            }),
            cap: backlog_cap,
        }
    }

    fn send(&self, data: Vec<u8>) {
        let mut state = self.state.lock().unwrap();
        state.total_bytes += data.len();
        state.backlog.push_back(data.clone());
        // Always retain at least the most recent chunk so a late subscriber
        // sees something, even if a single chunk exceeds the byte cap.
        while state.total_bytes > self.cap && state.backlog.len() > 1 {
            if let Some(old) = state.backlog.pop_front() {
                state.total_bytes -= old.len();
            } else {
                break;
            }
        }
        // Broadcast under the same lock so subscribe() can't snapshot
        // the backlog AND receive the same chunk from the live channel.
        let _ = self.tx.send(data);
    }

    /// Subscribe with atomic backlog replay. The returned receiver
    /// yields the backlog snapshot first, then live broadcasts — no
    /// gap, no interleaving. Both the backlog snapshot and the
    /// broadcast subscribe happen under the state lock, which `send()`
    /// also holds through its `tx.send()`, preventing duplicates.
    fn subscribe(&self) -> BacklogReceiver {
        let state = self.state.lock().unwrap();
        let replay: std::collections::VecDeque<Vec<u8>> = state.backlog.iter().cloned().collect();
        let rx = self.tx.subscribe();
        BacklogReceiver { replay, rx }
    }
}

/// Receiver that yields backlog chunks first, then live broadcast.
/// Created by `BacklogBroadcast::subscribe()`.
struct BacklogReceiver {
    replay: std::collections::VecDeque<Vec<u8>>,
    rx: tokio::sync::broadcast::Receiver<Vec<u8>>,
}

impl BacklogReceiver {
    async fn recv(&mut self) -> Result<Vec<u8>, tokio::sync::broadcast::error::RecvError> {
        if let Some(chunk) = self.replay.pop_front() {
            return Ok(chunk);
        }
        self.rx.recv().await
    }

    fn try_recv(&mut self) -> Result<Vec<u8>, tokio::sync::broadcast::error::TryRecvError> {
        if let Some(chunk) = self.replay.pop_front() {
            return Ok(chunk);
        }
        self.rx.try_recv()
    }
}

impl ActiveExecution {
    fn new(
        box_id: String,
        kind: SessionKind,
        mut execution: Execution,
        stdin: Option<ExecStdin>,
    ) -> Arc<Self> {
        let stdout = execution.stdout();
        let stderr = execution.stderr();

        let stdout_bus = Arc::new(BacklogBroadcast::new(
            ATTACH_BROADCAST_CAPACITY,
            BACKLOG_BYTE_CAP,
        ));
        let stderr_bus = Arc::new(BacklogBroadcast::new(
            ATTACH_BROADCAST_CAPACITY,
            BACKLOG_BYTE_CAP,
        ));
        let (done_tx, _) = tokio::sync::watch::channel(false);

        let now = Instant::now();
        let active = Arc::new(Self {
            box_id,
            kind,
            execution,
            stdin: tokio::sync::Mutex::new(stdin),
            stdout_bus: stdout_bus.clone(),
            stderr_bus: stderr_bus.clone(),
            attach: tokio::sync::Mutex::new(AttachState {
                connected: false,
                last_disconnect_at: Some(now),
                signaled_hup: false,
                signaled_term: false,
                reaping_kill: false,
                escalating: false,
            }),
            done: std::sync::atomic::AtomicBool::new(false),
            done_tx,
            exit_code: std::sync::atomic::AtomicI32::new(-1),
            done_at: std::sync::Mutex::new(None),
            created_at: now,
        });

        // Spawn pumps that read the (single-consumer) Stream half and
        // fan out via the backlog-aware broadcast. Unlike raw broadcast,
        // BacklogBroadcast retains recent output so late subscribers
        // see the backlog on subscribe.
        let stdout_handle = if let Some(mut out) = stdout {
            let bus = stdout_bus;
            Some(tokio::spawn(async move {
                while let Some(line) = out.next().await {
                    bus.send(line.into_bytes());
                }
            }))
        } else {
            None
        };
        let stderr_handle = if let Some(mut err) = stderr {
            let bus = stderr_bus;
            Some(tokio::spawn(async move {
                while let Some(line) = err.next().await {
                    bus.send(line.into_bytes());
                }
            }))
        } else {
            None
        };

        // Wait task: records exit code + flips done. Barriers the pump
        // tasks so all output is broadcast before done_tx fires.
        {
            let active = Arc::clone(&active);
            tokio::spawn(async move {
                if let Ok(result) = active.execution.wait().await {
                    active
                        .exit_code
                        .store(result.exit_code, std::sync::atomic::Ordering::SeqCst);
                }
                if let Some(h) = stdout_handle {
                    let _ = h.await;
                }
                if let Some(h) = stderr_handle {
                    let _ = h.await;
                }
                *active.done_at.lock().unwrap() = Some(Instant::now());
                active.done.store(true, std::sync::atomic::Ordering::SeqCst);
                let _ = active.done_tx.send(true);
            });
        }

        active
    }

    pub(in crate::commands::serve) fn box_id(&self) -> &str {
        &self.box_id
    }

    pub(in crate::commands::serve) fn kind(&self) -> SessionKind {
        self.kind
    }

    pub(in crate::commands::serve) fn stdout_bus(&self) -> &BacklogBroadcast {
        &self.stdout_bus
    }

    pub(in crate::commands::serve) fn stderr_bus(&self) -> &BacklogBroadcast {
        &self.stderr_bus
    }

    pub(in crate::commands::serve) fn stdin(&self) -> &tokio::sync::Mutex<Option<ExecStdin>> {
        &self.stdin
    }

    pub(in crate::commands::serve) fn execution(&self) -> &Execution {
        &self.execution
    }

    pub(in crate::commands::serve) fn is_done(&self) -> bool {
        self.done.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Subscribe to the "process is done" watch channel. Callers select
    /// on `rx.changed()` to wake the instant the wait task fires.
    pub(in crate::commands::serve) fn done_rx(&self) -> tokio::sync::watch::Receiver<bool> {
        self.done_tx.subscribe()
    }

    pub(in crate::commands::serve) fn exit_code(&self) -> i32 {
        self.exit_code.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub(in crate::commands::serve) fn created_at(&self) -> Instant {
        self.created_at
    }

    /// Whether a completed execution should still be retained in the map.
    /// Used by the reaper and tests.
    pub(in crate::commands::serve) fn should_retain(&self, now: Instant) -> bool {
        if !self.is_done() {
            return true;
        }
        let done_at = self.done_at.lock().unwrap();
        match *done_at {
            Some(at) => now.duration_since(at) <= COMPLETED_RETENTION_GRACE,
            None => true,
        }
    }

    /// Attempt to claim the single-attach slot. Returns true on success;
    /// false if another client is already attached OR the reaper has
    /// claimed a terminal kill. Resets escalation flags on success so a
    /// fresh disconnect starts a fresh reap clock.
    pub(in crate::commands::serve) async fn mark_connected(&self) -> bool {
        let mut s = self.attach.lock().await;
        if s.connected || s.reaping_kill || s.escalating {
            return false;
        }
        s.connected = true;
        s.last_disconnect_at = None;
        s.signaled_hup = false;
        s.signaled_term = false;
        true
    }

    pub(in crate::commands::serve) async fn mark_disconnected(&self) {
        let mut s = self.attach.lock().await;
        s.connected = false;
        s.last_disconnect_at = Some(Instant::now());
    }

    /// Set the terminal reaping flag so mark_connected() rejects.
    /// Used by the hard-cap kill path which bypasses the escalation
    /// state machine.
    pub(in crate::commands::serve) async fn mark_reaping_kill(&self) {
        let mut s = self.attach.lock().await;
        s.reaping_kill = true;
    }

    async fn is_reaping_kill(&self) -> bool {
        let s = self.attach.lock().await;
        s.reaping_kill
    }

    /// Reaper: atomically try to escalate to SIGHUP. Sets `escalating`
    /// to block concurrent `mark_connected()` during signal delivery.
    /// Returns `true` if the transition was taken; `false` if skipped.
    async fn try_escalate_hup(&self, now: Instant, reconnect_grace: std::time::Duration) -> bool {
        let mut s = self.attach.lock().await;
        if s.connected || s.signaled_hup || s.reaping_kill || s.escalating {
            return false;
        }
        let Some(disc) = s.last_disconnect_at else {
            return false;
        };
        if now.duration_since(disc) <= reconnect_grace {
            return false;
        }
        s.signaled_hup = true;
        s.escalating = true;
        s.last_disconnect_at = Some(now);
        true
    }

    /// Reaper: atomically try to escalate to SIGTERM.
    async fn try_escalate_term(&self, now: Instant, shutdown_grace: std::time::Duration) -> bool {
        let mut s = self.attach.lock().await;
        if s.connected || !s.signaled_hup || s.signaled_term || s.reaping_kill || s.escalating {
            return false;
        }
        let Some(disc) = s.last_disconnect_at else {
            return false;
        };
        if now.duration_since(disc) <= shutdown_grace {
            return false;
        }
        s.signaled_term = true;
        s.escalating = true;
        s.last_disconnect_at = Some(now);
        true
    }

    /// Reaper: atomically try to escalate to SIGKILL. Once this returns
    /// `true`, `mark_connected()` will reject — the exec is doomed.
    async fn try_escalate_kill(&self, now: Instant, shutdown_grace: std::time::Duration) -> bool {
        let mut s = self.attach.lock().await;
        if s.connected || !s.signaled_term || s.reaping_kill {
            return false;
        }
        let Some(disc) = s.last_disconnect_at else {
            return false;
        };
        if now.duration_since(disc) <= shutdown_grace {
            return false;
        }
        s.reaping_kill = true;
        true
    }

    /// Clear the `escalating` flag after successful signal delivery.
    async fn finish_escalation(&self) {
        let mut s = self.attach.lock().await;
        s.escalating = false;
    }

    /// Atomically mark the exec as doomed AND clear escalating. Used when
    /// signal delivery fails during escalation — ensures no gap between
    /// clearing escalating and setting reaping_kill where mark_connected
    /// could slip through.
    async fn escalation_failed_mark_doomed(&self) {
        let mut s = self.attach.lock().await;
        s.escalating = false;
        s.reaping_kill = true;
    }
}

// ============================================================================
// Phase 5.7 — Orphan reaper
// ============================================================================

const REAPER_TICK: std::time::Duration = std::time::Duration::from_secs(30);
const REAPER_SIGNAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const DEFAULT_RECONNECT_GRACE: std::time::Duration = std::time::Duration::from_secs(300);
const DEFAULT_SHUTDOWN_GRACE: std::time::Duration = std::time::Duration::from_secs(30);
const DEFAULT_MAX_SESSION_LIFETIME: std::time::Duration = std::time::Duration::from_secs(24 * 3600);
const COMPLETED_RETENTION_GRACE: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// Minimal duration parser: accepts `<n>s`, `<n>m`, `<n>h`, or a bare
/// integer interpreted as seconds. Mirrors Go's `time.ParseDuration` for
/// the cases we actually use. Returns `fallback` on any error or unset
/// env var, logging a warning so operators don't silently inherit the
/// default.
fn resolve_duration(var: &str, fallback: std::time::Duration) -> std::time::Duration {
    let raw = match std::env::var(var) {
        Ok(s) if !s.is_empty() => s,
        _ => return fallback,
    };
    let parsed = if let Some(rest) = raw.strip_suffix('h') {
        rest.parse::<u64>()
            .ok()
            .map(|n| std::time::Duration::from_secs(n * 3600))
    } else if let Some(rest) = raw.strip_suffix('m') {
        rest.parse::<u64>()
            .ok()
            .map(|n| std::time::Duration::from_secs(n * 60))
    } else if let Some(rest) = raw.strip_suffix('s') {
        rest.parse::<u64>().ok().map(std::time::Duration::from_secs)
    } else {
        raw.parse::<u64>().ok().map(std::time::Duration::from_secs)
    };
    match parsed {
        Some(d) => d,
        None => {
            tracing::warn!(env = var, value = %raw,
                "invalid duration env var (use Ns/Nm/Nh), using default");
            fallback
        }
    }
}

async fn reaper_loop(state: Arc<AppState>) {
    let reconnect_grace = resolve_duration("BOXLITE_RECONNECT_GRACE", DEFAULT_RECONNECT_GRACE);
    let shutdown_grace = resolve_duration("BOXLITE_SHUTDOWN_GRACE", DEFAULT_SHUTDOWN_GRACE);
    let max_lifetime =
        resolve_duration("BOXLITE_MAX_SESSION_LIFETIME", DEFAULT_MAX_SESSION_LIFETIME);

    let mut ticker = tokio::time::interval(REAPER_TICK);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        run_reap_once(
            &state,
            Instant::now(),
            reconnect_grace,
            shutdown_grace,
            max_lifetime,
        )
        .await;
    }
}

async fn run_reap_once(
    state: &AppState,
    now: Instant,
    reconnect_grace: std::time::Duration,
    shutdown_grace: std::time::Duration,
    max_lifetime: std::time::Duration,
) {
    let candidates: Vec<(String, Arc<ActiveExecution>)> = {
        let map = state.executions.read().await;
        map.iter()
            .map(|(k, v)| (k.clone(), Arc::clone(v)))
            .collect()
    };

    for (id, active) in candidates {
        // Done check first — a completed exec is always handled by the
        // retention path, even if it exceeds the lifetime cap. This
        // avoids starving done-eviction when try_kill_and_evict keeps
        // failing for an already-exited process.
        if active.is_done() {
            if !active.should_retain(now) {
                // Compare-and-remove, for the same reason as `try_kill_and_evict`:
                // a restarted box re-registers its main session under the same
                // container id, and this snapshot may already be stale.
                evict_if_same(state, &id, &active).await;
            }
            continue;
        }

        // A main session is never an orphan and never stale: it is the box's
        // init, so killing it powers the VM off and destroys the box. A client
        // walking away from `docker attach` does not stop the container, and
        // neither may this; nor may the lifetime cap, which exists to bound
        // *exec* sessions, not the workload they run beside.
        //
        // Every branch below signals or kills, so Main stops here. The
        // done-eviction above still applies to it — a main session whose init
        // has exited really is finished, and evicting a dead entry kills
        // nothing.
        if active.kind() == SessionKind::Main {
            continue;
        }

        if now.duration_since(active.created_at()) > max_lifetime {
            active.mark_reaping_kill().await;
            tracing::warn!(exec_id = %id, "session lifetime cap reached, killing");
            try_kill_and_evict(state, &id, &active).await;
            continue;
        }
        // Retry kill for entries already marked doomed by a prior tick
        // or a failed DELETE handler.
        if active.is_reaping_kill().await {
            try_kill_and_evict(state, &id, &active).await;
            continue;
        }
        if active.try_escalate_hup(now, reconnect_grace).await {
            let sig_result =
                tokio::time::timeout(REAPER_SIGNAL_TIMEOUT, active.execution().signal(1)).await;
            if matches!(sig_result, Ok(Ok(()))) {
                active.finish_escalation().await;
            } else {
                tracing::warn!(exec_id = %id, "SIGHUP delivery failed or timed out, killing");
                active.escalation_failed_mark_doomed().await;
                try_kill_and_evict(state, &id, &active).await;
            }
        } else if active.try_escalate_term(now, shutdown_grace).await {
            let sig_result =
                tokio::time::timeout(REAPER_SIGNAL_TIMEOUT, active.execution().signal(15)).await;
            if matches!(sig_result, Ok(Ok(()))) {
                active.finish_escalation().await;
            } else {
                tracing::warn!(exec_id = %id, "SIGTERM delivery failed or timed out, killing");
                active.escalation_failed_mark_doomed().await;
                try_kill_and_evict(state, &id, &active).await;
            }
        } else if active.try_escalate_kill(now, shutdown_grace).await {
            tracing::warn!(exec_id = %id, "orphan exec did not exit after SIGTERM, killing");
            try_kill_and_evict(state, &id, &active).await;
        }
    }
}

/// Kill and remove from the map. Only evicts on kill success; on failure
/// the entry stays with `reaping_kill=true` so the next reaper tick retries.
async fn try_kill_and_evict(state: &AppState, id: &str, active: &Arc<ActiveExecution>) {
    let result = tokio::time::timeout(REAPER_SIGNAL_TIMEOUT, active.execution().kill()).await;
    match result {
        Ok(Ok(())) => {
            evict_if_same(state, id, active).await;
        }
        Ok(Err(e)) => {
            tracing::warn!(exec_id = %id, err = %e, "kill failed, will retry next tick");
        }
        Err(_) => {
            tracing::warn!(exec_id = %id, "kill timed out, will retry next tick");
        }
    }
}

/// Remove `id` only if it still maps to the session we decided to reap.
///
/// The reaper works from a snapshot taken under an earlier read lock and awaits
/// in between (a kill can block for `REAPER_SIGNAL_TIMEOUT`), so by the time it
/// evicts, the key may have been rebound. That is not hypothetical for the main
/// session: its id *is* the container id, which is fixed at box creation, so a
/// box that restarts re-registers a brand-new session under the very same key.
/// A bare `remove(id)` would then delete the live session out from under its
/// client — and the client could not recover, because the guest refuses a second
/// `Attach` on a session that already has one.
async fn evict_if_same(state: &AppState, id: &str, doomed: &Arc<ActiveExecution>) {
    let mut map = state.executions.write().await;
    if let Some(current) = map.get(id)
        && Arc::ptr_eq(current, doomed)
    {
        map.remove(id);
    }
}

// ============================================================================
// Conversions
// ============================================================================

fn box_info_to_response(info: &BoxInfo) -> BoxResponse {
    BoxResponse {
        box_id: info.id.to_string(),
        name: info.name.clone(),
        status: info.status.as_str().to_string(),
        created_at: info.created_at.to_rfc3339(),
        updated_at: info.last_updated.to_rfc3339(),
        pid: info.pid,
        image: info.image.clone(),
        cpus: info.cpus,
        memory_mib: info.memory_mib,
        labels: info.labels.clone(),
        auto_pause: info.auto_pause,
        auto_delete: info.auto_delete,
        auto_resume: info.auto_resume,
        exit_code: info.exit_code,
    }
}

fn volume_info_to_response(info: &boxlite::runtime::types::VolumeInfo) -> types::VolumeResponse {
    types::VolumeResponse {
        id: info.id.clone(),
        created_at: info.created_at.to_rfc3339(),
        size_bytes: info.size_bytes,
    }
}

fn build_box_options(req: &CreateBoxRequest) -> Result<BoxOptions, boxlite::BoxliteError> {
    let rootfs = if let Some(ref path) = req.rootfs_path {
        RootfsSpec::RootfsPath(path.clone())
    } else {
        RootfsSpec::Image(req.image.clone().unwrap_or_else(|| "alpine:latest".into()))
    };

    let env: Vec<(String, String)> = req
        .env
        .as_ref()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();

    let network = match &req.network {
        Some(network) => NetworkSpec::try_from(NetworkConfig {
            mode: network.mode.parse::<NetworkMode>()?,
            allow_net: network.allow_net.clone(),
        })?,
        None => NetworkSpec::default(),
    };

    // SecurityOptions is deliberately NOT client-configurable over
    // REST: sandbox security is the operator's policy. The server
    // always uses `AdvancedBoxOptions::default()` for new boxes, so
    // the default-flip (jailer + seccomp on for Linux/macOS) applies
    // uniformly. Operators who want a different policy run the
    // server with a different default; clients cannot relax it.

    let auto_delete = req.auto_delete.unwrap_or(0);
    Ok(BoxOptions {
        rootfs,
        cpus: req.cpus,
        memory_mib: req.memory_mib,
        disk_size_gb: req.disk_size_gb,
        working_dir: req.working_dir.clone(),
        env,
        network,
        entrypoint: req.entrypoint.clone(),
        cmd: req.cmd.clone(),
        user: req.user.clone(),
        tty: req.tty.unwrap_or(false),
        auto_pause: req.auto_pause,
        auto_delete: Some(auto_delete),
        auto_resume: req.auto_resume,
        // Preserve the serve API's historical detached default for persistent
        // boxes, but do not synthesize an invalid detached remove-on-stop box.
        detach: req.detach.unwrap_or(auto_delete == 0),
        ..Default::default()
    })
}

fn build_box_command(req: &ExecRequest) -> Result<BoxCommand, boxlite::BoxliteError> {
    let mut cmd = BoxCommand::new(&req.command).args(req.args.iter().map(String::as_str));

    if let Some(ref env_map) = req.env {
        for (k, v) in env_map {
            cmd = cmd.env(k, v);
        }
    }
    if let Some(ref wd) = req.working_dir {
        cmd = cmd.working_dir(wd);
    }
    if req.tty {
        cmd = cmd.tty(true);
    }
    if let Some(secs) = req.timeout_seconds {
        cmd = cmd.timeout_seconds(secs)?;
    }
    Ok(cmd)
}

// ============================================================================
// Error Helpers
// ============================================================================

/// Build a JSON error response with the canonical wire envelope.
///
/// `error_type` and `code` are caller-supplied because some sites
/// (auth middleware, handler timeout, schema-validation rejection) emit
/// errors that don't correspond to a `BoxliteError` variant. For
/// `BoxliteError` paths use [`error_from_boxlite`] instead — it dispatches
/// to the single source of truth in `BoxliteError::http()`.
fn error_response(
    status: StatusCode,
    message: impl Into<String>,
    error_type: &str,
    code: &str,
) -> Response {
    let body = ErrorBody {
        error: ErrorDetail {
            message: message.into(),
            error_type: error_type.to_string(),
            code: code.to_string(),
            request_id: None,
        },
    };
    (status, Json(body)).into_response()
}

/// Map a `BoxliteError` to its canonical HTTP response. Delegates the
/// (status, type, code) decision to `BoxliteError::http()` so the mapping
/// is exhaustive at compile time — adding a new variant becomes a build
/// error in `errors.rs`, never a silent 500.
fn error_from_boxlite(err: &boxlite::BoxliteError) -> Response {
    let (code, etype, ecode) = err.http();
    let status = StatusCode::from_u16(code)
        .expect("BoxliteError::http() must return a valid HTTP status code");
    error_response(status, err.to_string(), etype, ecode)
}

/// Panic handler for [`CatchPanicLayer`]. Turns a handler panic into a
/// `500 InternalError internal` response with our wire envelope —
/// otherwise axum's default returns an empty `500 Internal Server Error`
/// with no body, breaking the client's `map_http_status` 500-vs-Network
/// distinction.
fn handle_panic(err: Box<dyn std::any::Any + Send + 'static>) -> Response {
    let detail = err
        .downcast_ref::<&'static str>()
        .map(|s| s.to_string())
        .or_else(|| err.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panic in handler".to_string());
    tracing::error!(panic = %detail, "handler panicked");
    error_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("internal error: {}", detail),
        "InternalError",
        "internal",
    )
}

/// Pure auth decision (unit-tested). `true` = allow. `expected == None` ⇒
/// permissive (no key configured). `GET /v1/config` is always public
/// (pre-auth capability discovery). Otherwise the presented bearer must
/// match `expected` (constant-time).
fn auth_allows(expected: Option<&str>, path: &str, bearer: Option<&str>) -> bool {
    let Some(expected) = expected else {
        return true;
    };
    if path == "/v1/config" {
        return true;
    }
    match bearer {
        Some(tok) => constant_time_eq(tok.as_bytes(), expected.as_bytes()),
        None => false,
    }
}

/// Auth middleware: thin axum adapter over [`auth_allows`]. 401 in the
/// standard error shape when denied.
async fn require_api_key(State(state): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let bearer = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "))
        });
    if auth_allows(state.api_key.as_deref(), req.uri().path(), bearer) {
        next.run(req).await
    } else {
        error_response(
            StatusCode::UNAUTHORIZED,
            "invalid or missing API key",
            "AuthError",
            "unauthenticated",
        )
    }
}

/// Length-checked constant-time byte compare — avoids a timing oracle on the
/// configured token without pulling in a crate.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ============================================================================
// Box Handle Cache Helper
// ============================================================================

async fn get_or_fetch_box(state: &AppState, box_id: &str) -> Result<Arc<LiteBox>, Response> {
    // Check cache first.
    //
    // A cached handle is only good while its box is up. A box can now stop
    // *itself* — its main command exits and the guest powers the VM off — and
    // such a handle is spent: it holds the dead VM and can never boot another.
    // The runtime's own cache is invalidated by the exit watcher, but this one is
    // ours, and nothing was clearing it. Serving from it would answer every later
    // `/exec`, `/files` and `/attach` on that box with a corpse, forever.
    //
    // So a non-Running box gets a fresh handle, which *can* boot it. That is the
    // auto-restart the cloud depends on: its reaper stops idle boxes and the next
    // SDK call is expected to bring them back.
    if let Some(cached) = state.boxes.read().await.get(box_id)
        && cached.info().status.is_active()
    {
        return Ok(Arc::clone(cached));
    }
    state.boxes.write().await.remove(box_id);

    // Fetch from runtime
    match state.runtime.get(box_id).await {
        Ok(Some(b)) => {
            let id = b.info().id.to_string();
            let arc = Arc::new(b);
            state.boxes.write().await.insert(id, Arc::clone(&arc));
            Ok(arc)
        }
        Ok(None) => Err(error_response(
            StatusCode::NOT_FOUND,
            format!("box not found: {box_id}"),
            "NotFoundError",
            "not_found",
        )),
        Err(e) => Err(error_from_boxlite(&e)),
    }
}

// ============================================================================
// Main Session (container init)
// ============================================================================

/// Find a box's already-open main session in the registry.
///
/// Linear, because the registry is keyed by execution id and the main
/// session's id (the container id) is exactly what the caller doesn't
/// know — see [`SessionKind`]. The registry holds one entry per live
/// session on this server, so the scan is bounded by that, and it only
/// runs on attach.
fn find_main_session(
    executions: &HashMap<String, Arc<ActiveExecution>>,
    box_id: &str,
) -> Option<Arc<ActiveExecution>> {
    executions
        .values()
        // `is_done()` matters here in a way it never did for execs. A main
        // session's id is the container id, which is fixed at box creation and
        // is therefore the *same across reboots* — so a finished session from
        // the previous run would still match this box, and an attach after a
        // restart would be handed the old VM's dead stream, its stale backlog
        // and its stale exit code. An exec cannot collide that way: it gets a
        // fresh id every time.
        .find(|active| {
            active.box_id() == box_id && active.kind() == SessionKind::Main && !active.is_done()
        })
        .cloned()
}

/// Return the box's main session, calling `open` to create it only if the
/// box does not have one yet.
///
/// `open` runs at most once per box while the session is registered: the
/// guest binds init's stdout/stderr to the *first* `Attach` RPC and
/// answers later ones with `already_exists` (guest `ExecState::attach`),
/// so a second `LiteBox::attach()` would hand back a permanently silent
/// `Execution` — and, whichever one won the registry, leave a client
/// attached to a dead stream. The caller therefore holds the registry
/// write lock across this whole function, which is what makes the
/// check-then-open atomic against a concurrent first attach.
async fn register_main_session<F, Fut>(
    executions: &mut HashMap<String, Arc<ActiveExecution>>,
    box_id: &str,
    open: F,
) -> Result<Arc<ActiveExecution>, boxlite::BoxliteError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Execution, boxlite::BoxliteError>>,
{
    if let Some(active) = find_main_session(executions, box_id) {
        return Ok(active);
    }

    let mut execution = open().await?;
    let stdin = execution.stdin();
    let exec_id = execution.id().clone();
    let active = ActiveExecution::new(box_id.to_string(), SessionKind::Main, execution, stdin);
    executions.insert(exec_id, Arc::clone(&active));
    Ok(active)
}

/// Get the box's main session for `GET /boxes/{box_id}/attach`, opening it
/// on the first attach.
///
/// A cold box is now booted *inside* the registry write lock, which the earlier
/// design deliberately avoided. It has to be: the client must be attached before
/// the main command runs (create → attach → start), so the attach is no longer
/// separable from the boot, and the check-then-open has to stay atomic — the
/// guest refuses a second Attach on one session, so a racing client would end up
/// holding a permanently silent `Execution`. The cost is stated plainly at the
/// call site and it is not small: a cold boot pulls the image, which is
/// unbounded, and everything else queues behind it.
///
/// It deliberately does NOT call `start()` first. `start()` on a *Stopped* box
/// runs the restart pipeline, and the box's init is the user's main command —
/// so attaching to a finished job would silently run the job again. `attach()`
/// already does the right thing for every status by itself: it boots a
/// `Configured` box (which has never run) and refuses a `Stopped` one.
async fn get_or_attach_main_session(
    state: &AppState,
    box_id: &str,
) -> Result<Arc<ActiveExecution>, Response> {
    if let Some(active) = find_main_session(&*state.executions.read().await, box_id) {
        return Ok(active);
    }

    let litebox = get_or_fetch_box(state, box_id).await?;

    // Attaching boots the box (creating its container) and subscribes to the main
    // command's session, but does *not* run init — `POST /start` does. So a client
    // mid `run --url` is registered here, on the stream, before it starts the box:
    // docker's create → attach → start, split across the two calls it makes.
    //
    // This runs under the registry write lock, and booting a cold box pulls its
    // image, which is unbounded, so every other `/exec`, `/attach` and the reaper
    // wait behind it. The lock buys the atomic check-then-open that stops two
    // clients opening two guest streams for one session — the guest refuses a
    // second Attach, so the loser would get a permanently silent Execution. A
    // per-box open lock would scope that to the same box; worth doing, not here.
    let mut executions = state.executions.write().await;
    register_main_session(&mut executions, box_id, || async {
        litebox.attach(None).await
    })
    .await
    .map_err(|e| error_from_boxlite(&e))
}

// ============================================================================
// Router
// ============================================================================

fn build_router(state: Arc<AppState>) -> Router {
    use handlers::{advanced, boxes, config, executions, files, me, metrics, snapshots, volumes};

    Router::new()
        // Identity (no tenant prefix)
        .route("/v1/me", get(me::get_me))
        .route("/v1/config", get(config::get_config))
        // Runtime metrics
        .route("/v1/metrics", get(metrics::runtime_metrics))
        // Named volumes
        .route(
            "/v1/volumes",
            post(volumes::create_volume).get(volumes::list_volumes),
        )
        .route(
            "/v1/volumes/{id}",
            get(volumes::get_volume).delete(volumes::remove_volume),
        )
        // Box CRUD (import first — static path before param path)
        .route("/v1/boxes/import", post(advanced::import_box))
        .route(
            "/v1/boxes",
            post(boxes::create_box).get(boxes::list_boxes),
        )
        .route(
            "/v1/boxes/{box_id}",
            get(boxes::get_box)
                .delete(boxes::remove_box)
                .head(boxes::head_box),
        )
        // Box lifecycle
        .route(
            "/v1/boxes/{box_id}/start",
            post(boxes::start_box),
        )
        .route(
            "/v1/boxes/{box_id}/stop",
            post(boxes::stop_box),
        )
        // Box metrics
        .route(
            "/v1/boxes/{box_id}/metrics",
            get(metrics::box_metrics),
        )
        // Main command session (container init) — docker's
        // `POST /containers/{id}/attach`, distinct from exec-attach below.
        .route(
            "/v1/boxes/{box_id}/attach",
            get(executions::attach_box),
        )
        // Execution
        .route(
            "/v1/boxes/{box_id}/exec",
            post(executions::start_execution),
        )
        .route(
            "/v1/boxes/{box_id}/executions/{exec_id}",
            get(executions::get_execution).delete(executions::kill_execution),
        )
        .route(
            "/v1/boxes/{box_id}/executions/{exec_id}/attach",
            get(executions::attach_execution),
        )
        .route(
            "/v1/boxes/{box_id}/executions/{exec_id}/signal",
            post(executions::send_signal),
        )
        .route(
            "/v1/boxes/{box_id}/executions/{exec_id}/resize",
            post(executions::resize_tty),
        )
        // Files
        .route(
            "/v1/boxes/{box_id}/files",
            put(files::upload_files).get(files::download_files),
        )
        // Snapshots
        .route(
            "/v1/boxes/{box_id}/snapshots",
            post(snapshots::create_snapshot).get(snapshots::list_snapshots),
        )
        .route(
            "/v1/boxes/{box_id}/snapshots/{name}",
            get(snapshots::get_snapshot).delete(snapshots::delete_snapshot),
        )
        .route(
            "/v1/boxes/{box_id}/snapshots/{name}/restore",
            post(snapshots::restore_snapshot),
        )
        // Clone & export
        .route(
            "/v1/boxes/{box_id}/clone",
            post(advanced::clone_box),
        )
        .route(
            "/v1/boxes/{box_id}/export",
            post(advanced::export_box),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            require_api_key,
        ))
        // Middleware stack (outermost first, applied in reverse):
        // 1. SetRequestIdLayer — read X-Request-Id from request, or mint
        //    a UUID. Stored in request extensions for downstream handlers
        //    and tracing spans.
        // 2. PropagateRequestIdLayer — copy the request-id onto the
        //    response headers so clients can correlate to server logs.
        // 3. CatchPanicLayer — handler panic ⇒ 500 with our envelope.
        //    Without this, axum returns an empty 500 which the client
        //    mis-classifies as a proxy/Network error.
        //
        // Skipped (intentionally): TimeoutLayer. boxlite handlers have
        // operation-specific timeouts (signal/kill use 10s, image pulls
        // can legitimately take minutes). A global request timeout would
        // break long-running ops.
        .layer(CatchPanicLayer::custom(handle_panic))
        .layer(PropagateRequestIdLayer::x_request_id())
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
        .with_state(state)
}

// ============================================================================
// Entry Point
// ============================================================================

pub async fn execute(args: ServeArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let runtime = global.create_runtime()?;

    let state = Arc::new(AppState {
        runtime,
        boxes: RwLock::new(HashMap::new()),
        executions: RwLock::new(HashMap::new()),
        api_key: args.api_key.clone(),
    });

    // Phase 5.7: spawn the orphan reaper. Same escalation policy as the
    // Go runner — 5min SIGHUP, +30s SIGTERM, +30s SIGKILL, 24h cap.
    tokio::spawn(reaper_loop(Arc::clone(&state)));

    let app = build_router(state.clone());
    let addr = format!("{}:{}", args.host, args.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;

    tracing::info!("boxlite serve listening on {}", addr);
    eprintln!("BoxLite REST API server listening on http://{addr}");

    // Graceful shutdown on ctrl-c
    let shutdown_state = state.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutting down...");
            eprintln!("\nShutting down...");
            let _ = shutdown_state.runtime.shutdown(Some(10)).await;
        })
        .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    // --- API-key auth decision (pure; no runtime/network needed) ---

    #[test]
    fn auth_allows_permissive_when_no_key() {
        assert!(auth_allows(None, "/v1/boxes", None));
        assert!(auth_allows(None, "/v1/me", Some("anything")));
    }

    #[test]
    fn auth_allows_config_public_even_with_key() {
        assert!(auth_allows(Some("k"), "/v1/config", None));
    }

    #[test]
    fn auth_allows_requires_exact_bearer_when_key_set() {
        assert!(auth_allows(Some("k"), "/v1/me", Some("k")));
        assert!(!auth_allows(Some("k"), "/v1/me", Some("wrong")));
        assert!(!auth_allows(Some("k"), "/v1/me", None));
        assert!(!auth_allows(Some("k"), "/v1/boxes", Some("")));
    }

    #[test]
    fn constant_time_eq_basic() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn build_box_command_rejects_invalid_timeout_seconds() {
        for seconds in [-1.0, f64::NAN, f64::INFINITY] {
            let req = ExecRequest {
                command: "true".to_string(),
                args: Vec::new(),
                stdin: None,
                env: None,
                timeout_seconds: Some(seconds),
                working_dir: None,
                tty: false,
            };

            let err = build_box_command(&req).expect_err("invalid timeout should fail");
            assert!(
                matches!(err, boxlite::BoxliteError::InvalidArgument(ref msg) if msg.contains("timeout_seconds")),
                "unexpected error for {seconds:?}: {err}"
            );
        }
    }

    // ============================================================
    // REST `security` wire contract: server-owned only.
    //
    // The REST surface deliberately exposes no knob for clients to
    // pick a security preset or override `SecurityOptions`. Combined
    // with `#[serde(deny_unknown_fields)]` on `CreateBoxRequest`,
    // any client attempt to send `security` / `security_settings`
    // is rejected at deserialize time (i.e. 400 from the API)
    // rather than silently relaxing the server's policy.
    // ============================================================

    /// `-t` has to survive the wire, or a REST `run -it` silently gets pipes.
    ///
    /// The terminal belongs to the container's init, so it is decided at
    /// *create* and nothing downstream can add it. The client only sends the
    /// field when asked (the server rejects unknown fields), so both shapes
    /// must work: present-and-true, and absent.
    #[test]
    fn build_box_options_carries_tty_from_the_wire() {
        let with_tty: super::types::CreateBoxRequest =
            serde_json::from_str(r#"{"image": "alpine:latest", "tty": true}"#)
                .expect("body with tty must deserialize");
        assert!(
            build_box_options(&with_tty).expect("build").tty,
            "a REST client asking for a terminal must get one"
        );

        let without: super::types::CreateBoxRequest =
            serde_json::from_str(r#"{"image": "alpine:latest"}"#).expect("body must deserialize");
        assert!(
            !build_box_options(&without).expect("build").tty,
            "no tty asked for, none granted"
        );
    }

    #[test]
    fn build_box_options_carries_lifecycle_policy_and_uses_compatible_detach_default() {
        let req: super::types::CreateBoxRequest = serde_json::from_str(
            r#"{"auto_pause": 900, "auto_delete": 3600, "auto_resume": false}"#,
        )
        .expect("lifecycle body must deserialize");
        let opts = build_box_options(&req).expect("build lifecycle options");
        assert_eq!(opts.auto_pause, Some(900));
        assert_eq!(opts.auto_delete, Some(3600));
        assert_eq!(opts.auto_resume, Some(false));
        assert!(!opts.detach, "remove-on-stop must not default to detached");

        let persistent: super::types::CreateBoxRequest =
            serde_json::from_str(r#"{"auto_delete": 0}"#).expect("body must deserialize");
        assert!(
            build_box_options(&persistent).expect("build").detach,
            "persistent boxes keep the serve API's historical detached default"
        );
    }

    #[test]
    fn build_box_options_empty_body_lands_on_server_default_security() {
        // Bog-standard REST body. Server resolves security from its
        // own default; on Linux/macOS that's jailer-on (the standard
        // preset, post-flip).
        let json = r#"{"image": "alpine:latest"}"#;
        let req: super::types::CreateBoxRequest =
            serde_json::from_str(json).expect("body must deserialize");
        let opts = build_box_options(&req).expect("build_box_options");
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        assert!(
            opts.advanced.security.jailer_enabled,
            "server default must be sandbox-on after the flip"
        );
    }

    #[test]
    fn create_box_request_rejects_client_supplied_security_preset() {
        // A malicious or careless client sends `security: "development"`
        // hoping to disable the jailer. `deny_unknown_fields` turns
        // that into a hard deserialize error, which the REST layer
        // surfaces as a 400 — there is no quiet fall-through.
        let json = r#"{"image": "alpine:latest", "security": "development"}"#;
        let msg = match serde_json::from_str::<super::types::CreateBoxRequest>(json) {
            Ok(_) => panic!("`security` must be rejected at deserialize"),
            Err(e) => e.to_string(),
        };
        assert!(
            msg.contains("unknown field") && msg.contains("security"),
            "expected deny-unknown-fields rejection mentioning `security`; got {msg}"
        );
    }

    #[test]
    fn create_box_request_rejects_client_supplied_security_settings() {
        // Same shape as the previous test but with a `security_settings`
        // struct. Also blocked at deserialize.
        let json = r#"{
            "image": "alpine:latest",
            "security_settings": {
                "jailer_enabled":  false,
                "seccomp_enabled": false,
                "uid": null,
                "gid": null,
                "new_pid_ns": false,
                "new_net_ns": false,
                "chroot_base": "/srv/boxlite",
                "chroot_enabled": false,
                "close_fds": false,
                "sanitize_env": false,
                "env_allowlist": [],
                "resource_limits": {},
                "sandbox_profile": null,
                "network_enabled": true
            }
        }"#;
        let msg = match serde_json::from_str::<super::types::CreateBoxRequest>(json) {
            Ok(_) => panic!("`security_settings` must be rejected at deserialize"),
            Err(e) => e.to_string(),
        };
        assert!(
            msg.contains("unknown field") && msg.contains("security_settings"),
            "expected deny-unknown-fields rejection mentioning `security_settings`; got {msg}"
        );
    }

    /// Build an `ActiveExecution` backed by a stub `Execution` whose
    /// stdout/stderr/result channels we control from the test.
    fn make_test_active() -> (
        Arc<ActiveExecution>,
        tokio::sync::mpsc::UnboundedSender<String>, // stdout driver
        tokio::sync::mpsc::UnboundedSender<String>, // stderr driver
        tokio::sync::mpsc::UnboundedSender<boxlite::ExecResult>, // result driver
    ) {
        let (exec, stdout_tx, stderr_tx, _stdin_rx, result_tx) =
            boxlite::Execution::stub("test-exec");
        let active = ActiveExecution::new("test-box".to_string(), SessionKind::Exec, exec, None);
        (active, stdout_tx, stderr_tx, result_tx)
    }

    // ---------------------------------------------------------------
    // Main session (container init) — `GET /boxes/{id}/attach`
    // ---------------------------------------------------------------

    /// Channel handles that keep a stub `Execution` alive. Dropping them
    /// closes the result channel, which the wait task reads as "process
    /// exited"; a main session under test must stay running.
    #[allow(dead_code)]
    struct StubChannels(
        tokio::sync::mpsc::UnboundedSender<String>,
        tokio::sync::mpsc::UnboundedSender<String>,
        tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
        tokio::sync::mpsc::UnboundedSender<boxlite::ExecResult>,
    );

    fn stub_execution(id: &str) -> (Execution, StubChannels) {
        let (exec, stdout_tx, stderr_tx, stdin_rx, result_tx) = boxlite::Execution::stub(id);
        (
            exec,
            StubChannels(stdout_tx, stderr_tx, stdin_rx, result_tx),
        )
    }

    // A second `GET /boxes/{id}/attach` must reuse the registered main
    // session, never open a second one. The guest binds init's stdout to
    // the first Attach RPC and rejects later ones, so a second
    // `LiteBox::attach()` would return an Execution that never streams —
    // and would hand a second client a live attach slot. The registry
    // entry is the record that the session is already open, so the second
    // call must find it and get refused by `mark_connected()` (the 409).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn second_attach_reuses_main_session_and_never_reopens_it() {
        let mut executions: HashMap<String, Arc<ActiveExecution>> = HashMap::new();
        let opens = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        // A tenant exec on the same box must not be mistaken for the main
        // session — it is addressed by its own id and has its own slot.
        let (tenant, _tenant_channels) = stub_execution("exec-1");
        executions.insert(
            "exec-1".to_string(),
            ActiveExecution::new("box1".to_string(), SessionKind::Exec, tenant, None),
        );

        let (init, _init_channels) = stub_execution("container-1");
        let mut init = Some(init);
        let first = register_main_session(&mut executions, "box1", || {
            opens.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let init = init.take().expect("opener runs once");
            async move { Ok(init) }
        })
        .await
        .expect("first attach opens the main session");

        // Second attach: the opener here would produce a *different*
        // session. If it ever runs, we have opened a second guest stream.
        let (decoy, _decoy_channels) = stub_execution("container-DECOY");
        let mut decoy = Some(decoy);
        let second = register_main_session(&mut executions, "box1", || {
            opens.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let decoy = decoy.take().expect("opener runs once");
            async move { Ok(decoy) }
        })
        .await
        .expect("second attach resolves the main session");

        assert_eq!(
            opens.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "the second attach must reuse the registered main session, not open another one",
        );
        assert!(
            Arc::ptr_eq(&first, &second),
            "both attaches must resolve to the same ActiveExecution",
        );
        assert_eq!(
            second.execution().id(),
            "container-1",
            "the main session keeps the container id it was opened with",
        );
        assert!(
            executions.contains_key("container-1"),
            "the main session is registered under its container id, alongside tenant execs: {:?}",
            executions.keys().collect::<Vec<_>>(),
        );

        // The single-attach claim is what turns the reused entry into a
        // 409 for the second client, exactly as for an exec session.
        assert!(first.mark_connected().await, "first client claims the slot");
        assert!(
            !second.mark_connected().await,
            "a second client on an attached main session must be refused (409)",
        );
    }

    // The main session is found by box id — the container id is not
    // knowable to the caller. Exec sessions and other boxes' sessions must
    // never answer that lookup.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn find_main_session_matches_only_the_boxs_init_session() {
        let mut executions: HashMap<String, Arc<ActiveExecution>> = HashMap::new();

        let (exec, _exec_channels) = stub_execution("exec-1");
        executions.insert(
            "exec-1".to_string(),
            ActiveExecution::new("box1".to_string(), SessionKind::Exec, exec, None),
        );
        let (other_init, _other_channels) = stub_execution("container-2");
        executions.insert(
            "container-2".to_string(),
            ActiveExecution::new("box2".to_string(), SessionKind::Main, other_init, None),
        );

        assert!(
            find_main_session(&executions, "box1").is_none(),
            "box1 has only an exec session — attaching must open its main session, not adopt the exec",
        );

        let (init, _init_channels) = stub_execution("container-1");
        executions.insert(
            "container-1".to_string(),
            ActiveExecution::new("box1".to_string(), SessionKind::Main, init, None),
        );

        let found = find_main_session(&executions, "box1").expect("box1 main session");
        assert_eq!(
            found.execution().id(),
            "container-1",
            "must not return box2's main session",
        );
    }

    // The container-attach route must be registered at the path the client
    // builds (`RestBox::attach` → `/v1/boxes/{id}/attach`). A method it
    // does not serve proves the path matched (405); an adjacent path that
    // was never registered proves the opposite (404). Neither reaches a
    // handler, so no box or VM is touched.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn container_attach_route_is_registered() {
        // A REST-backed runtime keeps AppState cheap: no local runtime
        // dirs, no embedded-runtime extraction. Routing is decided before
        // any handler runs, so the runtime is never called.
        let runtime = BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(
            "http://127.0.0.1:1".to_string(),
        ))
        .expect("rest runtime");
        let state = Arc::new(AppState {
            runtime,
            boxes: RwLock::new(HashMap::new()),
            executions: RwLock::new(HashMap::new()),
            api_key: None,
        });

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, build_router(state)).await;
        });

        let http = reqwest::Client::new();
        let attached = http
            .post(format!("http://127.0.0.1:{port}/v1/boxes/box1/attach"))
            .send()
            .await
            .expect("POST /attach");
        assert_eq!(
            attached.status().as_u16(),
            405,
            "GET /v1/boxes/{{box_id}}/attach must be registered (405 = path matched, method did not)",
        );

        let unrouted = http
            .get(format!("http://127.0.0.1:{port}/v1/boxes/box1/attach/nope"))
            .send()
            .await
            .expect("GET unregistered path");
        assert_eq!(
            unrouted.status().as_u16(),
            404,
            "control: an unregistered path must 404, so the 405 above is meaningful",
        );

        server.abort();
    }

    // ---------------------------------------------------------------
    // Finding 1: late subscriber misses pre-attach output
    // ---------------------------------------------------------------
    //
    // ActiveExecution pumps stdout through a tokio::sync::broadcast
    // sender. broadcast::subscribe() only delivers messages sent AFTER
    // the subscribe call. A client that calls GET /attach after output
    // has already been produced loses that output.
    //
    // This exercises the real ActiveExecution: we push lines through
    // the stub, let the pump broadcast them, then subscribe and check
    // whether the late subscriber sees the earlier lines.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn late_attach_subscriber_must_see_prior_output() {
        let (active, stdout_tx, _stderr_tx, _result_tx) = make_test_active();

        // Push 5 lines through the stub's stdout channel. The pump
        // task inside ActiveExecution::new reads these and broadcasts
        // them.
        for i in 1..=5 {
            stdout_tx.send(format!("line-{i}\n")).unwrap();
        }
        // Give the pump task a tick to broadcast all 5 chunks.
        tokio::time::sleep(Duration::from_millis(50)).await;

        // NOW subscribe — this is what run_attach_session does when a
        // client connects to /attach after the exec already produced
        // output.
        let mut rx = active.stdout_bus().subscribe();

        // Push one more line AFTER the subscribe so we can prove the
        // channel is alive.
        stdout_tx.send("line-6\n".to_string()).unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;

        let mut received = Vec::new();
        while let Ok(Ok(data)) = tokio::time::timeout(Duration::from_millis(50), rx.recv()).await {
            received.push(String::from_utf8(data).unwrap());
        }

        // MUST FAIL on unfixed code: received has only ["line-6\n"].
        // The 5 pre-subscribe lines are lost because broadcast has no
        // backlog replay.
        assert!(
            received.len() >= 6,
            "late subscriber must see pre-subscribe output; \
             got {} line(s): {:?}  (expected >= 6, including the 5 pre-attach lines)",
            received.len(),
            received,
        );
    }

    // ---------------------------------------------------------------
    // Finding 2: final stdout chunk lost on fast process exit
    // ---------------------------------------------------------------
    //
    // The architecture has TWO independent spawned tasks:
    //   (A) stdout pump: reads ExecStdout stream → broadcasts via stdout_bus
    //   (B) wait task: calls execution.wait() → stores exit_code → fires done_tx
    //
    // If (B) fires done_tx BEFORE (A) has broadcast the last chunk,
    // the WS writer's try_recv() drain misses it.
    //
    // Rather than racing the scheduler, we test the structural defect
    // directly: done_tx can fire while the pump's broadcast channel
    // still has unconsumed source items in the ExecStdout mpsc.
    // A correct implementation would barrier the pump's completion
    // before firing done_tx.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn done_signal_must_wait_for_pump_completion() {
        let (active, stdout_tx, stderr_tx, result_tx) = make_test_active();

        // Subscribe BEFORE any data is pushed — the subscriber will
        // receive all broadcast chunks. No sleep-based polling.
        let mut rx = active.stdout_bus().subscribe();
        let mut done_rx = active.done_rx();

        // Push output, then signal exit immediately. The pump task
        // must read from ExecStdout and broadcast BEFORE done fires.
        stdout_tx.send("final-line\n".to_string()).unwrap();
        drop(stdout_tx);
        drop(stderr_tx);
        result_tx
            .send(boxlite::ExecResult {
                exit_code: 0,
                error_message: None,
            })
            .unwrap();

        // Wait for the done signal.
        let _ = tokio::time::timeout(Duration::from_secs(2), done_rx.changed()).await;

        // After done fires, the pump barrier guarantees all output has
        // been broadcast. Drain with try_recv — no sleep needed.
        let mut all = Vec::new();
        while let Ok(bytes) = rx.try_recv() {
            all.push(String::from_utf8(bytes).unwrap());
        }

        assert!(
            all.iter().any(|s| s.contains("final-line")),
            "after done_rx fires, all output must have been broadcast; \
             got: {:?}",
            all,
        );
    }

    // ---------------------------------------------------------------
    // Finding 3: reaper immediately evicts completed execs
    // ---------------------------------------------------------------
    //
    // run_reap_once removes is_done() execs on the very next tick.
    // The Go runner retains them for 5 minutes. A client that polls
    // GET /executions/{id} shortly after exit gets 404.
    //
    // We can't construct a full AppState without BoxliteRuntime, so
    // we build the executions map directly and call run_reap_once.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reaper_retains_completed_exec_for_grace_period() {
        let (active, stdout_tx, stderr_tx, result_tx) = make_test_active();

        // Signal exit so is_done() flips true. Drop BOTH stream senders
        // so the pump tasks exit and the wait task's barrier completes.
        drop(stdout_tx);
        drop(stderr_tx);
        result_tx
            .send(boxlite::ExecResult {
                exit_code: 42,
                error_message: None,
            })
            .unwrap();
        for _ in 0..20 {
            if active.is_done() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(active.is_done(), "precondition: exec must be done");

        // The exec was just created so created_at is recent — the
        // production should_retain() must return true.
        let now = Instant::now();
        assert!(
            active.should_retain(now),
            "recently-completed exec must be retained (grace period = {:?})",
            COMPLETED_RETENTION_GRACE,
        );

        // Conversely, a time far in the future should NOT retain.
        let far_future = now + COMPLETED_RETENTION_GRACE + Duration::from_secs(1);
        assert!(
            !active.should_retain(far_future),
            "exec past the retention grace must not be retained",
        );
    }

    /// A finished main session must not be handed to a restarted box.
    ///
    /// Unlike an exec — which gets a fresh id every time — the main session's id
    /// is the container id, fixed at box creation and therefore identical across
    /// reboots. So the previous run's dead session still matches this box, and
    /// without an `is_done()` filter a post-restart attach would be given the
    /// old VM's stream, its stale backlog and its stale exit code, while the new
    /// boot's init session was never registered at all.
    #[tokio::test]
    async fn find_main_session_skips_a_finished_one_so_a_restart_gets_a_new_session() {
        let (exec, channels) = stub_execution("cid-main");
        let finished = ActiveExecution::new("box1".to_string(), SessionKind::Main, exec, None);

        let mut executions = HashMap::new();
        executions.insert("cid-main".to_string(), Arc::clone(&finished));

        assert!(
            find_main_session(&executions, "box1").is_some(),
            "precondition: a live main session is found"
        );

        // End it, exactly as init exiting would: send the result and drop the
        // stream senders so the pumps finish.
        let StubChannels(stdout_tx, stderr_tx, _stdin_rx, result_tx) = channels;
        drop(stdout_tx);
        drop(stderr_tx);
        result_tx
            .send(boxlite::ExecResult {
                exit_code: 0,
                error_message: None,
            })
            .unwrap();
        for _ in 0..40 {
            if finished.is_done() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(finished.is_done(), "precondition: the main session ended");

        assert!(
            find_main_session(&executions, "box1").is_none(),
            "a finished main session must not be reused — the restarted box needs a new one"
        );
    }

    /// The reaper must never reap the box's main session.
    ///
    /// That session is the container's init, so killing it powers the VM off
    /// and takes the whole box with it. Registering it in `state.executions` is
    /// what makes `/boxes/{id}/attach` work — but that map is the one the
    /// reaper walks, which put the user's box on the orphan-escalation path
    /// (SIGHUP → SIGTERM → SIGKILL → evict) the moment their client
    /// disconnected, and under the 24h lifetime cap even while still attached.
    /// Detaching from `docker attach` does not stop a container; nor may this.
    #[tokio::test]
    async fn reaper_never_reaps_the_boxs_main_session() {
        let runtime = BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(
            "http://127.0.0.1:1".to_string(),
        ))
        .expect("rest runtime");
        let state = AppState {
            runtime,
            boxes: RwLock::new(HashMap::new()),
            executions: RwLock::new(HashMap::new()),
            api_key: None,
        };

        // The box's main command, and an ordinary exec running beside it.
        let (init, _init_channels) = stub_execution("cid-main");
        let main = Arc::new(ActiveExecution::new(
            "box1".to_string(),
            SessionKind::Main,
            init,
            None,
        ));
        let (tenant_exec, _tenant_channels) = stub_execution("exec-1");
        let tenant = Arc::new(ActiveExecution::new(
            "box1".to_string(),
            SessionKind::Exec,
            tenant_exec,
            None,
        ));
        {
            let mut map = state.executions.write().await;
            map.insert("cid-main".to_string(), Arc::clone(&main));
            map.insert("exec-1".to_string(), Arc::clone(&tenant));
        }

        // Neither was ever attached, and we reap from far enough in the future
        // that the lifetime cap has long since passed — the harshest state the
        // reaper knows.
        let doomsday = Instant::now() + Duration::from_secs(48 * 60 * 60);
        run_reap_once(
            &state,
            doomsday,
            Duration::from_secs(1),
            Duration::from_secs(1),
            Duration::from_secs(60),
        )
        .await;

        let surviving = state.executions.read().await;
        assert!(
            surviving.contains_key("cid-main"),
            "the box's main session must survive the reaper — reaping it kills init and destroys the box"
        );
        assert!(
            !main.is_reaping_kill().await,
            "the main session must never even be marked for kill"
        );

        // Control: the exec beside it *is* reaped under the same tick, so this
        // proves the Main guard rather than a reaper that happens to be inert.
        assert!(
            !surviving.contains_key("exec-1"),
            "an orphaned exec past the lifetime cap must still be killed and evicted"
        );
    }
}
