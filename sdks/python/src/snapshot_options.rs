//! Python bindings for snapshot, export, and clone options.

use boxlite::{CloneOptions, ExportOptions, SnapshotOptions};
use pyo3::prelude::*;

/// Options for creating a snapshot.
#[pyclass(name = "SnapshotOptions")]
#[derive(Clone)]
pub(crate) struct PySnapshotOptions {
    #[pyo3(get, set)]
    pub quiesce: bool,
    #[pyo3(get, set)]
    pub quiesce_timeout_secs: u64,
    #[pyo3(get, set)]
    pub stop_on_quiesce_fail: bool,
}

#[pymethods]
impl PySnapshotOptions {
    #[new]
    #[pyo3(signature = (quiesce=true, quiesce_timeout_secs=30, stop_on_quiesce_fail=true))]
    fn new(quiesce: bool, quiesce_timeout_secs: u64, stop_on_quiesce_fail: bool) -> Self {
        Self {
            quiesce,
            quiesce_timeout_secs,
            stop_on_quiesce_fail,
        }
    }
}

impl From<PySnapshotOptions> for SnapshotOptions {
    fn from(py: PySnapshotOptions) -> Self {
        SnapshotOptions {
            quiesce: py.quiesce,
            quiesce_timeout_secs: py.quiesce_timeout_secs,
            stop_on_quiesce_fail: py.stop_on_quiesce_fail,
        }
    }
}

/// Options for exporting a box.
#[pyclass(name = "ExportOptions")]
#[derive(Clone)]
pub(crate) struct PyExportOptions {
    #[pyo3(get, set)]
    pub compress: bool,
    #[pyo3(get, set)]
    pub compression_level: i32,
    #[pyo3(get, set)]
    pub include_metadata: bool,
}

#[pymethods]
impl PyExportOptions {
    #[new]
    #[pyo3(signature = (compress=true, compression_level=3, include_metadata=true))]
    fn new(compress: bool, compression_level: i32, include_metadata: bool) -> Self {
        Self {
            compress,
            compression_level,
            include_metadata,
        }
    }
}

impl From<PyExportOptions> for ExportOptions {
    fn from(py: PyExportOptions) -> Self {
        ExportOptions {
            compress: py.compress,
            compression_level: py.compression_level,
            include_metadata: py.include_metadata,
        }
    }
}

/// Options for cloning a box.
#[pyclass(name = "CloneOptions")]
#[derive(Clone)]
pub(crate) struct PyCloneOptions {
    #[pyo3(get, set)]
    pub cow: bool,
    #[pyo3(get, set)]
    pub start_after_clone: bool,
    #[pyo3(get, set)]
    pub from_snapshot: Option<String>,
}

#[pymethods]
impl PyCloneOptions {
    #[new]
    #[pyo3(signature = (cow=true, start_after_clone=false, from_snapshot=None))]
    fn new(cow: bool, start_after_clone: bool, from_snapshot: Option<String>) -> Self {
        Self {
            cow,
            start_after_clone,
            from_snapshot,
        }
    }
}

impl From<PyCloneOptions> for CloneOptions {
    fn from(py: PyCloneOptions) -> Self {
        CloneOptions {
            cow: py.cow,
            start_after_clone: py.start_after_clone,
            from_snapshot: py.from_snapshot,
        }
    }
}
