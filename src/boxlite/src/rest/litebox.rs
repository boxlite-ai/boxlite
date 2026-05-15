//! RestBox — implements BoxBackend for the REST API.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::RwLock;
use reqwest::Method;
use tokio::sync::mpsc;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::BoxInfo;
use crate::litebox::copy::CopyOptions;
use crate::litebox::snapshot_mgr::SnapshotInfo;
use crate::litebox::{BoxCommand, ExecResult, ExecStderr, ExecStdin, ExecStdout, Execution};
use crate::metrics::BoxMetrics;
use crate::runtime::backend::{BoxBackend, SnapshotBackend};
use crate::runtime::id::BoxID;
use crate::runtime::options::{CloneOptions, ExportOptions, SnapshotOptions};

use super::client::ApiClient;
use super::exec::RestExecControl;
use super::types::{
    BoxMetricsResponse, BoxResponse, CloneBoxRequest, CreateSnapshotRequest, ExecRequest,
    ExecResponse, ExecutionStatusResponse, ExportBoxRequest, ListSnapshotsResponse,
    SnapshotResponse,
};

/// REST-backed box handle.
///
/// Holds a cached `BoxInfo` (updated on start/stop) and delegates
/// all operations to the remote REST API.
pub(crate) struct RestBox {
    client: ApiClient,
    cached_info: RwLock<BoxInfo>,
}

impl RestBox {
    pub fn new(client: ApiClient, info: BoxInfo) -> Self {
        Self {
            client,
            cached_info: RwLock::new(info),
        }
    }

    fn box_id_str(&self) -> String {
        self.cached_info.read().id.to_string()
    }
}

#[async_trait]
impl BoxBackend for RestBox {
    fn id(&self) -> &BoxID {
        // Safety: BoxID is immutable after construction. We leak a ref through
        // the RwLock, which is fine because the id field never changes.
        // This avoids cloning on every call.
        unsafe {
            let info = self.cached_info.data_ptr();
            &(*info).id
        }
    }

    fn name(&self) -> Option<&str> {
        // Same pattern as id() — name is immutable after construction.
        unsafe {
            let info = self.cached_info.data_ptr();
            (*info).name.as_deref()
        }
    }

    fn info(&self) -> BoxInfo {
        self.cached_info.read().clone()
    }

    async fn start(&self) -> BoxliteResult<()> {
        let box_id = self.box_id_str();
        let path = format!("/boxes/{}/start", box_id);
        let resp: BoxResponse = self.client.post_empty(&path).await?;
        let new_info = resp.to_box_info()?;
        let mut info = self.cached_info.write();
        *info = new_info;
        Ok(())
    }

