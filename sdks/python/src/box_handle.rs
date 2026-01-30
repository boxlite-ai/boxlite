use std::sync::Arc;

use crate::exec::PyExecution;
use crate::info::PyBoxInfo;
use crate::metrics::PyBoxMetrics;
use crate::util::map_err;
use boxlite::{BoxCommand, LiteBox};
use pyo3::prelude::*;

#[pyclass(name = "Box")]
pub(crate) struct PyBox {
    pub(crate) handle: Arc<LiteBox>,
}

#[pymethods]
impl PyBox {
    #[getter]
    fn id(&self) -> PyResult<String> {
        Ok(self.handle.id().to_string())
    }

    #[getter]
    fn name(&self) -> Option<String> {
        self.handle.name().map(|s| s.to_string())
    }

    fn info(&self) -> PyBoxInfo {
        PyBoxInfo::from(self.handle.info())
    }

    #[pyo3(signature = (command, args=None, env=None, tty=false))]
    fn exec<'a>(
        &self,
        py: Python<'a>,
        command: String,
        args: Option<Vec<String>>,
        env: Option<Vec<(String, String)>>,
        tty: bool,
    ) -> PyResult<Bound<'a, PyAny>> {
        let handle = Arc::clone(&self.handle);

        let args = args.unwrap_or_default();

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let mut cmd = BoxCommand::new(command);
            cmd = cmd.args(args);
            if let Some(env_vars) = env {
                for (k, v) in env_vars {
                    cmd = cmd.env(k, v);
                }
            }
            if tty {
                // Auto-detect terminal size like Docker (done inside .tty())
                cmd = cmd.tty(true);
            }

            let execution = handle.exec(cmd).await.map_err(map_err)?;

            Ok(PyExecution {
                execution: Arc::new(execution),
            })
        })
    }

    /// Start the box (initialize VM).
    ///
    /// For Configured boxes: initializes VM for the first time.
    /// For Stopped boxes: restarts the VM.
    ///
    /// This is idempotent - calling start() on a Running box is a no-op.
    /// Also called implicitly by exec() if the box is not running.
    fn start<'a>(&self, py: Python<'a>) -> PyResult<Bound<'a, PyAny>> {
        let handle = Arc::clone(&self.handle);

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle.start().await.map_err(map_err)?;
            Ok(())
        })
    }

    /// Stop the box (preserves state for restart).
    fn stop<'a>(&self, py: Python<'a>) -> PyResult<Bound<'a, PyAny>> {
        let handle = Arc::clone(&self.handle);

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle.stop().await.map_err(map_err)?;
            Ok(())
        })
    }

    fn metrics<'a>(&self, py: Python<'a>) -> PyResult<Bound<'a, PyAny>> {
        let handle = Arc::clone(&self.handle);

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let metrics = handle.metrics().await.map_err(map_err)?;
            Ok(PyBoxMetrics::from(metrics))
        })
    }

    /// Copy from host into the box container rootfs.
    ///
    /// **Note:** Destinations under tmpfs mounts (e.g. `/tmp`, `/dev/shm`) will
    /// silently fail — files land behind the mount and are invisible to the
    /// container. Same limitation as `docker cp`. Workaround: pipe tar via
    /// stdin through the box's command execution API.
    /// See: <https://github.com/moby/moby/issues/22020>
    #[pyo3(signature = (host_path, container_dest, copy_options=None))]
    fn copy_in<'a>(
        &self,
        py: Python<'a>,
        host_path: String,
        container_dest: String,
        copy_options: Option<crate::options::PyCopyOptions>,
    ) -> PyResult<Bound<'a, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let opts: boxlite::CopyOptions =
                copy_options.map_or_else(boxlite::CopyOptions::default, Into::into);

            handle
                .copy_into(std::path::Path::new(&host_path), &container_dest, opts)
                .await
                .map_err(map_err)?;
            Ok(())
        })
    }

    /// Copy from box container rootfs to host.
    #[pyo3(signature = (container_src, host_dest, copy_options=None))]
    fn copy_out<'a>(
        &self,
        py: Python<'a>,
        container_src: String,
        host_dest: String,
        copy_options: Option<crate::options::PyCopyOptions>,
    ) -> PyResult<Bound<'a, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let opts: boxlite::CopyOptions =
                copy_options.map_or_else(boxlite::CopyOptions::default, Into::into);

            handle
                .copy_out(&container_src, std::path::Path::new(&host_dest), opts)
                .await
                .map_err(map_err)?;
            Ok(())
        })
    }

    /// Enter async context manager - auto-starts the box (Testcontainers pattern).
    fn __aenter__<'a>(slf: PyRefMut<'_, Self>, py: Python<'a>) -> PyResult<Bound<'a, PyAny>> {
        let handle = Arc::clone(&slf.handle);

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            // Auto-start on context entry
            handle.start().await.map_err(map_err)?;
            Ok(PyBox { handle })
        })
    }

    #[allow(unsafe_op_in_unsafe_fn)]
    fn __aexit__<'a>(
        slf: PyRefMut<'a, Self>,
        py: Python<'a>,
        _exc_type: Py<PyAny>,
        _exc_val: Py<PyAny>,
        _exc_tb: Py<PyAny>,
    ) -> PyResult<Bound<'a, PyAny>> {
        let handle = Arc::clone(&slf.handle);

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle.stop().await.map_err(map_err)?;
            Ok(())
        })
    }

    fn __repr__(&self) -> String {
        format!("Box(id={:?})", self.handle.id().to_string())
    }
}
