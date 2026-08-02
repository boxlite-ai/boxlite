use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use boxlite::LiteBox;
use boxlite::litebox::BoxTunnel;
use pyo3::prelude::*;
use pyo3::types::PyBytes;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::util::map_err;

type ConnectionReader = boxlite::BoxReader;
type ConnectionWriter = boxlite::BoxWriter;

/// Handle for network operations on a box.
#[pyclass(name = "NetworkHandle")]
pub(crate) struct PyNetworkHandle {
    pub(crate) handle: Arc<LiteBox>,
}

/// A one-shot tunnel to one service port in a box.
#[pyclass(name = "BoxTunnel")]
pub(crate) struct PyBoxTunnel {
    handle: Arc<Mutex<Option<BoxTunnel>>>,
}

/// A bidirectional byte stream returned by a box tunnel.
#[pyclass(name = "BoxConnection")]
pub(crate) struct PyBoxConnection {
    reader: Arc<tokio::sync::Mutex<Option<ConnectionReader>>>,
    writer: Arc<tokio::sync::Mutex<Option<ConnectionWriter>>>,
    /// Borrowed from the halves, which close it; `None` for a remote pipe.
    /// Cleared by `close` so a closed connection never reports a descriptor
    /// the kernel may since have handed to someone else.
    raw_fd: Arc<Mutex<Option<i32>>>,
    /// Whether this transport ever had one, to tell "closed" from "no fd".
    has_fd: bool,
}

#[pymethods]
impl PyNetworkHandle {
    fn tunnel<'py>(&self, py: Python<'py>, port: u16) -> PyResult<Bound<'py, PyAny>> {
        if port == 0 {
            return Err(pyo3::exceptions::PyValueError::new_err(
                "tunnel port must be non-zero",
            ));
        }
        let handle = Arc::clone(&self.handle);
        let target: SocketAddr = format!("{}:{port}", boxlite::net::constants::GUEST_IP)
            .parse()
            .expect("BoxLite guest IP must be a valid socket address");
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let tunnel = handle.network().tunnel(target).await.map_err(map_err)?;
            Ok(PyBoxTunnel {
                handle: Arc::new(Mutex::new(Some(tunnel))),
            })
        })
    }
}

#[pymethods]
impl PyBoxTunnel {
    /// Public URL of a remotely served tunnel, or `None` for a local one.
    fn uri(&self) -> PyResult<Option<String>> {
        Ok(self
            .handle
            .lock()
            .map_err(|_| {
                map_err(boxlite::BoxliteError::Internal(
                    "tunnel lock poisoned".into(),
                ))
            })?
            .as_ref()
            .ok_or_else(|| {
                map_err(boxlite::BoxliteError::InvalidState(
                    "tunnel connection has already been consumed".into(),
                ))
            })?
            .uri()
            .map(str::to_owned))
    }

    fn connect<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let tunnel = handle
                .lock()
                .map_err(|_| {
                    map_err(boxlite::BoxliteError::Internal(
                        "tunnel lock poisoned".into(),
                    ))
                })?
                .take()
                .ok_or_else(|| {
                    map_err(boxlite::BoxliteError::InvalidState(
                        "tunnel connection has already been consumed".into(),
                    ))
                })?;
            let connection = tunnel.connect().map_err(map_err)?;
            let raw_fd = connection.raw_fd();
            let (reader, writer) = connection.into_split();
            Ok(PyBoxConnection {
                reader: Arc::new(tokio::sync::Mutex::new(Some(reader))),
                writer: Arc::new(tokio::sync::Mutex::new(Some(writer))),
                raw_fd: Arc::new(Mutex::new(raw_fd)),
                has_fd: raw_fd.is_some(),
            })
        })
    }
}

#[pymethods]
impl PyBoxConnection {
    /// Borrowed descriptor, as `socket.fileno()`. The connection still owns
    /// and closes it. Raises for a remotely served connection, which is an
    /// in-memory pipe rather than a socket.
    fn fileno(&self) -> PyResult<i32> {
        if !self.has_fd {
            return Err(map_err(boxlite::BoxliteError::Unsupported(
                "a remotely served connection has no local descriptor".into(),
            )));
        }
        (*self
            .raw_fd
            .lock()
            .map_err(|_| map_err(boxlite::BoxliteError::Internal("fd lock poisoned".into())))?)
        .ok_or_else(|| {
            map_err(boxlite::BoxliteError::InvalidState(
                "connection is closed".into(),
            ))
        })
    }

    fn read<'py>(&self, py: Python<'py>, max_bytes: usize) -> PyResult<Bound<'py, PyAny>> {
        if max_bytes == 0 {
            return Err(pyo3::exceptions::PyValueError::new_err(
                "max_bytes must be non-zero",
            ));
        }
        let reader = Arc::clone(&self.reader);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let mut guard = reader.lock().await;
            let stream = guard.as_mut().ok_or_else(|| {
                map_err(boxlite::BoxliteError::InvalidState(
                    "connection is closed".into(),
                ))
            })?;
            let mut buffer = vec![0; max_bytes];
            let read = stream.read(&mut buffer).await.map_err(|error| {
                map_err(boxlite::BoxliteError::Network(format!(
                    "read tunnel connection: {error}"
                )))
            })?;
            buffer.truncate(read);
            Python::attach(|py| Ok(PyBytes::new(py, &buffer).unbind()))
        })
    }

    fn write<'py>(&self, py: Python<'py>, data: Vec<u8>) -> PyResult<Bound<'py, PyAny>> {
        let writer = Arc::clone(&self.writer);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let mut guard = writer.lock().await;
            let stream = guard.as_mut().ok_or_else(|| {
                map_err(boxlite::BoxliteError::InvalidState(
                    "connection is closed".into(),
                ))
            })?;
            stream.write_all(&data).await.map_err(|error| {
                map_err(boxlite::BoxliteError::Network(format!(
                    "write tunnel connection: {error}"
                )))
            })?;
            Ok(data.len())
        })
    }

    fn close<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let reader = Arc::clone(&self.reader);
        let writer = Arc::clone(&self.writer);
        let raw_fd = Arc::clone(&self.raw_fd);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            // Drop the number before the halves close it.
            if let Ok(mut cached) = raw_fd.lock() {
                *cached = None;
            }
            let mut writer = writer.lock().await;
            if let Some(mut stream) = writer.take() {
                stream.shutdown().await.map_err(map_err)?;
            }
            reader.lock().await.take();
            Ok(())
        })
    }

    fn shutdown_write<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let writer = Arc::clone(&self.writer);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let mut writer = writer.lock().await;
            if let Some(stream) = writer.as_mut() {
                stream.shutdown().await.map_err(map_err)?;
            }
            Ok(())
        })
    }
}