    async fn exec(&self, command: BoxCommand) -> BoxliteResult<Execution> {
        let box_id = self.box_id_str();

        // 1. Create execution on remote server
        let path = format!("/boxes/{}/exec", box_id);
        let req = ExecRequest::from_command(&command);
        let resp: ExecResponse = self.client.post(&path, &req).await?;
        let execution_id = resp.execution_id;

        // 2. Set up channels for stdout, stderr, stdin, and result
        let (stdout_tx, stdout_rx) = mpsc::unbounded_channel::<String>();
        let (stderr_tx, stderr_rx) = mpsc::unbounded_channel::<String>();
        let (stdin_tx, stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (result_tx, result_rx) = mpsc::unbounded_channel::<ExecResult>();

        // 3. Spawn the bidirectional WebSocket pump (stdin + stdout + stderr + exit)
        let ws_client = self.client.clone();
        let ws_box_id = box_id.clone();
        let ws_exec_id = execution_id.clone();
        tokio::spawn(async move {
            attach_ws(
                &ws_client,
                &ws_box_id,
                &ws_exec_id,
                stdin_rx,
                stdout_tx,
                stderr_tx,
                result_tx,
            )
            .await;
        });

        // 4. Build Execution handle
        let control = RestExecControl::new(self.client.clone(), box_id);
        let stdout = ExecStdout::new(stdout_rx);
        let stderr = ExecStderr::new(stderr_rx);
        let stdin = ExecStdin::new(stdin_tx);

        Ok(Execution::new(
            execution_id,
            Box::new(control),
            result_rx,
            Some(stdin),
            Some(stdout),
            Some(stderr),
        ))
    }

    async fn attach(&self, execution_id: &str) -> BoxliteResult<Execution> {
        let box_id = self.box_id_str();

        // Open the WebSocket synchronously so a rejection (404 reaped /
        // 409 already-attached) surfaces here, at the caller's `await
        // box.attach(id)` point — not as an after-the-fact ExecResult
        // pulled from `wait()`.
        let path = format!("/boxes/{}/executions/{}/attach", box_id, execution_id);
        let stream = self.client.connect_ws(&path).await.map_err(|e| match e {
            BoxliteError::NotFound(msg) => BoxliteError::SessionReaped(format!(
                "session {} not found — likely reaped after disconnect timeout: {}",
                execution_id, msg
            )),
            BoxliteError::AlreadyExists(msg) => BoxliteError::AlreadyExists(format!(
                "session {} has another client attached: {}",
                execution_id, msg
            )),
            other => other,
        })?;

        let (stdout_tx, stdout_rx) = mpsc::unbounded_channel::<String>();
        let (stderr_tx, stderr_rx) = mpsc::unbounded_channel::<String>();
        let (stdin_tx, stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (result_tx, result_rx) = mpsc::unbounded_channel::<ExecResult>();

        let ws_client = self.client.clone();
        let ws_box_id = box_id.clone();
        let ws_exec_id = execution_id.to_string();
        tokio::spawn(async move {
            attach_ws_pump(
                &ws_client,
                &ws_box_id,
                &ws_exec_id,
                stream,
                stdin_rx,
                stdout_tx,
                stderr_tx,
                result_tx,
            )
            .await;
        });

        let control = RestExecControl::new(self.client.clone(), box_id);
        let stdout = ExecStdout::new(stdout_rx);
        let stderr = ExecStderr::new(stderr_rx);
        let stdin = ExecStdin::new(stdin_tx);

        Ok(Execution::new(
            execution_id.to_string(),
            Box::new(control),
            result_rx,
            Some(stdin),
            Some(stdout),
            Some(stderr),
        ))
    }

    async fn metrics(&self) -> BoxliteResult<BoxMetrics> {
        let box_id = self.box_id_str();
        let path = format!("/boxes/{}/metrics", box_id);
        let resp: BoxMetricsResponse = self.client.get(&path).await?;
        Ok(box_metrics_from_response(&resp))
    }

    async fn stop(&self) -> BoxliteResult<()> {
        let box_id = self.box_id_str();
        let path = format!("/boxes/{}/stop", box_id);
        let resp: BoxResponse = self.client.post_empty(&path).await?;
        let new_info = resp.to_box_info()?;
        let mut info = self.cached_info.write();
        *info = new_info;
        Ok(())
    }

    async fn copy_into(
        &self,
        host_src: &Path,
        container_dst: &str,
        _opts: CopyOptions,
    ) -> BoxliteResult<()> {
        let box_id = self.box_id_str();

        // Create tar archive from host path
        let tar_bytes = create_tar_from_path(host_src)?;

        // Upload tar to server
        let encoded_dst = urlencoding::encode(container_dst);
        let path = format!("/boxes/{}/files?path={}", box_id, encoded_dst);
        let builder = self
            .client
            .authorized_request(Method::PUT, &path)
            .await?
            .header("Content-Type", "application/x-tar")
            .body(tar_bytes);

        let resp = builder
            .send()
            .await
            .map_err(|e| BoxliteError::Internal(format!("copy_into upload failed: {}", e)))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(BoxliteError::Internal(format!(
                "copy_into failed (HTTP {}): {}",
                status, text
            )));
        }
        Ok(())
    }

    async fn copy_out(
        &self,
        container_src: &str,
        host_dst: &Path,
        _opts: CopyOptions,
    ) -> BoxliteResult<()> {
        let box_id = self.box_id_str();

        // Download tar from server
        let encoded_src = urlencoding::encode(container_src);
        let path = format!("/boxes/{}/files?path={}", box_id, encoded_src);
        let builder = self
            .client
            .authorized_request(Method::GET, &path)
            .await?
            .header("Accept", "application/x-tar");

        let resp = builder
            .send()
            .await
            .map_err(|e| BoxliteError::Internal(format!("copy_out download failed: {}", e)))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(BoxliteError::Internal(format!(
                "copy_out failed (HTTP {}): {}",
                status, text
            )));
        }

        let tar_bytes = resp
            .bytes()
            .await
            .map_err(|e| BoxliteError::Internal(format!("copy_out read body failed: {}", e)))?;

        // Extract tar to host path
        extract_tar_to_path(&tar_bytes, host_dst)
    }

    async fn clone_box(
        &self,
        options: CloneOptions,
        name: Option<String>,
    ) -> BoxliteResult<crate::LiteBox> {
        self.client.require_clone_enabled().await?;

        let box_id = self.box_id_str();
        let path = format!("/boxes/{}/clone", box_id);
        let req = CloneBoxRequest::from_options(&options, name.as_deref());
        let resp: BoxResponse = self.client.post(&path, &req).await?;

        let info = resp.to_box_info()?;
        let rest_box = Arc::new(RestBox::new(self.client.clone(), info));
        let box_backend: Arc<dyn BoxBackend> = rest_box.clone();
        let snapshot_backend: Arc<dyn SnapshotBackend> = rest_box;
        Ok(crate::LiteBox::new(box_backend, snapshot_backend))
    }

    async fn clone_boxes(
        &self,
        options: CloneOptions,
        count: usize,
        names: Vec<String>,
    ) -> BoxliteResult<Vec<crate::LiteBox>> {
        let mut results = Vec::with_capacity(count);
        for i in 0..count {
            let name = names.get(i).cloned();
            let litebox = self.clone_box(options.clone(), name).await?;
            results.push(litebox);
        }
        Ok(results)
    }

    async fn export_box(
        &self,
        options: ExportOptions,
        dest: &Path,
    ) -> BoxliteResult<crate::runtime::options::BoxArchive> {
        self.client.require_export_enabled().await?;

        let box_id = self.box_id_str();
        let path = format!("/boxes/{}/export", box_id);
        let req = ExportBoxRequest::from_options(&options);
        let archive_bytes = self.client.post_for_bytes(&path, &req).await?;

        let output_path = if dest.is_dir() {
            let name = self.name().unwrap_or("box");
            dest.join(format!("{}.boxlite", name))
        } else {
            dest.to_path_buf()
        };

        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to create export destination directory {}: {}",
                    parent.display(),
                    e
                ))
            })?;
        }

        std::fs::write(&output_path, &archive_bytes).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to write export archive {}: {}",
                output_path.display(),
                e
            ))
        })?;

        Ok(crate::runtime::options::BoxArchive::new(output_path))
    }
}

