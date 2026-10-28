use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use boxlite::LiteBox;
use boxlite::litebox::{BoxTunnel, SocketAddress, TunnelForwarder, TunnelOptions};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::options::{JsInboundNetworkSpec, JsOutboundNetworkSpec};
use crate::util::map_err;
use boxlite::runtime::options::{InboundNetworkConfig, OutboundNetworkConfig};

type ConnectionReader = boxlite::BoxReader;
type ConnectionWriter = boxlite::BoxWriter;

/// Handle for network operations on a box.
#[napi]
pub struct JsNetworkHandle {
    pub(crate) handle: Arc<LiteBox>,
}

/// A prepared one-shot tunnel to one service port in a box.
#[napi]
pub struct JsBoxTunnel {
    handle: Mutex<Option<BoxTunnel>>,
    uri: Option<String>,
    is_public: bool,
    token: Option<String>,
}

#[napi(object)]
pub struct JsSocketAddress {
    pub r#type: String,
    pub host: Option<String>,
    pub port: Option<f64>,
    pub path: Option<String>,
}

/// Access policy for `tunnel()`; an omitted field keeps its default.
#[napi(object)]
pub struct JsTunnelOptions {
    pub is_public: Option<bool>,
}

/// Binding-only adapter: read node:net SocketAddress getters before spawning.
pub struct TunnelTarget(SocketAddr);

impl TypeName for TunnelTarget {
    fn type_name() -> &'static str {
        "SocketAddress"
    }
    fn value_type() -> napi::ValueType {
        napi::ValueType::Object
    }
}

impl ValidateNapiValue for TunnelTarget {}

impl FromNapiValue for TunnelTarget {
    unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
        // SAFETY: napi validates the object and the lifetime of both handles.
        let target = unsafe { Object::from_napi_value(env, value)? };
        let address: String = target.get_named_property("address")?;
        let family: String = target.get_named_property("family")?;
        let port: f64 = target.get_named_property("port")?;
        let flowlabel: f64 = target.get_named_property("flowlabel")?;
        let ip = address
            .parse::<IpAddr>()
            .map_err(|_| Error::from_reason("tunnel target must use a numeric IP"))?;
        if family != if ip.is_ipv4() { "ipv4" } else { "ipv6" } {
            return Err(Error::from_reason(
                "tunnel target family does not match its address",
            ));
        }
        if !port.is_finite() || port.fract() != 0.0 || !(1.0..=u16::MAX as f64).contains(&port) {
            return Err(Error::from_reason(
                "tunnel target port must be an integer between 1 and 65535",
            ));
        }
        if flowlabel != 0.0 {
            return Err(Error::from_reason("tunnel target flowlabel must be zero"));
        }
        Ok(Self(SocketAddr::new(ip, port as u16)))
    }
}

#[napi]
pub struct JsTunnelForwarder {
    handle: TunnelForwarder,
}

