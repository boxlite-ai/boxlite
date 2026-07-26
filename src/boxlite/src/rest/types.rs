//! Request/response serde structs matching the OpenAPI schema.
//!
//! These are wire-format types for the REST API. They are converted
//! to/from core types (BoxInfo, BoxOptions, etc.) at the boundary.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::litebox::BoxStatus;
use crate::litebox::snapshot_mgr::SnapshotInfo;
use crate::runtime::options::{CloneOptions, ExportOptions, SnapshotOptions};

// ============================================================================
// Error Model
// ============================================================================

#[derive(Debug, Deserialize)]
pub(crate) struct ErrorResponse {
    pub error: ErrorModel,
}

#[derive(Debug, Deserialize)]
pub(crate) struct FlatErrorResponse {
    pub message: String,
    pub code: Option<String>,
}

impl FlatErrorResponse {
    pub(crate) fn into_error_model(self) -> ErrorModel {
        ErrorModel {
            message: self.message,
            error_type: "HttpError".to_string(),
            code: self.code.unwrap_or_else(|| "internal".to_string()),
            request_id: None,
        }
    }
}

/// Wire shape received from the server.
///
/// - `message` — human-readable error text.
/// - `error_type` — stable PascalCase identifier (K8s `Status.reason`
///   style). Mirrors `BoxliteError::http().1` server-side.
/// - `code` — stable snake_case machine identifier (Stripe `code` style).
///   The mapper in [`super::error::map_http_error`] dispatches on this
///   field; `error_type` is kept for diagnostics / logging.
/// - `request_id` — propagated from server's `X-Request-Id` middleware
///   when present; absent on older servers (forward-compat).
#[derive(Debug, Deserialize)]
pub(crate) struct ErrorModel {
    pub message: String,
    /// Preserved for diagnostics / log enrichment; dispatch happens on
    /// `code` (the snake string).
    #[serde(rename = "type")]
    #[allow(dead_code)]
    pub error_type: String,
    pub code: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub request_id: Option<String>,
}

// ============================================================================
// Configuration
// ============================================================================

/// Server configuration & capabilities — the `GET /v1/config` response.
/// Matches the `ServerConfig` schema in `openapi/box.openapi.yaml`.
#[derive(Debug, Deserialize, Clone)]
pub(crate) struct ServerConfig {
    pub capabilities: Option<ServerCapabilities>,
}

#[allow(dead_code)] // Constructed via serde::Deserialize
#[derive(Debug, Deserialize, Clone, Default)]
pub(crate) struct ServerCapabilities {
    pub snapshots_enabled: Option<bool>,
    pub clone_enabled: Option<bool>,
    pub export_enabled: Option<bool>,
    pub import_enabled: Option<bool>,
}

// ============================================================================
// Box
// ============================================================================

#[derive(Debug, Serialize)]
pub(crate) struct CreateBoxRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rootfs_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpus: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_mib: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_size_gb: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<CreateBoxNetworkSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entrypoint: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cmd: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secrets: Option<Vec<CreateBoxSecret>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_logs: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detach: Option<bool>,
    /// A terminal for the main command (`run -t`). Only sent when asked for:
    /// the server rejects unknown fields, so an older one would 400 on it —
    /// which is the right failure. Degrading `-it` to pipes silently, as the
    /// alternative, is how this whole class of bug happens.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tty: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_pause: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_delete: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_resume: Option<bool>,
}