#[async_trait]
impl SnapshotBackend for RestBox {
    async fn create(&self, options: SnapshotOptions, name: &str) -> BoxliteResult<SnapshotInfo> {
        self.client.require_snapshots_enabled().await?;

        let box_id = self.box_id_str();
        let path = format!("/boxes/{}/snapshots", box_id);
        let req = CreateSnapshotRequest::from_options(&options, name);
        let resp: SnapshotResponse = self.client.post(&path, &req).await?;
        Ok(resp.to_snapshot_info())
    }

    async fn list(&self) -> BoxliteResult<Vec<SnapshotInfo>> {
        self.client.require_snapshots_enabled().await?;

        let box_id = self.box_id_str();
        let path = format!("/boxes/{}/snapshots", box_id);
        let resp: ListSnapshotsResponse = self.client.get(&path).await?;
        Ok(resp
            .snapshots
            .iter()
            .map(SnapshotResponse::to_snapshot_info)
            .collect())
    }

    async fn get(&self, name: &str) -> BoxliteResult<Option<SnapshotInfo>> {
        self.client.require_snapshots_enabled().await?;

        let box_id = self.box_id_str();
        let encoded_name = urlencoding::encode(name);
        let path = format!("/boxes/{}/snapshots/{}", box_id, encoded_name);
        match self.client.get::<SnapshotResponse>(&path).await {
            Ok(resp) => Ok(Some(resp.to_snapshot_info())),
            Err(BoxliteError::NotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn remove(&self, name: &str) -> BoxliteResult<()> {
        self.client.require_snapshots_enabled().await?;

        let box_id = self.box_id_str();
        let encoded_name = urlencoding::encode(name);
        let path = format!("/boxes/{}/snapshots/{}", box_id, encoded_name);
        self.client.delete(&path).await
    }

    async fn restore(&self, name: &str) -> BoxliteResult<()> {
        self.client.require_snapshots_enabled().await?;

        let box_id = self.box_id_str();
        let encoded_name = urlencoding::encode(name);
        let path = format!("/boxes/{}/snapshots/{}/restore", box_id, encoded_name);
        self.client.post_empty_no_content(&path).await
    }
}

// ============================================================================
// WebSocket Attach
// ============================================================================
//
// One bidirectional WebSocket carries stdin (Binary frames), stdout/stderr
// with a 1-byte channel prefix (0x01 / 0x02), and control messages (text
// JSON: resize / signal / stdin_eof / exit / error). Wire format is the
// authoritative one defined by the server attach handler — see plan D1/D2.

/// Maximum idle interval before the WS reader gives up on the connection.
///
/// The watchdog catches silent CDN/proxy cuts that would otherwise leave the
/// reader parked forever on `stream.next().await`. Tests override this via
/// `cfg(test)` so they don't have to wait 45 s to observe a timeout.
#[cfg(not(test))]
const WS_WATCHDOG: std::time::Duration = std::time::Duration::from_secs(45);
#[cfg(test)]
const WS_WATCHDOG: std::time::Duration = std::time::Duration::from_millis(300);

/// Total wall-clock budget for reconnecting after a transient WS disconnect.
///
/// Aligned with the runner's `defaultReconnectGrace = 5 minutes` (Phase 4 reaper
/// in `exec_manager.go`) — we want to reattach before the runner SIGHUPs the
/// orphaned exec. Tests use a much shorter budget to keep them fast.
#[cfg(not(test))]
const WS_RECONNECT_BUDGET: std::time::Duration = std::time::Duration::from_secs(270);
#[cfg(test)]
const WS_RECONNECT_BUDGET: std::time::Duration = std::time::Duration::from_secs(1);

// Initial backoff is intentionally larger than the runner's WS keepalive
// interval (15s in apps/runner/.../boxlite_exec_attach.go). The most common
// reattach failure is the old server-side `runAttachLoop` not yet having
// observed our TCP RST — `MarkConnected` then returns 409 until the server's
// own keepalive Ping write fails and cleanup runs. Sleeping past that
// interval avoids burning the reconnect budget on guaranteed-409 retries.
const WS_RECONNECT_BACKOFF_INITIAL: std::time::Duration = std::time::Duration::from_secs(15);
const WS_RECONNECT_BACKOFF_MAX: std::time::Duration = std::time::Duration::from_secs(30);

/// Drive the bidirectional WS attach for a single execution.
///
/// Wire contract (mirrors the server's `/executions/{id}/attach` handler):
///
/// - Client → Server: binary frames are stdin bytes; text JSON frames are
///   control (`resize`, `signal`, `stdin_eof`).
/// - Server → Client: binary frames have a 1-byte channel prefix
///   (`0x01` = stdout, `0x02` = stderr); text JSON frames are
///   `{"type":"exit","exit_code":N}` (terminal) or
///   `{"type":"error","message":"..."}` (informational, connection stays open).
///
/// Always emits exactly one `ExecResult` to `result_tx` before returning,
/// so `Execution::wait()` can never observe a silent close.
async fn attach_ws(
    client: &ApiClient,
    box_id: &str,
    execution_id: &str,
    stdin_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    stdout_tx: mpsc::UnboundedSender<String>,
    stderr_tx: mpsc::UnboundedSender<String>,
    result_tx: mpsc::UnboundedSender<ExecResult>,
) {
    let path = format!("/boxes/{}/executions/{}/attach", box_id, execution_id);
    let stream = match client.connect_ws(&path).await {
        Ok(s) => s,
        Err(e) => {
            emit_or_fallback(
                client,
                box_id,
                execution_id,
                &result_tx,
                format!("WS connect failed: {}", e),
            )
            .await;
            return;
        }
    };
    attach_ws_pump(
        client,
        box_id,
        execution_id,
        stream,
        stdin_rx,
        stdout_tx,
        stderr_tx,
        result_tx,
    )
    .await;
}

/// Pump stdin/stdout/stderr/control over a WebSocket attach. On transient
/// disconnects (watchdog timeout, close frame, stream error) the pump probes
/// the server's view of the execution; if the exec is still running it
/// reconnects within `WS_RECONNECT_BUDGET` (aligned with the runner's
/// Phase-4-reaper grace period) before falling back to an error result.
///
/// stdin is forwarded inline via `tokio::select!` instead of a separate
/// spawned task so the WS sink can be replaced on each reconnect without
/// losing buffered stdin bytes.
#[allow(clippy::too_many_arguments)]
async fn attach_ws_pump(
    client: &ApiClient,
    box_id: &str,
    execution_id: &str,
    initial_stream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    mut stdin_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    stdout_tx: mpsc::UnboundedSender<String>,
    stderr_tx: mpsc::UnboundedSender<String>,
    result_tx: mpsc::UnboundedSender<ExecResult>,
) {
    use futures::{SinkExt, StreamExt};
    use std::time::Instant;
    use tokio_tungstenite::tungstenite::Message;

    let path = format!("/boxes/{}/executions/{}/attach", box_id, execution_id);

    // State persisted across reconnects:
    //
    // - `last_error_message` surfaces the most recent server-reported text
    //   error if we end up emitting a fallback ExecResult.
    // - `user_closed_stdin` remembers whether the SDK consumer dropped its
    //   stdin sender. On reconnect we immediately send `stdin_eof` on the
    //   fresh sink so the new server-side attach gets the same signal.
    let mut last_error_message: Option<String> = None;
    let mut user_closed_stdin = false;
    let mut reconnect_budget = WS_RECONNECT_BUDGET;

    let mut current_stream = Some(initial_stream);

    'session: loop {
        let stream = match current_stream.take() {
            Some(s) => s,
            None => unreachable!("stream populated at top of loop"),
        };
        let (mut sink, mut read) = stream.split();

        // If the user closed stdin during a previous attach, propagate the
        // EOF to this fresh server-side handler immediately. Best-effort.
        if user_closed_stdin {
            let _ = sink
                .send(Message::Text(r#"{"type":"stdin_eof"}"#.to_string()))
                .await;
        }

        // Cause that ended the inner loop — used by the reconnect/fallback path.
        let disconnect_cause: String;

        // Inner pump loop. Reads from WS and forwards stdin from the
        // SDK-side channel. Returns by setting `disconnect_cause` and
        // breaking when the WS becomes unusable; returns immediately from
        // the function on a clean Exit frame.
        loop {
            tokio::select! {
                // Forward stdin bytes from the SDK consumer to the WS sink.
                // Disabled once we've observed stdin EOF — the WS reader is
                // still running so we keep waiting for the exit frame.
                stdin_msg = stdin_rx.recv(), if !user_closed_stdin => {
                    match stdin_msg {
                        Some(bytes) => {
                            if sink.send(Message::Binary(bytes)).await.is_err() {
                                disconnect_cause = "stdin write failed (sink closed)".to_string();
                                break;
                            }
                        }
                        None => {
                            // SDK consumer dropped the stdin sender.
                            user_closed_stdin = true;
                            let _ = sink
                                .send(Message::Text(r#"{"type":"stdin_eof"}"#.to_string()))
                                .await;
                            // Continue reading — server still owes us an exit frame.
                        }
                    }
                }
                next = tokio::time::timeout(WS_WATCHDOG, read.next()) => {
                    let frame = match next {
                        Err(_) => {
                            disconnect_cause = "no WS traffic for watchdog interval (likely connection idle timeout or proxy cut)".to_string();
                            break;
                        }
                        Ok(None) => {
                            disconnect_cause = last_error_message.clone().unwrap_or_else(|| {
                                "WS stream ended before exit frame (likely connection idle timeout or proxy cut)".to_string()
                            });
                            break;
                        }
                        Ok(Some(Err(e))) => {
                            disconnect_cause = format!("WS stream read error: {}", e);
                            break;
                        }
                        Ok(Some(Ok(msg))) => msg,
                    };

                    match frame {
                        Message::Binary(bytes) => {
                            if let Some((channel, payload)) = bytes.split_first() {
                                let text = String::from_utf8_lossy(payload).into_owned();
                                match *channel {
                                    0x01 => {
                                        let _ = stdout_tx.send(text);
                                    }
                                    0x02 => {
                                        let _ = stderr_tx.send(text);
                                    }
                                    other => {
                                        tracing::warn!(channel = other, "WS attach: unknown channel prefix");
                                    }
                                }
                            }
                        }
                        Message::Text(text) => match parse_control_frame(&text) {
                            ControlFrame::Exit { exit_code } => {
                                let _ = result_tx.send(ExecResult {
                                    exit_code,
                                    error_message: None,
                                });
                                return;
                            }
                            ControlFrame::Error { message } => {
                                tracing::warn!(message = %message, "WS attach: server-reported error");
                                last_error_message = Some(message);
                            }
                            ControlFrame::Unknown => {
                                tracing::warn!(text = %text, "WS attach: unrecognized text frame");
                            }
                        },
                        Message::Close(_) => {
                            disconnect_cause = last_error_message.clone().unwrap_or_else(|| {
                                "WS closed before exit frame (likely connection idle timeout or proxy cut)".to_string()
                            });
                            break;
                        }
                        // Pings are auto-replied by tungstenite; pongs/frames just reset the watchdog.
                        Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
                    }
                }
            }
        }

        // We disconnected without seeing an Exit frame. Probe the server to
        // distinguish "exec really finished" from "transient WS drop".
        match probe_execution_status(client, box_id, execution_id).await {
            ProbeResult::Terminal(result) => {
                let _ = result_tx.send(result);
                return;
            }
            ProbeResult::StillRunning | ProbeResult::Unavailable => {
                // Try to reconnect within the remaining budget.
            }
        }

        // Reconnect attempt loop with exponential backoff.
        let mut backoff = WS_RECONNECT_BACKOFF_INITIAL;
        let reconnect_start = Instant::now();
        loop {
            if reconnect_budget.is_zero() {
                tracing::warn!(
                    box_id,
                    execution_id,
                    cause = %disconnect_cause,
                    "WS attach reconnect budget exhausted",
                );
                emit_or_fallback(client, box_id, execution_id, &result_tx, disconnect_cause).await;
                return;
            }

            let sleep_for = backoff.min(reconnect_budget);
            tokio::time::sleep(sleep_for).await;
            reconnect_budget = reconnect_budget.saturating_sub(sleep_for);

            match client.connect_ws(&path).await {
                Ok(new_stream) => {
                    tracing::info!(
                        box_id,
                        execution_id,
                        reconnect_after_ms = reconnect_start.elapsed().as_millis() as u64,
                        prior_cause = %disconnect_cause,
                        "WS attach reconnected",
                    );
                    current_stream = Some(new_stream);
                    continue 'session;
                }
                Err(e) => {
                    tracing::warn!(
                        box_id,
                        execution_id,
                        error = %e,
                        "WS attach reconnect failed; will retry",
                    );
                    backoff = (backoff * 2).min(WS_RECONNECT_BACKOFF_MAX);
                }
            }
        }
    }
}

/// Outcome of probing `/executions/{id}` after a WS disconnect.
enum ProbeResult {
    /// Server reported a terminal status (`completed`/`killed`/`timed_out`).
    /// The pump should emit this `ExecResult` and stop reconnecting.
    Terminal(ExecResult),
    /// Server reports the exec is still active. Pump should attempt reconnect.
    StillRunning,
    /// Probe failed (timeout, network, etc.). Pump retries reconnect anyway —
    /// the API might be temporarily unavailable but the runner could recover.
    Unavailable,
}

/// Probe the server's view of an execution. Mirrors the legacy
/// [`emit_or_fallback`] status query but returns a structured result so the
/// pump can decide whether to reconnect.
async fn probe_execution_status(
    client: &ApiClient,
    box_id: &str,
    execution_id: &str,
) -> ProbeResult {
    let status_path = format!("/boxes/{}/executions/{}", box_id, execution_id);
    let status_probe = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.get::<ExecutionStatusResponse>(&status_path),
    );
    match status_probe.await {
        Ok(Ok(info)) => match info.status.as_str() {
            "completed" | "killed" | "timed_out" => ProbeResult::Terminal(ExecResult {
                exit_code: info.exit_code.unwrap_or(-1),
                error_message: None,
            }),
            _ => ProbeResult::StillRunning,
        },
        _ => ProbeResult::Unavailable,
    }
}

/// Decoded form of a Server→Client text-JSON frame.
enum ControlFrame {
    Exit { exit_code: i32 },
    Error { message: String },
    Unknown,
}

fn parse_control_frame(text: &str) -> ControlFrame {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return ControlFrame::Unknown;
    };
    match value.get("type").and_then(|v| v.as_str()) {
        Some("exit") => {
            let exit_code = value
                .get("exit_code")
                .and_then(|v| v.as_i64())
                .unwrap_or(-1) as i32;
            ControlFrame::Exit { exit_code }
        }
        Some("error") => {
            let message = value
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("server reported error without message")
                .to_string();
            ControlFrame::Error { message }
        }
        _ => ControlFrame::Unknown,
    }
}

/// Emit a final `ExecResult` when the WS path terminated without an `exit`
/// frame. Tries the `GET /executions/{id}` status endpoint first so callers
/// observe the real exit code on a silent connection drop; falls back to a
/// synthesized error if the status query is unavailable or still running.
async fn emit_or_fallback(
    client: &ApiClient,
    box_id: &str,
    execution_id: &str,
    result_tx: &mpsc::UnboundedSender<ExecResult>,
    cause: String,
) {
    let status_path = format!("/boxes/{}/executions/{}", box_id, execution_id);
    let status_probe = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.get::<ExecutionStatusResponse>(&status_path),
    );
    if let Ok(Ok(info)) = status_probe.await {
        match info.status.as_str() {
            "completed" | "killed" | "timed_out" => {
                let _ = result_tx.send(ExecResult {
                    exit_code: info.exit_code.unwrap_or(-1),
                    error_message: None,
                });
                return;
            }
            _ => {
                // Server says the exec is still running — surface the
                // synthesized cause so the caller sees the disconnect.
            }
        }
    }
    let _ = result_tx.send(ExecResult {
        exit_code: -1,
        error_message: Some(cause),
    });
}

// ============================================================================
// Tar Helpers
// ============================================================================

/// Create a tar archive from a host file or directory.
fn create_tar_from_path(host_src: &Path) -> BoxliteResult<Vec<u8>> {
    let mut archive = tar::Builder::new(Vec::new());

    if host_src.is_dir() {
        archive.append_dir_all(".", host_src).map_err(|e| {
            BoxliteError::Internal(format!(
                "failed to create tar from {}: {}",
                host_src.display(),
                e
            ))
        })?;
    } else {
        let file_name = host_src
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".to_string());
        let mut file = std::fs::File::open(host_src).map_err(|e| {
            BoxliteError::Internal(format!("failed to open {}: {}", host_src.display(), e))
        })?;
        archive.append_file(&file_name, &mut file).map_err(|e| {
            BoxliteError::Internal(format!(
                "failed to add {} to tar: {}",
                host_src.display(),
                e
            ))
        })?;
    }

    archive
        .into_inner()
        .map_err(|e| BoxliteError::Internal(format!("failed to finalize tar archive: {}", e)))
}

/// Extract a tar archive to a host directory.
fn extract_tar_to_path(tar_bytes: &[u8], host_dst: &Path) -> BoxliteResult<()> {
    // Ensure parent directory exists
    if let Some(parent) = host_dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            BoxliteError::Internal(format!(
                "failed to create directory {}: {}",
                parent.display(),
                e
            ))
        })?;
    }

