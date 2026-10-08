use boxlite::BoxliteError;
use pyo3::{exceptions::PyRuntimeError, prelude::*};

type Raise = fn(String) -> PyErr;

/// Imports each `boxlite.errors` class (lazily, on the first failure raised as
/// it) and keys it by its name, which is the name `BoxliteError::http()` gives
/// the class — so the grouping of variants into classes is decided there.
macro_rules! python_classes {
    ($($class:ident),+ $(,)?) => {
        mod classes {
            $(pyo3::import_exception!(boxlite.errors, $class);)+
        }

        const CLASSES: &[(&str, Raise)] =
            &[$((stringify!($class), classes::$class::new_err::<String>)),+];
    };
}

python_classes!(
    InvalidArgumentError,
    UnsupportedError,
    NotFoundError,
    SessionReapedError,
    AlreadyExistsError,
    InvalidStateError,
    StoppedError,
    ImageError,
    ExecutionError,
    ResourceExhaustedError,
    NetworkError,
    UpstreamUnavailableError,
    EngineError,
    StorageError,
    DatabaseError,
    MetadataError,
    ConfigError,
    InternalError,
);

/// Raise a runtime failure as its `boxlite.errors` class, message unchanged.
pub(crate) fn map_err(err: BoxliteError) -> PyErr {
    let (_, class, _) = err.http();
    let message = err.to_string();
    match CLASSES.iter().find(|(name, _)| *name == class) {
        Some((_, raise)) => raise(message),
        None => PyRuntimeError::new_err(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One of every variant. The match has no wildcard, so a new variant stops
    /// this compiling until it is listed here too.
    fn every_variant() -> Vec<BoxliteError> {
        let all = vec![
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
        for err in &all {
            match err {
                BoxliteError::UnsupportedEngine
                | BoxliteError::Engine(_)
                | BoxliteError::Config(_)
                | BoxliteError::Storage(_)
                | BoxliteError::Image(_)
                | BoxliteError::Portal(_)
                | BoxliteError::Network(_)
                | BoxliteError::Rpc(_)
                | BoxliteError::RpcTransport(_)
                | BoxliteError::Internal(_)
                | BoxliteError::Execution(_)
                | BoxliteError::Unsupported(_)
                | BoxliteError::NotFound(_)
                | BoxliteError::AlreadyExists(_)
                | BoxliteError::InvalidState(_)
                | BoxliteError::Database(_)
                | BoxliteError::MetadataError(_)
                | BoxliteError::InvalidArgument(_)
                | BoxliteError::Stopped(_)
                | BoxliteError::ResourceExhausted(_)
                | BoxliteError::SessionReaped(_) => {}
            }
        }
        all
    }

    #[test]
    fn every_variant_is_raised_as_a_class_of_its_own() {
        for err in every_variant() {
            let (_, class, _) = err.http();
            assert!(
                CLASSES.iter().any(|(name, _)| *name == class),
                "{err:?} would be raised as a bare RuntimeError: no class for {class}"
            );
        }
    }

    /// The Python classes are written out by hand in `errors.py`; this reads
    /// that file so a class missing there, or carrying another code, fails
    /// here rather than when a user first meets that failure.
    #[test]
    fn every_class_is_declared_in_python_with_its_code() {
        let source = include_str!("../boxlite/errors.py");
        for err in every_variant() {
            let (_, class, code) = err.http();
            let start = source
                .find(&format!("\nclass {class}(_NativeError):"))
                .unwrap_or_else(|| panic!("errors.py declares no {class}"));
            let body = &source[start + 1..];
            let body = &body[..body.find("\nclass ").unwrap_or(body.len())];
            assert!(
                body.contains(&format!("code = \"{code}\"")),
                "errors.py gives {class} another code than {code}"
            );
        }
    }
}
