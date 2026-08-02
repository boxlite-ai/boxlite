use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use boxlite::LiteBox;
use boxlite::litebox::BoxTunnel;
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

/// A one-shot tunnel to one service port in a box.
#[napi]
pub struct JsBoxTunnel {
    handle: Arc<Mutex<Option<BoxTunnel>>>,
}

#[napi]
pub struct JsBoxConnection {
    reader: Arc<tokio::sync::Mutex<Option<ConnectionReader>>>,
    writer: Arc<tokio::sync::Mutex<Option<ConnectionWriter>>>,
    /// Borrowed from the halves, which close it; `None` for a remote pipe.
    /// Cleared by `close` so a closed connection never reports a descriptor
    /// the kernel may since have handed to someone else.
    raw_fd: Arc<Mutex<Option<i32>>>,
    /// Whether this transport ever had one, to tell "closed" from "no fd".
    has_fd: bool,
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
            handle: Arc::new(Mutex::new(Some(tunnel))),
        })
    }
}

#[napi]
impl JsBoxTunnel {
    /// Public URL of a remotely served tunnel, or `null` for a local one.
    #[napi]
    pub fn uri(&self) -> Result<Option<String>> {
        let handle = self
            .handle
            .lock()
            .map_err(|_| Error::from_reason("tunnel lock poisoned"))?;
        let tunnel = handle
            .as_ref()
            .ok_or_else(|| Error::from_reason("tunnel connection has already been consumed"))?;
        Ok(tunnel.uri().map(str::to_owned))
    }

    #[napi]
    pub async fn connect(&self) -> Result<JsBoxConnection> {
        let tunnel = self
            .handle
            .lock()
            .map_err(|_| Error::from_reason("tunnel lock poisoned"))?
            .take()
            .ok_or_else(|| Error::from_reason("tunnel connection has already been consumed"))?;
        let connection = tunnel.connect().map_err(map_err)?;
        let raw_fd = connection.raw_fd();
        let (reader, writer) = connection.into_split();
        Ok(JsBoxConnection {
            reader: Arc::new(tokio::sync::Mutex::new(Some(reader))),
            writer: Arc::new(tokio::sync::Mutex::new(Some(writer))),
            raw_fd: Arc::new(Mutex::new(raw_fd)),
            has_fd: raw_fd.is_some(),
        })
    }
}

#[napi]
impl JsBoxConnection {
    /// Borrowed descriptor, like a `net.Socket`'s fd. The connection still
    /// owns and closes it. Throws for a remotely served connection, which is
    /// an in-memory pipe rather than a socket.
    #[napi]
    pub fn fileno(&self) -> Result<i32> {
        if !self.has_fd {
            return Err(Error::from_reason(
                "a remotely served connection has no local descriptor",
            ));
        }
        (*self
            .raw_fd
            .lock()
            .map_err(|_| Error::from_reason("fd lock poisoned"))?)
        .ok_or_else(|| Error::from_reason("connection is closed"))
    }

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
        // Drop the number before the halves close it.
        if let Ok(mut cached) = self.raw_fd.lock() {
            *cached = None;
        }
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
