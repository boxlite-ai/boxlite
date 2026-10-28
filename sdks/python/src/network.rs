use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use boxlite::LiteBox;
use boxlite::litebox::{BoxTunnel, SocketAddress, TunnelForwarder, TunnelOptions};
use pyo3::prelude::*;
use pyo3::types::PyType;
use pyo3::types::{PyBytes, PyTuple};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::options::{PyInboundNetworkSpec, PyOutboundNetworkSpec};
use crate::util::map_err;
use boxlite::runtime::options::{InboundNetworkConfig, OutboundNetworkConfig};

type ConnectionReader = boxlite::BoxReader;
type ConnectionWriter = boxlite::BoxWriter;

fn parse_tunnel_target(target: &Bound<'_, PyTuple>) -> PyResult<SocketAddr> {
    use pyo3::exceptions::PyValueError;
    if target.len() != 2 && target.len() != 4 {
        return Err(PyValueError::new_err(
            "tunnel target must be (ip, port) or (ip, port, flowinfo, scope_id)",
        ));
    }
    let host: String = target.get_item(0)?.extract()?;
    let ip = host
        .parse::<IpAddr>()
        .map_err(|_| PyValueError::new_err("tunnel target must use a numeric IP"))?;
    let port: u16 = target.get_item(1)?.extract()?;
    if target.len() == 4 {
        let flowinfo: u32 = target.get_item(2)?.extract()?;
        let scope_id: u32 = target.get_item(3)?.extract()?;
        if !ip.is_ipv6() || flowinfo != 0 || scope_id != 0 {
            return Err(PyValueError::new_err(
                "four-element tunnel targets require IPv6 with zero flowinfo and scope_id",
            ));
        }
    }
    Ok(SocketAddr::new(ip, port))
}

/// Handle for network operations on a box.
#[pyclass(name = "NetworkHandle")]
pub(crate) struct PyNetworkHandle {
    pub(crate) handle: Arc<LiteBox>,
}

/// A one-shot tunnel to one service port in a box.
#[pyclass(name = "BoxTunnel")]
pub(crate) struct PyBoxTunnel {
    handle: Mutex<Option<BoxTunnel>>,
    uri: Option<String>,
    is_public: bool,
    token: Option<String>,
}

#[pyclass(name = "SocketAddress")]
#[derive(Clone)]
pub(crate) struct PySocketAddress {
    address: SocketAddress,
}

/// Access policy for `tunnel()`; public unless `is_public=False`.
#[pyclass(name = "TunnelOptions")]
#[derive(Clone)]
pub(crate) struct PyTunnelOptions {
    #[pyo3(get)]
    is_public: bool,
}

#[pymethods]
impl PyTunnelOptions {
    #[new]
    #[pyo3(signature = (is_public=true))]
    fn new(is_public: bool) -> Self {
        Self { is_public }
    }

    fn __repr__(&self) -> String {
        format!(
            "TunnelOptions(is_public={})",
            if self.is_public { "True" } else { "False" }
        )
    }
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
    fn update_inbound<'py>(
        &self,
        py: Python<'py>,
        spec: PyRef<'_, PyInboundNetworkSpec>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let config = InboundNetworkConfig {
            mode: spec.mode.parse().map_err(map_err)?,
            allow_net: spec.allow_net.clone(),
        };
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle
                .network()
                .update_inbound(config)
                .await
                .map_err(map_err)
        })
    }

    fn update_outbound<'py>(
        &self,
        py: Python<'py>,
        spec: PyRef<'_, PyOutboundNetworkSpec>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let config = OutboundNetworkConfig {
            mode: spec.mode.parse().map_err(map_err)?,
            allow_net: spec.allow_net.clone(),
        };
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle
                .network()
                .update_outbound(config)
                .await
                .map_err(map_err)
        })
    }

    /// Prepare a one-shot tunnel to an (ip, port) socket address tuple.
    /// IPv6 also accepts (ip, port, 0, 0). The IP must be loopback or the guest IP.
    #[pyo3(signature = (target, options=None))]
    fn tunnel<'py>(
        &self,
        py: Python<'py>,
        target: &Bound<'_, PyTuple>,
        options: Option<PyTunnelOptions>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let target = parse_tunnel_target(target)?;
        let is_public = options.is_none_or(|options| options.is_public);
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let tunnel = handle
                .network()
                .tunnel(target, TunnelOptions { is_public })
                .await
                .map_err(map_err)?;
            Ok(PyBoxTunnel {
                uri: tunnel.uri().map(str::to_owned),
                is_public: tunnel.is_public(),
                token: tunnel.token().map(str::to_owned),
                handle: Mutex::new(Some(tunnel)),
            })
        })
    }

    fn revoke_tunnel<'py>(&self, py: Python<'py>, port: u16) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle.network().revoke_tunnel(port).await.map_err(map_err)
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
        Ok(self.uri.clone())
    }

    fn is_public(&self) -> bool {
        self.is_public
    }

    fn token(&self) -> Option<String> {
        self.token.clone()
    }

    fn connect<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let tunnel = self.take()?;
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let (reader, writer) = tunnel.connect().await.map_err(map_err)?.into_split();
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

