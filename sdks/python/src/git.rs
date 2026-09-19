//! Python bindings for git operations.

use std::sync::Arc;

use boxlite::LiteBox;
use pyo3::prelude::*;

use crate::util::map_err;

/// Handle for git operations on a box.
///
/// Accessed as a property: `box.git.configure_user(...)`.
#[pyclass(name = "GitHandle")]
pub(crate) struct PyGitHandle {
    pub(crate) handle: Arc<LiteBox>,
}

#[pymethods]
impl PyGitHandle {
    /// Set `user.name` and `user.email` for commits in this box.
    #[pyo3(signature = (name, email, scope=None, path=None))]
    fn configure_user<'py>(
        &self,
        py: Python<'py>,
        name: String,
        email: String,
        scope: Option<String>,
        path: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle
                .git()
                .configure_user(&name, &email, scope.as_deref(), path.as_deref())
                .await
                .map_err(map_err)?;
            Ok(())
        })
    }

    /// Write a git config value. `scope` is `"global"` (default), `"local"`,
    /// or `"system"`; `"local"` requires `path`.
    #[pyo3(signature = (key, value, scope=None, path=None))]
    fn set_config<'py>(
        &self,
        py: Python<'py>,
        key: String,
        value: String,
        scope: Option<String>,
        path: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle
                .git()
                .set_config(&key, &value, scope.as_deref(), path.as_deref())
                .await
                .map_err(map_err)?;
            Ok(())
        })
    }

    /// Read a git config value. Same `scope` / `path` rules as `set_config`.
    #[pyo3(signature = (key, scope=None, path=None))]
    fn get_config<'py>(
        &self,
        py: Python<'py>,
        key: String,
        scope: Option<String>,
        path: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle
                .git()
                .get_config(&key, scope.as_deref(), path.as_deref())
                .await
                .map_err(map_err)
        })
    }

    fn __repr__(&self) -> String {
        format!("GitHandle(box_id={:?})", self.handle.id().to_string())
    }
}
