use std::sync::Arc;

use crate::exec::PyExecution;
use crate::info::PyBoxInfo;
use crate::metrics::PyBoxMetrics;
use crate::snapshot_options::{PyCloneOptions, PyExportOptions};
use crate::snapshots::PySnapshotHandle;
use crate::util::map_err;
use boxlite::{BoxCommand, CloneOptions, ExportOptions, LiteBox};
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

    /// Get the snapshot handle for snapshot operations.
    ///
    /// Usage: `box.snapshot.create("name")`, `box.snapshot.list()`, etc.
    #[getter]
    fn snapshot(&self) -> PySnapshotHandle {
        PySnapshotHandle {
            handle: Arc::clone(&self.handle),
        }
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
                cmd = cmd.tty(true);
            }

            let execution = handle.exec(cmd).await.map_err(map_err)?;

            Ok(PyExecution {
                execution: Arc::new(execution),
            })
        })
    }

    /// Start the box (initialize VM).
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

    /// Export this box as a portable archive.
    #[pyo3(signature = (dest, options=None))]
    fn export<'a>(
        &self,
        py: Python<'a>,
        dest: String,
        options: Option<PyExportOptions>,
    ) -> PyResult<Bound<'a, PyAny>> {
        let handle = Arc::clone(&self.handle);
        let opts: ExportOptions = options.map(Into::into).unwrap_or_default();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let path = handle
                .export(std::path::Path::new(&dest), opts)
                .await
                .map_err(map_err)?;
            Ok(path.to_string_lossy().to_string())
        })
    }

    /// Clone this box, creating a new box with copied disks.
    #[pyo3(signature = (name, options=None))]
    fn clone<'a>(
        &self,
        py: Python<'a>,
        name: String,
        options: Option<PyCloneOptions>,
    ) -> PyResult<Bound<'a, PyAny>> {
        let handle = Arc::clone(&self.handle);
        let opts: CloneOptions = options.map(Into::into).unwrap_or_default();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let cloned = LiteBox::clone(&handle, &name, opts)
                .await
                .map_err(map_err)?;
            Ok(PyBox {
                handle: Arc::new(cloned),
            })
        })
    }

    /// Copy from host into the box container rootfs.
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
