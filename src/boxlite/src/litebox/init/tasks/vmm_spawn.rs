//! Task: VMM Spawn - Build config and start the boxlite-shim subprocess.
//!
//! Builds VMM InstanceSpec from prepared components, then spawns a new VM
//! subprocess and returns a handler for runtime operations.

use super::guest_entrypoint::GuestEntrypointBuilder;
use super::{InitCtx, log_task_error, task_start};
use crate::disk::DiskFormat;
use crate::images::ContainerImageConfig;
use crate::litebox::init::types::resolve_user_volumes;
use crate::net::NetworkBackendConfig;
use crate::pipeline::PipelineTask;
use crate::rootfs::guest::{GuestRootfs, Strategy};
use crate::runtime::constants::{guest_paths, mount_tags};
use crate::runtime::id::BoxID;
use crate::runtime::layout::BoxFilesystemLayout;
use crate::runtime::options::BoxOptions;
use crate::runtime::rt_impl::SharedRuntimeImpl;
use crate::runtime::types::{ContainerID, PortMappingSource, ResolvedPortMapping};
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
        let (instance_spec, volume_mgr, rootfs_init, container_mounts, port_mappings) =
            build_config(
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
        let handler = spawn_vm(&box_id, &instance_spec, &options, &layout)
            .await
            .inspect_err(|e| log_task_error(&box_id, task_name, e))?;

        let mut ctx = ctx.lock().await;
        ctx.guard.set_handler(handler);
        ctx.volume_mgr = Some(volume_mgr);
        ctx.rootfs_init = Some(rootfs_init);
        ctx.container_mounts = Some(container_mounts);
        // Store CA cert PEM for Container.Init gRPC (passed as CACert proto field)
        ctx.ca_cert_pem = instance_spec
            .network_config
            .as_ref()
            .and_then(|nc| nc.ca_cert_pem.clone());
        // Hand the resolved port mappings to the pipeline so `BoxBuilder::build`
        // can ferry them out to `box_impl`, which persists them on `BoxState`
        // when the box transitions to `Running` — see [crate::runtime::types::
        // ResolvedPortMapping] for why this is post-conflict-resolution data.
        ctx.port_mappings = Some(port_mappings);
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
    Vec<ResolvedPortMapping>,
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
            vol.owner_uid,
            vol.owner_gid,
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

    // Network configuration (also surfaces post-conflict-resolution port
    // mappings so we can persist them on `BoxState` for `inspect`/`list`).
    let (network_config, resolved_port_mappings) =
        build_network_config(container_image_config, options, layout);

    // Assemble VMM instance spec
    let instance_spec = InstanceSpec {
        engine: VmmKind::Libkrun, // only engine — will be dynamic when others are added
        // Box identification and security
        box_id: box_id.to_string(),
        security: options.advanced.security.clone(),
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
        disable_network: matches!(
            options.network,
            crate::runtime::options::NetworkSpec::Disabled
        ),
        home_dir: runtime.layout.home_dir().to_path_buf(),
        // Diagnostic files in box_dir (preserved on crash)
        console_output: Some(layout.console_output_path()),
        exit_file: layout.exit_file_path(),
        detach: options.detach,
    };

    Ok((
        instance_spec,
        volume_mgr,
        rootfs_init,
        container_mounts,
        resolved_port_mappings,
    ))
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

    let executable = format!("{}/boxlite-guest", guest_paths::BIN_DIR);
    let mut builder = GuestEntrypointBuilder::new(executable);
    builder.with_arg("--listen");
    builder.with_arg(&listen_uri);
    builder.with_arg("--notify");
    builder.with_arg(&ready_notify_uri);

    // Debug vars first (prioritized - guaranteed space)
    if let Ok(v) = std::env::var("RUST_LOG") {
        builder.with_env("RUST_LOG", &v);
    }
    if let Ok(v) = std::env::var("RUST_BACKTRACE") {
        builder.with_env("RUST_BACKTRACE", &v);
    }

    // FILO order: image → user (later overrides earlier)
    for (key, value) in &guest_rootfs.env {
        builder.with_env(key, value);
    }
    for (key, value) in &options.env {
        builder.with_env(key, value);
    }

    // Secret placeholder env vars are injected in container_rootfs.rs (single source of truth).
    // The guest init process inherits them from the container environment.

    Ok(builder.build())
}

