//! Task: VMM Spawn - Build config and start the boxlite-shim subprocess.
//!
//! Builds VMM InstanceSpec from prepared components, then spawns a new VM
//! subprocess and returns a handler for runtime operations.

use super::{InitCtx, log_task_error, task_start};
use crate::disk::DiskFormat;
use crate::images::ContainerImageConfig;
use crate::litebox::init::types::resolve_user_volumes;
use crate::net::NetworkBackendConfig;
use crate::pipeline::PipelineTask;
use crate::runtime::constants::{guest_paths, mount_tags};
use crate::runtime::guest_rootfs::{GuestRootfs, Strategy};
use crate::runtime::layout::BoxFilesystemLayout;
use crate::runtime::options::BoxOptions;
use crate::runtime::rt_impl::SharedRuntimeImpl;
use crate::runtime::types::{BoxID, ContainerID};
use crate::util::find_binary;
use crate::vmm::controller::{ShimController, VmmController, VmmHandler};
use crate::vmm::{Entrypoint, InstanceSpec, VmmKind};
use crate::volumes::{ContainerMount, ContainerVolumeManager, GuestVolumeManager};
use async_trait::async_trait;
use boxlite_shared::Transport;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::collections::{HashMap, HashSet};
use std::path::Path;

pub struct VmmSpawnTask;

#[async_trait]
impl PipelineTask<InitCtx> for VmmSpawnTask {
    async fn run(self: Box<Self>, ctx: InitCtx) -> BoxliteResult<()> {
        let task_name = self.name();
        let box_id = task_start(&ctx, task_name).await;

        // Gather all inputs from previous tasks
        let (
            options,
            layout,
            container_image_config,
            container_disk_path,
            guest_disk_path,
            container_id,
            runtime,
            reuse_rootfs,
        ) = {
            let ctx = ctx.lock().await;
            let layout = ctx
                .layout
                .clone()
                .ok_or_else(|| BoxliteError::Internal("filesystem task must run first".into()))?;
            let container_image_config = ctx
                .container_image_config
                .clone()
                .ok_or_else(|| BoxliteError::Internal("rootfs task must run first".into()))?;
            let container_disk_path = ctx
                .container_disk
                .as_ref()
                .ok_or_else(|| BoxliteError::Internal("rootfs task must run first".into()))?
                .path()
                .to_path_buf();
            let guest_disk_path = ctx.guest_disk.as_ref().map(|d| d.path().to_path_buf());
            (
                ctx.config.options.clone(),
                layout,
                container_image_config,
                container_disk_path,
                guest_disk_path,
                ctx.config.container.id.clone(),
                ctx.runtime.clone(),
                ctx.reuse_rootfs,
            )
        };

        // Build config and get outputs
        let (instance_spec, volume_mgr, rootfs_init, container_mounts) = build_config(
            &box_id,
            &options,
            &layout,
            &container_image_config,
            &container_disk_path,
            guest_disk_path.as_deref(),
            &container_id,
            &runtime,
            reuse_rootfs,
        )
        .await
        .inspect_err(|e| log_task_error(&box_id, task_name, e))?;

        // Spawn VM
        let handler = spawn_vm(&box_id, &instance_spec, &options)
            .await
            .inspect_err(|e| log_task_error(&box_id, task_name, e))?;

        let mut ctx = ctx.lock().await;
        ctx.guard.set_handler(handler);
        ctx.volume_mgr = Some(volume_mgr);
        ctx.rootfs_init = Some(rootfs_init);
        ctx.container_mounts = Some(container_mounts);
        Ok(())
    }

    fn name(&self) -> &str {
        "vmm_spawn"
    }
}

