use super::SshUpdate;
use crate::service::server::GuestServer;
use boxlite_shared::{Ssh, SshControlRequest, SshControlResponse, SshSetupRequest};
use tonic::{Request, Response, Status};

#[tonic::async_trait]
impl Ssh for GuestServer {
    async fn control(
        &self,
        request: Request<SshControlRequest>,
    ) -> Result<Response<SshControlResponse>, Status> {
        let request = request.into_inner();
        if request.enable.is_none() && request.config.is_none() {
            return Ok(Response::new(SshControlResponse {
                status: Some(self.ssh_manager.status().await),
            }));
        }
        self.update_ssh(SshUpdate::Control(request))
            .await
            .map_err(|error| *error)
    }

    async fn setup(
        &self,
        request: Request<SshSetupRequest>,
    ) -> Result<Response<SshControlResponse>, Status> {
        self.update_ssh(SshUpdate::Setup(request.into_inner().client_public_key))
            .await
            .map_err(|error| *error)
    }
}

impl GuestServer {
    /// Mutations finish under the manager's lock even if their RPC is cancelled.
    async fn update_ssh(
        &self,
        update: SshUpdate,
    ) -> Result<Response<SshControlResponse>, Box<Status>> {
        if !self.init_state.lock().await.initialized {
            return Err(Status::failed_precondition(
                "Guest.Init must complete before SSH is configured",
            )
            .into());
        }
        if self.shutting_down.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(Status::failed_precondition("guest is shutting down").into());
        }
        let guest = self
            .ssh_manager
            .guest()
            .ok_or_else(|| Status::internal("SSH manager is not attached"))?;
        let status = tokio::spawn(async move { guest.ssh_manager.control(update).await })
            .await
            .map_err(|_| Status::internal("SSH operation failed"))??;
        Ok(Response::new(SshControlResponse {
            status: Some(status),
        }))
    }
}
