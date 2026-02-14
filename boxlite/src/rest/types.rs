//! Request/response serde structs matching the OpenAPI schema.
//!
//! These are wire-format types for the REST API. They are converted
//! to/from core types (BoxInfo, BoxOptions, etc.) at the boundary.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

// ============================================================================
// Error Model
// ============================================================================

#[derive(Debug, Deserialize)]
pub(crate) struct ErrorResponse {
    pub error: ErrorModel,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ErrorModel {
    pub message: String,
    #[serde(rename = "type")]
    pub error_type: String,
    #[allow(dead_code)]
    pub code: u16,
}

// ============================================================================
// Authentication
// ============================================================================

#[derive(Debug, Serialize)]
pub(crate) struct TokenRequest<'a> {
    pub grant_type: &'a str,
    pub client_id: &'a str,
    pub client_secret: &'a str,
}

#[derive(Debug, Deserialize)]
pub(crate) struct TokenResponse {
    pub access_token: String,
    #[allow(dead_code)]
    pub token_type: String,
    pub expires_in: u64,
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
    pub entrypoint: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cmd: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_remove: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detach: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub security: Option<String>,
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

        Self {
            name,
            image,
            rootfs_path,
            cpus: options.cpus,
            memory_mib: options.memory_mib,
            disk_size_gb: options.disk_size_gb,
            working_dir: options.working_dir.clone(),
            env,
            entrypoint: options.entrypoint.clone(),
            cmd: options.cmd.clone(),
            user: options.user.clone(),
            auto_remove: Some(options.auto_remove),
            detach: Some(options.detach),
            security: None, // TODO: map security preset
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
}

impl BoxResponse {
    pub fn to_box_info(&self) -> crate::BoxInfo {
        use crate::litebox::BoxStatus;
        use crate::runtime::types::BoxID;

        let id = BoxID::parse(&self.box_id).unwrap_or_default();

        let status = match self.status.as_str() {
            "configured" => BoxStatus::Configured,
            "running" => BoxStatus::Running,
            "stopping" => BoxStatus::Stopping,
            "stopped" => BoxStatus::Stopped,
            _ => BoxStatus::Unknown,
        };

        let created_at = chrono::DateTime::parse_from_rfc3339(&self.created_at)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now());

        let last_updated = chrono::DateTime::parse_from_rfc3339(&self.updated_at)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now());

        crate::BoxInfo {
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
        }
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct ListBoxesResponse {
    pub boxes: Vec<BoxResponse>,
    #[allow(dead_code)]
    pub next_page_token: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::*;

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
            entrypoint: None,
            cmd: None,
            user: None,
            auto_remove: Some(true),
            detach: None,
            security: None,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"name\":\"mybox\""));
        assert!(json.contains("\"image\":\"python:3.11\""));
        assert!(json.contains("\"cpus\":2"));
        // None fields should be skipped
        assert!(!json.contains("rootfs_path"));
        assert!(!json.contains("disk_size_gb"));
    }

    #[test]
    fn test_create_box_request_from_options() {
        use crate::runtime::options::{BoxOptions, RootfsSpec};

        let opts = BoxOptions {
            rootfs: RootfsSpec::Image("alpine:latest".into()),
            cpus: Some(4),
            memory_mib: Some(1024),
            ..Default::default()
        };
        let req = CreateBoxRequest::from_options(&opts, Some("test-box".into()));
        assert_eq!(req.name.as_deref(), Some("test-box"));
        assert_eq!(req.image.as_deref(), Some("alpine:latest"));
        assert!(req.rootfs_path.is_none());
        assert_eq!(req.cpus, Some(4));
        assert_eq!(req.memory_mib, Some(1024));
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
        };
        let info = resp.to_box_info();
        assert_eq!(info.name.as_deref(), Some("mybox"));
        assert_eq!(info.image, "python:3.11");
        assert_eq!(info.cpus, 2);
        assert_eq!(info.memory_mib, 512);
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
                "code": 404
            }
        }"#;
        let resp: ErrorResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.error.message, "box not found");
        assert_eq!(resp.error.error_type, "NotFoundError");
        assert_eq!(resp.error.code, 404);
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
}
