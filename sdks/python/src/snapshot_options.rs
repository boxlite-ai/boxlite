//! Python bindings for snapshot, export, and clone options.

use boxlite::{CloneOptions, ExportOptions, SnapshotOptions, SnapshotType};
use pyo3::prelude::*;

/// Select filesystem capture or the reserved memory contract.
#[pyclass(name = "SnapshotOptions")]
#[derive(Clone)]
pub(crate) struct PySnapshotOptions {
    pub snapshot_type: SnapshotType,
}

#[pymethods]
impl PySnapshotOptions {
    #[new]
    #[pyo3(signature = (snapshot_type="filesystem"))]
    fn new(snapshot_type: &str) -> PyResult<Self> {
        let snapshot_type = match snapshot_type {
            "filesystem" => SnapshotType::Filesystem,
            "memory" => SnapshotType::Memory,
            _ => {
                return Err(pyo3::exceptions::PyValueError::new_err(
                    "snapshot_type must be filesystem or memory",
                ));
            }
        };
        Ok(Self { snapshot_type })
    }

    #[getter]
    fn snapshot_type(&self) -> &'static str {
        self.snapshot_type.as_str()
    }
}

impl From<PySnapshotOptions> for SnapshotOptions {
    fn from(py: PySnapshotOptions) -> Self {
        SnapshotOptions {
            snapshot_type: py.snapshot_type,
        }
    }
}

/// Options for exporting a box (forward-compatible placeholder).
#[pyclass(name = "ExportOptions")]
#[derive(Clone)]
pub(crate) struct PyExportOptions {}

#[pymethods]
impl PyExportOptions {
    #[new]
    fn new() -> Self {
        Self {}
    }
}

impl From<PyExportOptions> for ExportOptions {
    fn from(_py: PyExportOptions) -> Self {
        ExportOptions {}
    }
}

/// Options for cloning a box (forward-compatible placeholder).
#[pyclass(name = "CloneOptions")]
#[derive(Clone)]
pub(crate) struct PyCloneOptions {}

#[pymethods]
impl PyCloneOptions {
    #[new]
    fn new() -> Self {
        Self {}
    }
}

impl From<PyCloneOptions> for CloneOptions {
    fn from(_py: PyCloneOptions) -> Self {
        CloneOptions {}
    }
}
