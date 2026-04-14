use std::sync::Arc;

use boxlite::ImageHandle;
use boxlite::runtime::types::ImageInfo;
use pyo3::prelude::*;

use crate::util::map_err;

#[pyclass(name = "ImageInfo")]
#[derive(Clone)]
pub(crate) struct PyImageInfo {
    #[pyo3(get)]
    pub(crate) reference: String,
    #[pyo3(get)]
    pub(crate) repository: String,
    #[pyo3(get)]
    pub(crate) tag: String,
    #[pyo3(get)]
    pub(crate) id: String,
    #[pyo3(get)]
    pub(crate) cached_at: String,
    #[pyo3(get)]
    pub(crate) size_bytes: Option<u64>,
}

#[pymethods]
impl PyImageInfo {
    fn __repr__(&self) -> String {
        format!(
            "ImageInfo(reference={:?}, id={:?}, cached_at={:?})",
            self.reference, self.id, self.cached_at
        )
    }
}

impl From<ImageInfo> for PyImageInfo {
    fn from(info: ImageInfo) -> Self {
        Self {
            reference: info.reference,
            repository: info.repository,
            tag: info.tag,
            id: info.id,
            cached_at: info.cached_at.to_rfc3339(),
            size_bytes: info.size.map(|size| size.as_bytes()),
        }
    }
}

#[pyclass(name = "ImagePullResult")]
#[derive(Clone)]
pub(crate) struct PyImagePullResult {
    #[pyo3(get)]
    pub(crate) reference: String,
    #[pyo3(get)]
    pub(crate) config_digest: String,
    #[pyo3(get)]
    pub(crate) layer_count: usize,
}

#[pymethods]
impl PyImagePullResult {
    fn __repr__(&self) -> String {
        format!(
            "ImagePullResult(reference={:?}, config_digest={:?}, layer_count={})",
            self.reference, self.config_digest, self.layer_count
        )
    }
}

#[pyclass(name = "ImageHandle")]
pub(crate) struct PyImageHandle {
    pub(crate) handle: Arc<ImageHandle>,
}

#[pymethods]
impl PyImageHandle {
    fn pull<'py>(&self, py: Python<'py>, reference: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let image = handle.pull(&reference).await.map_err(map_err)?;
            Ok(PyImagePullResult {
                reference: image.reference().to_string(),
                config_digest: image.config_digest().to_string(),
                layer_count: image.layer_count(),
            })
        })
    }

    fn list<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let infos = handle.list().await.map_err(map_err)?;
            Ok(infos.into_iter().map(PyImageInfo::from).collect::<Vec<_>>())
        })
    }

    fn __repr__(&self) -> String {
        "ImageHandle()".to_string()
    }
}
