use std::io;
use std::net::SocketAddr;
use std::os::fd::OwnedFd;
use std::path::PathBuf;

use boxlite_shared::BoxliteResult;
use boxlite_shared::constants::ssh::CONTROL_TIMEOUT;
use tokio::net::UnixStream;

use super::{Request, Response, failure, ipc::ControlChannel};
use crate::net::socket_path::BoxSockets;

/// Runtime-side entry point for the private shim forwarding protocol.
#[derive(Clone)]
pub(crate) struct ShimClient {
    path: PathBuf,
}

impl ShimClient {
    pub(crate) fn new(sockets: &BoxSockets) -> Self {
        Self {
            path: sockets.shim_sock(),
        }
    }

    pub(crate) async fn set(&self, listener: Option<(OwnedFd, SocketAddr)>) -> BoxliteResult<()> {
        let address = listener.as_ref().map(|(_, address)| *address);
        let descriptor = listener.as_ref().map(|(descriptor, _)| descriptor);
        match self
            .call(Request::SetSshForwarding { address }, descriptor)
            .await?
        {
            Response::Ok => Ok(()),
            _ => Err(failure("set SSH forwarding", "unexpected response")),
        }
    }

    pub(crate) async fn get_socket_addr(&self) -> BoxliteResult<Option<SocketAddr>> {
        match self.call(Request::GetSshSocketAddr, None).await? {
            Response::SshSocketAddr { address } => Ok(address),
            _ => Err(failure("get SSH listener address", "unexpected response")),
        }
    }

    async fn call(
        &self,
        request: Request,
        descriptor: Option<&OwnedFd>,
    ) -> BoxliteResult<Response> {
        let operation = async {
            let mut channel = ControlChannel(UnixStream::connect(&self.path).await?);
            channel.send(&request, descriptor).await?;
            channel.receive::<Response>().await
        };
        let (response, received) = tokio::time::timeout(CONTROL_TIMEOUT, operation)
            .await
            .map_err(|_| {
                failure(
                    "control",
                    "timed out; query the listener address to confirm the outcome",
                )
            })?
            .map_err(|error: io::Error| failure("control", error))?;
        if received.is_some() {
            return Err(failure("control", "unexpected response descriptor"));
        }
        match response {
            Response::Error { error } => Err(failure("control", error)),
            response => Ok(response),
        }
    }
}
