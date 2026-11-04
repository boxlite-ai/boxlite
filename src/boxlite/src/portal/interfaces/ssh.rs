//! Internal SSH wire boundary. No retry: a Control configuration update restarts the listener.

use boxlite_shared as proto;
use tonic::transport::Channel;

pub(crate) struct SshInterface {
    client: proto::SshClient<Channel>,
}

impl SshInterface {
    /// Reuse an established guest channel; connection setup belongs to the session.
    pub(crate) fn new(channel: Channel) -> Self {
        Self {
            client: proto::SshClient::new(channel),
        }
    }

    /// Send one request; retrying a configuration update could disconnect clients again.
    pub(crate) async fn control(
        &mut self,
        request: proto::SshControlRequest,
    ) -> Result<proto::SshControlResponse, Box<tonic::Status>> {
        Ok(self
            .client
            .control(request)
            .await
            .map_err(Box::new)?
            .into_inner())
    }

    /// A separate method makes older guests reject quick setup explicitly.
    pub(crate) async fn setup(
        &mut self,
        request: proto::SshSetupRequest,
    ) -> Result<proto::SshControlResponse, Box<tonic::Status>> {
        Ok(self
            .client
            .setup(request)
            .await
            .map_err(Box::new)?
            .into_inner())
    }
}
