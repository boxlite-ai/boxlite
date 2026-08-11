//! Task: Guest initialization.
//!
//! Sends init configuration to the guest and *creates* the container. Running
//! its init is a separate, host-driven step (`Container.Start`), so a client can
//! attach to the created-but-not-started session first and miss none of its
//! output. Builds guest volumes from the volume manager, uses rootfs config from
//! the vmm_config stage.

use super::{InitCtx, log_task_error, task_start};
use crate::net::constants::{GATEWAY_IP, GUEST_CIDR, GUEST_INTERFACE};
use crate::pipeline::PipelineTask;
use crate::portal::GuestSession;
use crate::portal::interfaces::container::ContainerAdvancedConfig;
use crate::portal::interfaces::{ContainerInitConfig, GuestInitConfig, NetworkInitConfig};
use crate::runtime::advanced_options::ContainerCapabilities;
use async_trait::async_trait;
use boxlite_shared::ContainerDevice;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

/// Oldest guest release that honors `advanced.capabilities` on
/// `Container.Init`. An earlier guest drops the field and starts the container
/// with the default capability set while the caller believes a policy applied.
/// Guest rootfs images are cached per version and reused, so a host can meet
/// one long after its own release.
const MIN_CAPABILITY_GUEST_VERSION: crate::portal::interfaces::guest::GuestVersion = (0, 9, 8);

/// Oldest guest release that honors `devices` on `Container.Init`. Same trap as
/// capabilities above: an earlier guest drops the field and starts the workload
/// with no `/dev/kvm` while the caller believes nesting was granted.
const MIN_DEVICE_GUEST_VERSION: crate::portal::interfaces::guest::GuestVersion = (0, 9, 8);

pub struct GuestInitTask;

struct GuestBootstrapConfig {
    guest: GuestInitConfig,
    container: ContainerInitConfig,
}

#[async_trait]
impl PipelineTask<InitCtx> for GuestInitTask {
    async fn run(self: Box<Self>, ctx: InitCtx) -> BoxliteResult<()> {
        let task_name = self.name();
        let box_id = task_start(&ctx, task_name).await;

        let (guest_session, volume_mgr, rootfs_init, container_mounts, bootstrap) = {
            let mut ctx = ctx.lock().await;
            let guest_session = ctx
                .guest_session
                .take()
                .ok_or_else(|| BoxliteError::Internal("connect task must run first".into()))?;
            let image = ctx
                .container_image_config
                .clone()
                .ok_or_else(|| BoxliteError::Internal("rootfs task must run first".into()))?;
            let volume_mgr = ctx
                .volume_mgr
                .take()
                .ok_or_else(|| BoxliteError::Internal("vmm_spawn task must run first".into()))?;
            let rootfs_init = ctx
                .rootfs_init
                .take()
                .ok_or_else(|| BoxliteError::Internal("vmm_spawn task must run first".into()))?;
            let container_mounts = ctx
                .container_mounts
                .take()
                .ok_or_else(|| BoxliteError::Internal("vmm_spawn task must run first".into()))?;

            let network = match &ctx.config.options.network {
                crate::runtime::options::NetworkSpec::Enabled { .. } => Some(NetworkInitConfig {
                    interface: GUEST_INTERFACE.to_string(),
                    ip: Some(GUEST_CIDR.to_string()),
                    gateway: Some(GATEWAY_IP.to_string()),
                }),
                crate::runtime::options::NetworkSpec::Disabled => None,
            };
            let devices = requested_devices(&ctx.config.options);
            let capabilities = requested_capabilities(
                &ctx.config.options.advanced.capabilities,
                ctx.config.options.advanced.fuse,
            );
            let bootstrap = GuestBootstrapConfig {
                guest: GuestInitConfig {
                    volumes: volume_mgr.build_guest_mounts(),
                    network,
                },
                container: ContainerInitConfig {
                    container_id: ctx.config.container.id.as_str().to_owned(),
                    image,
                    rootfs: rootfs_init.clone(),
                    mounts: container_mounts.clone(),
                    ca_certs: ctx.ca_cert_pem.iter().cloned().collect(),
                    tty: ctx.config.options.tty,
                    devices,
                    advanced: ContainerAdvancedConfig { capabilities },
                },
            };

            (
                guest_session,
                volume_mgr,
                rootfs_init,
                container_mounts,
                bootstrap,
            )
        };

        run_guest_init(guest_session.clone(), bootstrap)
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
async fn run_guest_init(
    guest_session: GuestSession,
    bootstrap: GuestBootstrapConfig,
) -> BoxliteResult<()> {
    // Step 1: Guest Init (volumes + network)
    tracing::info!("Sending guest initialization request");
    let mut guest_interface = guest_session.guest().await?;
    if !bootstrap.container.advanced.capabilities.is_empty() {
        guest_interface
            .require_min_version(MIN_CAPABILITY_GUEST_VERSION)
            .await?;
    }
    if !bootstrap.container.devices.is_empty() {
        guest_interface
            .require_min_version(MIN_DEVICE_GUEST_VERSION)
            .await?;
    }
    guest_interface.init(bootstrap.guest).await?;
    tracing::info!("Guest initialized successfully");

    // Step 2: create the container (rootfs + image config + user mounts). This
    // does NOT run init — Container.Init only creates.
    tracing::info!("Sending container configuration to guest");
    let mut container_interface = guest_session.container().await?;
    let returned_id = container_interface.init(bootstrap.container).await?;
    tracing::info!(container_id = %returned_id, "Container created");

    // Running init is deliberately *not* done here. The container is created and
    // left standing at the gate; the host runs it with `Container.Start` after a
    // client has attached, so nothing it prints can be missed however fast it is.

    Ok(())
}

/// The guest VM's own `/dev/kvm`, republished into the OCI workload so a nested
/// hypervisor can open it. The host's `/dev/kvm` is never passed through.
fn kvm_device() -> ContainerDevice {
    ContainerDevice {
        source: "/dev/kvm".to_string(),
        destination: "/dev/kvm".to_string(),
        file_mode: Some(0o666),
    }
}

/// The guest VM's FUSE character device, republished into the OCI workload so
/// a process such as `mount-s3` can create a userspace filesystem.
fn fuse_device() -> ContainerDevice {
    ContainerDevice {
        source: "/dev/fuse".to_string(),
        destination: "/dev/fuse".to_string(),
        file_mode: Some(0o666),
    }
}

fn requested_devices(options: &crate::runtime::options::BoxOptions) -> Vec<ContainerDevice> {
    let mut devices = Vec::new();
    if options.advanced.nested_virtualization {
        devices.push(kvm_device());
    }
    if options.advanced.fuse {
        devices.push(fuse_device());
    }
    devices
}

fn requested_capabilities(
    capabilities: &ContainerCapabilities,
    fuse: bool,
) -> ContainerCapabilities {
    let mut capabilities = capabilities.clone();
    if fuse
        && !capabilities.add.iter().any(|capability| {
            capability.eq_ignore_ascii_case("SYS_ADMIN")
                || capability.eq_ignore_ascii_case("CAP_SYS_ADMIN")
        })
    {
        capabilities.add.push("SYS_ADMIN".to_string());
    }
    capabilities
}
