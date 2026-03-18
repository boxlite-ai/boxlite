//! REST wire types matching the OpenAPI schema (`openapi/rest-sandbox-open-api.yaml`).
//!
//! All types derive `utoipa::ToSchema` for OpenAPI documentation.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

// ============================================================================
// Configuration
// ============================================================================

/// Server configuration and capabilities.
#[derive(Debug, Serialize, ToSchema)]
pub struct SandboxConfig {
    /// Default values applied when not specified in requests.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub defaults: Option<SandboxDefaults>,
    /// Server-enforced overrides that clients cannot change.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overrides: Option<HashMap<String, String>>,
    /// Server capability limits and feature flags.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<SandboxCapabilities>,
}

/// Default box configuration values.
#[derive(Debug, Serialize, ToSchema)]
pub struct SandboxDefaults {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpus: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_mib: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_size_gb: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub security_preset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_remove: Option<bool>,
}

/// Server capability limits and feature flags.
#[derive(Debug, Serialize, ToSchema)]
pub struct SandboxCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_cpus: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_memory_mib: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_disk_size_gb: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_boxes_per_prefix: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_concurrent_executions: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_transfer_max_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exec_timeout_max_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tty_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streaming_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshots_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clone_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub export_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported_security_presets: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key_lifetime: Option<String>,
}

// ============================================================================
// Authentication
// ============================================================================

/// OAuth2 client credentials token request.
#[derive(Debug, Deserialize, ToSchema)]
pub struct TokenRequest {
    pub grant_type: String,
    pub client_id: String,
    pub client_secret: String,
    #[serde(default)]
    pub scope: Option<String>,
}

/// OAuth2 token response.
#[derive(Debug, Serialize, ToSchema)]
pub struct TokenResponse {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

// ============================================================================
// Box
// ============================================================================

/// Sandbox box metadata.
#[derive(Debug, Serialize, ToSchema)]
#[schema(as = Box)]
pub struct RestBoxResponse {
    pub box_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub image: String,
    pub cpus: u32,
    pub memory_mib: u32,
    #[serde(default)]
    pub labels: HashMap<String, String>,
}

/// Box lifecycle state.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum BoxStatus {
    Configured,
    Running,
    Stopping,
    Stopped,
    Paused,
    Unknown,
}

/// Configuration for creating a new box.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateBoxRequest {
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
    pub volumes: Option<Vec<VolumeSpec>>,
    #[serde(default)]
    pub ports: Option<Vec<PortSpec>>,
    #[serde(default)]
    pub network: Option<String>,
    #[serde(default)]
    pub auto_remove: Option<bool>,
    #[serde(default)]
    pub detach: Option<bool>,
    #[serde(default)]
    pub security: Option<SecurityPreset>,
}

/// Host-to-guest filesystem mount.
#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct VolumeSpec {
    pub host_path: String,
    pub guest_path: String,
    #[serde(default)]
    pub read_only: bool,
}

/// Port forwarding rule (host → guest).
#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct PortSpec {
    #[serde(default)]
    pub host_port: Option<u16>,
    pub guest_port: u16,
    #[serde(default)]
    pub protocol: Option<String>,
    #[serde(default)]
    pub host_ip: Option<String>,
}

/// Security isolation preset.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SecurityPreset {
    Development,
    Standard,
    Maximum,
}

/// List boxes response with pagination.
#[derive(Debug, Serialize, ToSchema)]
pub struct ListBoxesResponse {
    pub boxes: Vec<RestBoxResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_page_token: Option<String>,
}

/// Request to stop a box with timeout.
#[derive(Debug, Deserialize, ToSchema)]
pub struct StopBoxRequest {
    #[serde(default = "default_timeout")]
    pub timeout_seconds: f64,
}

fn default_timeout() -> f64 {
    30.0
}

// ============================================================================
// Snapshots / Clone / Export
// ============================================================================

/// Snapshot metadata.
#[derive(Debug, Serialize, ToSchema)]
pub struct Snapshot {
    pub id: String,
    pub box_id: String,
    pub name: String,
    pub created_at: i64,
    pub guest_disk_bytes: i64,
    pub container_disk_bytes: i64,
    pub size_bytes: i64,
}

/// Request to create a snapshot.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateSnapshotRequest {
    pub name: String,
}

