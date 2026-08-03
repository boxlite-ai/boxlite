use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use boxlite::LiteBox;
use boxlite::litebox::{BoxEndpoint, BoxTunnel};
use pyo3::prelude::*;
use pyo3::types::PyBytes;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::util::map_err;

type ConnectionReader = tokio::io::ReadHalf<Box<dyn boxlite::BoxConnection>>;
type ConnectionWriter = tokio::io::WriteHalf<Box<dyn boxlite::BoxConnection>>;

async fn close_streams(
    reader: &tokio::sync::Mutex<Option<ConnectionReader>>,
    writer: &tokio::sync::Mutex<Option<ConnectionWriter>>,
) -> std::io::Result<()> {
    let mut writer = writer.lock().await;
    let shutdown_result = if let Some(mut stream) = writer.take() {
        match stream.shutdown().await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotConnected => Ok(()),
            Err(error) => Err(error),
        }
    } else {
        Ok(())
    };
    reader.lock().await.take();
    shutdown_result
}

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
    fn endpoint(&self, py: Python<'_>) -> PyResult<Py<PyAny>> {
        let endpoint = self
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
            .endpoint();
        match endpoint {
            BoxEndpoint::Uri(uri) => Ok(uri.into_pyobject(py)?.into_any().unbind()),
            BoxEndpoint::FileDescriptor(fd) => Ok(fd.into_pyobject(py)?.into_any().unbind()),
        }
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
            let (reader, writer) = tokio::io::split(connection);
            Ok(PyBoxConnection {
                reader: Arc::new(tokio::sync::Mutex::new(Some(reader))),
                writer: Arc::new(tokio::sync::Mutex::new(Some(writer))),
            })
        })
    }
}

#[pymethods]
impl PyBoxConnection {
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

    /// Close the connection and release its reader.
    ///
    /// An already disconnected writer (`NotConnected`) is treated as closed;
    /// other writer shutdown errors are returned.
    fn close<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let reader = Arc::clone(&self.reader);
        let writer = Arc::clone(&self.writer);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            close_streams(&reader, &writer).await.map_err(|error| {
                map_err(boxlite::BoxliteError::Network(format!(
                    "close tunnel connection: {error}"
                )))
            })
        })
    }

    fn shutdown_write<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let writer = Arc::clone(&self.writer);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let mut writer = writer.lock().await;
            if let Some(stream) = writer.as_mut() {
                stream.shutdown().await.map_err(|error| {
                    map_err(boxlite::BoxliteError::Network(format!(
                        "shut down tunnel writer: {error}"
                    )))
                })?;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

    struct ShutdownErrorStream(std::io::ErrorKind);

    impl AsyncRead for ShutdownErrorStream {
        fn poll_read(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            _buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    impl AsyncWrite for ShutdownErrorStream {
        fn poll_write(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            Poll::Ready(Ok(buf.len()))
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Err(std::io::Error::from(self.0)))
        }
    }

    #[test]
    fn close_tolerates_not_connected_and_clears_both_halves() {
        futures::executor::block_on(async {
            let connection: Box<dyn boxlite::BoxConnection> =
                Box::new(ShutdownErrorStream(std::io::ErrorKind::NotConnected));
            let (reader, writer) = tokio::io::split(connection);
            let reader = tokio::sync::Mutex::new(Some(reader));
            let writer = tokio::sync::Mutex::new(Some(writer));

            close_streams(&reader, &writer).await.unwrap();

            assert!(reader.lock().await.is_none());
            assert!(writer.lock().await.is_none());
        });
    }

    #[test]
    fn close_reports_shutdown_errors_after_clearing_both_halves() {
        futures::executor::block_on(async {
            let connection: Box<dyn boxlite::BoxConnection> =
                Box::new(ShutdownErrorStream(std::io::ErrorKind::BrokenPipe));
            let (reader, writer) = tokio::io::split(connection);
            let reader = tokio::sync::Mutex::new(Some(reader));
            let writer = tokio::sync::Mutex::new(Some(writer));

            let error = close_streams(&reader, &writer).await.unwrap_err();

            assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
            assert!(reader.lock().await.is_none());
            assert!(writer.lock().await.is_none());
        });
    }
}
