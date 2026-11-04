//! Memory checkpoint metadata and catalogs.

use std::collections::HashMap;
use std::sync::Arc;

use boxlite::{CheckpointDependencies, CheckpointInfo, LiteBox};
use pyo3::prelude::*;

use crate::util::map_err;

#[pyclass(name = "CheckpointInfo", get_all)]
pub(crate) struct PyCheckpointInfo {
    pub id: String,
    pub box_id: String,
    pub name: String,
    pub status: String,
    pub error: Option<String>,
    pub created_at: i64,
    pub cpus: u16,
    pub memory_bytes: u64,
    pub container_disk_bytes: u64,
    pub size_bytes: u64,
}

impl From<CheckpointInfo> for PyCheckpointInfo {
    fn from(info: CheckpointInfo) -> Self {
        Self {
            id: info.id,
            box_id: info.box_id,
            name: info.name,
            status: info.status,
            error: info.error,
            created_at: info.created_at,
            cpus: info.cpus,
            memory_bytes: info.memory_bytes,
            container_disk_bytes: info.container_disk_bytes,
            size_bytes: info.size_bytes,
        }
    }
}

/// Caller-local inspection. Nested dependency records retain their native schema.
#[pyclass(name = "CheckpointDependencies", get_all)]
pub(crate) struct PyCheckpointDependencies {
    pub version: u32,
    pub cpus: u16,
    pub memory_bytes: u64,
    pub boot_memory_mib: u32,
    pub max_memory_mib: u32,
    pub container_disk_bytes: u64,
    pub boot_disk_bytes: u64,
    pub boot_disk_sha256: String,
    pub qcow2_bytes: u64,
    pub qcow2_sha256: String,
    pub shares: Py<PyAny>,
    pub local_roots: HashMap<String, String>,
    pub boot_disk_path: Option<String>,
    pub disk_dependencies: Py<PyAny>,
}

impl PyCheckpointDependencies {
    pub(crate) fn from_core(py: Python<'_>, info: CheckpointDependencies) -> PyResult<Self> {
        let loads = py.import("json")?.getattr("loads")?;
        let shares = serde_json::to_string(&info.shares)
            .map_err(|error| pyo3::exceptions::PyValueError::new_err(error.to_string()))?;
        let disk_dependencies = serde_json::to_string(&info.disk_dependencies)
            .map_err(|error| pyo3::exceptions::PyValueError::new_err(error.to_string()))?;
        Ok(Self {
            version: info.version,
            cpus: info.cpus,
            memory_bytes: info.memory_bytes,
            boot_memory_mib: info.boot_memory_mib,
            max_memory_mib: info.max_memory_mib,
            container_disk_bytes: info.container_disk_bytes,
            boot_disk_bytes: info.boot_disk_bytes,
            boot_disk_sha256: info.boot_disk_sha256,
            qcow2_bytes: info.qcow2_bytes,
            qcow2_sha256: info.qcow2_sha256,
            shares: loads.call1((shares,))?.unbind(),
            local_roots: info
                .local_roots
                .into_iter()
                .map(|(tag, path)| (tag, path.to_string_lossy().into_owned()))
                .collect(),
            boot_disk_path: info
                .boot_disk_path
                .map(|path| path.to_string_lossy().into_owned()),
            disk_dependencies: loads.call1((disk_dependencies,))?.unbind(),
        })
    }
}

#[pyclass(name = "CheckpointHandle")]
pub(crate) struct PyCheckpointHandle {
    pub(crate) handle: Arc<LiteBox>,
}

#[pymethods]
impl PyCheckpointHandle {
    #[pyo3(signature = (*, name=None))]
    fn create<'py>(&self, py: Python<'py>, name: Option<String>) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            Ok(PyCheckpointInfo::from(
                handle.checkpoints().create(name).await.map_err(map_err)?,
            ))
        })
    }

    fn list<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            Ok(handle
                .checkpoints()
                .list()
                .await
                .map_err(map_err)?
                .into_iter()
                .map(PyCheckpointInfo::from)
                .collect::<Vec<_>>())
        })
    }

    fn get<'py>(&self, py: Python<'py>, id_or_name: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            Ok(handle
                .checkpoints()
                .get(&id_or_name)
                .await
                .map_err(map_err)?
                .map(PyCheckpointInfo::from))
        })
    }

    #[pyo3(signature = (id_or_name, *, force=false))]
    fn remove<'py>(
        &self,
        py: Python<'py>,
        id_or_name: String,
        force: bool,
    ) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle
                .checkpoints()
                .remove(&id_or_name, force)
                .await
                .map_err(map_err)
        })
    }
}

#[pyclass(name = "RuntimeCheckpointHandle")]
pub(crate) struct PyRuntimeCheckpointHandle {
    pub(crate) handle: boxlite::RuntimeCheckpointHandle,
}

#[pymethods]
impl PyRuntimeCheckpointHandle {
    fn list<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = self.handle.clone();
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

    fn get<'py>(&self, py: Python<'py>, id_or_name: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = self.handle.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            Ok(PyCheckpointInfo::from(
                handle.get(&id_or_name).await.map_err(map_err)?,
            ))
        })
    }

    #[pyo3(signature = (id_or_name, *, force=false))]
    fn remove<'py>(
        &self,
        py: Python<'py>,
        id_or_name: String,
        force: bool,
    ) -> PyResult<Bound<'py, PyAny>> {
        let handle = self.handle.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle.remove(&id_or_name, force).await.map_err(map_err)
        })
    }
}
