//! RestBox — implements BoxBackend for the REST API.

use std::path::Path;

use async_trait::async_trait;
use parking_lot::RwLock;
use reqwest::Method;
use tokio::sync::mpsc;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::BoxInfo;
use crate::litebox::copy::CopyOptions;
use crate::litebox::{BoxCommand, ExecResult, ExecStderr, ExecStdin, ExecStdout, Execution};
use crate::metrics::BoxMetrics;
use crate::runtime::backend::BoxBackend;
use crate::runtime::types::BoxID;

use super::client::ApiClient;
use super::exec::RestExecControl;
use super::types::{BoxMetricsResponse, BoxResponse, ExecRequest, ExecResponse};

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
        let mut info = self.cached_info.write();
        *info = resp.to_box_info();
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

        // 3. Spawn SSE reader task for output streaming
        let sse_client = self.client.clone();
        let sse_box_id = box_id.clone();
        let sse_exec_id = execution_id.clone();
        tokio::spawn(async move {
            let _ = read_sse_output(
                &sse_client,
                &sse_box_id,
                &sse_exec_id,
                stdout_tx,
                stderr_tx,
                result_tx,
            )
            .await;
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
        let mut info = self.cached_info.write();
        *info = resp.to_box_info();
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
}

// ============================================================================
// SSE Output Streaming
// ============================================================================

/// Read SSE events from the execution output endpoint and forward to channels.
async fn read_sse_output(
    client: &ApiClient,
    box_id: &str,
    execution_id: &str,
    stdout_tx: mpsc::UnboundedSender<String>,
    stderr_tx: mpsc::UnboundedSender<String>,
    result_tx: mpsc::UnboundedSender<ExecResult>,
) -> BoxliteResult<()> {
    let path = format!("/boxes/{}/executions/{}/output", box_id, execution_id);
    let builder = client.authorized_get(&path).await?;
    let resp = builder
        .header("Accept", "text/event-stream")
        .send()
        .await
        .map_err(|e| BoxliteError::Internal(format!("SSE connect failed: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(BoxliteError::Internal(format!(
            "SSE stream failed (HTTP {}): {}",
            status, text
        )));
    }

    // Read SSE stream line by line
    use futures::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut current_event = String::new();
    let mut current_data = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| BoxliteError::Internal(format!("SSE stream read error: {}", e)))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // Process complete lines
        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].trim_end_matches('\r').to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            if line.is_empty() {
                // Empty line = end of event, dispatch
                dispatch_sse_event(
                    &current_event,
                    &current_data,
                    &stdout_tx,
                    &stderr_tx,
                    &result_tx,
                );
                current_event.clear();
                current_data.clear();
            } else if let Some(value) = line.strip_prefix("event: ") {
                current_event = value.to_string();
            } else if let Some(value) = line.strip_prefix("data: ") {
                if !current_data.is_empty() {
                    current_data.push('\n');
                }
                current_data.push_str(value);
            }
        }
    }

    // Dispatch any remaining event
    if !current_event.is_empty() || !current_data.is_empty() {
        dispatch_sse_event(
            &current_event,
            &current_data,
            &stdout_tx,
            &stderr_tx,
            &result_tx,
        );
    }

    Ok(())
}

/// Dispatch a single SSE event to the appropriate channel.
fn dispatch_sse_event(
    event: &str,
    data: &str,
    stdout_tx: &mpsc::UnboundedSender<String>,
    stderr_tx: &mpsc::UnboundedSender<String>,
    result_tx: &mpsc::UnboundedSender<ExecResult>,
) {
    if data.is_empty() {
        return;
    }

    match event {
        "stdout" => {
            // SSE data is JSON: {"data":"<base64>"} per OpenAPI spec
            if let Some(decoded) = extract_and_decode_b64(data) {
                let _ = stdout_tx.send(decoded);
            }
        }
        "stderr" => {
            if let Some(decoded) = extract_and_decode_b64(data) {
                let _ = stderr_tx.send(decoded);
            }
        }
        "exit" => {
            // Parse exit code from JSON: {"exit_code": 0}
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                let exit_code = parsed
                    .get("exit_code")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(-1) as i32;
                let error_message = parsed
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                let _ = result_tx.send(ExecResult {
                    exit_code,
                    error_message,
                });
            }
        }
        "error" => {
            let _ = result_tx.send(ExecResult {
                exit_code: -1,
                error_message: Some(data.to_string()),
            });
        }
        _ => {
            // Ignore unknown event types (keepalive, etc.)
        }
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
