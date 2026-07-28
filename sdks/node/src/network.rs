use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use boxlite::LiteBox;
use boxlite::litebox::{BoxEndpoint, BoxTunnel};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::util::map_err;

type ConnectionReader = tokio::io::ReadHalf<Box<dyn boxlite::BoxConnection>>;
type ConnectionWriter = tokio::io::WriteHalf<Box<dyn boxlite::BoxConnection>>;

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
    #[napi]
    pub fn endpoint(&self) -> Result<Either<String, i32>> {
        let handle = self
            .handle
            .lock()
            .map_err(|_| Error::from_reason("tunnel lock poisoned"))?;
        let tunnel = handle
            .as_ref()
            .ok_or_else(|| Error::from_reason("tunnel connection has already been consumed"))?;
        match tunnel.endpoint() {
            BoxEndpoint::Uri(uri) => Ok(Either::A(uri)),
            BoxEndpoint::FileDescriptor(fd) => Ok(Either::B(fd)),
        }
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
        let (reader, writer) = tokio::io::split(connection);
        Ok(JsBoxConnection {
            reader: Arc::new(tokio::sync::Mutex::new(Some(reader))),
            writer: Arc::new(tokio::sync::Mutex::new(Some(writer))),
        })
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
            stream
                .shutdown()
                .await
                .map_err(|error| Error::from_reason(format!("close tunnel connection: {error}")))?;
        }
        self.reader.lock().await.take();
        Ok(())
    }

    #[napi]
    pub async fn shutdown_write(&self) -> Result<()> {
        let mut writer = self.writer.lock().await;
        if let Some(stream) = writer.as_mut() {
            stream
                .shutdown()
                .await
                .map_err(|error| Error::from_reason(format!("shut down tunnel writer: {error}")))?;
        }
        Ok(())
    }
}
