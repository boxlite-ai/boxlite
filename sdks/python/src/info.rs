use boxlite::{BoxInfo, BoxStateInfo, BoxStatus, HealthState as CoreHealthState};
use pyo3::prelude::*;

// ============================================================================
// HealthState - Health check state enumeration
// ============================================================================

#[pyclass(name = "HealthState")]
#[derive(Clone, Debug)]
pub struct PyHealthState {
    #[pyo3(get)]
    pub(crate) value: String,
}

#[pymethods]
impl PyHealthState {
    fn __repr__(&self) -> String {
        format!("<HealthState: {}>", self.value)
    }

    fn __str__(&self) -> String {
        self.value.clone()
    }

    #[staticmethod]
    fn none() -> Self {
        Self {
            value: "none".to_string(),
        }
    }

    #[staticmethod]
    fn starting() -> Self {
        Self {
            value: "starting".to_string(),
        }
    }

    #[staticmethod]
    fn healthy() -> Self {
        Self {
            value: "healthy".to_string(),
        }
    }

    #[staticmethod]
    fn unhealthy() -> Self {
        Self {
            value: "unhealthy".to_string(),
        }
    }

    fn is_none(&self) -> bool {
        self.value == "none"
    }

    fn is_starting(&self) -> bool {
        self.value == "starting"
    }

    fn is_healthy(&self) -> bool {
        self.value == "healthy"
    }

    fn is_unhealthy(&self) -> bool {
        self.value == "unhealthy"
    }
}

// ============================================================================
// HealthStatus - Health check status
// ============================================================================

#[pyclass(name = "HealthStatus")]
#[derive(Clone)]
pub struct PyHealthStatus {
    #[pyo3(get)]
    pub(crate) state: PyHealthState,
    #[pyo3(get)]
    pub(crate) failures: u32,
    #[pyo3(get)]
    pub(crate) last_check: Option<String>,
}

#[pymethods]
impl PyHealthStatus {
    fn __repr__(&self) -> String {
        serde_json::to_string_pretty(&serde_json::json!({
            "state": self.state.value,
            "failures": self.failures,
            "last_check": self.last_check
        }))
        .unwrap_or_default()
    }
}

// ============================================================================
// BoxStateInfo - Runtime state (Docker-like State object)
// ============================================================================

#[pyclass(name = "BoxStateInfo")]
#[derive(Clone)]
pub struct PyBoxStateInfo {
    #[pyo3(get)]
    pub(crate) status: String,
    #[pyo3(get)]
    pub(crate) running: bool,
    #[pyo3(get)]
    pub(crate) pid: Option<u32>,
}

#[pymethods]
impl PyBoxStateInfo {
    fn __repr__(&self) -> String {
        serde_json::to_string_pretty(&serde_json::json!({
            "status": self.status,
            "running": self.running,
            "pid": self.pid,
        }))
        .unwrap_or_default()
    }
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

fn health_state_to_py(state: &CoreHealthState) -> PyHealthState {
    let value = match state {
        CoreHealthState::None => "none",
        CoreHealthState::Starting => "starting",
        CoreHealthState::Healthy => "healthy",
        CoreHealthState::Unhealthy => "unhealthy",
    }
    .to_string();
    PyHealthState { value }
}

impl From<BoxStateInfo> for PyBoxStateInfo {
    fn from(state_info: BoxStateInfo) -> Self {
        PyBoxStateInfo {
            status: status_to_string(state_info.status),
            running: state_info.running,
            pid: state_info.pid,
        }
    }
}

// ============================================================================
// BoxInfo - Container info with nested state
// ============================================================================

#[pyclass(name = "BoxInfo")]
#[derive(Clone)]
pub(crate) struct PyBoxInfo {
    #[pyo3(get)]
    pub(crate) id: String,
    #[pyo3(get)]
    pub(crate) name: Option<String>,
    #[pyo3(get)]
    pub(crate) state: PyBoxStateInfo,
    #[pyo3(get)]
    pub(crate) created_at: String,
    #[pyo3(get)]
    pub(crate) image: String,
    #[pyo3(get)]
    pub(crate) cpus: u8,
    #[pyo3(get)]
    pub(crate) memory_mib: u32,
    #[pyo3(get)]
    pub(crate) health_status: PyHealthStatus,
}

#[pymethods]
impl PyBoxInfo {
    fn __repr__(&self) -> String {
        serde_json::to_string_pretty(&serde_json::json!({
            "id": self.id,
            "name": self.name,
            "state": {
                "status": self.state.status,
                "running": self.state.running,
                "pid": self.state.pid,
            },
            "image": self.image,
            "cpus": self.cpus,
            "memory_mib": self.memory_mib,
            "created_at": self.created_at,
            "health_status": {
                "state": self.health_status.state.value,
                "failures": self.health_status.failures,
                "last_check": self.health_status.last_check
            }
        }))
        .unwrap_or_default()
    }
}

impl From<BoxInfo> for PyBoxInfo {
    fn from(info: BoxInfo) -> Self {
        let state_info = BoxStateInfo::from(&info);
        let state = PyBoxStateInfo::from(state_info);
        let health_status = PyHealthStatus {
            state: health_state_to_py(&info.health_status.state),
            failures: info.health_status.failures,
            last_check: info.health_status.last_check.map(|dt| dt.to_rfc3339()),
        };

        PyBoxInfo {
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
