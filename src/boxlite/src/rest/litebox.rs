//! RestBox — implements BoxBackend for the REST API.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

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
    ExecResponse, ExecutionInfoResponse, ExportBoxRequest, ListSnapshotsResponse, SnapshotResponse,
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

        // 3a. Spawn SSE reader task for output streaming.
        //
        // The SSE reader is the *fast path* for terminal results. On
        // transport error or EOF without a terminal event, we do NOT
        // fabricate an `ExecResult` here. The poller (3b) is the sole
        // source of *synthesised* terminal results — but only after the
        // SSE reader has confirmed it is no longer producing output, so
        // transport-status errors cannot race a still-healthy stream.
        //
        // Coordination model: the SSE reader is the *sole* emitter of
        // the final `ExecResult`. The poller is signal-only — it places
        // a terminal `ExecutionInfoResponse` in `terminal_info` and
        // raises `terminal_signaled`, then exits without ever sending
        // its own result. This guarantees that the consumer's `wait()`
        // cannot see a "success" result race ahead of the SSE drain
        // and lose tail output.
        //
        // - `sse_done`: set when the SSE reader exits. The poller checks
        //   this before declaring a transport-error fallback so a
        //   status-only error cannot race an in-flight SSE exit event.
        // - `terminal_signaled`: set by the poller on terminal status
        //   so the SSE reader starts its bounded drain even if the
        //   server keeps the connection open with keepalive bytes.
        // - `terminal_info`: the polled status snapshot the SSE reader
        //   should synthesise from once drain completes (only used if
        //   no SSE terminal event arrives during drain).
        // - `sse_failure`: transport failure from the SSE reader,
        //   surfaced in the synthesised result so a completed-from-status
        //   result cannot silently mask truncated output.
        let sse_done = Arc::new(AtomicBool::new(false));
        let terminal_signaled = Arc::new(AtomicBool::new(false));
        let sse_failure: Arc<parking_lot::Mutex<Option<String>>> =
            Arc::new(parking_lot::Mutex::new(None));
        let terminal_info: Arc<parking_lot::Mutex<Option<ExecutionInfoResponse>>> =
            Arc::new(parking_lot::Mutex::new(None));
        let sse_done_for_sse = sse_done.clone();
        let terminal_signaled_for_sse = terminal_signaled.clone();
        let sse_failure_for_sse = sse_failure.clone();
        let terminal_info_for_sse = terminal_info.clone();

        let sse_client = self.client.clone();
        let sse_box_id = box_id.clone();
        let sse_exec_id = execution_id.clone();
        let result_tx_for_poller = result_tx.clone();
        let terminal_info_after_sse = terminal_info.clone();
        let result_tx_after_sse = result_tx.clone();
        tokio::spawn(async move {
            let outcome = read_sse_output(
                &sse_client,
                &sse_box_id,
                &sse_exec_id,
                stdout_tx,
                stderr_tx,
                result_tx.clone(),
                terminal_signaled_for_sse,
                terminal_info_for_sse,
                sse_failure_for_sse.clone(),
            )
            .await;
            match &outcome {
                Ok(true) => { /* normal: SSE delivered terminal */ }
                Ok(false) => {
                    let mut slot = sse_failure_for_sse.lock();
                    if slot.is_none() {
                        *slot = Some(
                            "SSE stream closed before delivering a terminal event".to_string(),
                        );
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        "SSE reader task failed; status poller will determine final result: {}",
                        e
                    );
                    let mut slot = sse_failure_for_sse.lock();
                    if slot.is_none() {
                        *slot = Some(e.to_string());
                    }
                }
            }
            // Order matters: set `sse_done` BEFORE consuming
            // `terminal_info`. Otherwise a poller tick that lands
            // between our consume-check and our sse_done store would
            // see sse_done=false, place its terminal snapshot, and exit
            // without us picking it up — stranding `wait()` on a closed
            // channel. With this ordering, any poller tick after we set
            // sse_done takes its own direct-send branch, and any poller
            // tick that already stored will be visible to the take()
            // below.
            sse_done_for_sse.store(true, Ordering::Release);
            if !matches!(outcome, Ok(true))
                && let Some(info) = terminal_info_after_sse.lock().take()
            {
                let sse_err = sse_failure_for_sse.lock().clone();
                let normal_completion = info.status == "completed" && info.exit_code.is_some();
                let (final_exit, error_message) = if let Some(sse_err) = sse_err {
                    // SSE failure → override exit_code so consumers
                    // using `.success()` / nonzero-exit checks treat
                    // it as failure rather than trusting the
                    // process-side exit code that may have been
                    // collected after output truncation.
                    (
                        -1,
                        Some(format!(
                            "process status=`{}` exit={:?}, but SSE output stream failed (output may be truncated): {}",
                            info.status, info.exit_code, sse_err
                        )),
                    )
                } else if normal_completion {
                    (info.exit_code.unwrap_or(-1), info.error_message)
                } else {
                    (
                            info.exit_code.unwrap_or(-1),
                            info.error_message.or_else(|| {
                                Some(format!(
                                    "execution reached terminal status `{}` (delivered via status-poll, not SSE exit event)",
                                    info.status
                                ))
                            }),
                        )
                };
                let _ = result_tx_after_sse.send(ExecResult {
                    exit_code: final_exit,
                    error_message,
                });
            }
        });

        // 3b. Spawn independent status poller.
        //
        // Wall-clock driven (NOT byte-driven), so it cannot be masked by a
        // server that keeps the SSE connection alive with keepalive bytes
        // but never delivers `exit`. Polls `GET /executions/{id}` every
        // POLL_INTERVAL; on terminal status, sends `ExecResult` and exits.
        // If the SSE reader already delivered an exit, the consumer's
        // `wait()` returns from the first message and a later poll-driven
        // result is harmless (it sits in the channel until dropped with
        // the rest of the Execution).
        //
        // Bounded by MAX_POLLS so we don't poll forever for a stuck VM —
        // 24h at 30s intervals = 2880 polls.
        let poll_client = self.client.clone();
        let poll_box_id = box_id.clone();
        let poll_exec_id = execution_id.clone();
        let poll_result_tx = result_tx_for_poller;
        let sse_done_for_poll = sse_done.clone();
        let terminal_signaled_for_poll = terminal_signaled.clone();
        let sse_failure_for_poll = sse_failure.clone();
        let terminal_info_for_poll = terminal_info.clone();
        tokio::spawn(async move {
            const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);
            // Per-poll timeout. The shared `Client` carries a 300s default
            // (`Client::DEFAULT_TIMEOUT`) for unary calls; against a
            // black-holed status endpoint that would let a single tick
            // monopolise wait() for 5 minutes, dwarfing POLL_INTERVAL and
            // pushing actual cycle time to ~5min/iter when chained with
            // the 5-error giveup threshold (≈25 minutes before bail).
            // Cap each poll explicitly so the consecutive-error book-
            // keeping reflects real elapsed time (≈2.5 min @ 5×30s).
            const PER_POLL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
            // Bail if status keeps failing — e.g. server returns 404 while
            // it owns the SSE stream, or the box is gone. Without this,
            // `wait()` would block silently retrying a permanently-broken
            // endpoint.
            const MAX_CONSECUTIVE_ERRORS: usize = 5; // ~2.5min at 30s

            // No fixed total-time cap: the SDK does not impose its own
            // execution timeout (`BoxCommand` has none by default), so a
            // legitimately long-running command must not be turned into a
            // false `-1` failure based on poll count alone. The loop
            // exits when (a) the receiver is dropped (consumer gave up),
            // (b) status reaches terminal, or (c) the status endpoint
            // becomes persistently broken AND the SSE reader has also
            // exited.
            let path = format!("/boxes/{}/executions/{}", poll_box_id, poll_exec_id);
            let mut interval = tokio::time::interval(POLL_INTERVAL);
            interval.tick().await; // skip immediate first tick
            let mut consecutive_errors = 0usize;
            // `last_error` is only ever read after a status-poll Err
            // increments `consecutive_errors`, and every read path is
            // preceded by a Some(...) assignment in the same Err arm
            // — so the initial None is never observed. Annotate to
            // satisfy `unused_assignments` without restructuring.
            #[allow(unused_assignments)]
            let mut last_error: Option<String> = None;

            loop {
                interval.tick().await;
                if poll_result_tx.is_closed() {
                    return;
                }
                // Wrap each poll in its own timeout so a stuck status
                // endpoint can't extend the consecutive-error window
                // beyond the documented bound. A timeout maps to the
                // same error path as a network failure.
                let poll_call = poll_client.get::<ExecutionInfoResponse>(&path);
                let poll_outcome = match tokio::time::timeout(PER_POLL_TIMEOUT, poll_call).await {
                    Ok(result) => result,
                    Err(_) => Err(BoxliteError::Network(format!(
                        "status poll exceeded per-poll timeout ({}s)",
                        PER_POLL_TIMEOUT.as_secs()
                    ))),
                };
                match poll_outcome {
                    Ok(info) if info.is_terminal() => {
                        // Two delivery paths:
                        // (a) SSE reader is still alive — hand off the
                        //     terminal snapshot and let the SSE task
                        //     emit the final ExecResult after drain. This
                        //     guarantees output ordering.
                        // (b) SSE reader has already exited — the
                        //     handoff has no consumer, so we must emit
                        //     the result here ourselves (with any sse
                        //     failure diagnostic) to avoid stranding
                        //     `wait()` on a closed channel.
                        if sse_done_for_poll.load(Ordering::Acquire) {
                            let sse_err = sse_failure_for_poll.lock().clone();
                            let normal_completion =
                                info.status == "completed" && info.exit_code.is_some();
                            let (final_exit, error_message) = if let Some(sse_err) = sse_err {
                                (
                                    -1,
                                    Some(format!(
                                        "process status=`{}` exit={:?}, but SSE output stream failed (output may be truncated): {}",
                                        info.status, info.exit_code, sse_err
                                    )),
                                )
                            } else if normal_completion {
                                (info.exit_code.unwrap_or(-1), info.error_message)
                            } else {
                                (
                                    info.exit_code.unwrap_or(-1),
                                    info.error_message.or_else(|| Some(format!(
                                        "execution reached terminal status `{}` (delivered via status-poll, not SSE exit event)",
                                        info.status
                                    ))),
                                )
                            };
                            let _ = poll_result_tx.send(ExecResult {
                                exit_code: final_exit,
                                error_message,
                            });
                        } else {
                            *terminal_info_for_poll.lock() = Some(info);
                            terminal_signaled_for_poll.store(true, Ordering::Release);
                            // Re-check sse_done after storing: the SSE
                            // reader may have exited and run its
                            // post-loop synthesis (which saw an empty
                            // terminal_info) between our earlier
                            // sse_done check and our store. If so, no
                            // one will consume the value we just placed
                            // — take it back and emit directly so
                            // `wait()` doesn't see a closed channel.
                            if sse_done_for_poll.load(Ordering::Acquire)
                                && let Some(info) = terminal_info_for_poll.lock().take()
                            {
                                let sse_err = sse_failure_for_poll.lock().clone();
                                let normal_completion =
                                    info.status == "completed" && info.exit_code.is_some();
                                let (final_exit, error_message) = if let Some(sse_err) = sse_err {
                                    (
                                        -1,
                                        Some(format!(
                                            "process status=`{}` exit={:?}, but SSE output stream failed (output may be truncated): {}",
                                            info.status, info.exit_code, sse_err
                                        )),
                                    )
                                } else if normal_completion {
                                    (info.exit_code.unwrap_or(-1), info.error_message)
                                } else {
                                    (
                                        info.exit_code.unwrap_or(-1),
                                        info.error_message.or_else(|| Some(format!(
                                            "execution reached terminal status `{}` (delivered via status-poll, not SSE exit event)",
                                            info.status
                                        ))),
                                    )
                                };
                                let _ = poll_result_tx.send(ExecResult {
                                    exit_code: final_exit,
                                    error_message,
                                });
                            }
                        }
                        return;
                    }
                    Ok(_running) => {
                        consecutive_errors = 0;
                        continue;
                    }
                    Err(e) => {
                        consecutive_errors += 1;
                        last_error = Some(e.to_string());
                        // Status polling is *advisory* while SSE is
                        // still attached. The in-tree REST server
                        // (`stream_execution_output` in
                        // src/cli/.../handlers/executions.rs) removes
                        // the execution from its registry the moment
                        // SSE attaches, so `GET /executions/{id}`
                        // returns 404 for the entire lifetime of a
                        // healthy stream. Treating those 404s as fatal
                        // would kill any execution longer than the
                        // error window. We therefore only give up when
                        // BOTH signal sources are dead: SSE has exited
                        // AND status has been broken for ~2.5min.
                        // The SSE reader's own idle probe still
                        // bounds the "silent stream" pathology by
                        // surfacing terminal status as soon as the
                        // server endpoint becomes reachable, so we
                        // do not need a separate unconditional cap
                        // here.
                        let sse_already_done = sse_done_for_poll.load(Ordering::Acquire);
                        let give_up =
                            consecutive_errors >= MAX_CONSECUTIVE_ERRORS && sse_already_done;
                        if give_up {
                            // Drive every code path to emit *exactly
                            // one* ExecResult:
                            //
                            // 1. Always seed `sse_failure` so any
                            //    synthesised result is annotated as
                            //    transport-failed (and downgraded to
                            //    exit_code -1).
                            // 2. Always store a synthetic
                            //    `terminal_info` so the SSE reader's
                            //    post-loop synthesis (if it runs) has
                            //    something to consume. Without this,
                            //    when SSE is alive but never delivers
                            //    exit, the reader could drop senders
                            //    without ever emitting a result.
                            // 3. Raise `terminal_signaled` so the SSE
                            //    reader exits drain promptly and runs
                            //    its synthesis path.
                            // 4. If SSE has already exited, send
                            //    directly here.
                            {
                                let mut slot = sse_failure_for_poll.lock();
                                slot.get_or_insert_with(|| {
                                    format!(
                                        "status check failed {} times (last error: {})",
                                        consecutive_errors,
                                        last_error.clone().unwrap_or_else(|| "<n/a>".to_string()),
                                    )
                                });
                            }
                            // Synthetic ExecutionInfoResponse standing in
                            // for "we don't know — declared a transport
                            // failure." Status field "unknown" is
                            // non-terminal-named to avoid colliding with
                            // real server statuses; consumers see the
                            // diagnostic via error_message.
                            *terminal_info_for_poll.lock() = Some(ExecutionInfoResponse {
                                execution_id: poll_exec_id.clone(),
                                status: "transport_failure".to_string(),
                                exit_code: None,
                                error_message: Some(format!(
                                    "status check failed {} times in a row (last error: {}); execution outcome unknown",
                                    consecutive_errors,
                                    last_error.clone().unwrap_or_else(|| "<n/a>".to_string()),
                                )),
                            });
                            terminal_signaled_for_poll.store(true, Ordering::Release);
                            if sse_already_done {
                                let _ = poll_result_tx.send(ExecResult {
                                    exit_code: -1,
                                    error_message: Some(format!(
                                        "status check failed {} times in a row (last error: {}); execution outcome unknown",
                                        consecutive_errors,
                                        last_error.unwrap_or_else(|| "<n/a>".to_string())
                                    )),
                                });
                            }
                            return;
                        }
                        continue;
                    }
                }
            }
        });

        // 4. Spawn stdin writer task
        let stdin_client = self.client.clone();
        let stdin_box_id = box_id.clone();
        let stdin_exec_id = execution_id.clone();
        tokio::spawn(async move {
            forward_stdin(&stdin_client, &stdin_box_id, &stdin_exec_id, stdin_rx).await;
        });

        // 5. Build Execution handle
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
// SSE Output Streaming
// ============================================================================

