use std::sync::Arc;

use boxlite::runtime::VolumeHandle;
use boxlite::runtime::types::VolumeInfo;
use pyo3::prelude::*;

use crate::util::map_err;

#[pyclass(name = "VolumeInfo")]
#[derive(Clone)]
pub(crate) struct PyVolumeInfo {
    #[pyo3(get)]
    pub(crate) name: String,
    #[pyo3(get)]
    pub(crate) mountpoint: String,
    #[pyo3(get)]
    pub(crate) created_at: String,
    #[pyo3(get)]
    pub(crate) size_bytes: Option<u64>,
}

#[pymethods]
impl PyVolumeInfo {
    fn __repr__(&self) -> String {
        format!(
            "VolumeInfo(name={:?}, mountpoint={:?}, created_at={:?})",
            self.name, self.mountpoint, self.created_at
        )
    }
}

impl From<VolumeInfo> for PyVolumeInfo {
    fn from(info: VolumeInfo) -> Self {
        Self {
            name: info.name,
            mountpoint: info.mountpoint.display().to_string(),
            created_at: info.created_at.to_rfc3339(),
            size_bytes: info.size_bytes,
        }
    }
}

#[pyclass(name = "VolumeHandle")]
pub(crate) struct PyVolumeHandle {
    pub(crate) handle: Arc<VolumeHandle>,
}

#[pymethods]
impl PyVolumeHandle {
    #[pyo3(signature = (name, size_gb=None))]
    fn create<'py>(
        &self,
        py: Python<'py>,
        name: String,
        size_gb: Option<u64>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let info = handle.create(&name, size_gb).await.map_err(map_err)?;
            Ok(PyVolumeInfo::from(info))
        })
    }

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

    fn get<'py>(&self, py: Python<'py>, name: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let info = handle.get(&name).await.map_err(map_err)?;
            Ok(PyVolumeInfo::from(info))
        })
    }

    #[pyo3(signature = (name, force=false))]
    fn remove<'py>(
        &self,
        py: Python<'py>,
        name: String,
        force: bool,
    ) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle.remove(&name, force).await.map_err(map_err)?;
            Ok(())
        })
    }

    fn __repr__(&self) -> String {
        "VolumeHandle()".to_string()
    }
}