/// Probe whether `desired_port` is bindable on host; otherwise let the OS
/// allocate an ephemeral host port.
///
/// Used for EXPOSE auto-publish only (never for user-provided `-p`, where
/// the user picked the port deliberately and silently rebinding would
/// violate intent — that path still fails fast via gvproxy `initErr`).
///
/// **Race:** there is a TOCTOU window between the probe `bind`/`close` and
/// gvproxy's later bind. If another process grabs the port in that window
/// gvproxy will fail with EADDRINUSE the same way it did before this
/// helper existed, so the worst case is no regression. Single-shot probe
/// is intentional: chained retries against a busy port range would only
/// widen the race without changing the underlying contention.
fn resolve_expose_host_port(desired_port: u16) -> (u16, PortMappingSource) {
    use std::net::TcpListener;

    // Happy path: desired host port is free → 1:1 EXPOSE mapping.
    if let Ok(listener) = TcpListener::bind(("0.0.0.0", desired_port)) {
        drop(listener);
        return (desired_port, PortMappingSource::AutoExpose);
    }

    // Conflict → ask the OS for an ephemeral host port.
    match TcpListener::bind(("0.0.0.0", 0)) {
        Ok(listener) => {
            let actual = listener
                .local_addr()
                .ok()
                .map(|addr| addr.port())
                .unwrap_or(0);
            drop(listener);
            if actual != 0 {
                tracing::info!(
                    "EXPOSE port {} busy on host; auto-remapped to host:{} (guest still listens on {})",
                    desired_port,
                    actual,
                    desired_port,
                );
                (actual, PortMappingSource::AutoRemap)
            } else {
                // Defensive: getsockname returned 0. Fall back to the
                // desired port and let gvproxy surface the real error.
                (desired_port, PortMappingSource::AutoExpose)
            }
        }
        Err(_) => {
            // OS refused even port 0 (out of ephemeral ports?). Fall back
            // to the desired port and let gvproxy surface the real error.
            (desired_port, PortMappingSource::AutoExpose)
        }
    }
}

/// Build network configuration from container image config and options.
///
/// Also returns the final list of `ResolvedPortMapping`s — one entry per
/// host:guest binding actually programmed into gvproxy — so the caller can
/// persist them on `BoxState` and surface them via `inspect`/`list`.
///
/// `None` for the network config means network is fully disabled
/// (`NetworkSpec::Disabled`); the resolved mappings vector is empty in
/// that case.
fn build_network_config(
    container_image_config: &crate::images::ContainerImageConfig,
    options: &crate::runtime::options::BoxOptions,
    layout: &BoxFilesystemLayout,
) -> (Option<NetworkBackendConfig>, Vec<ResolvedPortMapping>) {
    use crate::runtime::options::PortProtocol;

    let mut port_map: HashMap<u16, u16> = HashMap::new();
    let mut resolved: Vec<ResolvedPortMapping> = Vec::new();

    // Step 1: Collect guest ports that user wants to customize
    let user_guest_ports: HashSet<u16> = options.ports.iter().map(|p| p.guest_port).collect();

    // Step 2: Image EXPOSE ports — auto-publish with conflict fallback.
    //
    // If the desired host port (= guest_port) is already bound on the host,
    // pick an OS-allocated ephemeral instead. The guest still listens on
    // `guest_port` internally — only the host side moves. Reported back to
    // the user via `boxlite inspect`/`list` (source = AutoRemap) and an
    // info log line at remap time.
    for guest_port in container_image_config.tcp_ports() {
        if user_guest_ports.contains(&guest_port) {
            continue;
        }
        let (host_port, source) = resolve_expose_host_port(guest_port);
        port_map.insert(host_port, guest_port);
        resolved.push(ResolvedPortMapping {
            host_port,
            guest_port,
            protocol: PortProtocol::Tcp,
            source,
        });
    }

    // Step 3: User-provided mappings (always applied, never remapped — the
    // user picked the host port deliberately, and gvproxy's `initErr`
    // fast-fail path on collision is the documented contract; see
    // `src/cli/tests/dind_port_conflict.rs`).
    for port in &options.ports {
        let host_port = port.host_port.unwrap_or(port.guest_port);
        port_map.insert(host_port, port.guest_port);
        resolved.push(ResolvedPortMapping {
            host_port,
            guest_port: port.guest_port,
            protocol: port.protocol,
            source: PortMappingSource::User,
        });
    }

    let final_mappings: Vec<(u16, u16)> = port_map.into_iter().collect();

    tracing::info!(
        "Port mappings: {} (image: {}, user: {}, overridden: {}, auto-remapped: {})",
        final_mappings.len(),
        container_image_config.exposed_ports.len(),
        options.ports.len(),
        user_guest_ports
            .intersection(&container_image_config.tcp_ports().into_iter().collect())
            .count(),
        resolved
            .iter()
            .filter(|m| m.source == PortMappingSource::AutoRemap)
            .count(),
    );

    // Extract allow_net from NetworkSpec; Disabled = no network at all
    let allow_net = match &options.network {
        crate::runtime::options::NetworkSpec::Enabled { allow_net } => allow_net.clone(),
        crate::runtime::options::NetworkSpec::Disabled => return (None, Vec::new()),
    };

    let mut config = NetworkBackendConfig::new(final_mappings, layout.net_backend_socket_path());
    config.allow_net = allow_net;
    config.secrets = options.secrets.clone();

    // Generate ephemeral MITM CA when secrets are configured.
    // The CA cert+key flow through NetworkBackendConfig → GvproxyConfig → Go.
    if !options.secrets.is_empty() {
        match crate::net::ca::load_or_generate(&layout.ca_dir()) {
            Ok(ca) => {
                config.ca_cert_pem = Some(ca.cert_pem);
                config.ca_key_pem = Some(ca.key_pem);
            }
            Err(e) => {
                tracing::error!("MITM: CA setup failed, secrets disabled: {e}");
                config.secrets.clear();
            }
        }
    }

    (Some(config), resolved)
}

