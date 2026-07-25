//! `impl Ssh for GuestServer`: the typed control-plane RPC the Runner (via
//! the Rust/C/Go facade) uses to apply/query the SSH access snapshot.
//!
//! SSH bytes never touch this file -- it only ever reads/replaces
//! [`super::access::AccessState`] and reports [`super::SshRuntimeStatus`],
//! both owned by `GuestServer` so they exist whether or not the russh
//! listener itself is running.

use super::access::{self, AccessEntry, AccessSnapshot, KeyParseError, ReplaceError};
use super::limits::MAX_ACCESS_ENTRIES;
use super::IdentityStatus;
use crate::service::server::GuestServer;
use boxlite_shared::{
    ssh_server::Ssh, SshAccessSetRequest, SshIdentityStatus, SshStatusRequest, SshStatusResponse,
};
use std::time::{Duration, UNIX_EPOCH};
use tonic::{Request, Response, Status};

fn to_proto_identity_status(status: IdentityStatus) -> SshIdentityStatus {
    match status {
        IdentityStatus::Unknown => SshIdentityStatus::Unspecified,
        IdentityStatus::Ready => SshIdentityStatus::Ready,
        IdentityStatus::Degraded => SshIdentityStatus::Degraded,
    }
}

fn status_response(server: &GuestServer) -> SshStatusResponse {
    let status = server
        .ssh_status
        .read()
        .expect("ssh status lock poisoned")
        .clone();
    SshStatusResponse {
        applied_generation: server.ssh_access.current().generation,
        listener_ready: status.listener_ready,
        host_public_key: status.host_public_key,
        host_fingerprint: status.host_fingerprint,
        identity_status: to_proto_identity_status(status.identity_status).into(),
    }
}

impl From<KeyParseError> for Status {
    fn from(e: KeyParseError) -> Self {
        Status::invalid_argument(e.to_string())
    }
}

#[allow(clippy::result_large_err)]
fn to_access_entry(entry: boxlite_shared::SshAccessEntry) -> Result<AccessEntry, Status> {
    if entry.unix_user != access::SSH_UNIX_USER {
        return Err(Status::invalid_argument(format!(
            "unsupported unix_user (only '{}' is accepted)",
            access::SSH_UNIX_USER
        )));
    }
    let public_key = access::parse_authorized_public_key(&entry.public_key)?;
    let expires_at = UNIX_EPOCH
        .checked_add(Duration::from_secs(
            entry.expires_at_unix_seconds.max(0) as u64
        ))
        .ok_or_else(|| Status::invalid_argument("expires_at_unix_seconds out of range"))?;
    Ok(AccessEntry {
        credential_id: entry.credential_id,
        grant_id: entry.grant_id,
        fingerprint: entry.fingerprint,
        public_key,
        unix_user: entry.unix_user,
        expires_at,
    })
}

#[tonic::async_trait]
impl Ssh for GuestServer {
    async fn replace_access_set(
        &self,
        request: Request<SshAccessSetRequest>,
    ) -> Result<Response<SshStatusResponse>, Status> {
        let req = request.into_inner();
        if req.accesses.len() > MAX_ACCESS_ENTRIES {
            return Err(Status::resource_exhausted(format!(
                "access set exceeds {MAX_ACCESS_ENTRIES} entries"
            )));
        }

        let entries = req
            .accesses
            .into_iter()
            .map(to_access_entry)
            .collect::<Result<Vec<_>, Status>>()?;

        let snapshot = AccessSnapshot {
            generation: req.generation,
            entries,
        };

        match self.ssh_access.replace(snapshot) {
            Ok(()) => {
                tracing::info!(generation = req.generation, "ssh: access set applied");
                Ok(Response::new(status_response(self)))
            }
            Err(ReplaceError::StaleGeneration { current, attempted }) => {
                Err(Status::failed_precondition(format!(
                    "stale generation: attempted {attempted}, current {current}"
                )))
            }
            Err(ReplaceError::ConflictingGeneration { generation }) => {
                Err(Status::failed_precondition(format!(
                    "generation {generation} already applied with different content"
                )))
            }
        }
    }

