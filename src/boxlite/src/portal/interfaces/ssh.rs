//! Ssh service interface.
//!
//! Control-plane only: apply/query the guest's SSH access snapshot. SSH
//! bytes themselves stay on the existing network tunnel.

use boxlite_shared::{
    BoxliteResult, SshAccessSetRequest, SshClient, SshStatusRequest, SshStatusResponse,
};
use tonic::transport::Channel;

/// Ssh service interface.
pub struct SshInterface {
    client: SshClient<Channel>,
}

impl SshInterface {
    /// Create from a channel.
    pub fn new(channel: Channel) -> Self {
        Self {
            client: SshClient::new(channel),
        }
    }

    /// Full-set replace of the guest's active SSH access snapshot.
    pub async fn replace_access_set(
        &mut self,
        request: SshAccessSetRequest,
    ) -> BoxliteResult<SshStatusResponse> {
        Ok(self
            .client
            .replace_access_set(request)
            .await
            .map_err(map_tonic_err)?
            .into_inner())
    }

    /// Query applied generation, listener readiness, and host identity.
    pub async fn status(&mut self) -> BoxliteResult<SshStatusResponse> {
        Ok(self
            .client
            .status(SshStatusRequest {})
            .await
            .map_err(map_tonic_err)?
            .into_inner())
    }
}

/// Preserve the tonic status code's meaning rather than flattening every
/// failure into one generic error -- the design requires typed error
/// mapping at each boundary (e.g. a stale/conflicting generation must stay
/// distinguishable from a transport failure so callers can retry sensibly).
fn map_tonic_err(err: tonic::Status) -> boxlite_shared::BoxliteError {
    use boxlite_shared::BoxliteError;
    match err.code() {
        tonic::Code::FailedPrecondition => BoxliteError::InvalidState(err.message().to_string()),
        tonic::Code::InvalidArgument => BoxliteError::InvalidArgument(err.message().to_string()),
        tonic::Code::ResourceExhausted => {
            BoxliteError::ResourceExhausted(err.message().to_string())
        }
        _ => BoxliteError::Rpc(err.to_string()),
    }
}