/// Spawn VM subprocess and return handler.
async fn spawn_vm(
    box_id: &BoxID,
    config: &InstanceSpec,
    options: &BoxOptions,
    layout: &BoxFilesystemLayout,
) -> BoxliteResult<Box<dyn VmmHandler>> {
    let mut controller = ShimController::new(
        find_binary("boxlite-shim")?,
        VmmKind::Libkrun,
        box_id.clone(),
        options.clone(),
        layout.clone(),
    )?;

    controller.start(config).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// Free desired host port: helper returns 1:1 mapping tagged
    /// `AutoExpose`. Picking an OS-allocated ephemeral up-front
    /// guarantees a free port (no flake from another local service
    /// happening to hold a hard-coded one).
    #[test]
    fn resolve_expose_host_port_uses_desired_when_free() {
        let scout = TcpListener::bind(("0.0.0.0", 0)).expect("bind ephemeral");
        let free_port = scout.local_addr().unwrap().port();
        drop(scout); // release so the helper can re-bind

        let (host_port, source) = resolve_expose_host_port(free_port);
        assert_eq!(host_port, free_port);
        assert_eq!(source, PortMappingSource::AutoExpose);
    }

    /// Desired host port already bound: helper must NOT fail; it must
    /// pick a different (ephemeral) host port and tag it `AutoRemap`.
    /// This is the regression guard for the auto-remap fix — without
    /// the fallback, `boxlite run` (no explicit `-p`) would die with
    /// `gvproxy_create failed` whenever an EXPOSE host port collided.
    #[test]
    fn resolve_expose_host_port_falls_back_when_busy() {
        let holder = TcpListener::bind(("0.0.0.0", 0)).expect("bind ephemeral");
        let busy_port = holder.local_addr().unwrap().port();

        let (host_port, source) = resolve_expose_host_port(busy_port);

        assert_ne!(
            host_port, busy_port,
            "must remap away from busy port {}",
            busy_port,
        );
        assert_eq!(source, PortMappingSource::AutoRemap);

        // Ephemeral port should actually be bindable now (close the
        // listener and try) — the helper releases its probe socket
        // before returning. We bind to make sure the returned port
        // isn't some sentinel from the defensive fallback path.
        let probe = TcpListener::bind(("0.0.0.0", host_port));
        assert!(
            probe.is_ok(),
            "returned host_port {} must be bindable",
            host_port,
        );
        drop(holder);
    }
}
