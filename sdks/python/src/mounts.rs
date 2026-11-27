use boxlite::{MountHandle, MountInfo, MountRequest};
use pyo3::prelude::*;

use crate::util::map_err;

#[pyclass(name = "MountRequest", get_all, set_all)]
pub(crate) struct PyMountRequest {
    source: String,
    target: String,
    read_only: bool,
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
}

#[pyclass(name = "MountInfo", frozen, get_all)]
pub(crate) struct PyMountInfo {
    source: String,
    target: String,
    read_only: bool,
    state: String,
}

impl From<MountInfo> for PyMountInfo {
    fn from(info: MountInfo) -> Self {
        Self {
            source: info.source.display().to_string(),
            target: info.target.display().to_string(),
            read_only: info.read_only,
            state: info.state.to_string(),
        }
    }
}

/// Runtime directory mounts of one box, reached as `box.mount`.
///
/// A mount's `state` is `configured` while it is saved for the box's next
/// start, `preparing` until the guest confirms it, `mounted` once it is
/// visible in the container and `detaching` while its removal is incomplete.
/// No operation starts the box.
#[pyclass(name = "MountHandle")]
pub(crate) struct PyMountHandle(pub(crate) MountHandle);

#[pymethods]
impl PyMountHandle {
    /// Deliver a host directory into the container.
    ///
    /// A running box answers once the guest confirmed the mount. A stopped
    /// box saves it for its next start and answers `configured`.
    fn add<'py>(&self, py: Python<'py>, request: &PyMountRequest) -> PyResult<Bound<'py, PyAny>> {
        let mount = self.0.clone();
        let request = MountRequest {
            source: (&request.source).into(),
            target: (&request.target).into(),
            read_only: request.read_only,
        };
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            mount
                .add(request)
                .await
                .map(PyMountInfo::from)
                .map_err(map_err)
        })
    }

    /// Remove the mount at `target`, saved or live. Raises `NotFoundError`
    /// when no mount is there.
    fn remove<'py>(&self, py: Python<'py>, target: String) -> PyResult<Bound<'py, PyAny>> {
        let mount = self.0.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            mount.remove(target).await.map_err(map_err)
        })
    }

    /// Every mount of the box, saved or live.
    fn list<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let mount = self.0.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            Ok(mount
                .list()
                .await
                .map_err(map_err)?
                .into_iter()
                .map(PyMountInfo::from)
                .collect::<Vec<_>>())
        })
    }

    /// The mount at `target`, or `None` when no mount is there.
    fn get<'py>(&self, py: Python<'py>, target: String) -> PyResult<Bound<'py, PyAny>> {
        let mount = self.0.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            Ok(mount
                .get(target)
                .await
                .map_err(map_err)?
                .map(PyMountInfo::from))
        })
    }
}
