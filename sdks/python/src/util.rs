use boxlite::BoxliteError;
use pyo3::exceptions::PyRuntimeError;
use pyo3::import_exception;
use pyo3::prelude::*;

// Import Python exception classes defined in boxlite.errors
import_exception!(boxlite.errors, EngineError);
import_exception!(boxlite.errors, ConfigError);
import_exception!(boxlite.errors, StorageError);
import_exception!(boxlite.errors, ImageError);
import_exception!(boxlite.errors, PortalError);
import_exception!(boxlite.errors, NetworkError);
import_exception!(boxlite.errors, RpcError);
import_exception!(boxlite.errors, InternalError);
import_exception!(boxlite.errors, ExecutionError);
import_exception!(boxlite.errors, NotFoundError);
import_exception!(boxlite.errors, AlreadyExistsError);
import_exception!(boxlite.errors, InvalidStateError);
import_exception!(boxlite.errors, DatabaseError);
import_exception!(boxlite.errors, InvalidArgumentError);
import_exception!(boxlite.errors, StoppedError);
import_exception!(boxlite.errors, ResourceExhaustedError);

/// Map a BoxliteError to its corresponding typed Python exception.
pub(crate) fn map_boxlite_err(err: BoxliteError) -> PyErr {
    let msg = err.to_string();
    match err {
        BoxliteError::UnsupportedEngine => EngineError::new_err(msg),
        BoxliteError::Engine(_) => EngineError::new_err(msg),
        BoxliteError::Config(_) => ConfigError::new_err(msg),
        BoxliteError::Storage(_) => StorageError::new_err(msg),
        BoxliteError::Image(_) => ImageError::new_err(msg),
        BoxliteError::Portal(_) => PortalError::new_err(msg),
        BoxliteError::Network(_) => NetworkError::new_err(msg),
        // Rpc + RpcTransport both map to RpcError (low-level gRPC distinction not useful to Python users)
        BoxliteError::Rpc(_) | BoxliteError::RpcTransport(_) => RpcError::new_err(msg),
        BoxliteError::Internal(_) => InternalError::new_err(msg),
        BoxliteError::Execution(_) => ExecutionError::new_err(msg),
        // Unsupported -> EngineError: intentional simplification to avoid exception class explosion.
        // "Unsupported" errors are rare platform-level constraints (e.g., "feature X not on this OS").
        BoxliteError::Unsupported(_) => EngineError::new_err(msg),
        BoxliteError::NotFound(_) => NotFoundError::new_err(msg),
        BoxliteError::AlreadyExists(_) => AlreadyExistsError::new_err(msg),
        BoxliteError::InvalidState(_) => InvalidStateError::new_err(msg),
        BoxliteError::Database(_) => DatabaseError::new_err(msg),
        // MetadataError -> InternalError: metadata corruption is an internal concern, not actionable by SDK users.
        BoxliteError::MetadataError(_) => InternalError::new_err(msg),
        BoxliteError::InvalidArgument(_) => InvalidArgumentError::new_err(msg),
        BoxliteError::Stopped(_) => StoppedError::new_err(msg),
        BoxliteError::ResourceExhausted(_) => ResourceExhaustedError::new_err(msg),
    }
}

/// Fallback for non-BoxliteError types (preserves backwards compatibility).
pub(crate) fn map_err(err: impl std::fmt::Display) -> PyErr {
    PyRuntimeError::new_err(err.to_string())
}
