//! Python bindings for runtime directory delivery (M6).

use std::sync::Arc;

use boxlite::{LiteBox, MountInfo, MountRequest, MountState};
use pyo3::prelude::*;

use crate::util::map_err;

/// A request to deliver a host directory into the running container.
#[pyclass(name = "MountRequest")]
pub(crate) struct PyMountRequest {
    #[pyo3(get, set)]
    pub source: String,
    #[pyo3(get, set)]
    pub target: String,
    #[pyo3(get, set)]
    pub read_only: bool,
}

#[pymethods]
impl PyMountRequest {
    #[new]
    #[pyo3(signature = (*, source, target, read_only = false))]
    fn new(source: String, target: String, read_only: bool) -> Self {
        Self {
            source,
            target,
            read_only,
        }
    }

    fn __repr__(&self) -> String {
        format!(
            "MountRequest(source='{}', target='{}', read_only={})",
            self.source, self.target, self.read_only
        )
    }
}

/// A runtime mount as the outside world sees it.
#[pyclass(name = "MountInfo")]
pub(crate) struct PyMountInfo {
    #[pyo3(get)]
    pub source: String,
    #[pyo3(get)]
    pub target: String,
    #[pyo3(get)]
    pub read_only: bool,
    #[pyo3(get)]
    pub state: String,
}

#[pymethods]
impl PyMountInfo {
    fn __repr__(&self) -> String {
        format!(
            "MountInfo(source='{}', target='{}', read_only={}, state='{}')",
            self.source, self.target, self.read_only, self.state
        )
    }
}

impl From<MountInfo> for PyMountInfo {
    fn from(info: MountInfo) -> Self {
        Self {
            source: info.source.display().to_string(),
            target: info.target.display().to_string(),
            read_only: info.read_only,
            state: match info.state {
                MountState::Mounted => "mounted".into(),
                MountState::Detaching => "detaching".into(),
            },
        }
    }
}

/// Handle for runtime directory delivery on a Box.
///
/// Accessed via `box.mounts`: `await box.mounts.add(...)`,
/// `await box.mounts.list()`, `await box.mounts.remove(target)`.
#[pyclass(name = "MountsHandle")]
pub(crate) struct PyMountsHandle {
    pub(crate) handle: Arc<LiteBox>,
}

#[pymethods]
impl PyMountsHandle {
    /// Deliver a host directory into the running container.
    fn add<'py>(&self, py: Python<'py>, request: &PyMountRequest) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        let request = MountRequest {
            source: std::path::PathBuf::from(&request.source),
            target: std::path::PathBuf::from(&request.target),
            read_only: request.read_only,
        };
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let info = handle.mounts().add(request).await.map_err(map_err)?;
            Ok(PyMountInfo::from(info))
        })
    }

    /// Lazily detach the mount at a container target.
    fn remove<'py>(&self, py: Python<'py>, target: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle.mounts().remove(&target).await.map_err(map_err)?;
            Ok(())
        })
    }

    /// List every runtime mount of the current VM run.
    fn list<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let mounts = handle
                .mounts()
                .list()
                .await
                .map_err(map_err)?
                .into_iter()
                .map(PyMountInfo::from)
                .collect::<Vec<_>>();
            Ok(mounts)
        })
    }

    /// The mount at a container target, or None.
    fn get<'py>(&self, py: Python<'py>, target: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let info = handle
                .mounts()
                .get(&target)
                .await
                .map_err(map_err)?
                .map(PyMountInfo::from);
            Ok(info)
        })
    }
}
