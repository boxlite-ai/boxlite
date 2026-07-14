use boxlite::BoxliteError;
use pyo3::{create_exception, exceptions::PyRuntimeError, prelude::*};

create_exception!(boxlite_python, CommandStartError, PyRuntimeError);

pub(crate) fn map_err(err: impl std::fmt::Display) -> PyErr {
    PyRuntimeError::new_err(err.to_string())
}

pub(crate) fn map_exec_err(err: BoxliteError) -> PyErr {
    match err {
        BoxliteError::Execution(message) => CommandStartError::new_err(message),
        other => map_err(other),
    }
}
