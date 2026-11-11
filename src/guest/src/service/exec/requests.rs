//! Request identity survives output eviction and RPC caller cancellation for
//! a fixed acceptance deadline. Expired tokens are rejected before lookup, so
//! completed request records can be reclaimed without repeating effects.
use super::{error_response, start_execution};
use crate::service::server::GuestServer;
use boxlite_shared::{ExecRequest, ExecResponse};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
};
use tokio::sync::{watch, Mutex};
use tonic::Status;

struct RequestEntry {
    hash: [u8; 32],
    deadline: u64,
    result: watch::Receiver<Option<ExecResponse>>,
}

#[derive(Default)]
pub(crate) struct ExecutionRequests {
    entries: Mutex<HashMap<String, RequestEntry>>,
}

impl ExecutionRequests {
    pub async fn execute(
        self: &Arc<Self>,
        server: &GuestServer,
        key: &str,
        request: ExecRequest,
    ) -> Result<ExecResponse, Status> {
        self.execute_at(server, key, request, super::now_ms()).await
    }

    async fn execute_at(
        self: &Arc<Self>,
        server: &GuestServer,
        key: &str,
        request: ExecRequest,
        now: u64,
    ) -> Result<ExecResponse, Status> {
        let deadline = request_deadline(key, now)?;
        let hash: [u8; 32] = Sha256::digest(
            serde_json::to_vec(&(
                &request.execution_id,
                &request.program,
                &request.args,
                request.env.iter().collect::<BTreeMap<_, _>>(),
                &request.workdir,
                request.timeout_ms,
                request
                    .tty
                    .as_ref()
                    .map(|tty| (tty.rows, tty.cols, tty.x_pixels, tty.y_pixels)),
                &request.user,
            ))
            .map_err(|_| Status::invalid_argument("invalid execution payload"))?,
        )
        .into();
        let mut entries = self.entries.lock().await;
        // Unresolved startup tasks remain counted past expiry, including stuck
        // spawns. Capacity exhaustion rejects new starts instead of hiding use.
        entries.retain(|_, entry| entry.deadline > now || entry.result.borrow().is_none());
        let mut result = if let Some(entry) = entries.get(key) {
            if entry.hash != hash {
                return Ok(error_response(
                    String::new(),
                    "idempotency_mismatch",
                    "Idempotency-Key was used with a different request",
                ));
            }
            entry.result.clone()
        } else {
            if entries.len() >= 4096 {
                return Err(Status::resource_exhausted(
                    "execution request retention is full",
                ));
            }
            let (sender, receiver) = watch::channel(None);
            entries.insert(
                key.to_owned(),
                RequestEntry {
                    hash,
                    deadline,
                    result: receiver.clone(),
                },
            );
            // Own startup independently of the RPC future: disconnecting a
            // caller must not cancel a spawn after its side effects begin.
            let guest = server.clone();
            tokio::spawn(async move {
                let response = if deadline <= super::now_ms() {
                    error_response(
                        String::new(),
                        "request_expired",
                        "execution request expired",
                    )
                } else {
                    start_execution(&guest, request, None).await
                };
                sender.send_replace(Some(response));
            });
            receiver
        };
        drop(entries);
        loop {
            if let Some(response) = result.borrow().clone() {
                return Ok(response);
            }
            result
                .changed()
                .await
                .map_err(|_| Status::internal("execution startup task failed"))?;
        }
    }
}

fn request_deadline(key: &str, now: u64) -> Result<u64, Status> {
    let (token, deadline) = key
        .rsplit_once('.')
        .ok_or_else(|| Status::invalid_argument("missing request deadline"))?;
    if token.is_empty() || key.len() > 256 {
        return Err(Status::invalid_argument("invalid request token"));
    }
    let deadline: u64 = deadline
        .parse()
        .map_err(|_| Status::invalid_argument("invalid request deadline"))?;
    if deadline <= now {
        return Err(Status::failed_precondition("execution request expired"));
    }
    // The control plane supplies a fixed 24-hour deadline. Bound caller input
    // while allowing a minute of control-plane/guest clock skew.
    if deadline - now > 86_460_000 {
        return Err(Status::invalid_argument(
            "request deadline exceeds 24 hours",
        ));
    }
    Ok(deadline)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::GuestLayout;

    #[tokio::test]
    async fn expiry_reclaims_completed_requests_but_rejects_delayed_old_tokens() {
        let server = GuestServer::new(GuestLayout::new());
        let requests = Arc::new(ExecutionRequests::default());
        let now = super::super::now_ms();
        let key = format!("old.{}", now + 1000);
        // Invalid supplied IDs fail before spawn, but still publish a real
        // startup result through the same reservation/retention machinery.
        let payload = ExecRequest {
            execution_id: Some("forbidden".into()),
            ..Default::default()
        };
        let response = requests
            .execute_at(&server, &key, payload.clone(), now)
            .await
            .unwrap();
        assert_eq!(response.error.unwrap().reason, "invalid_argument");
        assert_eq!(requests.entries.lock().await.len(), 1);
        let new_key = format!("new.{}", now + 2000);
        requests
            .execute_at(&server, &new_key, payload.clone(), now + 1000)
            .await
            .unwrap();
        assert!(!requests.entries.lock().await.contains_key(&key));
        let error = requests
            .execute_at(&server, &key, payload, now + 1000)
            .await
            .unwrap_err();
        assert_eq!(error.code(), tonic::Code::FailedPrecondition);
    }

    #[tokio::test]
    async fn expired_pending_reservations_stay_counted_and_capacity_rejects_new_work() {
        let server = GuestServer::new(GuestLayout::new());
        let requests = Arc::new(ExecutionRequests::default());
        let now = super::super::now_ms();
        let (_sender, receiver) = watch::channel(None);
        for index in 0..4096 {
            requests.entries.lock().await.insert(
                index.to_string(),
                RequestEntry {
                    hash: [0; 32],
                    deadline: now - 1,
                    result: receiver.clone(),
                },
            );
        }
        let key = format!("new.{}", now + 1000);
        let error = requests
            .execute_at(&server, &key, ExecRequest::default(), now)
            .await
            .unwrap_err();
        assert_eq!(error.code(), tonic::Code::ResourceExhausted);
        assert_eq!(requests.entries.lock().await.len(), 4096);
    }

    #[test]
    fn deadlines_are_required_bounded_and_exclusive() {
        assert_eq!(request_deadline("token.1001", 1000).unwrap(), 1001);
        for key in [
            "token",
            "token.no",
            ".1001",
            "token.1000",
            "token.999",
            "token.86461001",
        ] {
            assert!(request_deadline(key, 1000).is_err(), "{key}");
        }
    }
}