#[cfg(test)]
mod tests {
    use std::ffi::CString;
    use std::io::{BufRead, BufReader, Read, Write};

    use pyo3::types::PyDict;

    use super::*;

    /// Fakes the cloud API for one box on a loopback port and returns each
    /// tunnel prepare body. CONNECT is accepted and held open, so a tunnel
    /// whose URI names this server can be consumed.
    fn tunnel_cloud() -> (String, std::sync::mpsc::Receiver<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (bodies, received) = std::sync::mpsc::channel();
        let server_url = url.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let (mut stream, bodies, url) =
                    (stream.unwrap(), bodies.clone(), server_url.clone());
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let (mut head, mut line) = (String::new(), String::new());
                    while reader.read_line(&mut line).unwrap() > 2 {
                        head.push_str(&line);
                        line.clear();
                    }
                    if head.starts_with("CONNECT ") {
                        stream
                            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                            .unwrap();
                        let _ = std::io::copy(&mut reader, &mut std::io::sink());
                        return;
                    }
                    let length = head
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length: ")?
                                .parse()
                                .ok()
                        })
                        .unwrap_or(0);
                    let mut body = vec![0; length];
                    reader.read_exact(&mut body).unwrap();
                    let body = String::from_utf8(body).unwrap();
                    let reply = if head.starts_with("GET /v1/boxes/box1 ") {
                        r#"{"box_id":"box1","status":"running","created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z","image":"alpine","cpus":1,"memory_mib":256}"#.to_string()
                    } else if head.starts_with("GET /v1/config ") {
                        r#"{"capabilities":{"private_tunnels_enabled":true}}"#.to_string()
                    } else if head.starts_with("POST /v1/boxes/box1/network/tunnel?port=3000 ") {
                        let private = body.contains(r#""isPublic":false"#);
                        bodies.send(body).unwrap();
                        if private {
                            format!(
                                r#"{{"uri":"{url}","isPublic":false,"token":"blt_created_token"}}"#
                            )
                        } else {
                            format!(r#"{{"uri":"{url}","isPublic":true,"token":null}}"#)
                        }
                    } else {
                        panic!("unexpected request: {head}");
                    };
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                        reply.len()
                    )
                    .unwrap();
                });
            }
        });
        (url, received)
    }

    /// Runs `script`'s `main()` with `network` bound to box1's handle on a
    /// REST runtime, the way Python code awaits `box.network.<call>`.
    fn run_with_network(url: &str, script: &str) -> (boxlite::BoxliteRuntime, Py<PyAny>) {
        let runtime =
            boxlite::BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(url.to_string()))
                .unwrap();
        let litebox = pyo3_async_runtimes::tokio::get_runtime()
            .block_on(runtime.get("box1"))
            .unwrap()
            .unwrap();
        let result = Python::attach(|py| {
            // Error conversion imports boxlite.errors; filtered runs cannot rely
            // on another test adding this package to the embedded interpreter.
            py.import("sys")
                .unwrap()
                .getattr("path")
                .unwrap()
                .call_method1("insert", (0, env!("CARGO_MANIFEST_DIR")))
                .unwrap();
            py.import("boxlite.errors").unwrap();
            let network = Bound::new(
                py,
                PyNetworkHandle {
                    handle: Arc::new(litebox),
                },
            )
            .unwrap();
            let globals = PyDict::new(py);
            globals.set_item("network", network).unwrap();
            globals
                .set_item("SocketAddress", py.get_type::<PySocketAddress>())
                .unwrap();
            globals
                .set_item("TunnelOptions", py.get_type::<PyTunnelOptions>())
                .unwrap();
            let script = CString::new(format!(
                "import asyncio\n\n{script}\nresult = asyncio.run(main())\n"
            ))
            .unwrap();
            py.run(&script, Some(&globals), None).unwrap();
            globals.get_item("result").unwrap().unwrap().unbind()
        });
        (runtime, result)
    }

    /// `is_public` is a new optional request field: omitted or at its default
    /// it stays off the wire; only a private tunnel sends it.
    #[test]
    fn tunnel_sends_is_public_only_when_private() {
        let (url, bodies) = tunnel_cloud();
        run_with_network(
            &url,
            "async def main():\n    target = ('127.0.0.1', 3000)\n    await network.tunnel(target)\n    await network.tunnel(target, TunnelOptions())\n    await network.tunnel(target, TunnelOptions(is_public=False))\n",
        );
        let sent: Vec<String> = (0..3)
            .map(|_| {
                bodies
                    .recv_timeout(std::time::Duration::from_secs(10))
                    .unwrap()
            })
            .collect();
        assert_eq!(sent, ["", "", r#"{"isPublic":false}"#]);
    }

    /// Only localhost or the guest IP names a service in the box; anything
    /// else is refused before a request is sent.
    #[test]
    fn tunnel_refuses_a_target_outside_the_box() {
        let (url, bodies) = tunnel_cloud();
        let (_runtime, result) = run_with_network(
            &url,
            "async def main():\n    refused = 0\n    for target in (('10.0.0.5', 3000), SocketAddress.unix('/tmp/service.sock'), ('127.0.0.1', 0), 3000, SocketAddress.tcp(port=3000), ('localhost', 3000), ('127.0.0.1', -1), ('127.0.0.1', 65536), ('127.0.0.1', 1.5), ('127.0.0.1',), ('127.0.0.1', 3000, 0), ('127.0.0.1', 3000, 0, 0), ('::1', 3000, 1, 0), ('::1', 3000, 0, 1)):\n        try:\n            await asyncio.wait_for(network.tunnel(target), timeout=5)\n        except asyncio.TimeoutError:\n            raise AssertionError(f\"target {target!r} timed out\")\n        except Exception:\n            refused += 1\n    return refused\n",
        );
        let refused: usize = Python::attach(|py| result.extract(py).unwrap());
        assert_eq!(refused, 14);
        assert!(
            bodies
                .recv_timeout(std::time::Duration::from_millis(200))
                .is_err()
        );
    }

    #[test]
    fn tunnel_accepts_ipv6_socket_tuples() {
        let (url, bodies) = tunnel_cloud();
        run_with_network(
            &url,
            "async def main():\n    await network.tunnel(('::1', 3000))\n    await network.tunnel(('::1', 3000, 0, 0))\n",
        );
        for _ in 0..2 {
            assert_eq!(
                bodies
                    .recv_timeout(std::time::Duration::from_secs(10))
                    .unwrap(),
                ""
            );
        }
    }

    #[test]
    fn tunnel_refuses_a_boolean_instead_of_options() {
        let (url, bodies) = tunnel_cloud();
        let (_runtime, result) = run_with_network(
            &url,
            "async def main():\n    try:\n        await network.tunnel(('127.0.0.1', 3000), False)\n    except TypeError:\n        return True\n    return False\n",
        );
        assert!(Python::attach(|py| result.extract::<bool>(py).unwrap()));
        assert!(bodies.try_recv().is_err());
    }

    /// The token is shown once; it must stay readable after connect consumes
    /// the tunnel.
    #[test]
    fn consumed_tunnel_still_reports_its_descriptor() {
        let (url, bodies) = tunnel_cloud();
        let (_runtime, result) = run_with_network(
            &url,
            "async def main():\n    tunnel = await network.tunnel(('127.0.0.1', 3000), TunnelOptions(is_public=False))\n    connection = await tunnel.connect()\n    await connection.close()\n    return (tunnel.uri(), tunnel.is_public(), tunnel.token())\n",
        );
        bodies
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap();
        let (uri, is_public, token): (Option<String>, bool, Option<String>) =
            Python::attach(|py| result.extract(py).unwrap());
        assert_eq!(uri.as_deref(), Some(url.as_str()));
        assert!(!is_public);
        assert_eq!(token.as_deref(), Some("blt_created_token"));
    }
}
