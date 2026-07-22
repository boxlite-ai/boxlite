use std::net::SocketAddr;
use std::os::fd::{AsRawFd, IntoRawFd};
use std::sync::{Arc, Mutex};

use boxlite::LiteBox;
use boxlite::litebox::{BoxEndpoint, BoxTunnel};
use pyo3::prelude::*;
use pyo3::types::PyDict;

use crate::util::map_err;

async fn connection_fd(
    mut connection: Box<dyn boxlite::BoxConnection>,
) -> std::result::Result<std::os::fd::OwnedFd, boxlite::BoxliteError> {
    let (sdk, mut bridge) = tokio::net::UnixStream::pair().map_err(|error| {
        boxlite::BoxliteError::Network(format!("create SDK socket bridge: {error}"))
    })?;
    tokio::spawn(async move {
        let _ = tokio::io::copy_bidirectional(&mut connection, &mut bridge).await;
    });
    sdk.into_std()
        .map(std::os::fd::OwnedFd::from)
        .map_err(|error| boxlite::BoxliteError::Network(format!("export SDK socket: {error}")))
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
    fn endpoint<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let endpoint = handle
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
            Python::attach(move |py| match endpoint {
                BoxEndpoint::Uri(uri) => Ok(uri.into_pyobject(py)?.into_any().unbind()),
                BoxEndpoint::FileDescriptor(fd) => Ok(fd.into_pyobject(py)?.into_any().unbind()),
            })
        })
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
            let fd = connection_fd(connection).await.map_err(map_err)?;
            Python::attach(move |py| {
                let kwargs = PyDict::new(py);
                kwargs.set_item("fileno", fd.as_raw_fd())?;
                let socket = py
                    .import("socket")?
                    .getattr("socket")?
                    .call((), Some(&kwargs))?;
                let _ = fd.into_raw_fd();
                socket.call_method1("setblocking", (false,))?;
                Ok(socket.unbind())
            })
        })
    }
}
