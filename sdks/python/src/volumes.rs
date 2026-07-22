use std::sync::Arc;

use boxlite::runtime::VolumeHandle;
use boxlite::runtime::types::VolumeInfo;
use pyo3::prelude::*;

use crate::util::map_err;

/// Metadata for a named volume.
#[pyclass(name = "VolumeInfo")]
#[derive(Clone)]
pub(crate) struct PyVolumeInfo {
    /// Server-assigned volume id used by get and remove operations.
    #[pyo3(get)]
    pub(crate) id: String,
    /// Creation timestamp formatted as an RFC 3339 string.
    #[pyo3(get)]
    pub(crate) created_at: String,
    /// Volume size in bytes when the backend can report it.
    #[pyo3(get)]
    pub(crate) size_bytes: Option<u64>,
}

#[pymethods]
impl PyVolumeInfo {
    fn __repr__(&self) -> String {
        format!(
            "VolumeInfo(id={:?}, created_at={:?})",
            self.id, self.created_at
        )
    }
}

impl From<VolumeInfo> for PyVolumeInfo {
    fn from(info: VolumeInfo) -> Self {
        Self {
            id: info.id,
            created_at: info.created_at.to_rfc3339(),
            size_bytes: info.size_bytes,
        }
    }
}

/// Runtime-scoped handle for named-volume operations.
#[pyclass(name = "VolumeHandle")]
pub(crate) struct PyVolumeHandle {
    pub(crate) handle: Arc<VolumeHandle>,
}

#[pymethods]
impl PyVolumeHandle {
    /// Create a named volume.
    ///
    /// Returns an awaitable that resolves to the new `VolumeInfo`. Backend
    /// failures are raised when the awaitable is awaited.
    fn create<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let info = handle.create().await.map_err(map_err)?;
            Ok(PyVolumeInfo::from(info))
        })
    }

    /// List named volumes visible to this runtime.
    ///
    /// Returns an awaitable that resolves to a list of `VolumeInfo` objects.
    fn list<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let infos = handle.list().await.map_err(map_err)?;
            Ok(infos
                .into_iter()
                .map(PyVolumeInfo::from)
                .collect::<Vec<_>>())
        })
    }

    /// Get metadata for a volume by server-assigned id.
    ///
    /// `id` is copied before this method returns. The returned awaitable resolves
    /// to `VolumeInfo` or raises when the volume does not exist.
    fn get<'py>(&self, py: Python<'py>, id: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let info = handle.get(&id).await.map_err(map_err)?;
            Ok(PyVolumeInfo::from(info))
        })
    }

    /// Remove a volume by id and return an awaitable resolving to `None`.
    ///
    /// When `force` is true, backends that support force removal treat a
    /// missing volume as success.
    #[pyo3(signature = (id, force=false))]
    fn remove<'py>(&self, py: Python<'py>, id: String, force: bool) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle.remove(&id, force).await.map_err(map_err)?;
            Ok(())
        })
    }

    fn __repr__(&self) -> String {
        "VolumeHandle()".to_string()
    }
}