    async fn status(
        &self,
        _request: Request<SshStatusRequest>,
    ) -> Result<Response<SshStatusResponse>, Status> {
        Ok(Response::new(status_response(self)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::GuestLayout;
    use boxlite_shared::SshAccessEntry;
    use std::time::SystemTime;

    fn test_server() -> GuestServer {
        let tmp = tempfile::tempdir().unwrap();
        GuestServer::new(GuestLayout::with_base(tmp.path()))
    }

    fn valid_entry(credential_id: &str) -> SshAccessEntry {
        let key = crate::service::ssh::access::test_support::generate_ed25519();
        SshAccessEntry {
            credential_id: credential_id.to_string(),
            grant_id: format!("grant-{credential_id}"),
            public_key: key.public_key().to_openssh().unwrap(),
            fingerprint: access::fingerprint(key.public_key()),
            unix_user: "root".to_string(),
            expires_at_unix_seconds: (SystemTime::now() + Duration::from_secs(300))
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64,
        }
    }

    #[tokio::test]
    async fn replace_then_status_reports_applied_generation() {
        let server = test_server();
        let resp = server
            .replace_access_set(Request::new(SshAccessSetRequest {
                generation: 1,
                accesses: vec![valid_entry("cred-1")],
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(resp.applied_generation, 1);

        let status = server
            .status(Request::new(SshStatusRequest {}))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(status.applied_generation, 1);
    }

    #[tokio::test]
    async fn stale_generation_is_rejected_and_snapshot_unchanged() {
        let server = test_server();
        server
            .replace_access_set(Request::new(SshAccessSetRequest {
                generation: 5,
                accesses: vec![],
            }))
            .await
            .unwrap();

        let err = server
            .replace_access_set(Request::new(SshAccessSetRequest {
                generation: 3,
                accesses: vec![],
            }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::FailedPrecondition);

        let status = server
            .status(Request::new(SshStatusRequest {}))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(
            status.applied_generation, 5,
            "rejected replace must not change the snapshot"
        );
    }

    #[tokio::test]
    async fn non_root_user_is_rejected() {
        let server = test_server();
        let mut entry = valid_entry("cred-1");
        entry.unix_user = "guest".to_string();
        let err = server
            .replace_access_set(Request::new(SshAccessSetRequest {
                generation: 1,
                accesses: vec![entry],
            }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn malformed_key_is_rejected() {
        let server = test_server();
        let mut entry = valid_entry("cred-1");
        entry.public_key = "not-a-key".to_string();
        let err = server
            .replace_access_set(Request::new(SshAccessSetRequest {
                generation: 1,
                accesses: vec![entry],
            }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn oversized_snapshot_is_rejected() {
        let server = test_server();
        let accesses = (0..MAX_ACCESS_ENTRIES + 1)
            .map(|i| valid_entry(&format!("cred-{i}")))
            .collect();
        let err = server
            .replace_access_set(Request::new(SshAccessSetRequest {
                generation: 1,
                accesses,
            }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), tonic::Code::ResourceExhausted);
    }

    #[tokio::test]
    async fn idempotent_replay_of_same_generation_succeeds() {
        let server = test_server();
        let req = SshAccessSetRequest {
            generation: 1,
            accesses: vec![valid_entry("cred-1")],
        };
        server
            .replace_access_set(Request::new(req.clone()))
            .await
            .unwrap();
        server.replace_access_set(Request::new(req)).await.unwrap();
    }

    #[tokio::test]
    async fn status_reports_degraded_identity_after_host_key_failure() {
        let server = test_server();
        {
            let mut status = server.ssh_status.write().unwrap();
            status.identity_status = IdentityStatus::Degraded;
        }
        let resp = server
            .status(Request::new(SshStatusRequest {}))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(resp.identity_status, SshIdentityStatus::Degraded as i32);
    }
}
