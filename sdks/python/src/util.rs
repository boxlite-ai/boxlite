use boxlite::BoxliteError;
use pyo3::{create_exception, exceptions::PyRuntimeError, prelude::*};

create_exception!(boxlite_python, ExecStartError, PyRuntimeError);

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
    let detail = message.to_ascii_lowercase();
    detail.contains("spawn_failed") && detail.contains("failed to spawn")
}