fn parse_socket_address(address: JsSocketAddress) -> Result<SocketAddress> {
    match address.r#type.as_str() {
        "tcp" => {
            if address.path.is_some() {
                return Err(Error::from_reason("TCP listener path must be omitted"));
            }
            let port = address
                .port
                .ok_or_else(|| Error::from_reason("TCP listener port is required"))?;
            if !port.is_finite() || port.fract() != 0.0 || !(0.0..=u16::MAX as f64).contains(&port)
            {
                return Err(Error::from_reason(
                    "TCP listener port must be an integer between 0 and 65535",
                ));
            }
            let host = address.host.as_deref().unwrap_or("127.0.0.1");
            let ip = if host.is_empty() {
                IpAddr::V4(Ipv4Addr::LOCALHOST)
            } else {
                host.parse::<IpAddr>()
                    .map_err(|_| Error::from_reason("TCP listener host must be a numeric IP"))?
            };
            Ok(SocketAddress::Tcp(SocketAddr::new(ip, port as u16)))
        }
        "unix" => {
            if address.host.is_some() || address.port.is_some() {
                return Err(Error::from_reason(
                    "Unix listener host and port must be omitted",
                ));
            }
            let path = PathBuf::from(
                address
                    .path
                    .ok_or_else(|| Error::from_reason("Unix listener path is required"))?,
            );
            if !path.is_absolute() {
                return Err(Error::from_reason("Unix listener path must be absolute"));
            }
            Ok(SocketAddress::Unix(path))
        }
        _ => Err(Error::from_reason("listener type must be 'tcp' or 'unix'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listener_port_rejects_non_integer_numbers() {
        for port in [f64::NAN, f64::INFINITY, -1.0, 1.5, 65_536.0] {
            let result = parse_socket_address(JsSocketAddress {
                r#type: "tcp".into(),
                host: None,
                port: Some(port),
                path: None,
            });
            assert!(result.is_err(), "accepted invalid port {port}");
        }
    }

    /// Fakes the cloud API for one box on a loopback port and returns each
    /// tunnel prepare body. CONNECT is accepted and held open, so a tunnel
    /// whose URI names this server can be consumed.
    fn tunnel_cloud() -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{BufRead, BufReader, Read, Write};
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

    fn network_at(
        tokio_rt: &tokio::runtime::Runtime,
        url: &str,
    ) -> (boxlite::BoxliteRuntime, JsNetworkHandle) {
        let runtime =
            boxlite::BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(url.to_string()))
                .unwrap();
        let litebox = tokio_rt.block_on(runtime.get("box1")).unwrap().unwrap();
        let network = JsNetworkHandle {
            handle: Arc::new(litebox),
        };
        (runtime, network)
    }

    fn localhost(port: u16) -> TunnelTarget {
        TunnelTarget(SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port))
    }

    #[test]
    fn tunnel_refuses_a_target_outside_the_box() {
        let tokio_rt = tokio::runtime::Runtime::new().unwrap();
        let (url, bodies) = tunnel_cloud();
        let (_runtime, network) = network_at(&tokio_rt, &url);
        for target in [TunnelTarget("10.0.0.5:3000".parse().unwrap()), localhost(0)] {
            assert!(tokio_rt.block_on(network.tunnel(target, None)).is_err());
        }
        assert!(
            bodies
                .recv_timeout(std::time::Duration::from_millis(200))
                .is_err()
        );
    }

    /// `isPublic` is a new optional request field: omitted or at its default
    /// it stays off the wire; only a private tunnel sends it.
    #[test]
    fn tunnel_sends_is_public_only_when_private() {
        let tokio_rt = tokio::runtime::Runtime::new().unwrap();
        let (url, bodies) = tunnel_cloud();
        let (_runtime, network) = network_at(&tokio_rt, &url);
        for (is_public, expected) in [
            (None, ""),
            (Some(true), ""),
            (Some(false), r#"{"isPublic":false}"#),
        ] {
            let options = is_public.map(|is_public| JsTunnelOptions {
                is_public: Some(is_public),
            });
            tokio_rt
                .block_on(network.tunnel(localhost(3000), options))
                .unwrap();
            let body = bodies
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap();
            assert_eq!(body, expected, "is_public {is_public:?}");
        }
    }

    /// The token is shown once; it must stay readable after connect consumes
    /// the tunnel.
    #[test]
    fn consumed_tunnel_still_reports_its_descriptor() {
        let tokio_rt = tokio::runtime::Runtime::new().unwrap();
        let (url, bodies) = tunnel_cloud();
        let (_runtime, network) = network_at(&tokio_rt, &url);
        let tunnel = tokio_rt
            .block_on(network.tunnel(
                localhost(3000),
                Some(JsTunnelOptions {
                    is_public: Some(false),
                }),
            ))
            .unwrap();
        bodies
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap();

        let _connection = tokio_rt.block_on(tunnel.connect()).unwrap();
        assert!(
            tokio_rt.block_on(tunnel.connect()).is_err(),
            "tunnel was not consumed by connect"
        );
        assert_eq!(tunnel.uri().unwrap().as_deref(), Some(url.as_str()));
        assert!(!tunnel.is_public());
        assert_eq!(tunnel.token().as_deref(), Some("blt_created_token"));
    }
}

fn render_socket_address(address: &SocketAddress) -> JsSocketAddress {
    match address {
        SocketAddress::Tcp(address) => JsSocketAddress {
            r#type: "tcp".to_string(),
            host: Some(address.ip().to_string()),
            port: Some(address.port().into()),
            path: None,
        },
        SocketAddress::Unix(path) => JsSocketAddress {
            r#type: "unix".to_string(),
            host: None,
            port: None,
            path: Some(path.to_string_lossy().into_owned()),
        },
    }
}

#[napi]
pub struct JsBoxConnection {
    reader: Arc<tokio::sync::Mutex<Option<ConnectionReader>>>,
    writer: Arc<tokio::sync::Mutex<Option<ConnectionWriter>>>,
}

#[napi]
impl JsNetworkHandle {
    #[napi]
    pub async fn update_inbound(&self, spec: JsInboundNetworkSpec) -> Result<()> {
        self.handle
            .network()
            .update_inbound(InboundNetworkConfig {
                mode: spec.mode.parse().map_err(map_err)?,
                allow_net: spec.allow_net.unwrap_or_default(),
            })
            .await
            .map_err(map_err)
    }

    #[napi]
    pub async fn update_outbound(&self, spec: JsOutboundNetworkSpec) -> Result<()> {
        self.handle
            .network()
            .update_outbound(OutboundNetworkConfig {
                mode: spec.mode.parse().map_err(map_err)?,
                allow_net: spec.allow_net.unwrap_or_default(),
            })
            .await
            .map_err(map_err)
    }

