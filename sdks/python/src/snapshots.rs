//! Python bindings for snapshot operations.

use std::sync::Arc;

use boxlite::{LiteBox, SnapshotInfo, SnapshotOptions};
use pyo3::prelude::*;

use crate::snapshot_options::PySnapshotOptions;
use crate::util::map_err;

/// Snapshot metadata.
#[pyclass(name = "SnapshotInfo")]
pub(crate) struct PySnapshotInfo {
    #[pyo3(get)]
    pub id: String,
    #[pyo3(get)]
    pub box_id: String,
    #[pyo3(get)]
    pub name: String,
    #[pyo3(get)]
    pub created_at: i64,
    #[pyo3(get)]
    pub snapshot_dir: String,
    #[pyo3(get)]
    pub guest_disk_bytes: u64,
    #[pyo3(get)]
    pub container_disk_bytes: u64,
    #[pyo3(get)]
    pub size_bytes: u64,
}

#[pymethods]
impl PySnapshotInfo {
    fn __repr__(&self) -> String {
        format!(
            "SnapshotInfo(name='{}', box_id='{}', created_at={})",
            self.name, self.box_id, self.created_at
        )
    }
}

impl From<SnapshotInfo> for PySnapshotInfo {
    fn from(r: SnapshotInfo) -> Self {
        Self {
            id: r.id,
            box_id: r.box_id,
            name: r.name,
            created_at: r.created_at,
            snapshot_dir: r.snapshot_dir,
            guest_disk_bytes: r.guest_disk_bytes,
            container_disk_bytes: r.container_disk_bytes,
            size_bytes: r.size_bytes,
        }
    }
}

/// Handle for snapshot operations on a Box.
///
/// Accessed as a property: `box.snapshot.create(...)`.
#[pyclass(name = "SnapshotHandle")]
pub(crate) struct PySnapshotHandle {
    pub(crate) handle: Arc<LiteBox>,
}

#[pymethods]
impl PySnapshotHandle {
    /// Create a snapshot of the box's current disk state.
    #[pyo3(signature = (name, options=None))]
    fn create<'py>(
        &self,
        py: Python<'py>,
        name: String,
        options: Option<PySnapshotOptions>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        let opts: SnapshotOptions = options.map(Into::into).unwrap_or_default();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let info = handle
                .snapshot()
                .create(&name, opts)
                .await
                .map_err(map_err)?;
            Ok(PySnapshotInfo::from(info))
        })
    }

    /// List all snapshots for this box.
    fn list<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let infos = handle.snapshot().list().await.map_err(map_err)?;
            Ok(infos
                .into_iter()
                .map(PySnapshotInfo::from)
                .collect::<Vec<_>>())
        })
    }

    /// Get a snapshot by name.
    fn get<'py>(&self, py: Python<'py>, name: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let info = handle.snapshot().get(&name).await.map_err(map_err)?;
            Ok(info.map(PySnapshotInfo::from))
        })
    }

    /// Remove a snapshot by name.
    fn remove<'py>(&self, py: Python<'py>, name: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle.snapshot().remove(&name).await.map_err(map_err)?;
            Ok(())
        })
    }

    /// Restore the box's disks from a snapshot.
    fn restore<'py>(&self, py: Python<'py>, name: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle.snapshot().restore(&name).await.map_err(map_err)?;
            Ok(())
        })
    }

    fn __repr__(&self) -> String {
        format!("SnapshotHandle(box_id={:?})", self.handle.id().to_string())
    }
}
