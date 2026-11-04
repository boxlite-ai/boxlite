use crate::service::server::GuestServer;
use boxlite_shared::{Ssh, SshControlRequest, SshControlResponse};
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
        if !self.init_state.lock().await.initialized {
            return Err(Status::failed_precondition(
                "Guest.Init must complete before SSH is configured",
            ));
        }
        if self.shutting_down.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(Status::failed_precondition("guest is shutting down"));
        }
        let guest = self
            .ssh_manager
            .guest()
            .ok_or_else(|| Status::internal("SSH manager is not attached"))?;
        let status = tokio::spawn(async move {
            guest
                .ssh_manager
                .control(request.enable, request.config)
                .await
        })
        .await
        .map_err(|_| Status::internal("SSH operation failed"))?
        .map_err(|error| *error)?;
        Ok(Response::new(SshControlResponse {
            status: Some(status),
        }))
    }
}
