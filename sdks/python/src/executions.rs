//! Python bindings for the live execution namespace, mirroring the Rust
//! `ExecutionsHandle`.
//!
//! Listing and recovery never start the box; attaching output keeps the
//! existing `Box.attach` contract.

use std::sync::Arc;

use boxlite::{AttachOptions, LiteBox};
use pyo3::prelude::*;

use crate::exec::{PyExecution, PyExecutionInfo};
use crate::util::map_err;

/// Live execution sessions of one box, reached as `box.executions()`.
#[pyclass(name = "Executions")]
pub(crate) struct PyExecutions {
    handle: Arc<LiteBox>,
}

impl PyExecutions {
    pub(crate) fn new(handle: Arc<LiteBox>) -> Self {
        Self { handle }
    }
}

#[pymethods]
impl PyExecutions {
    /// List live guest executions without starting a stopped box.
    fn list<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let executions = handle.executions().list().await.map_err(map_err)?;
            Ok(executions
                .into_iter()
                .map(PyExecutionInfo::from)
                .collect::<Vec<_>>())
        })
    }

    /// Recover control without claiming the session's output reader.
    fn get<'py>(&self, py: Python<'py>, execution_id: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let execution = handle
                .executions()
                .get(&execution_id)
                .await
                .map_err(map_err)?;
            Ok(PyExecution {
                execution: Arc::new(execution),
            })
        })
    }

    /// Attach to a listed live session without starting the box.
    #[pyo3(signature = (execution_id, stdin=true))]
    fn attach<'py>(
        &self,
        py: Python<'py>,
        execution_id: String,
        stdin: bool,
    ) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let mut options = AttachOptions::execution(execution_id);
            if !stdin {
                options = options.read_only();
            }
            let execution = handle.attach(options).await.map_err(map_err)?;
            Ok(PyExecution {
                execution: Arc::new(execution),
            })
        })
    }
}