/// List snapshots response.
#[derive(Debug, Serialize, ToSchema)]
pub struct ListSnapshotsResponse {
    pub snapshots: Vec<Snapshot>,
}

/// Request to clone a box.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CloneBoxRequest {
    #[serde(default)]
    pub name: Option<String>,
}

/// Forward-compatible export options.
#[derive(Debug, Deserialize, ToSchema)]
pub struct ExportBoxRequest {}

// ============================================================================
// Execution
// ============================================================================

/// Command execution request.
#[derive(Debug, Deserialize, ToSchema)]
#[schema(as = ExecRequest)]
pub struct RestExecRequest {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub timeout_seconds: Option<f64>,
    #[serde(default)]
    pub working_dir: Option<String>,
    #[serde(default)]
    pub tty: bool,
}

/// Response from starting an async execution.
#[derive(Debug, Serialize, ToSchema)]
#[schema(as = ExecResponse)]
pub struct RestExecResponse {
    pub execution_id: String,
}

/// Execution status and result.
#[derive(Debug, Serialize, ToSchema)]
pub struct ExecutionInfo {
    pub execution_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

/// Signal request.
#[derive(Debug, Deserialize, ToSchema)]
pub struct SignalRequest {
    pub signal: i32,
}

/// TTY resize request.
#[derive(Debug, Deserialize, ToSchema)]
pub struct ResizeRequest {
    pub cols: u32,
    pub rows: u32,
}

/// Query parameters for remove_box.
#[derive(Debug, Deserialize)]
pub struct RemoveQuery {
    #[serde(default)]
    pub force: Option<bool>,
}

// ============================================================================
// Metrics
// ============================================================================

/// Aggregate runtime metrics across all boxes.
#[derive(Debug, Serialize, ToSchema)]
pub struct RuntimeMetrics {
    #[serde(default)]
    pub boxes_created_total: u64,
    #[serde(default)]
    pub boxes_failed_total: u64,
    #[serde(default)]
    pub boxes_stopped_total: u64,
    #[serde(default)]
    pub num_running_boxes: u64,
    #[serde(default)]
    pub total_commands_executed: u64,
    #[serde(default)]
    pub total_exec_errors: u64,
}

/// Per-box resource usage and execution metrics.
#[derive(Debug, Serialize, ToSchema)]
pub struct BoxMetrics {
    #[serde(default)]
    pub commands_executed_total: u64,
    #[serde(default)]
    pub exec_errors_total: u64,
    #[serde(default)]
    pub bytes_sent_total: u64,
    #[serde(default)]
    pub bytes_received_total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_percent: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network_bytes_sent: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network_bytes_received: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network_tcp_connections: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network_tcp_errors: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boot_timing: Option<BootTiming>,
}

/// Stage-level initialization timing breakdown (milliseconds).
#[derive(Debug, Serialize, ToSchema)]
pub struct BootTiming {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_create_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guest_boot_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filesystem_setup_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_prepare_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guest_rootfs_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub box_config_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub box_spawn_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container_init_ms: Option<u64>,
}

// ============================================================================
// Images
// ============================================================================

/// Cached container image metadata.
#[derive(Debug, Serialize, ToSchema)]
pub struct ImageInfo {
    pub reference: String,
    pub repository: String,
    pub tag: String,
    pub id: String,
    pub cached_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
}

/// Request to pull an image from registry.
#[derive(Debug, Deserialize, ToSchema)]
pub struct PullImageRequest {
    pub reference: String,
}

/// List images response with pagination.
#[derive(Debug, Serialize, ToSchema)]
pub struct ListImagesResponse {
    pub images: Vec<ImageInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_page_token: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    // ====================================================================
    // Configuration
    // ====================================================================