    // Reject primitive options before conversion can treat them as an empty object.
    #[napi(
        strict,
        ts_args_type = "target: import('node:net').SocketAddress, options?: JsTunnelOptions"
    )]
    pub async fn tunnel(
        &self,
        target: TunnelTarget,
        options: Option<JsTunnelOptions>,
    ) -> Result<JsBoxTunnel> {
        let target = target.0;
        let is_public = options.and_then(|options| options.is_public);
        let tunnel = self
            .handle
            .network()
            .tunnel(
                target,
                TunnelOptions {
                    is_public: is_public.unwrap_or(true),
                },
            )
            .await
            .map_err(map_err)?;
        Ok(JsBoxTunnel {
            uri: tunnel.uri().map(str::to_owned),
            is_public: tunnel.is_public(),
            token: tunnel.token().map(str::to_owned),
            handle: Mutex::new(Some(tunnel)),
        })
    }

    #[napi]
    pub async fn revoke_tunnel(&self, port: u16) -> Result<()> {
        self.handle
            .network()
            .revoke_tunnel(port)
            .await
            .map_err(map_err)
    }
}

impl JsBoxTunnel {
    fn take(&self) -> Result<BoxTunnel> {
        self.handle
            .lock()
            .map_err(|_| Error::from_reason("tunnel lock poisoned"))?
            .take()
            .ok_or_else(|| Error::from_reason("tunnel connection has already been consumed"))
    }
}

#[napi]
impl JsTunnelForwarder {
    #[napi]
    pub fn local_addr(&self) -> JsSocketAddress {
        render_socket_address(self.handle.local_addr())
    }

    #[napi]
    pub async fn wait(&self) -> Result<()> {
        self.handle.wait().await.map_err(map_err)
    }

    #[napi]
    pub async fn close(&self) -> Result<()> {
        self.handle.close().await.map_err(map_err)
    }
}

#[napi]
impl JsBoxTunnel {
    /// Public URL of a remotely served tunnel, or `null` for a local one.
    #[napi]
    pub fn uri(&self) -> Result<Option<String>> {
        Ok(self.uri.clone())
    }

    #[napi]
    pub fn is_public(&self) -> bool {
        self.is_public
    }

    #[napi]
    pub fn token(&self) -> Option<String> {
        self.token.clone()
    }

    #[napi]
    pub async fn connect(&self) -> Result<JsBoxConnection> {
        let tunnel = self.take()?;
        let (reader, writer) = tunnel.connect().await.map_err(map_err)?.into_split();
        Ok(JsBoxConnection {
            reader: Arc::new(tokio::sync::Mutex::new(Some(reader))),
            writer: Arc::new(tokio::sync::Mutex::new(Some(writer))),
        })
    }

    #[napi]
    pub async fn forward(&self, listen: JsSocketAddress) -> Result<JsTunnelForwarder> {
        let listen = parse_socket_address(listen)?;
        let tunnel = self.take()?;
        tunnel
            .forward(listen)
            .await
            .map(|handle| JsTunnelForwarder { handle })
            .map_err(map_err)
    }
}

#[napi]
impl JsBoxConnection {
    #[napi]
    pub async fn read(&self, max_bytes: u32) -> Result<Buffer> {
        if max_bytes == 0 {
            return Err(Error::from_reason("maxBytes must be non-zero"));
        }
        let mut guard = self.reader.lock().await;
        let stream = guard
            .as_mut()
            .ok_or_else(|| Error::from_reason("connection is closed"))?;
        let mut buffer = vec![0; max_bytes as usize];
        let read = stream
            .read(&mut buffer)
            .await
            .map_err(|error| Error::from_reason(format!("read tunnel connection: {error}")))?;
        buffer.truncate(read);
        Ok(buffer.into())
    }

    #[napi]
    pub async fn write(&self, data: Buffer) -> Result<u32> {
        let mut guard = self.writer.lock().await;
        let stream = guard
            .as_mut()
            .ok_or_else(|| Error::from_reason("connection is closed"))?;
        stream
            .write_all(&data)
            .await
            .map_err(|error| Error::from_reason(format!("write tunnel connection: {error}")))?;
        Ok(data.len() as u32)
    }

    #[napi]
    pub async fn close(&self) -> Result<()> {
        let mut writer = self.writer.lock().await;
        if let Some(mut stream) = writer.take() {
            stream.shutdown().await.map_err(map_err)?;
        }
        self.reader.lock().await.take();
        Ok(())
    }

    #[napi]
    pub async fn shutdown_write(&self) -> Result<()> {
        let mut writer = self.writer.lock().await;
        if let Some(stream) = writer.as_mut() {
            stream.shutdown().await.map_err(map_err)?;
        }
        Ok(())
    }
}
