use crate::service::server::GuestServer;
use boxlite_shared::{
    Ssh, SshConfigureRequest, SshConfigureResponse, SshDisableRequest, SshDisableResponse,
    SshStatusRequest, SshStatusResponse,
};
use tonic::{Request, Response, Status};

#[tonic::async_trait]
impl Ssh for GuestServer {
    async fn configure(
        &self,
        request: Request<SshConfigureRequest>,
    ) -> Result<Response<SshConfigureResponse>, Status> {
        if !self.init_state.lock().await.initialized {
            return Err(Status::failed_precondition(
                "Guest.Init must complete before SSH is configured",
            ));
        }
        let config = request
            .into_inner()
            .config
            .ok_or_else(|| Status::invalid_argument("SSH config is required"))?;
        Ok(Response::new(SshConfigureResponse {
            status: Some(
                self.ssh_manager
                    .configure(config)
                    .await
                    .map_err(|error| *error)?,
            ),
        }))
    }
    async fn status(
        &self,
        _: Request<SshStatusRequest>,
    ) -> Result<Response<SshStatusResponse>, Status> {
        Ok(Response::new(SshStatusResponse {
            status: Some(self.ssh_manager.status().await),
        }))
    }
    async fn disable(
        &self,
        _: Request<SshDisableRequest>,
    ) -> Result<Response<SshDisableResponse>, Status> {
        Ok(Response::new(SshDisableResponse {
            status: Some(self.ssh_manager.disable().await.map_err(|error| *error)?),
        }))
    }
}