    let mut archive = tar::Archive::new(tar_bytes);
    archive.unpack(host_dst).map_err(|e| {
        BoxliteError::Internal(format!(
            "failed to extract tar to {}: {}",
            host_dst.display(),
            e
        ))
    })
}

// ============================================================================
// Metrics Conversion
// ============================================================================

/// Convert REST box metrics response to core BoxMetrics.
fn box_metrics_from_response(resp: &BoxMetricsResponse) -> BoxMetrics {
    let (
        total_create_ms,
        guest_boot_ms,
        fs_setup_ms,
        img_prepare_ms,
        guest_rootfs_ms,
        box_config_ms,
        box_spawn_ms,
        container_init_ms,
    ) = if let Some(ref timing) = resp.boot_timing {
        (
            timing.total_create_ms.map(|v| v as u128),
            timing.guest_boot_ms.map(|v| v as u128),
            timing.filesystem_setup_ms.map(|v| v as u128),
            timing.image_prepare_ms.map(|v| v as u128),
            timing.guest_rootfs_ms.map(|v| v as u128),
            timing.box_config_ms.map(|v| v as u128),
            timing.box_spawn_ms.map(|v| v as u128),
            timing.container_init_ms.map(|v| v as u128),
        )
    } else {
        (None, None, None, None, None, None, None, None)
    };

    BoxMetrics {
        commands_executed_total: resp.commands_executed_total,
        exec_errors_total: resp.exec_errors_total,
        bytes_sent_total: resp.bytes_sent_total,
        bytes_received_total: resp.bytes_received_total,
        total_create_duration_ms: total_create_ms,
        guest_boot_duration_ms: guest_boot_ms,
        cpu_percent: resp.cpu_percent,
        memory_bytes: resp.memory_bytes,
        network_bytes_sent: resp.network_bytes_sent,
        network_bytes_received: resp.network_bytes_received,
        network_tcp_connections: resp.network_tcp_connections,
        network_tcp_errors: resp.network_tcp_errors,
        stage_filesystem_setup_ms: fs_setup_ms,
        stage_image_prepare_ms: img_prepare_ms,
        stage_guest_rootfs_ms: guest_rootfs_ms,
        stage_box_config_ms: box_config_ms,
        stage_box_spawn_ms: box_spawn_ms,
        stage_container_init_ms: container_init_ms,
    }
}