/// Build VMM config from prepared rootfs outputs.
#[allow(clippy::too_many_arguments)]
async fn build_config(
    box_id: &BoxID,
    options: &BoxOptions,
    layout: &BoxFilesystemLayout,
    container_image_config: &ContainerImageConfig,
    container_disk_path: &Path,
    guest_disk_path: Option<&Path>,
    container_id: &ContainerID,
    runtime: &SharedRuntimeImpl,
    reuse_rootfs: bool,
) -> BoxliteResult<(
    InstanceSpec,
    GuestVolumeManager,
    crate::portal::interfaces::ContainerRootfsInitConfig,
    Vec<ContainerMount>,
)> {
    // Transport setup
    let transport = Transport::unix(layout.socket_path());
    let ready_transport = Transport::unix(layout.ready_socket_path());

    let user_volumes = resolve_user_volumes(&options.volumes)?;

    // Prepare container directories (image/, rw/, rootfs/)
    let container_layout = layout.shared_layout().container(container_id.as_str());
    container_layout.prepare()?;

    // Create GuestVolumeManager and configure volumes
    let mut volume_mgr = GuestVolumeManager::new();

    // SHARED virtiofs - needed by all strategies
    volume_mgr.add_fs_share(mount_tags::SHARED, layout.shared_dir(), None, false, None);

    // Add container rootfs disk (COW overlay workflow):
    // 1. Base disk: Pre-built ext4 image with container layers merged
    // 2. COW disk: QCOW2 overlay with copy-on-write semantics
    //    - Inherits formatted ext4 from base (need_format=false)
    //    - May have larger virtual size if disk_size_gb specified
    // 3. Guest mount: Only resize on fresh start, not restart
    //    - Fresh start with custom size: resize2fs expands filesystem
    //    - Restart: filesystem already at correct size, skip resize
    let need_resize = options.disk_size_gb.is_some() && !reuse_rootfs;
    let rootfs_device = volume_mgr.add_block_device(
        container_disk_path,
        DiskFormat::Qcow2,
        false,
        None,
        false,       // need_format: COW child inherits formatted base
        need_resize, // need_resize: only on fresh start with custom disk size
    );

    // Update rootfs_init with actual device path and resize flag
    let rootfs_init = crate::portal::interfaces::ContainerRootfsInitConfig::DiskImage {
        device: rootfs_device,
        need_format: false, // COW child uses pre-formatted base
        need_resize,        // Only on fresh start with custom disk size
    };

    // Add user volumes via ContainerVolumeManager
    let mut container_mgr = ContainerVolumeManager::new(&mut volume_mgr);
    for vol in &user_volumes {
        container_mgr.add_volume(
            container_id.as_str(),
            &vol.tag,
            &vol.tag,
            vol.host_path.clone(),
            &vol.guest_path,
            vol.read_only,
        );
    }
    let container_mounts = container_mgr.build_container_mounts();

    // Get guest rootfs from runtime cache and configure with disk
    let guest_rootfs = runtime
        .guest_rootfs
        .get()
        .ok_or_else(|| BoxliteError::Internal("guest_rootfs not initialized".into()))?
        .clone();

    let guest_rootfs = configure_guest_rootfs(guest_rootfs, guest_disk_path, &mut volume_mgr)?;

    // Build VMM config from volume manager
    let vmm_config = volume_mgr.build_vmm_config();

    // Guest entrypoint
    let guest_entrypoint =
        build_guest_entrypoint(&transport, &ready_transport, &guest_rootfs, options)?;

    // Network configuration
    let network_config = build_network_config(container_image_config, options);

    // Use runtime home for logs (not box_home)
    let runtime_home = runtime.layout.home_dir();
    let logs_dir = runtime.layout.logs_dir();

    // Assemble VMM instance spec
    let instance_spec = InstanceSpec {
        // Box identification and security
        box_id: box_id.to_string(),
        security: options.security.clone(),
        // VM resources
        cpus: options.cpus,
        memory_mib: options.memory_mib,
        // Filesystem and devices
        fs_shares: vmm_config.fs_shares,
        block_devices: vmm_config.block_devices,
        guest_entrypoint,
        transport: transport.clone(),
        ready_transport: ready_transport.clone(),
        guest_rootfs,
        network_config,
        network_backend_endpoint: None,
        home_dir: runtime_home.to_path_buf(),
        console_output: Some(logs_dir.join(format!("{}-console.log", box_id))),
        detach: options.detach,
        parent_pid: std::process::id(),
    };

    Ok((instance_spec, volume_mgr, rootfs_init, container_mounts))
}

