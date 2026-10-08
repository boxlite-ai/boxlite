use std::sync::Arc;

use boxlite::ImageHandle;
use boxlite::runtime::types::{ImageDetail, ImageInfo, ImageUsage, ImageVersion};
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

/// One build of an image.
#[pyclass(name = "ImageVersion")]
#[derive(Clone)]
pub(crate) struct PyImageVersion {
    #[pyo3(get)]
    pub(crate) digest: String,
    #[pyo3(get)]
    pub(crate) size_bytes: Option<u64>,
    #[pyo3(get)]
    pub(crate) source_ref: String,
    #[pyo3(get)]
    pub(crate) recorded_at: String,
}

#[pymethods]
impl PyImageVersion {
    fn __repr__(&self) -> String {
        format!(
            "ImageVersion(digest={:?}, source_ref={:?})",
            self.digest, self.source_ref
        )
    }
}

impl From<ImageVersion> for PyImageVersion {
    fn from(version: ImageVersion) -> Self {
        Self {
            digest: version.digest,
            size_bytes: version.size_bytes,
            source_ref: version.source_ref,
            recorded_at: version.recorded_at.to_rfc3339(),
        }
    }
}

/// An image name and every build held under it.
#[pyclass(name = "ImageDetail")]
#[derive(Clone)]
pub(crate) struct PyImageDetail {
    #[pyo3(get)]
    pub(crate) name: String,
    #[pyo3(get)]
    pub(crate) tags: Vec<String>,
    #[pyo3(get)]
    pub(crate) curated: bool,
    #[pyo3(get)]
    pub(crate) versions: Vec<PyImageVersion>,
}

#[pymethods]
impl PyImageDetail {
    fn __repr__(&self) -> String {
        format!(
            "ImageDetail(name={:?}, tags={:?}, versions={})",
            self.name,
            self.tags,
            self.versions.len()
        )
    }
}

impl From<ImageDetail> for PyImageDetail {
    fn from(detail: ImageDetail) -> Self {
        Self {
            name: detail.name,
            tags: detail.tags,
            curated: detail.curated,
            versions: detail
                .versions
                .into_iter()
                .map(PyImageVersion::from)
                .collect(),
        }
    }
}

/// Images held against the allowance, on a REST runtime.
#[pyclass(name = "ImageUsage")]
#[derive(Clone)]
pub(crate) struct PyImageUsage {
    #[pyo3(get)]
    pub(crate) count: u64,
    #[pyo3(get)]
    pub(crate) limit: u64,
    #[pyo3(get)]
    pub(crate) known_bytes: u64,
}

#[pymethods]
impl PyImageUsage {
    fn __repr__(&self) -> String {
        format!(
            "ImageUsage(count={}, limit={}, known_bytes={})",
            self.count, self.limit, self.known_bytes
        )
    }
}

impl From<ImageUsage> for PyImageUsage {
    fn from(usage: ImageUsage) -> Self {
        Self {
            count: usage.count,
            limit: usage.limit,
            known_bytes: usage.known_bytes,
        }
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

    /// Every build held under an image name, such as "docker.io/library/alpine".
    fn get<'py>(&self, py: Python<'py>, name: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let detail = handle.get(&name).await.map_err(map_err)?;
            Ok(PyImageDetail::from(detail))
        })
    }

    /// Stop holding an image name, every tag of it.
    fn remove<'py>(&self, py: Python<'py>, name: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle.remove(&name).await.map_err(map_err)?;
            Ok(())
        })
    }

    /// Images held against the allowance; REST runtimes only.
    fn usage<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let usage = handle.usage().await.map_err(map_err)?;
            Ok(PyImageUsage::from(usage))
        })
    }

    fn __repr__(&self) -> String {
        "ImageHandle()".to_string()
    }
}
