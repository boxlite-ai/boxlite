//! REST-managed checkpoints; local runtimes raise an unsupported error.

use std::sync::Arc;

use boxlite::{CheckpointHandle, CheckpointInfo};
use pyo3::prelude::*;

use crate::util::map_err;

#[pyclass(name = "CheckpointInfo")]
#[derive(Clone)]
pub(crate) struct PyCheckpointInfo {
    #[pyo3(get)]
    id: String,
    #[pyo3(get)]
    name: String,
    #[pyo3(get)]
    source_box_id: String,
    #[pyo3(get)]
    created_at: String,
    #[pyo3(get)]
    size_bytes: u64,
    #[pyo3(get)]
    state: String,
    #[pyo3(get)]
    error_reason: Option<String>,
}

impl From<CheckpointInfo> for PyCheckpointInfo {
    fn from(info: CheckpointInfo) -> Self {
        Self {
            id: info.id,
            name: info.name,
            source_box_id: info.source_box_id,
            created_at: info.created_at.to_rfc3339(),
            size_bytes: info.size_bytes,
            state: format!("{:?}", info.state).to_lowercase(),
            error_reason: info.error_reason,
        }
    }
}

#[pyclass(name = "CheckpointHandle")]
pub(crate) struct PyCheckpointHandle {
    pub(crate) handle: Arc<CheckpointHandle>,
}

#[pymethods]
impl PyCheckpointHandle {
    /// Capture a box directly into an independent managed disk archive.
    #[pyo3(signature = (source, name=None))]
    fn create<'py>(
        &self,
        py: Python<'py>,
        source: String,
        name: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            Ok(PyCheckpointInfo::from(
                handle.create(&source, name).await.map_err(map_err)?,
            ))
        })
    }

    fn list<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            Ok(handle
                .list()
                .await
                .map_err(map_err)?
                .into_iter()
                .map(PyCheckpointInfo::from)
                .collect::<Vec<_>>())
        })
    }

    fn get<'py>(&self, py: Python<'py>, key: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            Ok(PyCheckpointInfo::from(
                handle.get(&key).await.map_err(map_err)?,
            ))
        })
    }

    /// Force ignores absence; it never bypasses active use.
    #[pyo3(signature = (key, force=false))]
    fn remove<'py>(
        &self,
        py: Python<'py>,
        key: String,
        force: bool,
    ) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle.remove(&key, force).await.map_err(map_err)
        })
    }
}