/// Configure guest rootfs with device path from volume manager.
fn configure_guest_rootfs(
    mut guest_rootfs: GuestRootfs,
    guest_disk_path: Option<&Path>,
    volume_mgr: &mut GuestVolumeManager,
) -> BoxliteResult<GuestRootfs> {
    if let Some(disk_path_input) = guest_disk_path
        && let Strategy::Disk { ref disk_path, .. } = guest_rootfs.strategy
    {
        // Add disk to volume manager (guest rootfs - no format/resize needed)
        let device_path = volume_mgr.add_block_device(
            disk_path_input,
            DiskFormat::Qcow2,
            false,
            None,
            false, // need_format
            false, // need_resize
        );

        // Update strategy with device path
        guest_rootfs.strategy = Strategy::Disk {
            disk_path: disk_path.clone(),
            device_path: Some(device_path),
        };
    }

    Ok(guest_rootfs)
}

fn build_guest_entrypoint(
    transport: &Transport,
    ready_transport: &Transport,
    guest_rootfs: &GuestRootfs,
    options: &crate::runtime::options::BoxOptions,
) -> BoxliteResult<Entrypoint> {
    let listen_uri = transport.to_uri();
    let ready_notify_uri = ready_transport.to_uri();

    // Start with guest rootfs env
    let mut env: Vec<(String, String)> = guest_rootfs.env.clone();

    // Override with user env vars
    for (key, value) in &options.env {
        env.retain(|(k, _)| k != key);
        env.push((key.clone(), value.clone()));
    }

    // Inject RUST_LOG from host for debugging
    if !env.iter().any(|(k, _)| k == "RUST_LOG")
        && let Ok(rust_log) = std::env::var("RUST_LOG")
        && !rust_log.is_empty()
    {
        env.push(("RUST_LOG".to_string(), rust_log));
    }

    // Inject RUST_BACKTRACE from host for debugging
    if !env.iter().any(|(k, _)| k == "RUST_BACKTRACE")
        && let Ok(rust_backtrace) = std::env::var("RUST_BACKTRACE")
        && !rust_backtrace.is_empty()
    {
        env.push(("RUST_BACKTRACE".to_string(), rust_backtrace));
    }

    Ok(Entrypoint {
        executable: format!("{}/boxlite-guest", guest_paths::BIN_DIR),
        args: vec![
            "--listen".to_string(),
            listen_uri,
            "--notify".to_string(),
            ready_notify_uri,
        ],
        env,
    })
}

/// Build network configuration from container image config and options.
fn build_network_config(
    container_image_config: &crate::images::ContainerImageConfig,
    options: &crate::runtime::options::BoxOptions,
) -> Option<NetworkBackendConfig> {
    let mut port_map: HashMap<u16, u16> = HashMap::new();

    // Step 1: Collect guest ports that user wants to customize
    let user_guest_ports: HashSet<u16> = options.ports.iter().map(|p| p.guest_port).collect();

    // Step 2: Image exposed ports (only add default 1:1 mapping if user didn't override)
    for port in container_image_config.tcp_ports() {
        if !user_guest_ports.contains(&port) {
            port_map.insert(port, port);
        }
    }

    // Step 3: User-provided mappings (always applied)
    for port in &options.ports {
        let host_port = port.host_port.unwrap_or(port.guest_port);
        port_map.insert(host_port, port.guest_port);
    }

    let final_mappings: Vec<(u16, u16)> = port_map.into_iter().collect();

    tracing::info!(
        "Port mappings: {} (image: {}, user: {}, overridden: {})",
        final_mappings.len(),
        container_image_config.exposed_ports.len(),
        options.ports.len(),
        user_guest_ports
            .intersection(&container_image_config.tcp_ports().into_iter().collect())
            .count()
    );

    // Always return Some - gvproxy provides virtio-net (eth0) even without port mappings
    Some(NetworkBackendConfig::new(final_mappings))
}

/// Spawn VM subprocess and return handler.
async fn spawn_vm(
    box_id: &BoxID,
    config: &InstanceSpec,
    options: &BoxOptions,
) -> BoxliteResult<Box<dyn VmmHandler>> {
    let mut controller = ShimController::new(
        find_binary("boxlite-shim")?,
        VmmKind::Libkrun,
        box_id.clone(),
        options.clone(),
    )?;

    controller.start(config).await
}
