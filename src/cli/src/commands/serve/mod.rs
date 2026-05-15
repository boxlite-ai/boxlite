//! `boxlite serve` — long-running REST API server.
//!
//! Holds a single BoxliteRuntime and exposes the full REST API
//! over HTTP so that `Boxlite.rest()` clients can connect.

mod handlers;
mod types;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use clap::Args;
use futures::StreamExt;
use tokio::sync::RwLock;

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
}

/// Server-side state for one execution. The underlying `Execution`'s
/// stdout/stderr are consumed once at creation and tee'd into broadcast
/// channels so any number of attach sessions (over time) can subscribe.
/// The `Execution` itself is kept in the map so `wait()`, `kill()`,
/// `signal()`, `resize_tty()` and reattach all work.
pub(in crate::commands::serve) struct ActiveExecution {
    box_id: String,
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
    fn new(box_id: String, mut execution: Execution, stdin: Option<ExecStdin>) -> Arc<Self> {
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
                state.executions.write().await.remove(&id);
            }
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
            state.executions.write().await.remove(id);
        }
        Ok(Err(e)) => {
            tracing::warn!(exec_id = %id, err = %e, "kill failed, will retry next tick");
        }
        Err(_) => {
            tracing::warn!(exec_id = %id, "kill timed out, will retry next tick");
        }
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
        auto_remove: req.auto_remove.unwrap_or(false),
        detach: req.detach.unwrap_or(true),
        ..Default::default()
    })
}

fn build_box_command(req: &ExecRequest) -> BoxCommand {
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
        cmd = cmd.timeout(std::time::Duration::from_secs_f64(secs));
    }
    cmd
}

// ============================================================================
// Error Helpers
// ============================================================================

fn error_response(status: StatusCode, message: impl Into<String>, error_type: &str) -> Response {
    let body = ErrorBody {
        error: ErrorDetail {
            message: message.into(),
            error_type: error_type.to_string(),
            code: status.as_u16(),
        },
    };
    (status, Json(body)).into_response()
}

fn classify_boxlite_error(err: &boxlite::BoxliteError) -> (StatusCode, &'static str) {
    let msg = err.to_string().to_lowercase();
    if msg.contains("not found") {
        (StatusCode::NOT_FOUND, "NotFoundError")
    } else if msg.contains("already") || msg.contains("conflict") {
        (StatusCode::CONFLICT, "ConflictError")
    } else if msg.contains("unsupported") {
        (StatusCode::BAD_REQUEST, "UnsupportedError")
    } else {
        (StatusCode::INTERNAL_SERVER_ERROR, "InternalError")
    }
}

// ============================================================================
// Box Handle Cache Helper
// ============================================================================

async fn get_or_fetch_box(state: &AppState, box_id: &str) -> Result<Arc<LiteBox>, Response> {
    // Check cache first
    if let Some(b) = state.boxes.read().await.get(box_id) {
        return Ok(Arc::clone(b));
    }

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
        )),
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            Err(error_response(status, e.to_string(), etype))
        }
    }
}

// ============================================================================
// Router
// ============================================================================

fn build_router(state: Arc<AppState>) -> Router {
    use handlers::{advanced, boxes, config, executions, files, me, metrics, snapshots};

    Router::new()
        // Identity (no tenant prefix)
        .route("/v1/me", get(me::get_me))
        .route("/v1/config", get(config::get_config))
        // Runtime metrics
        .route("/v1/default/metrics", get(metrics::runtime_metrics))
        // Box CRUD (import first — static path before param path)
        .route("/v1/default/boxes/import", post(advanced::import_box))
        .route(
            "/v1/default/boxes",
            post(boxes::create_box).get(boxes::list_boxes),
        )
        .route(
            "/v1/default/boxes/{box_id}",
            get(boxes::get_box)
                .delete(boxes::remove_box)
                .head(boxes::head_box),
        )
        // Box lifecycle
        .route(
            "/v1/default/boxes/{box_id}/start",
            post(boxes::start_box),
        )
        .route(
            "/v1/default/boxes/{box_id}/stop",
            post(boxes::stop_box),
        )
        // Box metrics
        .route(
            "/v1/default/boxes/{box_id}/metrics",
            get(metrics::box_metrics),
        )
        // Execution
        .route(
            "/v1/default/boxes/{box_id}/exec",
            post(executions::start_execution),
        )
        .route(
            "/v1/default/boxes/{box_id}/executions/{exec_id}",
            get(executions::get_execution).delete(executions::kill_execution),
        )
        .route(
            "/v1/default/boxes/{box_id}/executions/{exec_id}/attach",
            get(executions::attach_execution),
        )
        .route(
            "/v1/default/boxes/{box_id}/executions/{exec_id}/signal",
            post(executions::send_signal),
        )
        .route(
            "/v1/default/boxes/{box_id}/executions/{exec_id}/resize",
            post(executions::resize_tty),
        )
        // Files
        .route(
            "/v1/default/boxes/{box_id}/files",
            put(files::upload_files).get(files::download_files),
        )
        // Snapshots
        .route(
            "/v1/default/boxes/{box_id}/snapshots",
            post(snapshots::create_snapshot).get(snapshots::list_snapshots),
        )
        .route(
            "/v1/default/boxes/{box_id}/snapshots/{name}",
            get(snapshots::get_snapshot).delete(snapshots::delete_snapshot),
        )
        .route(
            "/v1/default/boxes/{box_id}/snapshots/{name}/restore",
            post(snapshots::restore_snapshot),
        )
        // Clone & export
        .route(
            "/v1/default/boxes/{box_id}/clone",
            post(advanced::clone_box),
        )
        .route(
            "/v1/default/boxes/{box_id}/export",
            post(advanced::export_box),
        )
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
        let active = ActiveExecution::new("test-box".to_string(), exec, None);
        (active, stdout_tx, stderr_tx, result_tx)
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
}
