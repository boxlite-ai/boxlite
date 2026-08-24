use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use boxlite::LiteBox;
use boxlite::litebox::{BoxTunnel, SocketAddress, TunnelForwarder};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::util::map_err;

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
}

#[napi(object)]
pub struct JsSocketAddress {
    pub r#type: String,
    pub host: Option<String>,
    pub port: Option<f64>,
    pub path: Option<String>,
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
    pub async fn tunnel(&self, port: u16) -> Result<JsBoxTunnel> {
        if port == 0 {
            return Err(Error::from_reason("tunnel port must be non-zero"));
        }
        let target: SocketAddr = format!("{}:{port}", boxlite::net::constants::GUEST_IP)
            .parse()
            .expect("BoxLite guest IP must be a valid socket address");
        let tunnel = self
            .handle
            .network()
            .tunnel(target)
            .await
            .map_err(map_err)?;
        Ok(JsBoxTunnel {
            handle: Mutex::new(Some(tunnel)),
        })
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
        let guard = self
            .handle
            .lock()
            .map_err(|_| Error::from_reason("tunnel lock poisoned"))?;
        let tunnel = guard
            .as_ref()
            .ok_or_else(|| Error::from_reason("tunnel connection has already been consumed"))?;
        Ok(tunnel.uri().map(str::to_owned))
    }

    #[napi]
    pub async fn connect(&self) -> Result<JsBoxConnection> {
        let tunnel = self.take()?;
        let (reader, writer) = tunnel.connect().map_err(map_err)?.into_split();
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
