use boxlite::BoxliteError;
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use pyo3::types::PyType;

/// Raise `InvalidArgumentError` for input the binding rejects before calling the runtime.
pub(crate) fn invalid_argument(message: impl Into<String>) -> PyErr {
    map_err(BoxliteError::InvalidArgument(message.into()))
}

/// Raise `InvalidStateError` for a binding-side precondition the object no longer meets.
pub(crate) fn invalid_state(message: impl Into<String>) -> PyErr {
    map_err(BoxliteError::InvalidState(message.into()))
}

/// Raise the `boxlite.errors` exception that matches the runtime error's variant.
pub(crate) fn map_err(err: BoxliteError) -> PyErr {
    let message = err.to_string();
    let class_name = error_class_name(&err);
    Python::attach(|py| match lookup_error_class(py, class_name) {
        Ok(class) => PyErr::from_type(class, message),
        // Only reachable when `boxlite.errors` can't be imported (e.g. the binding's
        // own Rust tests run in a bare interpreter). Keep the original error rather
        // than replacing it with an import failure; `BoxliteError` derives from
        // `RuntimeError`, so callers see the same base type either way.
        Err(_) => PyRuntimeError::new_err(message),
    })
}

/// The classes live in `boxlite/errors.py` so their hierarchy and docs stay in one
/// place; the binding only picks which one to raise.
fn lookup_error_class<'py>(py: Python<'py>, class_name: &str) -> PyResult<Bound<'py, PyType>> {
    let class = py.import("boxlite.errors")?.getattr(class_name)?;
    Ok(class.cast_into::<PyType>()?)
}

/// Exhaustive on purpose: a new `BoxliteError` variant fails to compile here
/// instead of silently surfacing as the base class.
fn error_class_name(err: &BoxliteError) -> &'static str {
    match err {
        BoxliteError::UnsupportedEngine => "UnsupportedEngineError",
        BoxliteError::Engine(_) => "EngineError",
        BoxliteError::Config(_) => "ConfigError",
        BoxliteError::Storage(_) => "StorageError",
        BoxliteError::Image(_) => "ImageError",
        BoxliteError::Portal(_) => "PortalError",
        BoxliteError::Network(_) => "NetworkError",
        BoxliteError::Rpc(_) => "RpcError",
        BoxliteError::RpcTransport(_) => "RpcTransportError",
        BoxliteError::Internal(_) => "InternalError",
        BoxliteError::Execution(_) => "ExecutionError",
        BoxliteError::Unsupported(_) => "UnsupportedError",
        BoxliteError::NotFound(_) => "NotFoundError",
        BoxliteError::AlreadyExists(_) => "AlreadyExistsError",
        BoxliteError::InvalidState(_) => "InvalidStateError",
        BoxliteError::Database(_) => "DatabaseError",
        BoxliteError::MetadataError(_) => "MetadataError",
        BoxliteError::InvalidArgument(_) => "InvalidArgumentError",
        BoxliteError::Stopped(_) => "StoppedError",
        BoxliteError::ResourceExhausted(_) => "ResourceExhaustedError",
        BoxliteError::SessionReaped(_) => "SessionReapedError",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every class name the binding can raise must exist in `boxlite/errors.py`,
    /// otherwise that variant silently degrades to a bare `RuntimeError`.
    #[test]
    fn every_error_class_name_is_defined_in_errors_py() {
        let errors_py = include_str!("../boxlite/errors.py");
        let variants = [
            BoxliteError::UnsupportedEngine,
            BoxliteError::Engine(String::new()),
            BoxliteError::Config(String::new()),
            BoxliteError::Storage(String::new()),
            BoxliteError::Image(String::new()),
            BoxliteError::Portal(String::new()),
            BoxliteError::Network(String::new()),
            BoxliteError::Rpc(String::new()),
            BoxliteError::RpcTransport(String::new()),
            BoxliteError::Internal(String::new()),
            BoxliteError::Execution(String::new()),
            BoxliteError::Unsupported(String::new()),
            BoxliteError::NotFound(String::new()),
            BoxliteError::AlreadyExists(String::new()),
            BoxliteError::InvalidState(String::new()),
            BoxliteError::Database(String::new()),
            BoxliteError::MetadataError(String::new()),
            BoxliteError::InvalidArgument(String::new()),
            BoxliteError::Stopped(String::new()),
            BoxliteError::ResourceExhausted(String::new()),
            BoxliteError::SessionReaped(String::new()),
        ];
        for variant in &variants {
            let class_name = error_class_name(variant);
            assert!(
                errors_py.contains(&format!("class {class_name}(BoxliteError):")),
                "boxlite/errors.py has no `class {class_name}(BoxliteError)` for {variant:?}"
            );
        }
    }
}
