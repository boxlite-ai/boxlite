//! Guest service implementation.
//!
//! Handles guest initialization and management (Init, Ping, Shutdown RPCs).

use crate::service::server::GuestServer;
use boxlite_shared::{
    guest_init_response, Guest as GuestService, GuestInitError, GuestInitRequest,
    GuestInitResponse, GuestInitSuccess, PingRequest, PingResponse, ShutdownRequest,
    ShutdownResponse,
};
use tonic::{Request, Response, Status};
use tracing::{debug, error, info};

#[tonic::async_trait]
impl GuestService for GuestServer {
    /// Initialize guest environment.
    ///
    /// This must be called first after connection. It:
    /// 1. Mounts all volumes (virtiofs + block devices)
    /// 2. Configures network (if specified)
    ///
    /// Note: Rootfs setup is handled by Container.Init.
    async fn init(
        &self,
        request: Request<GuestInitRequest>,
    ) -> Result<Response<GuestInitResponse>, Status> {
        let req = request.into_inner();
        info!("Received guest init request");

        // Check if already initialized
        let mut init_state = self.init_state.lock().await;
        if init_state.initialized {
            error!("Guest already initialized (Init can only be called once)");
            return Ok(Response::new(GuestInitResponse {
                result: Some(guest_init_response::Result::Error(GuestInitError {
                    reason: "Guest already initialized (Init can only be called once)".to_string(),
                })),
            }));
        }

        // Step 1: Mount all volumes (virtiofs + block devices)
        // Empty mount_point = guest determines path from tag
        info!("Mounting {} volumes", req.volumes.len());
        if let Err(e) = crate::storage::mount_volumes(&req.volumes) {
            error!("Failed to mount volumes: {}", e);
            return Ok(Response::new(GuestInitResponse {
                result: Some(guest_init_response::Result::Error(GuestInitError {
                    reason: format!("Failed to mount volumes: {}", e),
                })),
            }));
        }

        // Step 2: Configure network (if specified)
        if let Some(network) = req.network {
            info!("Configuring network interface: {}", network.interface);
            if let Err(e) = crate::network::configure_network_from_config(
                &network.interface,
                network.ip.as_deref(),
                network.gateway.as_deref(),
            )
            .await
            {
                error!("Failed to configure network: {}", e);
                return Ok(Response::new(GuestInitResponse {
                    result: Some(guest_init_response::Result::Error(GuestInitError {
                        reason: format!("Failed to configure network: {}", e),
                    })),
                }));
            }
        }

        // Mark as initialized
        init_state.initialized = true;

        info!("✅ Guest initialized successfully");
        Ok(Response::new(GuestInitResponse {
            result: Some(guest_init_response::Result::Success(GuestInitSuccess {})),
        }))
    }

    async fn ping(&self, _request: Request<PingRequest>) -> Result<Response<PingResponse>, Status> {
        debug!("Received ping request");
        Ok(Response::new(PingResponse {
            version: env!("CARGO_PKG_VERSION").to_string(),
        }))
    }

    async fn shutdown(
        &self,
        _request: Request<ShutdownRequest>,
    ) -> Result<Response<ShutdownResponse>, Status> {
        info!("Received shutdown request - graceful shutdown starting");

        // Step 1: Gracefully shutdown all running executions
        const EXEC_SHUTDOWN_TIMEOUT_MS: u64 = 1000;
        info!("Stopping running executions...");
        self.registry.shutdown_all(EXEC_SHUTDOWN_TIMEOUT_MS).await;

        // Step 2: Gracefully shutdown all containers
        const CONTAINER_SHUTDOWN_TIMEOUT_MS: u64 = 2000;
        info!("Stopping containers...");
        let containers = self.containers.lock().await;
        for (container_id, container_arc) in containers.iter() {
            info!(container_id = %container_id, "Shutting down container");
            let container = container_arc.lock().await;
            if let Err(e) = container.shutdown(CONTAINER_SHUTDOWN_TIMEOUT_MS) {
                error!(container_id = %container_id, error = %e, "Failed to shutdown container");
            }
        }
        drop(containers);

        // Step 3: Sync all filesystems to ensure data is flushed to disk.
        // This is critical for COW disks to be in consistent state on restart.
        info!("Syncing filesystems...");
        unsafe {
            nix::libc::sync();
        }

        info!("Graceful shutdown complete");
        Ok(Response::new(ShutdownResponse {}))
    }
}
