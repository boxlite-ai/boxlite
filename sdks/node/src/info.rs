use boxlite::runtime::types::{BoxInfo, BoxStatus};
use napi_derive::napi;

// ============================================================================
// BoxStateInfo - Runtime state (Docker-like State object)
// ============================================================================

/// Runtime state information for a box.
///
/// Contains dynamic state that changes during the box lifecycle,
/// following Docker's State object pattern.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsBoxStateInfo {
    /// Current lifecycle status ("configured", "running", "stopped", etc.)
    pub status: String,

    /// Whether the box is currently running
    pub running: bool,

    /// Process ID of the VMM subprocess (undefined if not running)
    pub pid: Option<u32>,
}

fn status_to_string(status: BoxStatus) -> String {
    match status {
        BoxStatus::Unknown => "unknown",
        BoxStatus::Configured => "configured",
        BoxStatus::Running => "running",
        BoxStatus::Stopping => "stopping",
        BoxStatus::Stopped => "stopped",
        BoxStatus::Snapshotting => "snapshotting",
        BoxStatus::Restoring => "restoring",
        BoxStatus::Exporting => "exporting",
    }
    .to_string()
}

// ============================================================================
// BoxInfo - Container info with nested state
// ============================================================================

/// Public metadata about a box (returned by list operations).
///
/// Provides read-only information about a box's identity, configuration,
/// and runtime state. The `state` field contains dynamic runtime information.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsBoxInfo {
    /// Unique box identifier (ULID format)
    pub id: String,

    /// User-defined name (optional)
    pub name: Option<String>,

    /// Runtime state information
    pub state: JsBoxStateInfo,

    /// Creation timestamp (ISO 8601 format)
    pub created_at: String,

    /// Image reference or rootfs path
    pub image: String,

    /// Allocated CPU count
    pub cpus: u8,

    /// Allocated memory in MiB
    pub memory_mib: u32,
}

impl From<BoxInfo> for JsBoxInfo {
    fn from(info: BoxInfo) -> Self {
        let state = JsBoxStateInfo {
            status: status_to_string(info.status),
            running: info.status.is_running(),
            pid: info.pid,
        };

        Self {
            id: info.id.to_string(),
            name: info.name,
            state,
            created_at: info.created_at.to_rfc3339(),
            image: info.image,
            cpus: info.cpus,
            memory_mib: info.memory_mib,
        }
    }
}
