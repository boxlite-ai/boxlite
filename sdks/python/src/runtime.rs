use std::sync::Arc;

use boxlite::BoxliteRuntime;
use pyo3::prelude::*;

use crate::box_handle::PyBox;
use crate::info::PyBoxInfo;
use crate::metrics::PyRuntimeMetrics;
use crate::options::{PyBoxOptions, PyBoxliteRestOptions, PyOptions};
use crate::util::map_err;

#[pyclass(name = "Boxlite")]
pub(crate) struct PyBoxlite {
    pub(crate) runtime: Arc<BoxliteRuntime>,
}

#[pymethods]
impl PyBoxlite {
    #[new]
    fn new(options: PyOptions) -> PyResult<Self> {
        let runtime = BoxliteRuntime::new(options.into()).map_err(map_err)?;

        Ok(Self {
            runtime: Arc::new(runtime),
        })
    }

    #[staticmethod]
    fn default() -> PyResult<Self> {
        let runtime = BoxliteRuntime::default_runtime();
        Ok(Self {
            runtime: Arc::new(runtime.clone()),
        })
    }

    /// Create a REST-backed runtime connecting to a remote BoxLite server.
    ///
    /// All box operations are delegated to the remote server via HTTP.
    ///
    /// Example::
    ///
    ///     opts = boxlite.BoxliteRestOptions(url="https://api.example.com")
    ///     runtime = boxlite.Boxlite.rest(opts)
    ///
    ///     # From environment variables
    ///     opts = boxlite.BoxliteRestOptions.from_env()
    ///     runtime = boxlite.Boxlite.rest(opts)
    #[staticmethod]
    fn rest(options: PyBoxliteRestOptions) -> PyResult<Self> {
        let runtime = BoxliteRuntime::rest(options.into()).map_err(map_err)?;
        Ok(Self {
            runtime: Arc::new(runtime),
        })
    }

    #[staticmethod]
    fn init_default(options: PyOptions) -> PyResult<()> {
        BoxliteRuntime::init_default_runtime(options.into()).map_err(map_err)
    }

    #[pyo3(signature = (options, name=None))]
    fn create<'py>(
        &self,
        py: Python<'py>,
        options: PyBoxOptions,
        name: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let runtime = Arc::clone(&self.runtime);
        let opts = options.into();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let handle = runtime.create(opts, name).await.map_err(map_err)?;
            Ok(PyBox {
                handle: Arc::new(handle),
            })
        })
    }

    #[pyo3(signature = (_state=None))]
    fn list_info<'py>(
        &self,
        py: Python<'py>,
        _state: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let runtime = Arc::clone(&self.runtime);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let infos = runtime.list_info().await.map_err(map_err)?;
            Ok(infos.into_iter().map(PyBoxInfo::from).collect::<Vec<_>>())
        })
    }

    /// Get information about a specific box by ID or name.
    fn get_info<'py>(&self, py: Python<'py>, id_or_name: String) -> PyResult<Bound<'py, PyAny>> {
        let runtime = Arc::clone(&self.runtime);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            Ok(runtime
                .get_info(&id_or_name)
                .await
                .map_err(map_err)?
                .map(PyBoxInfo::from))
        })
    }

    /// Get a box handle by ID or name (for reattach or restart).
    ///
    /// Args:
    ///     id_or_name: Either a box ID (ULID) or user-defined name
    ///
    /// Returns:
    ///     Box handle if found, None otherwise
    fn get<'py>(&self, py: Python<'py>, id_or_name: String) -> PyResult<Bound<'py, PyAny>> {
        let runtime = Arc::clone(&self.runtime);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            tracing::trace!("Python get() called with id_or_name={}", id_or_name);

            let result = runtime.get(&id_or_name).await.map_err(map_err)?;

            tracing::trace!("Rust get() returned: is_some={}", result.is_some());

            let py_box = result.map(|handle| {
                tracing::trace!("Wrapping LiteBox in PyBox for id_or_name={}", id_or_name);
                PyBox {
                    handle: Arc::new(handle),
                }
            });

            tracing::trace!("Returning PyBox to Python: is_some={}", py_box.is_some());
            Ok(py_box)
        })
    }

    /// Get an existing box by name, or create a new one if it doesn't exist.
    ///
    /// Returns:
    ///     Tuple of (Box, bool) where bool is True if newly created, False if existing
    #[pyo3(signature = (options, name=None))]
    fn get_or_create<'py>(
        &self,
        py: Python<'py>,
        options: PyBoxOptions,
        name: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let runtime = Arc::clone(&self.runtime);
        let opts = options.into();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let (handle, created) = runtime.get_or_create(opts, name).await.map_err(map_err)?;
            Ok((
                PyBox {
                    handle: Arc::new(handle),
                },
                created,
            ))
        })
    }

    fn metrics<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let runtime = Arc::clone(&self.runtime);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let metrics = runtime.metrics().await.map_err(map_err)?;
            Ok(PyRuntimeMetrics::from(metrics))
        })
    }

    /// Remove a box by ID or name.
    ///
    /// Args:
    ///     id_or_name: Either a box ID (ULID) or user-defined name
    ///     force: If True, stop the box first if running (default: False)
    #[pyo3(signature = (id_or_name, force=false))]
    fn remove<'py>(
        &self,
        py: Python<'py>,
        id_or_name: String,
        force: bool,
    ) -> PyResult<Bound<'py, PyAny>> {
        let runtime = Arc::clone(&self.runtime);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            runtime.remove(&id_or_name, force).await.map_err(map_err)?;
            Ok(())
        })
    }

    fn close(&self) -> PyResult<()> {
        Ok(())
    }

    /// Gracefully shutdown all boxes in this runtime.
    ///
    /// This method stops all running boxes, waiting up to `timeout` seconds
    /// for each box to stop gracefully before force-killing it.
    ///
    /// After calling this method, the runtime is permanently shut down and
    /// will return errors for any new operations (like `create()`).
    ///
    /// Args:
    ///     timeout: Seconds to wait before force-killing each box:
    ///         - None (default) - Use default timeout (10 seconds)
    ///         - Positive integer - Wait that many seconds
    ///         - -1 - Wait indefinitely (no timeout)
    #[pyo3(signature = (timeout=None))]
    fn shutdown<'py>(&self, py: Python<'py>, timeout: Option<i32>) -> PyResult<Bound<'py, PyAny>> {
        let runtime = Arc::clone(&self.runtime);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            runtime.shutdown(timeout).await.map_err(map_err)?;
            Ok(())
        })
    }

    fn __enter__(slf: PyRef<'_, Self>) -> PyResult<PyRef<'_, Self>> {
        Ok(slf)
    }

    fn __exit__(
        &self,
        _exc_type: Py<PyAny>,
        _exc_val: Py<PyAny>,
        _exc_tb: Py<PyAny>,
    ) -> PyResult<()> {
        self.close()
    }

    fn __repr__(&self) -> String {
        "Boxlite(open=true)".to_string()
    }
}
