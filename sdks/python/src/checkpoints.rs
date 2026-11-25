//! REST-managed checkpoints; local runtimes raise an unsupported error.

use std::sync::Arc;

use boxlite::{
    BoxliteError, BoxliteResult, CheckpointHandle, CheckpointInfo, CheckpointKind,
    CheckpointOptions,
};
use pyo3::prelude::*;

use crate::util::map_err;

#[pyclass(name = "CheckpointOptions", from_py_object)]
#[derive(Clone, Default)]
pub(crate) struct PyCheckpointOptions {
    #[pyo3(get, set)]
    pub(crate) kind: Option<String>,
}

#[pymethods]
impl PyCheckpointOptions {
    #[new]
    #[pyo3(signature = (kind=None))]
    fn new(kind: Option<String>) -> Self {
        Self { kind }
    }

    fn __repr__(&self) -> String {
        match &self.kind {
            Some(kind) => format!("CheckpointOptions(kind={kind:?})"),
            None => "CheckpointOptions(kind=None)".into(),
        }
    }
}

fn parse_checkpoint_options(
    options: Option<PyCheckpointOptions>,
) -> BoxliteResult<CheckpointOptions> {
    let kind = match options.and_then(|options| options.kind).as_deref() {
        None => None,
        Some("disk") => Some(CheckpointKind::Disk),
        Some("full") => Some(CheckpointKind::Full),
        Some(kind) => {
            return Err(BoxliteError::InvalidArgument(format!(
                "checkpoint kind must be 'disk' or 'full', got {kind:?}"
            )));
        }
    };
    Ok(CheckpointOptions { kind })
}

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
    #[pyo3(get)]
    kind: String,
    #[pyo3(get)]
    memory_size_bytes: Option<u64>,
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
            kind: info.kind.as_str().to_string(),
            memory_size_bytes: info.memory_size_bytes,
        }
    }
}

#[pyclass(name = "CheckpointHandle")]
pub(crate) struct PyCheckpointHandle {
    pub(crate) handle: Arc<CheckpointHandle>,
}

#[pymethods]
impl PyCheckpointHandle {
    /// Capture a box into an independent managed checkpoint.
    #[pyo3(signature = (source, name=None, options=None))]
    fn create<'py>(
        &self,
        py: Python<'py>,
        source: String,
        name: Option<String>,
        options: Option<PyCheckpointOptions>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let options = parse_checkpoint_options(options).map_err(map_err)?;
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            Ok(PyCheckpointInfo::from(
                handle
                    .create_with_options(&source, name, options)
                    .await
                    .map_err(map_err)?,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_options_parse_kinds() {
        let parse = |kind: &str| {
            parse_checkpoint_options(Some(PyCheckpointOptions::new(Some(kind.into()))))
        };
        assert_eq!(parse_checkpoint_options(None).unwrap().kind, None);
        assert_eq!(parse("disk").unwrap().kind, Some(CheckpointKind::Disk));
        assert_eq!(parse("full").unwrap().kind, Some(CheckpointKind::Full));
        assert!(matches!(
            parse("unknown"),
            Err(BoxliteError::InvalidArgument(_))
        ));
    }

    #[test]
    fn checkpoint_info_preserves_kind_and_memory_size() {
        let info = serde_json::from_value::<CheckpointInfo>(serde_json::json!({
            "id": "archive", "name": "base", "source_box_id": "source",
            "created_at": "2026-11-06T00:00:00Z", "size_bytes": 4096,
            "kind": "full", "memory_size_bytes": 0
        }))
        .unwrap();
        let info = PyCheckpointInfo::from(info);
        assert_eq!(info.kind, "full");
        assert_eq!(info.memory_size_bytes, Some(0));
    }
}
