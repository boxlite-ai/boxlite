//! Task: Guest initialization.
//!
//! Sends init configuration to the guest and *creates* the container. Running
//! its init is a separate, host-driven step (`Container.Start`), so a client can
//! attach to the created-but-not-started session first and miss none of its
//! output. Builds guest volumes from the volume manager, uses rootfs config from
//! the vmm_config stage.

use super::{InitCtx, log_task_error, task_start};
use crate::images::ContainerImageConfig;
use crate::net::constants::{GATEWAY_IP, GUEST_CIDR, GUEST_INTERFACE};
use crate::pipeline::PipelineTask;
use crate::portal::GuestSession;
use crate::portal::interfaces::{ContainerRootfsInitConfig, GuestInitConfig, NetworkInitConfig};
use crate::runtime::options::NetworkSpec;
use crate::runtime::types::ContainerID;
use crate::volumes::{ContainerMount, GuestVolumeManager};
use async_trait::async_trait;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

pub struct GuestInitTask;

#[async_trait]
impl PipelineTask<InitCtx> for GuestInitTask {
    async fn run(self: Box<Self>, ctx: InitCtx) -> BoxliteResult<()> {
        let task_name = self.name();
        let box_id = task_start(&ctx, task_name).await;

        let (
            guest_session,
            container_image_config,
            container_id,
            volume_mgr,
            rootfs_init,
            container_mounts,
            log_capture_path,
            network_spec,
            ca_cert_pem,
            tty,
        ) =
            {
                let mut ctx = ctx.lock().await;
                let guest_session = ctx
                    .guest_session
                    .take()
                    .ok_or_else(|| BoxliteError::Internal("connect task must run first".into()))?;
                let container_image_config = ctx
                    .container_image_config
                    .clone()
                    .ok_or_else(|| BoxliteError::Internal("rootfs task must run first".into()))?;
                let volume_mgr = ctx.volume_mgr.take().ok_or_else(|| {
                    BoxliteError::Internal("vmm_spawn task must run first".into())
                })?;
                let rootfs_init = ctx.rootfs_init.take().ok_or_else(|| {
                    BoxliteError::Internal("vmm_spawn task must run first".into())
                })?;
                let container_mounts = ctx.container_mounts.take().ok_or_else(|| {
                    BoxliteError::Internal("vmm_spawn task must run first".into())
                })?;
                let network_spec = ctx.config.options.network.clone();
                let log_capture_path = ctx.log_capture_path.clone();
                let ca_cert_pem = ctx.ca_cert_pem.clone();
                let tty = ctx.config.options.tty;
                (
                    guest_session,
                    container_image_config,
                    ctx.config.container.id.clone(),
                    volume_mgr,
                    rootfs_init,
                    container_mounts,
                    log_capture_path,
                    network_spec,
                    ca_cert_pem,
                    tty,
                )
            };

        run_guest_init(
            guest_session.clone(),
            &container_image_config,
            &container_id,
            &volume_mgr,
            &rootfs_init,
            &container_mounts,
            log_capture_path,
            &network_spec,
            ca_cert_pem.as_deref(),
            tty,
        )
        .await
        .inspect_err(|e| log_task_error(&box_id, task_name, e))?;

        let mut ctx = ctx.lock().await;
        ctx.guest_session = Some(guest_session);
        ctx.volume_mgr = Some(volume_mgr);
        ctx.rootfs_init = Some(rootfs_init);
        ctx.container_mounts = Some(container_mounts);

        Ok(())
    }

    fn name(&self) -> &str {
        "guest_init"
    }
}

/// Initialize the guest and create the container (init is *not* run here).
#[allow(clippy::too_many_arguments)]
async fn run_guest_init(
    guest_session: GuestSession,
    container_image_config: &ContainerImageConfig,
    container_id: &ContainerID,
    volume_mgr: &GuestVolumeManager,
    rootfs_init: &ContainerRootfsInitConfig,
    container_mounts: &[ContainerMount],
    log_capture_path: Option<String>,
    network_spec: &NetworkSpec,
    ca_cert_pem: Option<&str>,
    tty: bool,
) -> BoxliteResult<()> {
    let container_id_str = container_id.as_str();

    // Build guest volumes from volume manager
    let guest_volumes = volume_mgr.build_guest_mounts();

    let network = match network_spec {
        NetworkSpec::Enabled { .. } => Some(NetworkInitConfig {
            interface: GUEST_INTERFACE.to_string(),
            ip: Some(GUEST_CIDR.to_string()),
            gateway: Some(GATEWAY_IP.to_string()),
        }),
        NetworkSpec::Disabled => None,
    };

    let guest_init_config = GuestInitConfig {
        volumes: guest_volumes,
        network,
    };

    // Step 1: Guest Init (volumes + network)
    tracing::info!("Sending guest initialization request");
    let mut guest_interface = guest_session.guest().await?;
    guest_interface.init(guest_init_config).await?;
    tracing::info!("Guest initialized successfully");

    // Step 2: create the container (rootfs + image config + user mounts). This
    // does NOT run init — Container.Init only creates.
    tracing::info!("Sending container configuration to guest");
    let mut container_interface = guest_session.container().await?;
    let ca_certs: Vec<String> = ca_cert_pem.into_iter().map(|s| s.to_string()).collect();
    let returned_id = container_interface
        .init(
            container_id_str,
            container_image_config.clone(),
            rootfs_init.clone(),
            container_mounts.to_vec(),
            ca_certs,
            tty,
            log_capture_path,
        )
        .await?;
    tracing::info!(container_id = %returned_id, "Container created");

    // Running init is deliberately *not* done here. The container is created and
    // left standing at the gate; the host runs it with `Container.Start` after a
    // client has attached, so nothing it prints can be missed however fast it is.

    Ok(())
}