/// Read SSE events from the execution output endpoint and forward to channels.
/// Returns whether a valid SSE terminal event (`exit`/`error`) was
/// observed during the stream. The caller records this so a clean EOF
/// before any terminal event can be surfaced as a transport-level
/// failure to the poller, ensuring `wait()` cannot report success while
/// silently truncating output.
//
// The argument list is wide because the SSE reader and the status poller
// share several pieces of coordination state (sse_failure, terminal_info,
// terminal_signaled). Bundling them into a `SseReadCtx` struct would
// obscure which clones the spawn closure needs vs which the reader owns,
// so we accept the wider signature here.
#[allow(clippy::too_many_arguments)]
async fn read_sse_output(
    client: &ApiClient,
    box_id: &str,
    execution_id: &str,
    stdout_tx: mpsc::UnboundedSender<String>,
    stderr_tx: mpsc::UnboundedSender<String>,
    result_tx: mpsc::UnboundedSender<ExecResult>,
    terminal_signaled: Arc<AtomicBool>,
    terminal_info: Arc<parking_lot::Mutex<Option<ExecutionInfoResponse>>>,
    sse_failure: Arc<parking_lot::Mutex<Option<String>>>,
) -> BoxliteResult<bool> {
    let path = format!("/boxes/{}/executions/{}/output", box_id, execution_id);
    // SSE streams stay open for the lifetime of the execution; route through
    // the streaming client which has no total request timeout. We still
    // bound *header arrival* with a finite timeout — without it, a server
    // or proxy that accepts the connection but never sends headers would
    // hang this task forever, holding the channels open and blocking
    // `Execution::wait()` indefinitely.
    const SSE_HEADER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

    let builder = client.authorized_streaming_get(&path).await?;
    let send_fut = builder.header("Accept", "text/event-stream").send();
    let resp = match tokio::time::timeout(SSE_HEADER_TIMEOUT, send_fut).await {
        Ok(Ok(resp)) => resp,
        Ok(Err(e)) => {
            return Err(BoxliteError::Internal(format!("SSE connect failed: {}", e)));
        }
        Err(_) => {
            return Err(BoxliteError::Internal(format!(
                "SSE connect timeout: no response headers within {}s",
                SSE_HEADER_TIMEOUT.as_secs()
            )));
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        // The streaming client has no total timeout, so a server that
        // sends error headers but never finishes the body would leave
        // this `text()` call awaiting forever. The SSE reader would
        // never return, never set `sse_done`, and the poller (which
        // is advisory-only while `sse_done == false`) could not
        // deliver a terminal result. Bound the body read.
        const ERROR_BODY_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
        let text = match tokio::time::timeout(ERROR_BODY_READ_TIMEOUT, resp.text()).await {
            Ok(Ok(t)) => t,
            Ok(Err(_)) => String::new(),
            Err(_) => "<error body read exceeded 5s timeout>".to_string(),
        };
        return Err(BoxliteError::Internal(format!(
            "SSE stream failed (HTTP {}): {}",
            status, text
        )));
    }

    // Read SSE stream line by line.
    //
    // Idle handling: a silent long-running command can legitimately produce
    // no bytes for arbitrary periods. When no bytes arrive within
    // `SSE_IDLE_POLL`, query `GET /executions/{id}` to confirm remote state:
    //   - status=running   -> reset and keep waiting
    //   - status=terminal  -> enter *drain mode* (short timeout) so any
    //                          in-flight `exit`/`stdout`/`stderr` events
    //                          still buffered on the wire have a chance to
    //                          arrive before we synthesise from status. If
    //                          drain times out, *then* synthesise. Failing
    //                          to do this would truncate trailing output.
    //   - status fails     -> surface a transport error
    //
    // EOF handling: if the stream returns `None` before we've seen an `exit`
    // event, status-poll once and synthesise based on the result instead of
    // silently returning Ok (which would leave `Execution::wait()` blocked
    // forever).
    //
    // This avoids: the original 24h hard cap (iter 1), the byte-idle
    // false-positives (iter 3), terminal-status output truncation (iter 4),
    // and EOF-without-exit hangs (iter 4).
    const SSE_IDLE_POLL: std::time::Duration = std::time::Duration::from_secs(60);
    const SSE_DRAIN_AFTER_TERMINAL: std::time::Duration = std::time::Duration::from_secs(5);

    let status_path = format!("/boxes/{}/executions/{}", box_id, execution_id);

    use futures::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut current_event = String::new();
    let mut current_data = String::new();
    let mut event_count: u64 = 0;
    let mut last_event_at = std::time::Instant::now();
    // Tracks the last time we received a *meaningful* dispatched event
    // (stdout/stderr/exit/error), as opposed to raw byte arrival which
    // is incremented even by SSE keepalive comments. The drain-idle
    // window uses this so a server sending periodic keepalives can't
    // prevent the drain from ever ending.
    let mut last_meaningful_at = std::time::Instant::now();
    let mut exit_seen = false;
    // Terminal `ExecResult` parsed from a successful SSE `exit`/`error`
    // event. We hold it through the bounded drain instead of sending it
    // immediately; if the stream then errors during drain, we annotate
    // the result with the failure before emitting. Without this hold,
    // `wait()` could see a clean success result before truncation
    // becomes apparent.
    let mut sse_terminal_result: Option<ExecResult> = None;
    // Once set, we know the remote process has completed and we're trying
    // to drain trailing output before declaring the stream done.
    let mut pending_terminal: Option<ExecutionInfoResponse> = None;
    // After a valid SSE terminal event (or external terminal signal from
    // the poller) we must NOT keep waiting for EOF indefinitely — some
    // servers/proxies leave the connection open after `exit`, which
    // would keep stdout/stderr senders alive forever. But we also can't
    // use a fixed wall-clock cutoff: a process that produced a large
    // backlog of stdout right before exiting may still be flushing those
    // bytes through the stream. Approach: enter "drain mode" on
    // terminal, then break only when bytes have been *idle* for
    // `TERMINAL_DRAIN_IDLE`. Each arriving chunk extends the drain
    // window naturally, so large trailing output is not truncated, while
    // a silent keepalive-only stream still exits promptly.
    const TERMINAL_DRAIN_IDLE: std::time::Duration = std::time::Duration::from_secs(2);
    // Hard wall-clock cap on the drain regardless of activity. Backstop
    // against pathological servers that keep refreshing the drain timer
    // forever via attacker-controlled `event: stdout`/`data: ...` floods.
    // Set generously (5 min) so legitimate large trailing output backlogs
    // (hundreds of MB drained over a slow link) can complete; legitimate
    // commands stop draining via byte-idle long before this cap fires.
    const TERMINAL_DRAIN_MAX: std::time::Duration = std::time::Duration::from_secs(300);
    let mut terminal_drain_started: Option<std::time::Instant> = None;
    // When the idle probe runs (because no meaningful events for
    // `SSE_IDLE_POLL`), we record the timestamp so the next probe is
    // throttled to one-per-`SSE_IDLE_POLL` window. Without this,
    // `last_meaningful_at`-based saturation produces a 0-duration
    // wakeup that fires the probe again immediately if it returned a
    // non-terminal/error result, which becomes a hot loop against the
    // status endpoint for any quiet long-running command.
    // Reset back to `None` whenever a real meaningful event arrives,
    // so a fresh idle window starts from the next quiet period.
    let mut last_idle_probe_at: Option<std::time::Instant> = None;
    // Opt-in cap from `BoxliteRestOptions::sse_silence_max`. `None`
    // means unbounded (current default). When set, `Execution::wait()`
    // returns a transport-failure ExecResult after this much silence
    // (no stdout/stderr/exit events; SSE keepalive comments do NOT
    // refresh the timer — that's the whole point).
    let sse_silence_max = client.sse_silence_max();

    loop {
        // Opt-in silence cap. Anchored on `last_meaningful_at` so axum
        // keepalive comments (`:\n\n` every ~15s) cannot perpetually
        // refresh the deadline. We check at the top of every loop
        // iteration so even a stream with sub-cap keepalives is caught.
        if let Some(max) = sse_silence_max {
            let elapsed = last_meaningful_at.elapsed();
            if elapsed >= max {
                tracing::warn!(
                    events_seen = event_count,
                    silence_secs = elapsed.as_secs_f64(),
                    cap_secs = max.as_secs_f64(),
                    "SSE silence exceeded sse_silence_max — synthesising transport failure"
                );
                {
                    let mut slot = sse_failure.lock();
                    if slot.is_none() {
                        *slot = Some(format!(
                            "SSE silent for {:.1}s exceeded sse_silence_max ({:.1}s)",
                            elapsed.as_secs_f64(),
                            max.as_secs_f64(),
                        ));
                    }
                }
                let _ = result_tx.send(ExecResult {
                    exit_code: -1,
                    error_message: Some(format!(
                        "SSE silent for {:.1}s (no stdout/stderr/exit events); \
                         exceeded sse_silence_max={:.1}s — declaring transport failure",
                        elapsed.as_secs_f64(),
                        max.as_secs_f64(),
                    )),
                });
                return Ok(true);
            }
        }

        // External terminal signal: poller saw terminal status. Start
        // the bounded *byte-idle* drain so we can flush any in-flight
        // bytes and then exit even if the server keeps the stream open
        // with keepalives. Reset `last_meaningful_at` to NOW so a
        // long-quiet command's idle window starts from this moment
        // rather than from whenever the last stdout chunk was.
        if terminal_drain_started.is_none() && terminal_signaled.load(Ordering::Acquire) {
            terminal_drain_started = Some(std::time::Instant::now());
            last_meaningful_at = std::time::Instant::now();
            tracing::debug!(
                events_seen = event_count,
                "external terminal signal received — entering byte-idle drain"
            );
        }

        // While in drain mode, exit when no MEANINGFUL event has been
        // dispatched for `TERMINAL_DRAIN_IDLE`. We deliberately use
        // `last_meaningful_at` (updated only by stdout/stderr/exit/error
        // dispatches) instead of `last_event_at` (which is reset by any
        // raw chunk including keepalive comments) — otherwise a server
        // sending sub-2s keepalive bytes after exit would keep refreshing
        // the timer and stdout/stderr senders would never drop.
        if let Some(started) = terminal_drain_started {
            if last_meaningful_at.elapsed() >= TERMINAL_DRAIN_IDLE {
                break;
            }
            if started.elapsed() >= TERMINAL_DRAIN_MAX {
                tracing::warn!(
                    events_seen = event_count,
                    elapsed_secs = started.elapsed().as_secs_f64(),
                    "terminal drain hit hard wall-clock cap; closing stream"
                );
                // Hitting the cap is unsafe: bytes were still arriving,
                // so trailing output may be lost. Record this as an SSE
                // failure so the held terminal result is annotated with
                // a truncation diagnostic instead of looking like clean
                // success.
                let mut slot = sse_failure.lock();
                if slot.is_none() {
                    *slot = Some(format!(
                        "terminal drain exceeded hard wall-clock cap of {}s while output was still arriving — output may be truncated",
                        TERMINAL_DRAIN_MAX.as_secs()
                    ));
                }
                break;
            }
        }

        let timeout_for_iter = if terminal_drain_started.is_some() {
            TERMINAL_DRAIN_IDLE.saturating_sub(last_meaningful_at.elapsed())
        } else if pending_terminal.is_some() {
            SSE_DRAIN_AFTER_TERMINAL
        } else {
            // Idle-probe trigger is based on last MEANINGFUL event,
            // not raw chunks. axum's `KeepAlive::default()` sends
            // `:\n\n` comments every ~15s; if we anchored on raw
            // chunk arrival (last_event_at), each keepalive would
            // restart the 60s window and the probe would never
            // fire on a server that's silent at the application
            // level but alive at the transport level.
            //
            // Once we've already issued a probe (and are still
            // quiet), throttle subsequent probes to one per
            // `SSE_IDLE_POLL`. Otherwise a non-terminal probe
            // result would let the saturating-sub return zero on
            // the next loop iteration and we'd hammer the status
            // endpoint.
            let baseline_elapsed = match last_idle_probe_at {
                Some(t) => t.elapsed(),
                None => last_meaningful_at.elapsed(),
            };
            SSE_IDLE_POLL.saturating_sub(baseline_elapsed)
        };

        // Don't sleep through the silence cap. If the configured
        // budget is shorter than the iteration's natural timeout
        // (idle-probe / drain), wake up at the deadline so the
        // top-of-loop check fires precisely instead of late.
        let timeout_for_iter = match sse_silence_max {
            Some(max) => {
                let remaining = max.saturating_sub(last_meaningful_at.elapsed());
                std::cmp::min(timeout_for_iter, remaining)
            }
            None => timeout_for_iter,
        };

        let next = match tokio::time::timeout(timeout_for_iter, stream.next()).await {
            Ok(item) => item,
            Err(_) => {
                if terminal_drain_started.is_some() {
                    // Byte-idle within the drain window. Loop top will
                    // detect the elapsed deadline and break.
                    continue;
                }
                if let Some(info) = pending_terminal.take() {
                    // Drain timed out — process is done and no more bytes
                    // are coming. The SSE stream never delivered a real
                    // `exit` event, so override exit_code to -1 to
                    // signal a transport-level failure to consumers
                    // using `.success()` checks. Trusting the polled
                    // exit_code here would let truncated-output
                    // executions look identical to clean successes.
                    tracing::info!(
                        events_seen = event_count,
                        idle_secs = last_event_at.elapsed().as_secs_f64(),
                        status = %info.status,
                        "SSE drain timeout after terminal status — synthesising exit"
                    );
                    let _ = result_tx.send(ExecResult {
                        exit_code: -1,
                        error_message: Some(format!(
                            "process exit_code={:?}, status={}; but SSE stream did not deliver `exit` event before drain timeout — trailing output may be truncated{}",
                            info.exit_code,
                            info.status,
                            info.error_message
                                .map(|e| format!(" (server: {})", e))
                                .unwrap_or_default()
                        )),
                    });
                    return Ok(true);
                }
                // First idle — verify remote state. Use a short bounded
                // timeout on the probe instead of the client-wide 300s,
                // so a degraded status endpoint cannot stall the SSE
                // reader for minutes. Bytes that arrive on the stream
                // during the probe are TCP-buffered and read on the
                // next loop iteration.
                const STATUS_PROBE_MAX: std::time::Duration = std::time::Duration::from_secs(5);
                let probe_fut = client.get::<ExecutionInfoResponse>(&status_path);
                // Stamp BEFORE awaiting so a probe-timeout `continue`
                // also throttles. Without this, every failed probe
                // would re-enter the timeout branch with a zero-
                // duration sleep and burn CPU/API budget tightly.
                last_idle_probe_at = Some(std::time::Instant::now());
                let info_result = match tokio::time::timeout(STATUS_PROBE_MAX, probe_fut).await {
                    Ok(res) => res,
                    Err(_) => {
                        tracing::warn!(
                            "SSE idle status probe exceeded {}s — continuing to read stream",
                            STATUS_PROBE_MAX.as_secs()
                        );
                        continue;
                    }
                };
                match info_result {
                    Ok(info) if info.is_terminal() => {
                        tracing::debug!(
                            events_seen = event_count,
                            idle_secs = last_event_at.elapsed().as_secs_f64(),
                            status = %info.status,
                            "SSE idle and remote terminal — entering drain mode"
                        );
                        pending_terminal = Some(info);
                        continue;
                    }
                    Ok(_running) => {
                        tracing::debug!(
                            events_seen = event_count,
                            idle_secs = last_event_at.elapsed().as_secs_f64(),
                            "SSE idle but execution still running — continuing to read"
                        );
                        continue;
                    }
                    Err(e) => {
                        // Status probe failed transiently. The SSE stream
                        // itself is still connected — do NOT tear it down
                        // over a status-endpoint blip, because the remote
                        // process may keep producing stdout/stderr and we
                        // would lose that output. Log and let the loop
                        // continue waiting on the stream. The independent
                        // poller (spawned in `exec()`) will eventually
                        // catch the terminal status if SSE never delivers.
                        tracing::warn!(
                            events_seen = event_count,
                            idle_secs = last_event_at.elapsed().as_secs_f64(),
                            "SSE idle and status probe failed (continuing to read stream): {}",
                            e
                        );
                        continue;
                    }
                }
            }
        };
        let Some(chunk) = next else { break };
        // Don't `?`-propagate read errors: if we hold a parsed terminal
        // result (`sse_terminal_result.is_some()`), we still want to
        // emit it (annotated with the failure) before returning. Save
        // the failure into `sse_failure` and break out — the post-loop
        // logic does the right thing.
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(
                    events_seen = event_count,
                    idle_secs = last_event_at.elapsed().as_secs_f64(),
                    "SSE stream read error: {}",
                    e
                );
                let mut slot = sse_failure.lock();
                if slot.is_none() {
                    *slot = Some(format!(
                        "SSE stream read error after {} events ({:.1}s idle): {}",
                        event_count,
                        last_event_at.elapsed().as_secs_f64(),
                        e
                    ));
                }
                break;
            }
        };
        last_event_at = std::time::Instant::now();
        event_count += 1;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // Process complete lines
        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].trim_end_matches('\r').to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            if line.is_empty() {
                // Empty line = end of event. Use the dispatch outcome to
                // decide whether to mark `exit_seen`: only a successfully-
                // parsed terminal event counts. A malformed terminal event
                // leaves `exit_seen` false so EOF/idle paths can still
                // recover via status-poll.
                let outcome =
                    dispatch_sse_event(&current_event, &current_data, &stdout_tx, &stderr_tx);
                match outcome {
                    DispatchOutcome::Terminal(result) => {
                        exit_seen = true;
                        pending_terminal = None;
                        last_meaningful_at = std::time::Instant::now();
                        last_idle_probe_at = None;
                        // Hold the terminal result; emit after drain.
                        sse_terminal_result = Some(result);
                        if terminal_drain_started.is_none() {
                            terminal_drain_started = Some(std::time::Instant::now());
                        }
                    }
                    DispatchOutcome::TerminalMalformed => {
                        tracing::warn!(
                            event = %current_event,
                            data_len = current_data.len(),
                            "SSE terminal event malformed; falling back to status-poll on EOF"
                        );
                    }
                    DispatchOutcome::NonTerminal => {
                        // Only count it as "meaningful" if the event
                        // actually carried stdout/stderr data; pure
                        // keepalives/comments must not refresh the
                        // drain-idle timer.
                        if !current_data.is_empty()
                            && (current_event == "stdout" || current_event == "stderr")
                        {
                            last_meaningful_at = std::time::Instant::now();
                            last_idle_probe_at = None;
                        }
                    }
                }
                current_event.clear();
                current_data.clear();
            } else if let Some(value) = line.strip_prefix("event: ") {
                current_event = value.to_string();
            } else if let Some(value) = line.strip_prefix("data: ") {
                if !current_data.is_empty() {
                    current_data.push('\n');
                }
                current_data.push_str(value);
                // Refresh drain-idle ONLY when we already know the
                // surrounding event is genuine output (stdout/stderr).
                // We must not refresh on `event: keepalive\ndata: {}`
                // patterns, which would let a server keep a completed
                // stream alive forever and block consumers that read
                // until end-of-stream.
                if current_event == "stdout" || current_event == "stderr" {
                    last_meaningful_at = std::time::Instant::now();
                    last_idle_probe_at = None;
                }
            }
        }
    }

    // The server may have closed the stream right after a terminal event
    // whose trailing blank line never arrived (so the in-loop dispatch
    // never fired). Process that residual event NOW, before the EOF
    // synthesis fallback — otherwise we'd send a synthetic "stream closed"
    // result and discard the real exit code.
    if !current_event.is_empty() || !current_data.is_empty() {
        let outcome = dispatch_sse_event(&current_event, &current_data, &stdout_tx, &stderr_tx);
        if let DispatchOutcome::Terminal(result) = outcome {
            exit_seen = true;
            pending_terminal = None;
            // Late-arriving terminal — emit it via the sse_terminal_result
            // path so the post-loop annotation logic (sse_failure /
            // truncation) applies uniformly.
            if sse_terminal_result.is_none() {
                sse_terminal_result = Some(result);
            }
        }
        current_event.clear();
        current_data.clear();
    }

    // If we held a terminal SSE result through the drain, emit it now —
    // and annotate with `sse_failure` if the stream errored DURING the
    // drain, so a mid-drain truncation cannot masquerade as clean
    // success. We also override `exit_code` to -1 in that case so
    // consumers using `.success()` / nonzero-exit checks treat it as
    // failure rather than trusting the process-side exit code that may
    // have been delivered before output truncation occurred.
    if let Some(result) = sse_terminal_result.take() {
        let sse_err = sse_failure.lock().clone();
        let final_result = if let Some(sse_err) = sse_err {
            ExecResult {
                exit_code: -1,
                error_message: Some(format!(
                    "process exit_code={} but SSE stream failed during/after terminal drain (output may be truncated): {}",
                    result.exit_code, sse_err
                )),
            }
        } else {
            result
        };
        let _ = result_tx.send(final_result);
    }

    // If neither SSE terminal nor pending_terminal/terminal_info exists,
    // the stream is closing cleanly without a definitive outcome. We do
    // NOT fabricate a terminal result here from EOF alone — doing so
    // would let `wait()` succeed while the remote process might still
    // be running. Drop our sender; the status poller delivers the real
    // terminal status.
    //
    // If a previous idle iteration already polled and saw terminal,
    // `pending_terminal` carries that snapshot; forwarding it gives
    // consumers faster feedback than waiting for the next poll tick. The
    // poller's later send is redundant but harmless.
    if !exit_seen {
        // Stream closed without delivering a terminal SSE event. Record
        // this as a transport failure BEFORE synthesising the result so
        // any subsequent `error_message` accurately reflects the
        // truncation risk. The spawned task's post-return code also sets
        // sse_failure, but that runs too late — the synthesis below has
        // already constructed the result.
        {
            let mut slot = sse_failure.lock();
            if slot.is_none() {
                *slot = Some("SSE stream closed before delivering a terminal event".to_string());
            }
        }
        // Prefer the snapshot from the in-loop idle status-poll, falling
        // back to the externally-shared `terminal_info` placed by the
        // poller task. This is the SSE reader's *sole* path to emit a
        // synthesised final result — it runs only AFTER the bounded
        // drain has elapsed, so consumers don't see a "success" race
        // ahead of any straggling stdout/stderr.
        let info = pending_terminal
            .take()
            .or_else(|| terminal_info.lock().take());
        if let Some(info) = info {
            // If the SSE stream had a transport failure, override
            // exit_code to -1 so consumers using `.success()` /
            // nonzero-exit checks treat it as failure — silent output
            // loss must not look identical to a fully-streamed success.
            let sse_err = sse_failure.lock().clone();
            let normal_completion = info.status == "completed" && info.exit_code.is_some();
            let (final_exit, error_message) = if let Some(sse_err) = sse_err {
                (
                    -1,
                    Some(format!(
                        "process status=`{}` exit={:?}, but SSE output stream failed (output may be truncated): {}",
                        info.status, info.exit_code, sse_err
                    )),
                )
            } else if normal_completion {
                (info.exit_code.unwrap_or(-1), info.error_message)
            } else {
                (
                    info.exit_code.unwrap_or(-1),
                    info.error_message.or_else(|| Some(format!(
                        "execution reached terminal status `{}` (delivered via status-poll, not SSE exit event)",
                        info.status
                    ))),
                )
            };
            let _ = result_tx.send(ExecResult {
                exit_code: final_exit,
                error_message,
            });
        }
    }

    tracing::info!(
        events_seen = event_count,
        idle_secs = last_event_at.elapsed().as_secs_f64(),
        exit_seen,
        "SSE stream closed by server"
    );

    Ok(exit_seen)
}

