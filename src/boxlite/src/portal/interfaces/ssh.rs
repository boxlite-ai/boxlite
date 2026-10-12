//! Internal SSH wire boundary. No retry: Configure restarts the listener.

use boxlite_shared::{self as proto, BoxliteError, BoxliteResult};
use tonic::transport::Channel;

use crate::litebox::{SshConfig, SshStatus};

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

    /// Send the complete replacement configuration once, leaving validation to the guest.
    /// Retrying could disconnect clients by replacing the listener a second time.
    pub(crate) async fn configure(&mut self, config: SshConfig) -> BoxliteResult<SshStatus> {
        let response = self
            .client
            .configure(proto::SshConfigureRequest {
                config: Some(config_to_proto(config)),
            })
            .await
            .map_err(|status| map_tonic_err("configure", status))?;
        status_from_proto("configure", response.into_inner().status)
    }

    /// Read the guest's current listener state without exposing its credentials.
    pub(crate) async fn status(&mut self) -> BoxliteResult<SshStatus> {
        let response = self
            .client
            .status(proto::SshStatusRequest {})
            .await
            .map_err(|status| map_tonic_err("status", status))?;
        status_from_proto("status", response.into_inner().status)
    }

    /// Request guest-side SSH teardown and return its reported state without retrying.
    pub(crate) async fn disable(&mut self) -> BoxliteResult<SshStatus> {
        let response = self
            .client
            .disable(proto::SshDisableRequest {})
            .await
            .map_err(|status| map_tonic_err("disable", status))?;
        status_from_proto("disable", response.into_inner().status)
    }
}

/// Preserve each login's credentials when crossing from the public API to the wire.
fn config_to_proto(config: SshConfig) -> proto::SshConfig {
    proto::SshConfig {
        listen_address: config.listen_address,
        host_private_key: config.host_private_key,
        accounts: config
            .accounts
            .into_iter()
            .map(|account| proto::SshAccount {
                login: account.login,
                authorized_keys: account.authorized_keys,
                ca: account.ca.map(|ca| proto::SshCaConfig {
                    public_key: ca.public_key,
                    principal: ca.principal,
                }),
            })
            .collect(),
    }
}

/// Reject a missing status instead of treating an incomplete reply as disabled SSH.
fn status_from_proto(name: &str, status: Option<proto::SshStatus>) -> BoxliteResult<SshStatus> {
    let status = status
        .ok_or_else(|| BoxliteError::Internal(format!("SSH {name}: response missing status")))?;
    Ok(SshStatus {
        enabled: status.enabled,
        generation: status.generation,
        listen_address: status.listen_address,
        host_public_key: status.host_public_key,
        host_key_fingerprint: status.host_key_fingerprint,
    })
}

/// Preserve actionable guest error categories and include the failed SSH operation.
fn map_tonic_err(name: &str, status: tonic::Status) -> BoxliteError {
    let message = format!("SSH {name}: {status}");
    match status.code() {
        tonic::Code::InvalidArgument => BoxliteError::InvalidArgument(message),
        tonic::Code::FailedPrecondition => BoxliteError::InvalidState(message),
        tonic::Code::Unimplemented => BoxliteError::Unsupported(message),
        _ => BoxliteError::Rpc(message),
    }
}
