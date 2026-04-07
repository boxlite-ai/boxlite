//! JSON serialization utilities for BoxLite FFI
//!
//! Provides functions for converting BoxLite types to JSON.

use boxlite::runtime::types::{BoxInfo, BoxStatus, ImageInfo};

/// Convert BoxStatus to string representation
pub fn status_to_string(status: BoxStatus) -> &'static str {
    match status {
        BoxStatus::Unknown => "unknown",
        BoxStatus::Configured => "configured",
        BoxStatus::Running => "running",
        BoxStatus::Stopping => "stopping",
        BoxStatus::Stopped => "stopped",
        BoxStatus::Paused => "paused",
    }
}

/// Convert BoxInfo to JSON with nested state structure
pub fn box_info_to_json(info: &BoxInfo) -> serde_json::Value {
    serde_json::json!({
        "id": info.id.to_string(),
        "name": info.name,
        "state": {
            "status": status_to_string(info.status),
            "running": info.status.is_running(),
            "pid": info.pid
        },
        "created_at": info.created_at.to_rfc3339(),
        "image": info.image,
        "cpus": info.cpus,
        "memory_mib": info.memory_mib
    })
}

/// Convert cached image metadata to JSON.
pub fn image_info_to_json(info: &ImageInfo) -> serde_json::Value {
    serde_json::json!({
        "reference": info.reference,
        "repository": info.repository,
        "tag": info.tag,
        "id": info.id,
        "cached_at": info.cached_at.to_rfc3339(),
        "size_bytes": info.size.map(|size| size.as_bytes())
    })
}

/// Convert pulled image metadata to JSON.
pub fn image_pull_result_to_json(
    reference: &str,
    config_digest: &str,
    layer_count: usize,
) -> serde_json::Value {
    serde_json::json!({
        "reference": reference,
        "config_digest": config_digest,
        "layer_count": layer_count
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use boxlite::runtime::types::Bytes;
    use chrono::Utc;

    #[test]
    fn image_info_serializes_expected_fields() {
        let info = ImageInfo {
            reference: "docker.io/library/alpine:latest".to_string(),
            repository: "docker.io/library/alpine".to_string(),
            tag: "latest".to_string(),
            id: "sha256:abc123".to_string(),
            cached_at: Utc::now(),
            size: Some(Bytes::from_bytes(4096)),
        };

        let json = image_info_to_json(&info);

        assert_eq!(json["reference"], "docker.io/library/alpine:latest");
        assert_eq!(json["repository"], "docker.io/library/alpine");
        assert_eq!(json["tag"], "latest");
        assert_eq!(json["id"], "sha256:abc123");
        assert_eq!(json["size_bytes"], 4096);
        assert!(json["cached_at"].as_str().is_some());
    }

    #[test]
    fn image_pull_result_serializes_expected_fields() {
        let json = image_pull_result_to_json("alpine:latest", "sha256:def456", 3);

        assert_eq!(json["reference"], "alpine:latest");
        assert_eq!(json["config_digest"], "sha256:def456");
        assert_eq!(json["layer_count"], 3);
    }
}
