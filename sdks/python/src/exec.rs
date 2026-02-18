use crate::util::map_err;
use boxlite::Execution;
use pyo3::{Bound, PyAny, PyRef, PyResult, Python, pyclass, pymethods};
use std::sync::Arc;
use tokio::sync::Mutex;

#[pyclass(name = "ExecStdout")]
pub(crate) struct PyExecStdout {
    pub(crate) stream: Arc<Mutex<boxlite::ExecStdout>>,
}

#[pymethods]
impl PyExecStdout {
    fn __aiter__(slf: PyRef<'_, Self>) -> PyRef<'_, Self> {
        slf
    }

    fn __anext__<'a>(&self, py: Python<'a>) -> PyResult<Option<Bound<'a, PyAny>>> {
        let stream = Arc::clone(&self.stream);

        let future = pyo3_async_runtimes::tokio::future_into_py(py, async move {
            use futures::StreamExt;
            let mut guard = stream.lock().await;
            match guard.next().await {
                Some(line) => Ok(line),
                None => Err(pyo3::exceptions::PyStopAsyncIteration::new_err("")),
            }
        })?;

        Ok(Some(future))
    }

    fn __repr__(&self) -> String {
        "ExecStdout(...)".to_string()
    }
}

#[pyclass(name = "ExecStdin")]
pub(crate) struct PyExecStdin {
    pub(crate) stream: Arc<Mutex<boxlite::ExecStdin>>,
}

#[pymethods]
impl PyExecStdin {
    /// Send data to stdin.
    fn send_input<'a>(&self, py: Python<'a>, data: Vec<u8>) -> PyResult<Bound<'a, PyAny>> {
        let stream = Arc::clone(&self.stream);

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let mut guard = stream.lock().await;
            guard.write_all(&data).await.map_err(map_err)?;
            Ok(())
        })
    }

    /// Close stdin stream, signaling EOF to the process.
    fn close<'a>(&self, py: Python<'a>) -> PyResult<Bound<'a, PyAny>> {
        let stream = Arc::clone(&self.stream);

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let mut guard = stream.lock().await;
            guard.close();
            Ok(())
        })
    }

    /// Check if stdin is closed.
    fn is_closed<'a>(&self, py: Python<'a>) -> PyResult<Bound<'a, PyAny>> {
        let stream = Arc::clone(&self.stream);

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let guard = stream.lock().await;
            Ok(guard.is_closed())
        })
    }

    fn __repr__(&self) -> String {
        "ExecStdin(...)".to_string()
    }
}

#[pyclass(name = "ExecStderr")]
pub(crate) struct PyExecStderr {
    pub(crate) stream: Arc<Mutex<boxlite::ExecStderr>>,
}

#[pymethods]
impl PyExecStderr {
    fn __aiter__(slf: PyRef<'_, Self>) -> PyRef<'_, Self> {
        slf
    }

    fn __anext__<'a>(&self, py: Python<'a>) -> PyResult<Option<Bound<'a, PyAny>>> {
        let stream = Arc::clone(&self.stream);

        let future = pyo3_async_runtimes::tokio::future_into_py(py, async move {
            use futures::StreamExt;
            let mut guard = stream.lock().await;
            match guard.next().await {
                Some(line) => Ok(line),
                None => Err(pyo3::exceptions::PyStopAsyncIteration::new_err("")),
            }
        })?;

        Ok(Some(future))
    }

    fn __repr__(&self) -> String {
        "ExecStderr(...)".to_string()
    }
}

#[pyclass(name = "ExecResult")]
pub(crate) struct PyExecResult {
    #[pyo3(get, set)]
    pub(crate) exit_code: i32,
    #[pyo3(get, set)]
    pub(crate) error_message: Option<String>,
}

#[pyclass(name = "Execution")]
pub(crate) struct PyExecution {
    pub(crate) execution: Arc<Execution>,
}

#[pymethods]
impl PyExecution {
    fn id(&self) -> PyResult<String> {
        Ok(self.execution.id().clone())
    }

    fn stdin(&self) -> PyResult<PyExecStdin> {
        let execution = unsafe { &mut *(Arc::as_ptr(&self.execution) as *mut Execution) };
        match execution.stdin() {
            Some(stream) => Ok(PyExecStdin {
                stream: Arc::new(Mutex::new(stream)),
            }),
            None => Err(pyo3::exceptions::PyRuntimeError::new_err(
                "stdin stream not available",
            )),
        }
    }

    fn stdout(&self) -> PyResult<PyExecStdout> {
        let execution = unsafe { &mut *(Arc::as_ptr(&self.execution) as *mut Execution) };
        match execution.stdout() {
            Some(stream) => Ok(PyExecStdout {
                stream: Arc::new(Mutex::new(stream)),
            }),
            None => Err(pyo3::exceptions::PyRuntimeError::new_err(
                "stdout stream not available",
            )),
        }
    }

    fn stderr(&self) -> PyResult<PyExecStderr> {
        let execution = unsafe { &mut *(Arc::as_ptr(&self.execution) as *mut Execution) };
        match execution.stderr() {
            Some(stream) => Ok(PyExecStderr {
                stream: Arc::new(Mutex::new(stream)),
            }),
            None => Err(pyo3::exceptions::PyRuntimeError::new_err(
                "stderr stream not available",
            )),
        }
    }

    fn wait<'a>(&self, py: Python<'a>) -> PyResult<Bound<'a, PyAny>> {
        let execution = Arc::clone(&self.execution);

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let execution_mut = unsafe { &mut *(Arc::as_ptr(&execution) as *mut Execution) };
            let exec_result = execution_mut.wait().await.map_err(map_err)?;
            Ok(PyExecResult {
                exit_code: exec_result.exit_code,
                error_message: exec_result.error_message,
            })
        })
    }

    fn kill<'a>(&self, py: Python<'a>) -> PyResult<Bound<'a, PyAny>> {
        let execution = Arc::clone(&self.execution);

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let execution_mut = unsafe { &mut *(Arc::as_ptr(&execution) as *mut Execution) };
            execution_mut.kill().await.map_err(map_err)?;
            Ok(())
        })
    }

    /// Resize PTY terminal window.
    ///
    /// Only works for executions started with TTY enabled (tty=True).
    fn resize_tty<'a>(&self, py: Python<'a>, rows: u32, cols: u32) -> PyResult<Bound<'a, PyAny>> {
        let execution = Arc::clone(&self.execution);

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            execution.resize_tty(rows, cols).await.map_err(map_err)?;
            Ok(())
        })
    }

    fn __repr__(&self) -> String {
        "Execution(...)".to_string()
    }
}
