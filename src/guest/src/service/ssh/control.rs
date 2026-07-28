use crate::service::server::GuestServer;
use crate::service::ssh::{SshConfig, SshRuntimeStatus, SshStartError};
use boxlite_shared::{
    Ssh as SshService, SshConfigureRequest, SshConfigureResponse, SshDisableRequest,
    SshDisableResponse, SshStatus, SshStatusRequest, SshStatusResponse,
};
use std::net::SocketAddr;
use tonic::{Request, Response, Status};

#[tonic::async_trait]
impl SshService for GuestServer {
    async fn configure(
        &self,
        request: Request<SshConfigureRequest>,
    ) -> Result<Response<SshConfigureResponse>, Status> {
        if !self.init_state.lock().await.initialized {
            return Err(Status::failed_precondition(
                "Guest.Init must complete before SSH is configured",
            ));
        }

        let request = request.into_inner();
        let listen_addr: SocketAddr = request.listen_address.parse().map_err(|error| {
            Status::invalid_argument(format!("invalid SSH listen address: {error}"))
        })?;
        let config = SshConfig::new(listen_addr, request.ca_public_key, request.principal)
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
            status: Some(self.ssh_manager.disable().await.into()),
        }))
    }
}

impl From<SshRuntimeStatus> for SshStatus {
    fn from(status: SshRuntimeStatus) -> Self {
        Self {
            enabled: status.enabled,
            listen_address: status
                .listen_addr
                .map(|address| address.to_string())
                .unwrap_or_default(),
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
