use std::net::SocketAddr;
use std::os::fd::IntoRawFd;
use std::sync::{Arc, Mutex};

use boxlite::LiteBox;
use boxlite::litebox::{BoxEndpoint, BoxTunnel};
use napi::bindgen_prelude::*;
use napi_derive::napi;

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
    pub async fn endpoint(&self) -> Result<Either<String, i32>> {
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

    /// Consume the tunnel stream and return its owned Unix file descriptor.
    #[napi(js_name = "_connectFd")]
    pub async fn connect_fd(&self) -> Result<i32> {
        let tunnel = self
            .handle
            .lock()
            .map_err(|_| Error::from_reason("tunnel lock poisoned"))?
            .take()
            .ok_or_else(|| Error::from_reason("tunnel connection has already been consumed"))?;
        let connection = tunnel.connect().map_err(map_err)?;
        Ok(connection_fd(connection)
            .await
            .map_err(map_err)?
            .into_raw_fd())
    }
}
