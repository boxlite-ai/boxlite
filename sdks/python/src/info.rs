use boxlite::{BoxInfo, BoxStateInfo, BoxStatus};
use pyo3::prelude::*;

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
            "pid": self.pid
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
        BoxStatus::Snapshotting => "snapshotting",
        BoxStatus::Restoring => "restoring",
        BoxStatus::Exporting => "exporting",
    }
    .to_string()
}

impl From<BoxStateInfo> for PyBoxStateInfo {
    fn from(info: BoxStateInfo) -> Self {
        PyBoxStateInfo {
            status: status_to_string(info.status),
            running: info.running,
            pid: info.pid,
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
                "pid": self.state.pid
            },
            "image": self.image,
            "cpus": self.cpus,
            "memory_mib": self.memory_mib,
            "created_at": self.created_at
        }))
        .unwrap_or_default()
    }
}

impl From<BoxInfo> for PyBoxInfo {
    fn from(info: BoxInfo) -> Self {
        let state = PyBoxStateInfo {
            status: status_to_string(info.status),
            running: info.status.is_running(),
            pid: info.pid,
        };

        PyBoxInfo {
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