impl CreateBoxRequest {
    pub fn from_options(
        options: &crate::runtime::options::BoxOptions,
        name: Option<String>,
    ) -> Self {
        use crate::runtime::options::RootfsSpec;

        let (image, rootfs_path) = match &options.rootfs {
            RootfsSpec::Image(img) => (Some(img.clone()), None),
            RootfsSpec::RootfsPath(path) => (None, Some(path.clone())),
        };

        let env = if options.env.is_empty() {
            None
        } else {
            Some(options.env.iter().cloned().collect())
        };

        let secrets = if options.secrets.is_empty() {
            None
        } else {
            Some(options.secrets.iter().map(CreateBoxSecret::from).collect())
        };

        // SecurityOptions is intentionally NOT carried on the wire.
        // Sandbox security is the operator's policy and is set
        // server-side; the REST surface deliberately exposes no knob
        // for clients to relax it (would be a sandbox-escape vector).
        // Local-mode callers and CLI/Go/C SDKs continue to honour
        // `BoxOptions.advanced.security` because those run under the
        // caller's own trust boundary.

        Self {
            name,
            image,
            rootfs_path,
            cpus: options.cpus,
            memory_mib: options.memory_mib,
            disk_size_gb: options.disk_size_gb,
            working_dir: options.working_dir.clone(),
            env,
            network: Some(CreateBoxNetworkSpec::from(&options.network)),
            entrypoint: options.entrypoint.clone(),
            cmd: options.cmd.clone(),
            user: options.user.clone(),
            secrets,
            capture_logs: Some(options.capture_logs),
            detach: Some(options.detach),
            tty: options.tty.then_some(true),
            // The deprecated remove-on-stop flag was never applied by the cloud
            // control-plane mapper. Keep remote defaults unchanged and only send
            // the modern lifecycle fields when callers explicitly configure them.
            auto_pause: options.auto_pause,
            auto_delete: options.auto_delete,
            auto_resume: options.auto_resume,
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct CreateBoxNetworkSpec {
    pub mode: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub allow_net: Vec<String>,
}

impl From<&crate::runtime::options::NetworkSpec> for CreateBoxNetworkSpec {
    fn from(spec: &crate::runtime::options::NetworkSpec) -> Self {
        let config = crate::runtime::options::NetworkConfig::from(spec);
        let mode = match config.mode {
            crate::runtime::options::NetworkMode::Enabled => "enabled",
            crate::runtime::options::NetworkMode::Disabled => "disabled",
        };
        Self {
            mode: mode.to_string(),
            allow_net: config.allow_net,
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct CreateBoxSecret {
    pub name: String,
    pub value: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub hosts: Vec<String>,
    pub placeholder: String,
}

impl From<&crate::runtime::options::Secret> for CreateBoxSecret {
    fn from(secret: &crate::runtime::options::Secret) -> Self {
        Self {
            name: secret.name.clone(),
            value: secret.value.clone(),
            hosts: secret.hosts.clone(),
            placeholder: secret.placeholder.clone(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct BoxResponse {
    pub box_id: String,
    pub name: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub pid: Option<u32>,
    pub image: String,
    pub cpus: u8,
    pub memory_mib: u32,
    #[serde(default)]
    pub labels: HashMap<String, String>,
    /// Absent while the box's main command is still running. An older server
    /// omits it entirely, which reads the same as "still running" — the
    /// honest answer when it cannot say.
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default = "default_auto_pause")]
    pub auto_pause: u32,
    #[serde(default = "default_auto_delete")]
    pub auto_delete: u32,
    #[serde(default = "default_auto_resume")]
    pub auto_resume: bool,
}

impl BoxResponse {
    pub fn to_box_info(&self) -> boxlite_shared::errors::BoxliteResult<crate::BoxInfo> {
        use crate::runtime::id::BoxID;
        use boxlite_shared::errors::BoxliteError;

        let id = BoxID::parse(&self.box_id).ok_or_else(|| {
            BoxliteError::Internal(format!(
                "REST server returned unparseable box_id: {:?} (must be non-empty, ≤{} chars, URL/path-safe)",
                self.box_id,
                BoxID::MAX_LENGTH,
            ))
        })?;

        let status = parse_box_status(&self.status);

        let created_at = chrono::DateTime::parse_from_rfc3339(&self.created_at)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now());

        let last_updated = chrono::DateTime::parse_from_rfc3339(&self.updated_at)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now());

        Ok(crate::BoxInfo {
            id,
            name: self.name.clone(),
            status,
            created_at,
            last_updated,
            pid: self.pid,
            image: self.image.clone(),
            cpus: self.cpus,
            memory_mib: self.memory_mib,
            labels: self.labels.clone(),
            auto_pause: self.auto_pause,
            auto_delete: self.auto_delete,
            auto_resume: self.auto_resume,
            health_status: crate::litebox::HealthStatus::new(), // REST API doesn't provide health status
            exit_code: self.exit_code,
        })
    }
}

fn default_auto_pause() -> u32 {
    900
}

fn default_auto_delete() -> u32 {
    0
}

fn default_auto_resume() -> bool {
    true
}

#[derive(Debug, Deserialize)]
pub(crate) struct ListBoxesResponse {
    pub boxes: Vec<BoxResponse>,
    #[allow(dead_code)]
    pub next_page_token: Option<String>,
}

// ============================================================================
// Named volumes (`/v1/volumes`)
// ============================================================================

/// Body for `POST /v1/volumes`. Volume creation takes no parameters — the
/// server assigns the id — so the body is empty.
#[derive(Debug, Serialize)]
pub(crate) struct CreateVolumeRequest {}

/// A single volume as returned by the REST API.
#[derive(Debug, Deserialize)]
pub(crate) struct VolumeResponse {
    pub id: String,
    pub created_at: String,
    #[serde(default)]
    pub size_bytes: Option<u64>,
}

impl VolumeResponse {
    pub fn to_volume_info(&self) -> crate::volumes::VolumeInfo {
        let created_at = chrono::DateTime::parse_from_rfc3339(&self.created_at)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now());

        crate::volumes::VolumeInfo {
            id: self.id.clone(),
            created_at,
            size_bytes: self.size_bytes,
        }
    }
}

/// Response for `GET /v1/volumes`.
#[derive(Debug, Deserialize)]
pub(crate) struct ListVolumesResponse {
    pub volumes: Vec<VolumeResponse>,
}

// ============================================================================
// Snapshot / Clone / Export
// ============================================================================

#[derive(Debug, Serialize)]
pub(crate) struct CreateSnapshotRequest {
    pub name: String,
}

impl CreateSnapshotRequest {
    pub fn from_options(_options: &SnapshotOptions, name: &str) -> Self {
        Self {
            name: name.to_string(),
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
pub(crate) struct SnapshotResponse {
    pub id: String,
    pub box_id: String,
    pub name: String,
    pub created_at: i64,
    pub container_disk_bytes: u64,
    pub size_bytes: u64,
}

impl SnapshotResponse {
    pub fn to_snapshot_info(&self) -> SnapshotInfo {
        SnapshotInfo {
            id: self.id.clone(),
            box_id: self.box_id.clone(),
            name: self.name.clone(),
            created_at: self.created_at,
            disk_info: crate::disk::DiskInfo {
                base_path: String::new(),
                container_disk_bytes: self.container_disk_bytes,
                size_bytes: self.size_bytes,
            },
        }
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct ListSnapshotsResponse {
    pub snapshots: Vec<SnapshotResponse>,
}

#[derive(Debug, Serialize)]
pub(crate) struct CloneBoxRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl CloneBoxRequest {
    pub fn from_options(_options: &CloneOptions, name: Option<&str>) -> Self {
        Self {
            name: name.map(|s| s.to_string()),
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct ExportBoxRequest {}

impl ExportBoxRequest {
    pub fn from_options(_options: &ExportOptions) -> Self {
        Self {}
    }
}

// ============================================================================
// Execution
// ============================================================================

#[derive(Debug, Serialize)]
pub(crate) struct ExecRequest {
    pub command: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_dir: Option<String>,
    #[serde(default)]
    pub tty: bool,
}

impl ExecRequest {
    pub fn from_command(cmd: &crate::BoxCommand) -> Self {
        let env = cmd
            .env
            .as_ref()
            .map(|pairs| pairs.iter().cloned().collect::<HashMap<String, String>>());
        let timeout_seconds = cmd.timeout.map(|d| d.as_secs_f64());

        Self {
            command: cmd.command.clone(),
            args: cmd.args.clone(),
            env,
            timeout_seconds,
            working_dir: cmd.working_dir.clone(),
            tty: cmd.tty,
        }
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct ExecResponse {
    pub execution_id: String,
}

/// Response from `GET /executions/{exec_id}` (status fallback).
///
/// Mirrors the OpenAPI `ExecutionInfo` schema; used by the WS attach
/// path when the connection terminates without an `exit` frame so
/// callers still observe the real exit code.
#[derive(Debug, Deserialize)]
pub(crate) struct ExecutionStatusResponse {
    pub status: String,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Serialize)]
pub(crate) struct SignalRequestBody {
    pub signal: i32,
}

#[derive(Debug, Serialize)]
pub(crate) struct ResizeRequestBody {
    pub cols: u32,
    pub rows: u32,
}

// ============================================================================
// Metrics
// ============================================================================

#[derive(Debug, Deserialize)]
pub(crate) struct RuntimeMetricsResponse {
    #[serde(default)]
    pub boxes_created_total: u64,
    #[serde(default)]
    pub boxes_failed_total: u64,
    #[serde(default)]
    pub boxes_stopped_total: u64,
    #[serde(default)]
    #[allow(dead_code)]
    pub num_running_boxes: u64,
    #[serde(default)]
    pub total_commands_executed: u64,
    #[serde(default)]
    pub total_exec_errors: u64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct BoxMetricsResponse {
    #[serde(default)]
    pub commands_executed_total: u64,
    #[serde(default)]
    pub exec_errors_total: u64,
    #[serde(default)]
    pub bytes_sent_total: u64,
    #[serde(default)]
    pub bytes_received_total: u64,
    pub cpu_percent: Option<f32>,
    pub memory_bytes: Option<u64>,
    pub network_bytes_sent: Option<u64>,
    pub network_bytes_received: Option<u64>,
    pub network_tcp_connections: Option<u64>,
    pub network_tcp_errors: Option<u64>,
    pub boot_timing: Option<BootTimingResponse>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct BootTimingResponse {
    pub total_create_ms: Option<u64>,
    pub guest_boot_ms: Option<u64>,
    pub filesystem_setup_ms: Option<u64>,
    pub image_prepare_ms: Option<u64>,
    pub guest_rootfs_ms: Option<u64>,
    pub box_config_ms: Option<u64>,
    pub box_spawn_ms: Option<u64>,
    pub container_init_ms: Option<u64>,
}

fn parse_box_status(status: &str) -> BoxStatus {
    match status {
        "configured" => BoxStatus::Configured,
        "running" => BoxStatus::Running,
        "stopping" => BoxStatus::Stopping,
        "stopped" => BoxStatus::Stopped,
        "paused" => BoxStatus::Paused,
        _ => BoxStatus::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::options::BoxOptions;

    #[test]
    fn test_create_box_request_serialization() {
        let req = CreateBoxRequest {
            name: Some("mybox".into()),
            image: Some("python:3.11".into()),
            rootfs_path: None,
            cpus: Some(2),
            memory_mib: Some(512),
            disk_size_gb: None,
            working_dir: None,
            env: None,
            network: Some(CreateBoxNetworkSpec {
                mode: "enabled".into(),
                allow_net: vec!["api.openai.com".into()],
            }),
            entrypoint: None,
            cmd: None,
            user: None,
            tty: None,
            secrets: Some(vec![CreateBoxSecret {
                name: "openai".into(),
                value: "sk-test".into(),
                hosts: vec!["api.openai.com".into()],
                placeholder: "<BOXLITE_SECRET:openai>".into(),
            }]),
            capture_logs: None,
            detach: None,
            auto_pause: Some(900),
            auto_delete: Some(604800),
            auto_resume: None,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"name\":\"mybox\""));
        assert!(json.contains("\"image\":\"python:3.11\""));
        assert!(json.contains("\"cpus\":2"));
        assert!(
            json.contains("\"network\":{\"mode\":\"enabled\",\"allow_net\":[\"api.openai.com\"]}")
        );
        assert!(json.contains("\"secrets\""));
        // None fields should be skipped
        assert!(!json.contains("rootfs_path"));
        assert!(!json.contains("disk_size_gb"));
    }

    #[test]
    fn test_create_box_request_from_options() {
        use crate::runtime::options::{BoxOptions, NetworkSpec, RootfsSpec, Secret};

        let opts = BoxOptions {
            rootfs: RootfsSpec::Image("alpine:latest".into()),
            cpus: Some(4),
            memory_mib: Some(1024),
            network: NetworkSpec::Enabled {
                allow_net: vec!["api.openai.com".into()],
            },
            secrets: vec![Secret {
                name: "openai".into(),
                value: "sk-test".into(),
                hosts: vec!["api.openai.com".into()],
                placeholder: "<BOXLITE_SECRET:openai>".into(),
            }],
            auto_pause: Some(1800),
            auto_delete: Some(604800),
            ..Default::default()
        };
        let req = CreateBoxRequest::from_options(&opts, Some("test-box".into()));
        assert_eq!(req.name.as_deref(), Some("test-box"));
        assert_eq!(req.image.as_deref(), Some("alpine:latest"));
        assert!(req.rootfs_path.is_none());
        assert_eq!(req.cpus, Some(4));
        assert_eq!(req.memory_mib, Some(1024));
        assert_eq!(
            req.network.as_ref().map(|n| n.mode.as_str()),
            Some("enabled")
        );
        assert_eq!(
            req.network.as_ref().map(|n| n.allow_net.clone()),
            Some(vec!["api.openai.com".into()])
        );
        assert_eq!(req.secrets.as_ref().map(Vec::len), Some(1));
        assert_eq!(req.auto_pause, Some(1800));
        assert_eq!(req.auto_delete, Some(604800));
        assert_eq!(
            req.secrets.as_ref().unwrap()[0].placeholder,
            "<BOXLITE_SECRET:openai>"
        );
    }

    #[test]
    #[allow(deprecated)]
    fn deprecated_auto_remove_does_not_change_rest_lifecycle_defaults() {
        for auto_remove in [false, true] {
            let opts = BoxOptions {
                auto_remove,
                auto_delete: None,
                ..Default::default()
            };
            let req = CreateBoxRequest::from_options(&opts, None);
            assert_eq!(req.auto_pause, None);
            assert_eq!(req.auto_delete, None);
        }

        let modern = BoxOptions {
            auto_remove: true,
            auto_pause: Some(900),
            auto_delete: Some(3600),
            ..Default::default()
        };
        let req = CreateBoxRequest::from_options(&modern, None);
        assert_eq!(req.auto_pause, Some(900));
        assert_eq!(req.auto_delete, Some(3600));
    }

    #[test]
    fn test_create_box_request_from_options_disabled_network() {
        use crate::runtime::options::{BoxOptions, NetworkSpec, RootfsSpec};

        let opts = BoxOptions {
            rootfs: RootfsSpec::Image("alpine:latest".into()),
            network: NetworkSpec::Disabled,
            ..Default::default()
        };

        let req = CreateBoxRequest::from_options(&opts, None);
        assert_eq!(
            req.network.as_ref().map(|n| n.mode.as_str()),
            Some("disabled")
        );
        assert!(req.network.as_ref().unwrap().allow_net.is_empty());
    }

    /// REST is intentionally a "the server picks the security policy"
    /// surface: even a caller with a non-default `SecurityOptions`
    /// (here: `maximum`) MUST serialize a wire body that carries
    /// neither `security` nor `security_settings`. Re-introducing
    /// either field would let a client toggle the operator's
    /// sandbox configuration — a sandbox-escape vector. The test
    /// asserts both the absence of the JSON keys and the absence
    /// of the preset name to catch either field being smuggled
    /// back in under a renamed alias.
    #[test]
    fn test_create_box_request_never_carries_security_on_the_wire() {
        use crate::SecurityOptions;
        use crate::runtime::advanced_options::AdvancedBoxOptions;
        use crate::runtime::options::{BoxOptions, RootfsSpec};

        let opts = BoxOptions {
            rootfs: RootfsSpec::Image("alpine:latest".into()),
            advanced: AdvancedBoxOptions {
                security: SecurityOptions::enabled(),
                ..Default::default()
            },
            ..Default::default()
        };
        let req = CreateBoxRequest::from_options(&opts, None);
        let json = serde_json::to_string(&req).unwrap();
        assert!(
            !json.contains("security"),
            "wire form must NOT carry any security knob; got: {json}"
        );
    }

    #[test]
    fn test_box_response_deserialization() {
        let json = r#"{
            "box_id": "01J0000000000000000000000A",
            "name": "mybox",
            "status": "running",
            "created_at": "2024-01-01T00:00:00Z",
            "updated_at": "2024-01-01T00:01:00Z",
            "pid": 1234,
            "image": "python:3.11",
            "cpus": 2,
            "memory_mib": 512,
            "labels": {}
        }"#;
        let resp: BoxResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.box_id, "01J0000000000000000000000A");
        assert_eq!(resp.name.as_deref(), Some("mybox"));
        assert_eq!(resp.status, "running");
        assert_eq!(resp.pid, Some(1234));
        assert_eq!(resp.cpus, 2);
        assert_eq!(resp.auto_pause, 900);
        assert_eq!(resp.auto_delete, 0);
    }

    #[test]
    fn test_box_response_to_box_info() {
        let resp = BoxResponse {
            box_id: "01J0000000000000000000000A".to_string(),
            name: Some("mybox".to_string()),
            status: "running".to_string(),
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:01:00Z".to_string(),
            pid: Some(1234),
            image: "python:3.11".to_string(),
            cpus: 2,
            memory_mib: 512,
            labels: HashMap::new(),
            exit_code: None,
            auto_pause: 1800,
            auto_delete: 604800,
            auto_resume: true,
        };
        let info = resp.to_box_info().expect("valid ULID box_id should parse");
        assert_eq!(info.name.as_deref(), Some("mybox"));
        assert_eq!(info.image, "python:3.11");
        assert_eq!(info.cpus, 2);
        assert_eq!(info.memory_mib, 512);
        assert_eq!(info.auto_pause, 1800);
        assert_eq!(info.auto_delete, 604800);
    }

    #[test]
    fn test_box_response_to_box_info_uuid() {
        // Some servers may return UUIDs as box_id (not just 12-char Base62 / 26-char ULID).
        // Verify the SDK accepts them and round-trips the id verbatim.
        let resp = BoxResponse {
            box_id: "d406c59d-eb09-4bc3-9b3a-62455c7e8f32".to_string(),
            name: Some("uuid-box".to_string()),
            status: "running".to_string(),
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:01:00Z".to_string(),
            pid: Some(5678),
            image: "alpine:latest".to_string(),
            cpus: 1,
            memory_mib: 256,
            labels: HashMap::new(),
            exit_code: None,
            auto_pause: 900,
            auto_delete: 0,
            auto_resume: true,
        };
        let info = resp.to_box_info().expect("UUID box_id should parse");
        assert_eq!(info.id.as_str(), "d406c59d-eb09-4bc3-9b3a-62455c7e8f32");
        assert_eq!(info.name.as_deref(), Some("uuid-box"));
    }

    #[test]
    fn test_box_response_to_box_info_unparseable() {
        // BoxID is opaque server-issued — most strings parse. The only
        // shapes that must propagate a parse error are the ones that
        // would corrupt URLs / on-disk paths if accepted: empty, oversized,
        // or containing path-traversal / URL-unsafe characters. This is
        // the belt-and-suspenders against the old silent-mint bug.
        let mk = |bad_id: &str| BoxResponse {
            box_id: bad_id.to_string(),
            name: None,
            status: "running".to_string(),
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:01:00Z".to_string(),
            pid: None,
            image: "alpine:latest".to_string(),
            cpus: 1,
            memory_mib: 256,
            labels: HashMap::new(),
            exit_code: None,
            auto_pause: 900,
            auto_delete: 0,
            auto_resume: true,
        };
        assert!(mk("").to_box_info().is_err(), "empty");
        assert!(mk("a/b").to_box_info().is_err(), "slash");
        assert!(mk("a b").to_box_info().is_err(), "whitespace");
        assert!(mk("a.b").to_box_info().is_err(), "dot");
    }

    #[test]
    fn test_exec_request_serialization() {
        let req = ExecRequest {
            command: "python3".to_string(),
            args: vec!["-c".to_string(), "print('hi')".to_string()],
            env: None,
            timeout_seconds: Some(30.0),
            working_dir: Some("/app".to_string()),
            tty: false,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"command\":\"python3\""));
        assert!(json.contains("\"timeout_seconds\":30.0"));
        assert!(json.contains("\"working_dir\":\"/app\""));
    }

    #[test]
    fn test_error_response_deserialization() {
        let json = r#"{
            "error": {
                "message": "box not found",
                "type": "NotFoundError",
                "code": "not_found",
                "request_id": "req_01HZK"
            }
        }"#;
        let resp: ErrorResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.error.message, "box not found");
        assert_eq!(resp.error.error_type, "NotFoundError");
        assert_eq!(resp.error.code, "not_found");
        assert_eq!(resp.error.request_id.as_deref(), Some("req_01HZK"));
    }

    #[test]
    fn test_runtime_metrics_deserialization() {
        let json = r#"{
            "boxes_created_total": 10,
            "boxes_failed_total": 1,
            "boxes_stopped_total": 5,
            "num_running_boxes": 4,
            "total_commands_executed": 100,
            "total_exec_errors": 2
        }"#;
        let resp: RuntimeMetricsResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.boxes_created_total, 10);
        assert_eq!(resp.total_commands_executed, 100);
    }

    #[test]
    fn test_box_status_transient_mapping() {
        let mut resp = BoxResponse {
            box_id: "01J0000000000000000000000A".to_string(),
            name: Some("mybox".to_string()),
            status: "snapshotting".to_string(),
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:01:00Z".to_string(),
            pid: Some(1234),
            image: "python:3.11".to_string(),
            cpus: 2,
            memory_mib: 512,
            labels: HashMap::new(),
            exit_code: None,
            auto_pause: 900,
            auto_delete: 0,
            auto_resume: true,
        };

        // Legacy transient statuses map to Unknown (no longer valid)
        assert_eq!(resp.to_box_info().unwrap().status, BoxStatus::Unknown);
        resp.status = "paused".to_string();
        assert_eq!(resp.to_box_info().unwrap().status, BoxStatus::Paused);
    }

    #[test]
    fn test_server_config_capabilities_deserialization() {
        let json = r#"{
            "capabilities": {
                "snapshots_enabled": true,
                "clone_enabled": false,
                "export_enabled": true
            }
        }"#;
        let resp: ServerConfig = serde_json::from_str(json).unwrap();
        let caps = resp.capabilities.unwrap();
        assert_eq!(caps.snapshots_enabled, Some(true));
        assert_eq!(caps.clone_enabled, Some(false));
        assert_eq!(caps.export_enabled, Some(true));
    }

    #[test]
    fn test_snapshot_response_to_snapshot_info() {
        let resp = SnapshotResponse {
            id: "01JABCDEF0123456789XYZABCD".to_string(),
            box_id: "01J0000000000000000000000A".to_string(),
            name: "snap1".to_string(),
            created_at: 1_700_000_000,
            container_disk_bytes: 2048,
            size_bytes: 4096,
        };

        let info = resp.to_snapshot_info();
        assert_eq!(info.name, "snap1");
        assert_eq!(info.disk_info.base_path, "");
        assert_eq!(info.disk_info.size_bytes, 4096);
    }
}
