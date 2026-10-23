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