    #[test]
    fn test_sandbox_config_serialization() {
        let config = SandboxConfig {
            defaults: None,
            overrides: None,
            capabilities: Some(SandboxCapabilities {
                snapshots_enabled: Some(true),
                clone_enabled: Some(false),
                max_cpus: None,
                max_memory_mib: None,
                max_disk_size_gb: None,
                max_boxes_per_prefix: None,
                max_concurrent_executions: None,
                file_transfer_max_bytes: None,
                exec_timeout_max_seconds: None,
                tty_enabled: None,
                streaming_enabled: None,
                export_enabled: None,
                supported_security_presets: None,
                idempotency_key_lifetime: None,
            }),
        };
        let v: Value = serde_json::to_value(&config).unwrap();
        // None fields should be omitted
        assert!(!v.as_object().unwrap().contains_key("defaults"));
        assert!(!v.as_object().unwrap().contains_key("overrides"));
        assert_eq!(v["capabilities"]["snapshots_enabled"], true);
        assert_eq!(v["capabilities"]["clone_enabled"], false);
        // None sub-fields omitted
        assert!(
            !v["capabilities"]
                .as_object()
                .unwrap()
                .contains_key("max_cpus")
        );
    }

    #[test]
    fn test_token_response_serialization() {
        let resp = TokenResponse {
            access_token: "tok-123".into(),
            token_type: "bearer".into(),
            expires_in: 3600,
            scope: Some("boxes:read".into()),
        };
        let v: Value = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["access_token"], "tok-123");
        assert_eq!(v["token_type"], "bearer");
        assert_eq!(v["expires_in"], 3600);
        assert_eq!(v["scope"], "boxes:read");
    }

    #[test]
    fn test_token_response_scope_omitted_when_none() {
        let resp = TokenResponse {
            access_token: "tok".into(),
            token_type: "bearer".into(),
            expires_in: 60,
            scope: None,
        };
        let v: Value = serde_json::to_value(&resp).unwrap();
        assert!(!v.as_object().unwrap().contains_key("scope"));
    }

    // ====================================================================
    // Box types
    // ====================================================================

