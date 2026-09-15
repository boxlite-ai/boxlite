use crate::service::server::GuestServer;
use crate::service::ssh::{SshConfig, SshRuntimeStatus, SshStartError};
use boxlite_shared::{
    Ssh as SshService, SshConfigureRequest, SshConfigureResponse, SshDisableRequest,
    SshDisableResponse, SshStatus, SshStatusRequest, SshStatusResponse,
};
use tonic::{Request, Response, Status};

#[tonic::async_trait]
impl SshService for GuestServer {
    async fn configure(
        &self,
        request: Request<SshConfigureRequest>,
    ) -> Result<Response<SshConfigureResponse>, Status> {
        let init_state = self.init_state.lock().await;
        if !init_state.initialized {
            return Err(Status::failed_precondition(
                "Guest.Init must complete before SSH is configured",
            ));
        }
        drop(init_state);

        let config = SshConfig::from_request(request.into_inner())
            .map_err(|error| Status::invalid_argument(error.to_string()))?;
        let status = self
            .ssh_manager
            .configure(config)
            .await
            .map_err(start_error_status)?;
        Ok(Response::new(SshConfigureResponse {
            status: Some(status.into()),
        }))
    }

    async fn status(
        &self,
        _request: Request<SshStatusRequest>,
    ) -> Result<Response<SshStatusResponse>, Status> {
        Ok(Response::new(SshStatusResponse {
            status: Some(self.ssh_manager.status().await.into()),
        }))
    }

    async fn disable(
        &self,
        _request: Request<SshDisableRequest>,
    ) -> Result<Response<SshDisableResponse>, Status> {
        Ok(Response::new(SshDisableResponse {
            status: Some(
                self.ssh_manager
                    .disable()
                    .await
                    .map_err(|error| Status::internal(error.to_string()))?
                    .into(),
            ),
        }))
    }
}

impl From<SshRuntimeStatus> for SshStatus {
    fn from(status: SshRuntimeStatus) -> Self {
        Self {
            enabled: status.enabled,
            vsock_port: if status.enabled {
                boxlite_shared::constants::network::GUEST_SSH_PORT
            } else {
                0
            },
            generation: status.generation,
            host_key_fingerprint: status.host_key_fingerprint.unwrap_or_default(),
        }
    }
}

fn start_error_status(error: SshStartError) -> Status {
    match error {
        SshStartError::ShuttingDown => Status::failed_precondition(error.to_string()),
        SshStartError::Bind(error) => {
            Status::unavailable(format!("failed to bind SSH listener: {error}"))
        }
        other => Status::internal(other.to_string()),
    }
}
