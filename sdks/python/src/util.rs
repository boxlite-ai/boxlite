use pyo3::{exceptions::PyRuntimeError, prelude::*};

pub(crate) fn map_err(err: impl std::fmt::Display) -> PyErr {
    PyRuntimeError::new_err(err.to_string())
}
