use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use boxlite::LiteBox;
use boxlite::litebox::{BoxTunnel, SocketAddress, TunnelForwarder};
use pyo3::prelude::*;
use pyo3::types::PyBytes;
use pyo3::types::PyType;
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
    handle: Mutex<Option<BoxTunnel>>,
}

#[pyclass(name = "SocketAddress")]
#[derive(Clone)]
pub(crate) struct PySocketAddress {
    address: SocketAddress,
}

#[pyclass(name = "TunnelForwarder")]
pub(crate) struct PyTunnelForwarder {
    handle: TunnelForwarder,
}

#[pymethods]
impl PySocketAddress {
    #[classmethod]
    #[pyo3(signature = (host="127.0.0.1", port=0))]
    fn tcp(_class: &Bound<'_, PyType>, host: &str, port: u16) -> PyResult<Self> {
        let ip = if host.is_empty() {
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        } else {
            host.parse::<IpAddr>().map_err(|_| {
                pyo3::exceptions::PyValueError::new_err("tunnel listener host must be a numeric IP")
            })?
        };
        Ok(Self {
            address: SocketAddress::Tcp(SocketAddr::new(ip, port)),
        })
    }

    #[classmethod]
    fn unix(_class: &Bound<'_, PyType>, path: PathBuf) -> PyResult<Self> {
        if !path.is_absolute() {
            return Err(pyo3::exceptions::PyValueError::new_err(
                "tunnel Unix socket path must be absolute",
            ));
        }
        Ok(Self {
            address: SocketAddress::Unix(path),
        })
    }

    fn __str__(&self) -> String {
        self.address.to_string()
    }

    #[getter]
    fn kind(&self) -> &'static str {
        match &self.address {
            SocketAddress::Tcp(_) => "tcp",
            SocketAddress::Unix(_) => "unix",
        }
    }

    #[getter]
    fn host(&self) -> Option<String> {
        match &self.address {
            SocketAddress::Tcp(address) => Some(address.ip().to_string()),
            SocketAddress::Unix(_) => None,
        }
    }

    #[getter]
    fn port(&self) -> Option<u16> {
        match &self.address {
            SocketAddress::Tcp(address) => Some(address.port()),
            SocketAddress::Unix(_) => None,
        }
    }

    #[getter]
    fn path(&self) -> Option<PathBuf> {
        match &self.address {
            SocketAddress::Tcp(_) => None,
            SocketAddress::Unix(path) => Some(path.clone()),
        }
    }
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
        let target: SocketAddr = format!("{}:{port}", boxlite::net::constants::GUEST_IP)
            .parse()
            .expect("BoxLite guest IP must be a valid socket address");
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let tunnel = handle.network().tunnel(target).await.map_err(map_err)?;
            Ok(PyBoxTunnel {
                handle: Mutex::new(Some(tunnel)),
            })
        })
    }
}

impl PyBoxTunnel {
    fn take(&self) -> PyResult<BoxTunnel> {
        self.handle
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
            })
    }
}

#[pymethods]
impl PyTunnelForwarder {
    fn local_addr(&self) -> PySocketAddress {
        PySocketAddress {
            address: self.handle.local_addr().clone(),
        }
    }

    fn wait<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = self.handle.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle.wait().await.map_err(map_err)
        })
    }

    fn close<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = self.handle.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle.close().await.map_err(map_err)
        })
    }
}

#[pymethods]
impl PyBoxTunnel {
    /// Public URL of a remotely served tunnel, or `None` for a local one.
    fn uri(&self) -> PyResult<Option<String>> {
        let guard = self.handle.lock().map_err(|_| {
            map_err(boxlite::BoxliteError::Internal(
                "tunnel lock poisoned".into(),
            ))
        })?;
        let tunnel = guard.as_ref().ok_or_else(|| {
            map_err(boxlite::BoxliteError::InvalidState(
                "tunnel connection has already been consumed".into(),
            ))
        })?;
        Ok(tunnel.uri().map(str::to_owned))
    }

    fn connect<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let tunnel = self.take()?;
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let (reader, writer) = tunnel.connect().map_err(map_err)?.into_split();
            Ok(PyBoxConnection {
                reader: Arc::new(tokio::sync::Mutex::new(Some(reader))),
                writer: Arc::new(tokio::sync::Mutex::new(Some(writer))),
            })
        })
    }

    fn forward<'py>(
        &self,
        py: Python<'py>,
        listen: PyRef<'_, PySocketAddress>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let tunnel = self.take()?;
        let listen = listen.address.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            tunnel
                .forward(listen)
                .await
                .map(|handle| PyTunnelForwarder { handle })
                .map_err(map_err)
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

    fn close<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let reader = Arc::clone(&self.reader);
        let writer = Arc::clone(&self.writer);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
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
