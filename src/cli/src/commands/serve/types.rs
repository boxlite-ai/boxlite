//! Wire types (request/response JSON) for the REST API.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

// ============================================================================
// Box Types
// ============================================================================

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateBoxRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub rootfs_path: Option<String>,
    #[serde(default)]
    pub cpus: Option<u8>,
    #[serde(default)]
    pub memory_mib: Option<u32>,
    #[serde(default)]
    pub disk_size_gb: Option<u64>,
    #[serde(default)]
    pub working_dir: Option<String>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub entrypoint: Option<Vec<String>>,
    #[serde(default)]
    pub cmd: Option<Vec<String>>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub network: Option<NetworkSpec>,
    #[serde(default)]
    pub auto_remove: Option<bool>,
    #[serde(default)]
    pub detach: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct NetworkSpec {
    pub mode: String,
    #[serde(default)]
    pub allow_net: Vec<String>,
}

#[derive(Serialize)]
pub(super) struct BoxResponse {
    pub box_id: String,
    pub name: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub pid: Option<u32>,
    pub image: String,
    pub cpus: u8,
    pub memory_mib: u32,
    pub labels: HashMap<String, String>,
}

#[derive(Serialize)]
pub(super) struct ListBoxesResponse {
    pub boxes: Vec<BoxResponse>,
}

// ============================================================================
// Execution Types
// ============================================================================

#[derive(Deserialize)]
pub(super) struct ExecRequest {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub stdin: Option<String>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub timeout_seconds: Option<f64>,
    #[serde(default)]
    pub working_dir: Option<String>,
    #[serde(default)]
    pub tty: bool,
}

#[derive(Serialize)]
pub(super) struct ExecResponse {
    pub execution_id: String,
}

#[derive(Deserialize)]
pub(super) struct SignalRequest {
    pub signal: i32,
}

#[derive(Deserialize)]
pub(super) struct ResizeRequest {
    pub cols: u32,
    pub rows: u32,
}

// ============================================================================
// Config Types
// ============================================================================

#[derive(Serialize)]
pub(super) struct SandboxConfigResponse {
    pub capabilities: SandboxCapabilities,
}

#[derive(Serialize)]
pub(super) struct SandboxCapabilities {
    pub snapshots_enabled: bool,
    pub clone_enabled: bool,
    pub export_enabled: bool,
    pub import_enabled: bool,
}

// ============================================================================
// Snapshot Types
// ============================================================================

#[derive(Deserialize)]
pub(super) struct CreateSnapshotRequest {
    pub name: String,
}

#[derive(Serialize)]
pub(super) struct SnapshotResponse {
    pub id: String,
    pub box_id: String,
    pub name: String,
    pub created_at: i64,
    pub container_disk_bytes: u64,
    pub size_bytes: u64,
}

#[derive(Serialize)]
pub(super) struct ListSnapshotsResponse {
    pub snapshots: Vec<SnapshotResponse>,
}

// ============================================================================
// Clone & Import Types
// ============================================================================

#[derive(Deserialize)]
pub(super) struct CloneRequest {
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct ImportQuery {
    #[serde(default)]
    pub name: Option<String>,
}

// ============================================================================
// Metrics Types
// ============================================================================

#[derive(Serialize)]
pub(super) struct RuntimeMetricsResponse {
    pub boxes_created_total: u64,
    pub boxes_failed_total: u64,
    pub boxes_stopped_total: u64,
    pub num_running_boxes: u64,
    pub total_commands_executed: u64,
    pub total_exec_errors: u64,
}

#[derive(Serialize)]
pub(super) struct BoxMetricsResponse {
    pub commands_executed_total: u64,
    pub exec_errors_total: u64,
    pub bytes_sent_total: u64,
    pub bytes_received_total: u64,
    pub cpu_percent: Option<f32>,
    pub memory_bytes: Option<u64>,
    pub network_bytes_sent: Option<u64>,
    pub network_bytes_received: Option<u64>,
    pub network_tcp_connections: Option<u64>,
    pub network_tcp_errors: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boot_timing: Option<BootTimingResponse>,
}

#[derive(Serialize)]
pub(super) struct BootTimingResponse {
    pub total_create_ms: Option<u64>,
    pub guest_boot_ms: Option<u64>,
    pub filesystem_setup_ms: Option<u64>,
    pub image_prepare_ms: Option<u64>,
    pub guest_rootfs_ms: Option<u64>,
    pub box_config_ms: Option<u64>,
    pub box_spawn_ms: Option<u64>,
    pub container_init_ms: Option<u64>,
}

// ============================================================================
// Error Types
// ============================================================================

#[derive(Serialize)]
pub(super) struct ErrorBody {
    pub error: ErrorDetail,
}

#[derive(Serialize)]
pub(super) struct ErrorDetail {
    pub message: String,
    #[serde(rename = "type")]
    pub error_type: String,
    pub code: u16,
}

// ============================================================================
// Query Types
// ============================================================================

#[derive(Deserialize)]
pub(super) struct RemoveQuery {
    #[serde(default)]
    pub force: Option<bool>,
}

#[derive(Deserialize)]
pub(super) struct FileQuery {
    pub path: String,
}