#[cfg(test)]
mod tests {
    //! Tests for the WebSocket attach pump.
    //!
    //! Each test stands up an in-process TCP listener bound to an ephemeral
    //! port. Per-connection routing inspects the first request line so the
    //! same listener handles both the WS upgrade (`/attach`) and the HTTP
    //! status fallback (`GET /executions/{id}`).

    use super::*;
    use crate::rest::client::ApiClient;
    use crate::rest::options::BoxliteRestOptions;
    use futures::{SinkExt, StreamExt};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::Mutex;
    use tokio_tungstenite::tungstenite::Message;

    /// Recorded behavior of the in-process test server.
    #[derive(Default)]
    struct ServerState {
        /// Binary frames the server received from the client (stdin bytes).
        received_stdin: Vec<Vec<u8>>,
        /// Whether `GET /executions/{id}` was hit and what we replied with.
        status_calls: u32,
    }

    /// Shorthand for the `Arc<Mutex<...>>` shared between server and client.
    type SharedState = Arc<Mutex<ServerState>>;

    /// Read the first HTTP request line + headers off a freshly accepted TCP
    /// stream. Returns the raw bytes consumed (so the WS upgrade can resume
    /// from where we left off if needed) and a parsed view of the request.
    async fn read_request_head(stream: &mut TcpStream) -> Vec<u8> {
        let mut buf = Vec::with_capacity(1024);
        let mut tmp = [0u8; 512];
        loop {
            let n = match stream.read(&mut tmp).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            buf.extend_from_slice(&tmp[..n]);
            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
            if buf.len() > 16 * 1024 {
                break;
            }
        }
        buf
    }

