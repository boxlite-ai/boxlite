use boxlite::BoxliteError;
use pyo3::{create_exception, exceptions::PyRuntimeError, prelude::*};

create_exception!(boxlite_python, ExecStartError, PyRuntimeError);

const EXEC_START_REASON: &str = "spawn_failed";

pub(crate) fn map_err(err: impl std::fmt::Display) -> PyErr {
    PyRuntimeError::new_err(err.to_string())
}

pub(crate) fn map_exec_start_err(err: BoxliteError) -> PyErr {
    if is_exec_start_failure(&err) {
        ExecStartError::new_err(err.to_string())
    } else {
        map_err(err)
    }
}

fn is_exec_start_failure(err: &BoxliteError) -> bool {
    let BoxliteError::Internal(message) = err else {
        return false;
    };
    message
        .strip_prefix(EXEC_START_REASON)
        .is_some_and(|detail| detail.starts_with(": "))
}