/// Outcome of processing a single SSE event.
enum DispatchOutcome {
    /// Event consumed; no terminal result was produced (stdout, stderr,
    /// keepalive, unknown event type, or empty data).
    NonTerminal,
    /// `exit`/`error` event was parsed. The returned `ExecResult` is
    /// returned to the SSE reader rather than sent on `result_tx`
    /// immediately, so the reader can hold it through the bounded drain
    /// and annotate it with any subsequent SSE failure (e.g. mid-drain
    /// stream error). Without this hold, `wait()` could observe a clean
    /// success result before truncation became apparent.
    Terminal(ExecResult),
    /// `exit`/`error` event was received but its payload could not be
    /// parsed; nothing was sent. The caller MUST treat this as if the
    /// terminal event was never delivered (i.e. fall back to status-poll
    /// or stream-EOF handling), since silently consuming it would leave
    /// `Execution::wait()` hanging.
    TerminalMalformed,
}

/// Dispatch a single SSE event.
///
/// Output events (`stdout`/`stderr`) are forwarded immediately on their
/// channels. Terminal events (`exit`/`error`) are *parsed* but NOT sent
/// on `result_tx` — the parsed `ExecResult` is returned to the caller
/// inside [`DispatchOutcome::Terminal`] so it can be held through the
/// bounded drain.
fn dispatch_sse_event(
    event: &str,
    data: &str,
    stdout_tx: &mpsc::UnboundedSender<String>,
    stderr_tx: &mpsc::UnboundedSender<String>,
) -> DispatchOutcome {
    let is_terminal_event = event == "exit" || event == "error";
    if data.is_empty() {
        return if is_terminal_event {
            DispatchOutcome::TerminalMalformed
        } else {
            DispatchOutcome::NonTerminal
        };
    }

    match event {
        "stdout" => {
            // SSE data is JSON: {"data":"<base64>"} per OpenAPI spec
            if let Some(decoded) = extract_and_decode_b64(data) {
                let _ = stdout_tx.send(decoded);
            }
            DispatchOutcome::NonTerminal
        }
        "stderr" => {
            if let Some(decoded) = extract_and_decode_b64(data) {
                let _ = stderr_tx.send(decoded);
            }
            DispatchOutcome::NonTerminal
        }
        "exit" => match serde_json::from_str::<serde_json::Value>(data) {
            Ok(parsed) => {
                let exit_code = parsed
                    .get("exit_code")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(-1) as i32;
                let error_message = parsed
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                DispatchOutcome::Terminal(ExecResult {
                    exit_code,
                    error_message,
                })
            }
            Err(_) => DispatchOutcome::TerminalMalformed,
        },
        "error" => DispatchOutcome::Terminal(ExecResult {
            exit_code: -1,
            error_message: Some(data.to_string()),
        }),
        _ => DispatchOutcome::NonTerminal,
    }
}

/// Extract base64 value from SSE JSON `{"data":"<base64>"}` and decode to UTF-8.
fn extract_and_decode_b64(data: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(data).ok()?;
    let b64 = parsed.get("data")?.as_str()?;
    base64_decode(b64).ok()
}

/// Decode base64-encoded SSE data to a UTF-8 string.
fn base64_decode(data: &str) -> Result<String, BoxliteError> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| BoxliteError::Internal(format!("base64 decode error: {}", e)))?;
    String::from_utf8(bytes)
        .map_err(|e| BoxliteError::Internal(format!("UTF-8 decode error: {}", e)))
}

// ============================================================================
// Stdin Forwarding
// ============================================================================

/// Forward stdin data from channel to the remote execution input endpoint.
async fn forward_stdin(
    client: &ApiClient,
    box_id: &str,
    execution_id: &str,
    mut stdin_rx: mpsc::UnboundedReceiver<Vec<u8>>,
) {
    let path = format!("/boxes/{}/executions/{}/input", box_id, execution_id);
    while let Some(data) = stdin_rx.recv().await {
        if client.post_bytes(&path, data, false).await.is_err() {
            break;
        }
    }
    // Channel closed = EOF, send close signal
    let _ = client.post_bytes(&path, vec![], true).await;
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
