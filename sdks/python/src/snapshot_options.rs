//! Python bindings for snapshot, export, and clone options.

use boxlite::{CloneOptions, ExportOptions, SnapshotOptions};
use pyo3::prelude::*;

/// Options for creating a snapshot (forward-compatible placeholder).
#[pyclass(name = "SnapshotOptions")]
#[derive(Clone)]
pub(crate) struct PySnapshotOptions {}

#[pymethods]
impl PySnapshotOptions {
    #[new]
    fn new() -> Self {
        Self {}
    }
}

impl From<PySnapshotOptions> for SnapshotOptions {
    fn from(_py: PySnapshotOptions) -> Self {
        SnapshotOptions {}
    }
}

/// Options for exporting a box archive. The default exports disks only.
#[pyclass(name = "ExportOptions")]
#[derive(Clone, Default)]
pub(crate) struct PyExportOptions {
    #[pyo3(get, set)]
    pub(crate) include_memory: bool,
}

#[pymethods]
impl PyExportOptions {
    #[new]
    #[pyo3(signature = (include_memory = false))]
    fn new(include_memory: bool) -> Self {
        Self { include_memory }
    }

    fn __repr__(&self) -> String {
        format!("ExportOptions(include_memory={})", self.include_memory)
    }
}

impl From<PyExportOptions> for ExportOptions {
    fn from(py: PyExportOptions) -> Self {
        Self {
            include_memory: py.include_memory,
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_options_from_py() {
        let default: ExportOptions = PyExportOptions::default().into();
        assert!(!default.include_memory);

        let full: ExportOptions = PyExportOptions::new(true).into();
        assert!(full.include_memory);
    }
}