    /// Build an `ApiClient` pointed at `127.0.0.1:{port}`.
    fn client_for(port: u16) -> ApiClient {
        let opts = BoxliteRestOptions::new(format!("http://127.0.0.1:{}", port));
        ApiClient::new(&opts).expect("ApiClient::new")
    }

    /// Send a minimal HTTP/1.1 200 OK with a JSON body.
    async fn write_status_response(stream: &mut TcpStream, body: &str) {
        let resp = format!(
            "HTTP/1.1 200 OK\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = stream.write_all(resp.as_bytes()).await;
        let _ = stream.shutdown().await;
    }

    /// Stream wrapper that replays a buffered prefix before delegating to the
    /// underlying TcpStream. Lets us peek at the HTTP request line for
    /// routing while still letting `accept_async` re-parse it.
    struct ChainedStream {
        head: Vec<u8>,
        head_pos: usize,
        inner: TcpStream,
    }

    impl tokio::io::AsyncRead for ChainedStream {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            if self.head_pos < self.head.len() {
                let remaining = &self.head[self.head_pos..];
                let take = remaining.len().min(buf.remaining());
                buf.put_slice(&remaining[..take]);
                self.head_pos += take;
                return std::task::Poll::Ready(Ok(()));
            }
            std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
        }
    }

