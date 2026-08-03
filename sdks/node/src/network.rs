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

    /// Close the connection and release its reader.
    ///
    /// An already disconnected writer (`NotConnected`) is treated as closed;
    /// other writer shutdown errors are returned.
    #[napi]
    pub async fn close(&self) -> Result<()> {
        close_streams(&self.reader, &self.writer)
            .await
            .map_err(|error| Error::from_reason(format!("close tunnel connection: {error}")))
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