    #[test]
    fn test_rest_box_response_serialization() {
        let resp = RestBoxResponse {
            box_id: "01ABC".into(),
            name: Some("mybox".into()),
            status: "running".into(),
            created_at: "2024-01-01T00:00:00Z".into(),
            updated_at: "2024-01-01T00:01:00Z".into(),
            pid: Some(1234),
            image: "alpine:latest".into(),
            cpus: 2,
            memory_mib: 512,
            labels: HashMap::from([("env".into(), "test".into())]),
        };
        let v: Value = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["box_id"], "01ABC");
        assert_eq!(v["name"], "mybox");
        assert_eq!(v["pid"], 1234);
        assert_eq!(v["labels"]["env"], "test");
    }

    #[test]
    fn test_rest_box_response_optional_fields() {
        let resp = RestBoxResponse {
            box_id: "01ABC".into(),
            name: None,
            status: "stopped".into(),
            created_at: "2024-01-01T00:00:00Z".into(),
            updated_at: "2024-01-01T00:00:00Z".into(),
            pid: None,
            image: "alpine".into(),
            cpus: 1,
            memory_mib: 128,
            labels: HashMap::new(),
        };
        let v: Value = serde_json::to_value(&resp).unwrap();
        assert!(v["name"].is_null());
        assert!(v["pid"].is_null());
    }

    #[test]
    fn test_box_status_enum_serde() {
        assert_eq!(
            serde_json::to_string(&BoxStatus::Running).unwrap(),
            "\"running\""
        );
        assert_eq!(
            serde_json::to_string(&BoxStatus::Configured).unwrap(),
            "\"configured\""
        );
        assert_eq!(
            serde_json::to_string(&BoxStatus::Stopping).unwrap(),
            "\"stopping\""
        );
        assert_eq!(
            serde_json::to_string(&BoxStatus::Stopped).unwrap(),
            "\"stopped\""
        );
        assert_eq!(
            serde_json::to_string(&BoxStatus::Paused).unwrap(),
            "\"paused\""
        );
        assert_eq!(
            serde_json::to_string(&BoxStatus::Unknown).unwrap(),
            "\"unknown\""
        );

        // Deserialize round-trip
        let status: BoxStatus = serde_json::from_str("\"running\"").unwrap();
        assert!(matches!(status, BoxStatus::Running));
    }

    #[test]
    fn test_security_preset_enum_serde() {
        assert_eq!(
            serde_json::to_string(&SecurityPreset::Development).unwrap(),
            "\"development\""
        );
        assert_eq!(
            serde_json::to_string(&SecurityPreset::Standard).unwrap(),
            "\"standard\""
        );
        assert_eq!(
            serde_json::to_string(&SecurityPreset::Maximum).unwrap(),
            "\"maximum\""
        );
    }

    #[test]
    fn test_create_box_request_full_deserialization() {
        let input = json!({
            "name": "mybox",
            "image": "python:3.11",
            "cpus": 4,
            "memory_mib": 1024,
            "disk_size_gb": 10,
            "working_dir": "/app",
            "env": {"FOO": "bar"},
            "entrypoint": ["/bin/sh"],
            "cmd": ["-c", "echo hi"],
            "user": "1000:1000",
            "volumes": [{"host_path": "/tmp", "guest_path": "/mnt", "read_only": true}],
            "ports": [{"guest_port": 8080, "protocol": "tcp"}],
            "network": "isolated",
            "auto_remove": false,
            "detach": true,
            "security": "maximum"
        });
        let req: CreateBoxRequest = serde_json::from_value(input).unwrap();
        assert_eq!(req.name.as_deref(), Some("mybox"));
        assert_eq!(req.cpus, Some(4));
        assert_eq!(req.volumes.as_ref().unwrap().len(), 1);
        assert!(req.volumes.as_ref().unwrap()[0].read_only);
        assert_eq!(req.ports.as_ref().unwrap()[0].guest_port, 8080);
        assert!(matches!(req.security, Some(SecurityPreset::Maximum)));
    }

    #[test]
    fn test_create_box_request_defaults() {
        let req: CreateBoxRequest = serde_json::from_str("{}").unwrap();
        assert!(req.name.is_none());
        assert!(req.image.is_none());
        assert!(req.cpus.is_none());
        assert!(req.memory_mib.is_none());
        assert!(req.volumes.is_none());
        assert!(req.ports.is_none());
        assert!(req.security.is_none());
        assert!(req.auto_remove.is_none());
        assert!(req.detach.is_none());
    }

    #[test]
    fn test_create_box_request_with_env_map() {
        let input = json!({"env": {"KEY1": "val1", "KEY2": "val2"}});
        let req: CreateBoxRequest = serde_json::from_value(input).unwrap();
        let env = req.env.unwrap();
        assert_eq!(env.len(), 2);
        assert_eq!(env["KEY1"], "val1");
    }

    #[test]
    fn test_list_boxes_response_with_pagination() {
        let resp = ListBoxesResponse {
            boxes: vec![],
            next_page_token: Some("tok-abc".into()),
        };
        let v: Value = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["next_page_token"], "tok-abc");
        assert!(v["boxes"].as_array().unwrap().is_empty());
    }

    #[test]
    fn test_list_boxes_response_without_pagination() {
        let resp = ListBoxesResponse {
            boxes: vec![],
            next_page_token: None,
        };
        let v: Value = serde_json::to_value(&resp).unwrap();
        assert!(!v.as_object().unwrap().contains_key("next_page_token"));
    }

    #[test]
    fn test_stop_box_request_default_timeout() {
        let req: StopBoxRequest = serde_json::from_str("{}").unwrap();
        assert!((req.timeout_seconds - 30.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_stop_box_request_custom_timeout() {
        let req: StopBoxRequest = serde_json::from_str(r#"{"timeout_seconds": 5.0}"#).unwrap();
        assert!((req.timeout_seconds - 5.0).abs() < f64::EPSILON);
    }

    // ====================================================================
    // Snapshot / Clone / Export
    // ====================================================================

    #[test]
    fn test_snapshot_serialization() {
        let snap = Snapshot {
            id: "snap-01".into(),
            box_id: "box-01".into(),
            name: "before-deploy".into(),
            created_at: 1700000000,
            guest_disk_bytes: 1024,
            container_disk_bytes: 2048,
            size_bytes: 4096,
        };
        let v: Value = serde_json::to_value(&snap).unwrap();
        assert_eq!(v["name"], "before-deploy");
        assert_eq!(v["created_at"], 1700000000_i64);
        assert_eq!(v["size_bytes"], 4096);
    }

    #[test]
    fn test_create_snapshot_request_deserialization() {
        let req: CreateSnapshotRequest = serde_json::from_str(r#"{"name": "snap1"}"#).unwrap();
        assert_eq!(req.name, "snap1");
    }

    #[test]
    fn test_clone_box_request_with_name() {
        let req: CloneBoxRequest = serde_json::from_str(r#"{"name": "clone-1"}"#).unwrap();
        assert_eq!(req.name.as_deref(), Some("clone-1"));
    }

    #[test]
    fn test_clone_box_request_without_name() {
        let req: CloneBoxRequest = serde_json::from_str("{}").unwrap();
        assert!(req.name.is_none());
    }

    // ====================================================================
    // Execution
    // ====================================================================

    #[test]
    fn test_exec_request_full() {
        let input = json!({
            "command": "python3",
            "args": ["-c", "print('hi')"],
            "env": {"PYTHONPATH": "/app"},
            "timeout_seconds": 30.0,
            "working_dir": "/app",
            "tty": true
        });
        let req: RestExecRequest = serde_json::from_value(input).unwrap();
        assert_eq!(req.command, "python3");
        assert_eq!(req.args.len(), 2);
        assert!(req.tty);
        assert_eq!(req.timeout_seconds, Some(30.0));
    }

    #[test]
    fn test_exec_request_minimal() {
        let req: RestExecRequest = serde_json::from_str(r#"{"command": "ls"}"#).unwrap();
        assert_eq!(req.command, "ls");
        assert!(req.args.is_empty());
        assert!(!req.tty);
        assert!(req.env.is_none());
        assert!(req.timeout_seconds.is_none());
        assert!(req.working_dir.is_none());
    }

    #[test]
    fn test_exec_response_serialization() {
        let resp = RestExecResponse {
            execution_id: "exec-01".into(),
        };
        let v: Value = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["execution_id"], "exec-01");
    }

    #[test]
    fn test_execution_info_omits_null_fields() {
        let info = ExecutionInfo {
            execution_id: "exec-01".into(),
            status: "running".into(),
            exit_code: None,
            started_at: None,
            duration_ms: None,
            error_message: None,
        };
        let v: Value = serde_json::to_value(&info).unwrap();
        assert_eq!(v["execution_id"], "exec-01");
        assert_eq!(v["status"], "running");
        assert!(!v.as_object().unwrap().contains_key("exit_code"));
        assert!(!v.as_object().unwrap().contains_key("duration_ms"));
    }

    #[test]
    fn test_execution_info_with_completed() {
        let info = ExecutionInfo {
            execution_id: "exec-02".into(),
            status: "completed".into(),
            exit_code: Some(0),
            started_at: Some("2024-01-01T00:00:00Z".into()),
            duration_ms: Some(1500),
            error_message: None,
        };
        let v: Value = serde_json::to_value(&info).unwrap();
        assert_eq!(v["exit_code"], 0);
        assert_eq!(v["duration_ms"], 1500);
    }

    #[test]
    fn test_signal_request_deserialization() {
        let req: SignalRequest = serde_json::from_str(r#"{"signal": 9}"#).unwrap();
        assert_eq!(req.signal, 9);
    }

    #[test]
    fn test_resize_request_deserialization() {
        let req: ResizeRequest = serde_json::from_str(r#"{"cols": 120, "rows": 40}"#).unwrap();
        assert_eq!(req.cols, 120);
        assert_eq!(req.rows, 40);
    }

    #[test]
    fn test_remove_query_defaults() {
        let q: RemoveQuery = serde_json::from_str("{}").unwrap();
        assert!(q.force.is_none());
    }

    #[test]
    fn test_remove_query_with_force() {
        let q: RemoveQuery = serde_json::from_str(r#"{"force": true}"#).unwrap();
        assert_eq!(q.force, Some(true));
    }

    // ====================================================================
    // Metrics
    // ====================================================================

    #[test]
    fn test_runtime_metrics_serialization() {
        let m = RuntimeMetrics {
            boxes_created_total: 10,
            boxes_failed_total: 1,
            boxes_stopped_total: 5,
            num_running_boxes: 4,
            total_commands_executed: 100,
            total_exec_errors: 2,
        };
        let v: Value = serde_json::to_value(&m).unwrap();
        assert_eq!(v["boxes_created_total"], 10);
        assert_eq!(v["total_exec_errors"], 2);
    }

    #[test]
    fn test_box_metrics_optional_fields() {
        let m = BoxMetrics {
            commands_executed_total: 5,
            exec_errors_total: 0,
            bytes_sent_total: 100,
            bytes_received_total: 200,
            cpu_percent: Some(25.5),
            memory_bytes: Some(1024 * 1024),
            network_bytes_sent: None,
            network_bytes_received: None,
            network_tcp_connections: None,
            network_tcp_errors: None,
            boot_timing: None,
        };
        let v: Value = serde_json::to_value(&m).unwrap();
        assert_eq!(v["cpu_percent"], 25.5);
        assert_eq!(v["memory_bytes"], 1024 * 1024);
        assert!(!v.as_object().unwrap().contains_key("network_bytes_sent"));
        assert!(!v.as_object().unwrap().contains_key("boot_timing"));
    }

    #[test]
    fn test_boot_timing_all_none() {
        let bt = BootTiming {
            total_create_ms: None,
            guest_boot_ms: None,
            filesystem_setup_ms: None,
            image_prepare_ms: None,
            guest_rootfs_ms: None,
            box_config_ms: None,
            box_spawn_ms: None,
            container_init_ms: None,
        };
        let v: Value = serde_json::to_value(&bt).unwrap();
        assert!(v.as_object().unwrap().is_empty());
    }

    #[test]
    fn test_boot_timing_partial() {
        let bt = BootTiming {
            total_create_ms: Some(500),
            guest_boot_ms: Some(200),
            filesystem_setup_ms: None,
            image_prepare_ms: None,
            guest_rootfs_ms: None,
            box_config_ms: None,
            box_spawn_ms: None,
            container_init_ms: None,
        };
        let v: Value = serde_json::to_value(&bt).unwrap();
        assert_eq!(v["total_create_ms"], 500);
        assert_eq!(v["guest_boot_ms"], 200);
        assert_eq!(v.as_object().unwrap().len(), 2);
    }

    // ====================================================================
    // Images
    // ====================================================================

    #[test]
    fn test_image_info_serialization() {
        let img = ImageInfo {
            reference: "docker.io/library/python:3.11".into(),
            repository: "docker.io/library/python".into(),
            tag: "3.11".into(),
            id: "sha256:abc123".into(),
            cached_at: "2024-01-01T00:00:00Z".into(),
            size_bytes: Some(150_000_000),
        };
        let v: Value = serde_json::to_value(&img).unwrap();
        assert_eq!(v["reference"], "docker.io/library/python:3.11");
        assert_eq!(v["tag"], "3.11");
        assert_eq!(v["size_bytes"], 150_000_000_u64);
    }

    #[test]
    fn test_image_info_no_size() {
        let img = ImageInfo {
            reference: "alpine:latest".into(),
            repository: "alpine".into(),
            tag: "latest".into(),
            id: "sha256:def".into(),
            cached_at: "2024-01-01T00:00:00Z".into(),
            size_bytes: None,
        };
        let v: Value = serde_json::to_value(&img).unwrap();
        assert!(!v.as_object().unwrap().contains_key("size_bytes"));
    }

    #[test]
    fn test_pull_image_request_deserialization() {
        let req: PullImageRequest =
            serde_json::from_str(r#"{"reference": "python:3.11"}"#).unwrap();
        assert_eq!(req.reference, "python:3.11");
    }

    #[test]
    fn test_list_images_response() {
        let resp = ListImagesResponse {
            images: vec![],
            next_page_token: None,
        };
        let v: Value = serde_json::to_value(&resp).unwrap();
        assert!(v["images"].as_array().unwrap().is_empty());
        assert!(!v.as_object().unwrap().contains_key("next_page_token"));
    }

    // ====================================================================
    // Volume / Port
    // ====================================================================

    #[test]
    fn test_volume_spec_round_trip() {
        let input = json!({"host_path": "/tmp", "guest_path": "/mnt"});
        let vol: VolumeSpec = serde_json::from_value(input).unwrap();
        assert_eq!(vol.host_path, "/tmp");
        assert_eq!(vol.guest_path, "/mnt");
        assert!(!vol.read_only); // default
    }

    #[test]
    fn test_port_spec_round_trip() {
        let input = json!({"guest_port": 8080});
        let port: PortSpec = serde_json::from_value(input).unwrap();
        assert_eq!(port.guest_port, 8080);
        assert!(port.host_port.is_none());
        assert!(port.protocol.is_none());
    }
}