    impl tokio::io::AsyncWrite for ChainedStream {
        fn poll_write(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &[u8],
        ) -> std::task::Poll<Result<usize, std::io::Error>> {
            std::pin::Pin::new(&mut self.inner).poll_write(cx, buf)
        }

        fn poll_flush(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), std::io::Error>> {
            std::pin::Pin::new(&mut self.inner).poll_flush(cx)
        }

        fn poll_shutdown(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), std::io::Error>> {
            std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
        }
    }

    /// Install the WS server: peek the head, route by Upgrade header, run
    /// the per-connection handler. Subsequent connections (after the WS
    /// upgrade is consumed) reply with `status_body` if provided so the
    /// `attach_ws` status fallback path can be exercised end-to-end.
    ///
    /// The loop runs until the listener is dropped (`server.abort()` from
    /// the test) — never `return`s on its own — so status probes that
    /// arrive AFTER the WS connection closes still get answered.
    async fn run_server<F, Fut>(
        listener: TcpListener,
        state: SharedState,
        status_body: Option<String>,
        ws_handler: F,
    ) where
        F: FnOnce(tokio_tungstenite::WebSocketStream<ChainedStream>, SharedState) -> Fut
            + Send
            + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let mut ws_handler = Some(ws_handler);
        loop {
            let (mut stream, _) = match listener.accept().await {
                Ok(p) => p,
                Err(_) => return,
            };
            let head = read_request_head(&mut stream).await;
            let head_str = String::from_utf8_lossy(&head);
            let is_upgrade = head_str.to_ascii_lowercase().contains("upgrade: websocket");
            if is_upgrade {
                if let Some(handler) = ws_handler.take() {
                    let chained = ChainedStream {
                        head,
                        head_pos: 0,
                        inner: stream,
                    };
                    match tokio_tungstenite::accept_async(chained).await {
                        Ok(ws) => handler(ws, state.clone()).await,
                        Err(_) => continue,
                    }
                }
                // Already handled the upgrade once; subsequent ones close.
            } else if let Some(ref body) = status_body {
                let mut s = state.lock().await;
                s.status_calls += 1;
                drop(s);
                write_status_response(&mut stream, body).await;
            } else {
                let _ = stream.shutdown().await;
            }
        }
    }

    // ─── ws_clean_exit_emits_result ───────────────────────────────────────
    //
    // Server sends one stdout binary frame, one exit text frame, then
    // closes. Client must observe `ExecResult { exit_code: 7 }`, the
    // stdout payload, and stdin bytes must round-trip back as binary.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ws_clean_exit_emits_result() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state: SharedState = Arc::new(Mutex::new(ServerState::default()));
        let state_clone = state.clone();
        let server = tokio::spawn(async move {
            run_server(listener, state_clone, None, |mut ws, state| async move {
                // Drain at least one stdin frame BEFORE sending exit so the
                // assertion below has something to observe — without this
                // ordering the client may abort its stdin pump before the
                // bytes traverse the WS.
                if let Some(Ok(Message::Binary(b))) = ws.next().await {
                    let mut s = state.lock().await;
                    s.received_stdin.push(b);
                }
                ws.send(Message::Binary(vec![0x01, b'h', b'i']))
                    .await
                    .unwrap();
                ws.send(Message::Text(r#"{"type":"exit","exit_code":7}"#.into()))
                    .await
                    .unwrap();
                let _ = ws.close(None).await;
            })
            .await;
        });

        let client = client_for(port);
        let (stdout_tx, mut stdout_rx) = mpsc::unbounded_channel::<String>();
        let (stderr_tx, _stderr_rx) = mpsc::unbounded_channel::<String>();
        let (stdin_tx, stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (result_tx, mut result_rx) = mpsc::unbounded_channel::<ExecResult>();

        // Push stdin before the pump runs; it'll be drained as soon as
        // the WS connection is up.
        stdin_tx.send(b"hello".to_vec()).unwrap();

        let attach = tokio::spawn(async move {
            attach_ws(
                &client, "box1", "exec1", stdin_rx, stdout_tx, stderr_tx, result_tx,
            )
            .await;
        });

        let res = tokio::time::timeout(Duration::from_secs(3), result_rx.recv())
            .await
            .expect("result channel timed out")
            .expect("result channel closed without value");
        assert_eq!(res.exit_code, 7);
        assert!(res.error_message.is_none());

        let out = tokio::time::timeout(Duration::from_secs(1), stdout_rx.recv())
            .await
            .expect("stdout timed out")
            .expect("stdout channel closed");
        assert_eq!(out, "hi");

        attach.await.unwrap();
        let s = state.lock().await;
        assert!(
            s.received_stdin.iter().any(|b| b == b"hello"),
            "server never observed stdin payload; got {:?}",
            s.received_stdin
        );
        drop(s);
        server.abort();
    }

    // ─── ws_close_without_exit_falls_back_to_status ──────────────────────
    //
    // Server sends one stdout frame, then closes WITHOUT an exit frame.
    // The client must hit `GET /executions/{id}` and surface the real exit
    // code (42) from that response — never a generic "stream closed" error.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ws_close_without_exit_falls_back_to_status() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state: SharedState = Arc::new(Mutex::new(ServerState::default()));
        let status_body =
            r#"{"execution_id":"exec1","status":"completed","exit_code":42}"#.to_string();
        let state_clone = state.clone();
        let server = tokio::spawn(async move {
            run_server(
                listener,
                state_clone,
                Some(status_body),
                |mut ws, _state| async move {
                    ws.send(Message::Binary(vec![0x01, b'x'])).await.unwrap();
                    let _ = ws.close(None).await;
                },
            )
            .await;
        });

        let client = client_for(port);
        let (stdout_tx, _stdout_rx) = mpsc::unbounded_channel::<String>();
        let (stderr_tx, _stderr_rx) = mpsc::unbounded_channel::<String>();
        let (_stdin_tx, stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (result_tx, mut result_rx) = mpsc::unbounded_channel::<ExecResult>();

        let attach = tokio::spawn(async move {
            attach_ws(
                &client, "box1", "exec1", stdin_rx, stdout_tx, stderr_tx, result_tx,
            )
            .await;
        });

        let res = tokio::time::timeout(Duration::from_secs(3), result_rx.recv())
            .await
            .expect("result channel timed out")
            .expect("result channel closed without value");
        assert_eq!(
            res.exit_code, 42,
            "expected status fallback to surface real exit code"
        );
        assert!(res.error_message.is_none());

        attach.await.unwrap();
        let s = state.lock().await;
        assert!(
            s.status_calls >= 1,
            "status fallback endpoint was never called"
        );
        drop(s);
        server.abort();
    }

    // ─── ws_watchdog_fires_when_idle ─────────────────────────────────────
    //
    // Server accepts the upgrade and then goes silent. The cfg(test)
    // override keeps WS_WATCHDOG short (~300 ms) so this test finishes
    // promptly. The emitted ExecResult must name the watchdog as cause —
    // otherwise we've regressed the silent-stall protection.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ws_watchdog_fires_when_idle() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state: SharedState = Arc::new(Mutex::new(ServerState::default()));
        let state_clone = state.clone();
        let server = tokio::spawn(async move {
            run_server(listener, state_clone, None, |ws, _state| async move {
                // Hold the connection open without sending anything.
                // Wait long enough for the client watchdog to fire and
                // close the WS from its side.
                let _kept_alive = ws;
                tokio::time::sleep(Duration::from_secs(2)).await;
            })
            .await;
        });

        let client = client_for(port);
        let (stdout_tx, _stdout_rx) = mpsc::unbounded_channel::<String>();
        let (stderr_tx, _stderr_rx) = mpsc::unbounded_channel::<String>();
        let (_stdin_tx, stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (result_tx, mut result_rx) = mpsc::unbounded_channel::<ExecResult>();

        let attach = tokio::spawn(async move {
            attach_ws(
                &client, "box1", "exec1", stdin_rx, stdout_tx, stderr_tx, result_tx,
            )
            .await;
        });

        let res = tokio::time::timeout(Duration::from_secs(3), result_rx.recv())
            .await
            .expect("watchdog never fired")
            .expect("result channel closed without value");
        assert_eq!(res.exit_code, -1);
        let msg = res.error_message.expect("expected diagnostic message");
        assert!(msg.contains("watchdog"), "unexpected diagnostic: {:?}", msg);

        attach.await.unwrap();
        server.abort();
    }

    // ─── ws_text_error_frame_logs_but_continues ──────────────────────────
    //
    // An informational `error` text frame must NOT terminate the
    // connection. Only the subsequent `exit` frame does. This guards
    // against treating a recoverable signal-rejection as a terminal error.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ws_text_error_frame_logs_but_continues() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state: SharedState = Arc::new(Mutex::new(ServerState::default()));
        let state_clone = state.clone();
        let server = tokio::spawn(async move {
            run_server(listener, state_clone, None, |mut ws, _state| async move {
                ws.send(Message::Text(
                    r#"{"type":"error","message":"signal not allowed"}"#.into(),
                ))
                .await
                .unwrap();
                ws.send(Message::Text(r#"{"type":"exit","exit_code":0}"#.into()))
                    .await
                    .unwrap();
                let _ = ws.close(None).await;
            })
            .await;
        });

        let client = client_for(port);
        let (stdout_tx, _stdout_rx) = mpsc::unbounded_channel::<String>();
        let (stderr_tx, _stderr_rx) = mpsc::unbounded_channel::<String>();
        let (_stdin_tx, stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (result_tx, mut result_rx) = mpsc::unbounded_channel::<ExecResult>();

        let attach = tokio::spawn(async move {
            attach_ws(
                &client, "box1", "exec1", stdin_rx, stdout_tx, stderr_tx, result_tx,
            )
            .await;
        });

        let res = tokio::time::timeout(Duration::from_secs(3), result_rx.recv())
            .await
            .expect("result channel timed out")
            .expect("result channel closed without value");
        assert_eq!(
            res.exit_code, 0,
            "informational error frame must not terminate the attach"
        );
        assert!(res.error_message.is_none());

        attach.await.unwrap();
        server.abort();
    }
}
