use boxlite::litebox::HealthState as CoreHealthState;
use boxlite::runtime::types::{BoxInfo, BoxStateInfo, BoxStatus};
use napi_derive::napi;

// ============================================================================
// HealthState - Health check state enumeration
// ============================================================================

/// Health state of a box.
#[napi(string_enum)]
#[derive(Clone, Debug)]
pub enum JsHealthState {
    /// No health check configured
    None,
    /// Within start_period, not yet checked
    Starting,
    /// Last health check passed
    Healthy,
    /// Failed retries consecutive checks
    Unhealthy,
}

fn health_state_to_js(state: &CoreHealthState) -> JsHealthState {
    match state {
        CoreHealthState::None => JsHealthState::None,
        CoreHealthState::Starting => JsHealthState::Starting,
        CoreHealthState::Healthy => JsHealthState::Healthy,
        CoreHealthState::Unhealthy => JsHealthState::Unhealthy,
    }
}

// ============================================================================
// HealthStatus - Health check status
// ============================================================================

/// Health status of a box with health check enabled.
///
/// Tracks the current health state and consecutive failure count.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsHealthStatus {
    /// Current health state
    pub state: JsHealthState,
    /// Consecutive health check failures
    pub failures: u32,
    /// Last health check timestamp (ISO 8601 format)
    pub last_check: Option<String>,
}

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
        BoxStatus::Paused => "paused",
    }
    .to_string()
}

impl From<BoxStateInfo> for JsBoxStateInfo {
    fn from(state_info: BoxStateInfo) -> Self {
        Self {
            status: status_to_string(state_info.status),
            running: state_info.running,
            pid: state_info.pid,
        }
    }
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

    /// Health status
    pub health_status: JsHealthStatus,
}

impl From<BoxInfo> for JsBoxInfo {
    fn from(info: BoxInfo) -> Self {
        let state_info = BoxStateInfo::from(&info);
        let state = JsBoxStateInfo::from(state_info);
        let health_status = JsHealthStatus {
            state: health_state_to_js(&info.health_status.state),
            failures: info.health_status.failures,
            last_check: info.health_status.last_check.map(|dt| dt.to_rfc3339()),
        };

        Self {
            id: info.id.to_string(),
            name: info.name,
            state,
            created_at: info.created_at.to_rfc3339(),
            image: info.image,
            cpus: info.cpus,
            memory_mib: info.memory_mib,
            health_status,
        }
    }
}
