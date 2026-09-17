//! SSH control over the existing guest RPC connection.

use crate::runtime::ssh::PreparedSsh;
use boxlite_shared::constants::network::GUEST_SSH_PORT;
use boxlite_shared::{
    BoxliteError, BoxliteResult, SshClient, SshDisableRequest, SshStatus, SshStatusRequest,
};
use std::time::Duration;
use tonic::{Request, transport::Channel};

const RPC_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) struct SshInterface {
    client: SshClient<Channel>,
}

impl SshInterface {
    pub(crate) fn new(channel: Channel) -> Self {
        Self {
            client: SshClient::new(channel),
        }
    }

    pub(crate) async fn configure(&mut self, prepared: PreparedSsh) -> BoxliteResult<SshStatus> {
        let mut request = Request::new(prepared.request);
        request.set_timeout(RPC_TIMEOUT);
        let response = tokio::time::timeout(RPC_TIMEOUT, self.client.configure(request))
            .await
            .map_err(|_| BoxliteError::Internal("Ssh.Configure timed out after 30 seconds".into()))?
            .map_err(|status| BoxliteError::Internal(format!("Ssh.Configure failed: {status}")))?
            .into_inner();
        verify_configured_status(response.status, &prepared.host_key_fingerprint)
    }

    pub(crate) async fn disable(&mut self) -> BoxliteResult<SshStatus> {
        let mut request = Request::new(SshDisableRequest {});
        request.set_timeout(RPC_TIMEOUT);
        let response = tokio::time::timeout(RPC_TIMEOUT, self.client.disable(request))
            .await
            .map_err(|_| BoxliteError::Internal("Ssh.Disable timed out after 30 seconds".into()))?
            .map_err(|status| BoxliteError::Internal(format!("Ssh.Disable failed: {status}")))?
            .into_inner();
        verify_disabled_status(response.status)
    }

    pub(crate) async fn status(&mut self) -> BoxliteResult<SshStatus> {
        let mut request = Request::new(SshStatusRequest {});
        request.set_timeout(RPC_TIMEOUT);
        let response = tokio::time::timeout(RPC_TIMEOUT, self.client.status(request))
            .await
            .map_err(|_| BoxliteError::Internal("Ssh.Status timed out after 30 seconds".into()))?
            .map_err(|status| BoxliteError::Internal(format!("Ssh.Status failed: {status}")))?
            .into_inner();
        verify_status(response.status, "Ssh.Status")
    }
}

fn verify_status(status: Option<SshStatus>, operation: &str) -> BoxliteResult<SshStatus> {
    let Some(status) = status else {
        return Err(BoxliteError::Internal(format!(
            "{operation} returned no SSH status"
        )));
    };
    let valid = if status.enabled {
        status.vsock_port == GUEST_SSH_PORT
            && !status.host_key_fingerprint.is_empty()
            && status.generation > 0
    } else {
        status.vsock_port == 0 && status.host_key_fingerprint.is_empty()
    };
    if !valid {
        return Err(BoxliteError::Internal(format!(
            "{operation} returned incompatible status: {status:?}"
        )));
    }
    Ok(status)
}

fn verify_configured_status(
    status: Option<SshStatus>,
    fingerprint: &str,
) -> BoxliteResult<SshStatus> {
    let status = verify_status(status, "Ssh.Configure")?;
    if !status.enabled
        || status.vsock_port != GUEST_SSH_PORT
        || status.host_key_fingerprint != fingerprint
    {
        return Err(BoxliteError::Internal(format!(
            "Ssh.Configure returned incompatible status (expected enabled listener and host fingerprint {fingerprint}): {status:?}"
        )));
    }
    Ok(status)
}

fn verify_disabled_status(status: Option<SshStatus>) -> BoxliteResult<SshStatus> {
    let status = verify_status(status, "Ssh.Disable")?;
    if status.enabled {
        return Err(BoxliteError::Internal(format!(
            "Ssh.Disable returned an enabled listener: {status:?}"
        )));
    }
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enabled() -> SshStatus {
        SshStatus {
            enabled: true,
            vsock_port: GUEST_SSH_PORT,
            host_key_fingerprint: "SHA256:expected".into(),
            generation: 1,
        }
    }

    #[test]
    fn ssh_configure_requires_enabled_listener_address_identity_and_generation() {
        let expected = enabled();
        assert_eq!(
            verify_configured_status(Some(expected.clone()), &expected.host_key_fingerprint)
                .unwrap(),
            expected
        );
        for status in [
            None,
            Some(SshStatus::default()),
            Some(SshStatus {
                vsock_port: GUEST_SSH_PORT + 1,
                ..expected.clone()
            }),
            Some(SshStatus {
                vsock_port: 0,
                ..expected.clone()
            }),
            Some(SshStatus {
                host_key_fingerprint: "SHA256:other".into(),
                ..expected.clone()
            }),
            Some(SshStatus {
                generation: 0,
                ..expected.clone()
            }),
        ] {
            assert!(verify_configured_status(status, &expected.host_key_fingerprint).is_err());
        }
    }

    #[test]
    fn ssh_disable_requires_confirmed_disabled_listener() {
        let disabled = SshStatus {
            generation: 3,
            ..Default::default()
        };
        assert_eq!(
            verify_disabled_status(Some(disabled.clone())).unwrap(),
            disabled
        );
        for status in [
            None,
            Some(enabled()),
            Some(SshStatus {
                vsock_port: GUEST_SSH_PORT,
                ..disabled.clone()
            }),
            Some(SshStatus {
                host_key_fingerprint: "SHA256:old".into(),
                ..disabled
            }),
        ] {
            assert!(verify_disabled_status(status).is_err());
        }
    }

    #[test]
    fn ssh_status_accepts_initial_disabled_state_and_rejects_malformed_listener() {
        assert_eq!(
            verify_status(Some(SshStatus::default()), "Ssh.Status").unwrap(),
            SshStatus::default()
        );
        assert_eq!(
            verify_status(Some(enabled()), "Ssh.Status").unwrap(),
            enabled()
        );
        for status in [
            None,
            Some(SshStatus {
                vsock_port: 0,
                ..enabled()
            }),
            Some(SshStatus {
                host_key_fingerprint: String::new(),
                ..enabled()
            }),
        ] {
            assert!(verify_status(status, "Ssh.Status").is_err());
        }
    }
}
