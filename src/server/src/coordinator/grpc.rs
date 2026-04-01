//! gRPC service implementation for the coordinator.
//!
//! Workers call these RPCs to register and send heartbeats.

use std::sync::Arc;

use chrono::Utc;
use tonic::{Request, Response, Status};

use crate::coordinator::state::CoordinatorState;
use crate::proto::coordinator_service_server::CoordinatorService;
use crate::proto::{
    RegisterWorkerRequest, RegisterWorkerResponse, WorkerHeartbeatRequest, WorkerHeartbeatResponse,
};
use crate::types::{WorkerCapacity, WorkerInfo, WorkerStatus, mint_worker_id, mint_worker_name};

pub struct CoordinatorServiceImpl {
    state: Arc<CoordinatorState>,
}

impl CoordinatorServiceImpl {
    pub fn new(state: Arc<CoordinatorState>) -> Self {
        Self { state }
    }
}

#[tonic::async_trait]
impl CoordinatorService for CoordinatorServiceImpl {
    async fn register_worker(
        &self,
        request: Request<RegisterWorkerRequest>,
    ) -> Result<Response<RegisterWorkerResponse>, Status> {
        let req = request.into_inner();
        let now = Utc::now();

        // Check if a worker with this URL already exists (re-registration after restart)
        let workers = self
            .state
            .store
            .list_workers()
            .await
            .map_err(|e| Status::internal(format!("Failed to list workers: {e}")))?;
        let existing = workers.into_iter().find(|w| w.url == req.url);

        let (worker_id, worker_name, registered_at) = match existing {
            Some(w) => {
                tracing::info!(
                    worker_id = %w.id,
                    name = %w.name,
                    url = %req.url,
                    "Worker re-registering (same URL)"
                );
                (w.id, w.name, w.registered_at)
            }
            None => (mint_worker_id(), mint_worker_name(), now),
        };

        let capacity = req
            .capacity
            .map(|c| WorkerCapacity {
                max_boxes: c.max_boxes,
                available_cpus: c.available_cpus,
                available_memory_mib: c.available_memory_mib,
                running_boxes: c.running_boxes,
            })
            .unwrap_or_default();

        let worker = WorkerInfo {
            id: worker_id.clone(),
            name: worker_name.clone(),
            url: req.url.clone(),
            labels: req.labels,
            registered_at,
            last_heartbeat: now,
            status: WorkerStatus::Active,
            capacity,
        };

        self.state
            .store
            .upsert_worker(&worker)
            .await
            .map_err(|e| Status::internal(format!("Failed to register worker: {e}")))?;

        tracing::info!(
            worker_id = %worker_id,
            name = %worker_name,
            url = %req.url,
            "Worker registered via gRPC"
        );

        Ok(Response::new(RegisterWorkerResponse {
            worker_id,
            name: worker_name,
        }))
    }

    async fn worker_heartbeat(
        &self,
        request: Request<WorkerHeartbeatRequest>,
    ) -> Result<Response<WorkerHeartbeatResponse>, Status> {
        let req = request.into_inner();

        let capacity = req
            .capacity
            .map(|c| WorkerCapacity {
                max_boxes: c.max_boxes,
                available_cpus: c.available_cpus,
                available_memory_mib: c.available_memory_mib,
                running_boxes: c.running_boxes,
            })
            .unwrap_or_default();

        self.state
            .store
            .update_worker_heartbeat(&req.worker_id, &capacity)
            .await
            .map_err(|e| {
                Status::internal(format!(
                    "Failed to update heartbeat for {}: {e}",
                    req.worker_id
                ))
            })?;

        Ok(Response::new(WorkerHeartbeatResponse { accepted: true }))
    }
}
