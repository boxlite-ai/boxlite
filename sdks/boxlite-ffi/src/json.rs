//! JSON serialization utilities for BoxLite FFI
//!
//! Provides functions for converting BoxLite types to JSON.

use boxlite::runtime::types::{BoxInfo, BoxStatus};

/// Convert BoxStatus to string representation
pub fn status_to_string(status: BoxStatus) -> &'static str {
    match status {
        BoxStatus::Unknown => "unknown",
        BoxStatus::Configured => "configured",
        BoxStatus::Running => "running",
        BoxStatus::Stopping => "stopping",
        BoxStatus::Stopped => "stopped",
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
