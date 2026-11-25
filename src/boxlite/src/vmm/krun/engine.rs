//! Krun - VMM implementation using libkrun.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::context::KrunContext;
use crate::disk::Qcow2Helper;
use crate::experimental::custom_kernel::KernelFormat;
use crate::runtime::constants::network;
use crate::runtime::constants::vm_defaults::{DEFAULT_CPUS, DEFAULT_MEMORY_MIB};
#[cfg(unix)]
#[allow(dead_code)]
use crate::vmm::vmm_socket::{ControlError, ControlOp, ControlReply, ControlResponse};
use crate::vmm::{InstanceSpec, Vmm, VmmConfig, VmmInstance, engine::VmmInstanceImpl};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

/// Libkrun-specific VMM instance implementation.
#[allow(dead_code)]
struct KrunVmmInstance {
    context: Arc<KrunContext>,
    probe: Box<dyn crate::system_check::HypervisorProbe>,
    vmm_socket_path: PathBuf,
    box_tmp_dir: PathBuf,
    container_disk_path: Option<PathBuf>,
    guest_rootfs_path: Option<PathBuf>,
}

impl VmmInstanceImpl for KrunVmmInstance {
    fn enter(self: Box<Self>) -> BoxliteResult<()> {
        // Only serve vmm.sock on targets that support libkrun full checkpoints;
        // Linux aarch64 VMM seccomp profiles exclude vmm_socket syscalls.
        #[cfg(any(
            all(target_os = "macos", target_arch = "aarch64"),
            all(target_os = "linux", target_arch = "x86_64")
        ))]
        {
            let context = Arc::clone(&self.context);
            let box_tmp_dir = self.box_tmp_dir.clone();
            let container_disk_path = self.container_disk_path.clone();
            let guest_rootfs_path = self.guest_rootfs_path.clone();
            if let Err(error) =
                crate::vmm::vmm_socket::serve(&self.vmm_socket_path, move |op, _| {
                    handle_control_op(
                        &context,
                        &box_tmp_dir,
                        container_disk_path.as_deref(),
                        guest_rootfs_path.as_deref(),
                        op,
                    )
                })
            {
                tracing::warn!(
                    %error,
                    path = %self.vmm_socket_path.display(),
                    "VMM control socket unavailable"
                );
            }
        }

        // Actually start the VM - following microsandbox pattern
        // In libkrun:
        // - Success: krun_start_enter never returns (process becomes VM)
        // - Failure: returns negative error code
        // - Guest exit: returns positive exit status (guest process exit code)
        //
        // IMPORTANT: libkrun takes over the current process completely.
        // This means:
        // 1. Unit tests cannot test this functionality (process takeover incompatible with test harness)
        // 2. This must run in the main application process or a separate process
        // 3. libkrunfw must be available in system library paths for successful VM creation
        let status = unsafe { self.context.start_enter() };

        // If we reach here, either:
        // 1. VM failed to start (negative status)
        // 2. VM started and guest exited (non-negative status) - this is success
        if status < 0 {
            // VM failed to start — use hypervisor probe to diagnose the cause.
            // libkrun collapses all errors to -EINVAL, so the probe inspects
            // the hypervisor directly to get the specific error code.
            let err = BoxliteError::Engine(format!("VM failed to start (libkrun status={status})"));
            Err(self.probe.diagnose_create_failure(err))
        } else {
            // VM started and guest exited successfully (status is guest exit code)
            Ok(())
        }
    }
}

#[cfg(unix)]
#[allow(dead_code)]
fn handle_control_op(
    ctx: &KrunContext,
    box_tmp_dir: &Path,
    container_disk_path: Option<&Path>,
    guest_rootfs_path: Option<&Path>,
    op: ControlOp,
) -> ControlResponse {
    match op {
        ControlOp::CaptureCheckpoint {
            vm_state_path,
            disk_dst_path,
        } => capture_checkpoint(
            ctx,
            box_tmp_dir,
            container_disk_path,
            guest_rootfs_path,
            &vm_state_path,
            &disk_dst_path,
        ),
        ControlOp::ResizeDisk { .. } => Err(ControlError::Unsupported(
            "disk resize is not supported by libkrun".into(),
        )),
        #[cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]
        ControlOp::RegisterMount { .. }
        | ControlOp::ListMounts
        | ControlOp::SetMountState { .. }
        | ControlOp::RemoveMount { .. } => Err(ControlError::Unsupported(
            "mount control is not supported by libkrun".into(),
        )),
    }
}

#[cfg(unix)]
#[allow(dead_code)]
fn resolve_existing_dir(dir: &Path) -> std::io::Result<PathBuf> {
    use std::os::unix::fs::OpenOptionsExt;

    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY)
        .open(dir)?;

    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::ffi::OsStrExt;

        let mut buf = [0u8; libc::PATH_MAX as usize];
        // F_GETPATH resolves the open directory vnode without lstat'ing sandboxed ancestor dirs.
        // SAFETY: `file` is a valid open directory fd and `buf` has length PATH_MAX.
        let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buf.as_mut_ptr()) };
        if rc == -1 {
            return Err(std::io::Error::last_os_error());
        }
        let len = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        Ok(PathBuf::from(std::ffi::OsStr::from_bytes(&buf[..len])))
    }

    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;

        std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        dir.canonicalize()
    }
}

#[cfg(unix)]
#[allow(dead_code)]
fn ensure_within_tmp(target: &Path, box_tmp_dir: &Path) -> Result<PathBuf, ControlError> {
    if !target.is_absolute() {
        return Err(ControlError::InvalidInput(format!(
            "checkpoint path must be absolute: {}",
            target.display()
        )));
    }
    if target
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(ControlError::InvalidInput(format!(
            "checkpoint path cannot contain parent traversal: {}",
            target.display()
        )));
    }
    let file_name = target.file_name().ok_or_else(|| {
        ControlError::InvalidInput(format!(
            "checkpoint path has no file name: {}",
            target.display()
        ))
    })?;
    let parent = target.parent().ok_or_else(|| {
        ControlError::InvalidInput(format!(
            "checkpoint path has no parent directory: {}",
            target.display()
        ))
    })?;
    let canon_tmp = resolve_existing_dir(box_tmp_dir).map_err(|e| {
        ControlError::Failed(format!(
            "box tmp directory {} unavailable: {e}",
            box_tmp_dir.display()
        ))
    })?;
    let canon_parent = resolve_existing_dir(parent).map_err(|e| {
        ControlError::InvalidInput(format!(
            "checkpoint parent directory {} unavailable: {e}",
            parent.display()
        ))
    })?;
    if !canon_parent.starts_with(&canon_tmp) {
        return Err(ControlError::InvalidInput(format!(
            "checkpoint path {} must reside under {}",
            target.display(),
            box_tmp_dir.display()
        )));
    }
    let resolved = canon_parent.join(file_name);
    if let Ok(meta) = std::fs::symlink_metadata(&resolved)
        && meta.file_type().is_symlink()
    {
        return Err(ControlError::InvalidInput(format!(
            "checkpoint target cannot be a symlink: {}",
            resolved.display()
        )));
    }
    Ok(resolved)
}

#[cfg(unix)]
#[allow(dead_code)]
fn capture_checkpoint(
    ctx: &KrunContext,
    box_tmp_dir: &Path,
    container_disk_path: Option<&Path>,
    guest_rootfs_path: Option<&Path>,
    vm_state_path: &Path,
    disk_dst_path: &Path,
) -> ControlResponse {
    struct ResumeOnDrop<'a> {
        ctx: &'a KrunContext,
        armed: bool,
    }

    impl Drop for ResumeOnDrop<'_> {
        fn drop(&mut self) {
            if self.armed
                && let Err(error) = self.ctx.resume()
            {
                tracing::error!(%error, "Failed to resume VM after checkpoint capture error");
            }
        }
    }

    let vm_state_path = ensure_within_tmp(vm_state_path, box_tmp_dir)?;
    let disk_dst_path = ensure_within_tmp(disk_dst_path, box_tmp_dir)?;
    if vm_state_path == disk_dst_path {
        return Err(ControlError::InvalidInput(
            "checkpoint VM state and disk output paths must differ".into(),
        ));
    }
    let vda_path = container_disk_path.ok_or_else(|| {
        ControlError::Failed("no container disk (vda) configured for checkpoint".into())
    })?;

    ctx.pause().map_err(|error| {
        let message = format!("krun_pause failed: {error}");
        if error.raw_os_error() == Some(libc::ESHUTDOWN) {
            ControlError::ShimShutdown(message)
        } else {
            ControlError::Failed(message)
        }
    })?;
    let mut resume_guard = ResumeOnDrop { ctx, armed: true };

    ctx.save_checkpoint(&vm_state_path)
        .map_err(|e| ControlError::Failed(format!("krun_save_checkpoint failed: {e}")))?;

    Qcow2Helper::flatten(vda_path, &disk_dst_path)
        .map_err(|e| ControlError::Failed(format!("disk flatten failed: {e}")))?;

    let vm_state_bytes = std::fs::metadata(&vm_state_path)
        .map_err(|e| ControlError::Failed(format!("failed to stat vmstate file: {e}")))?
        .len();

    resume_guard.armed = false;
    ctx.resume()
        .map_err(|e| ControlError::Failed(format!("krun_resume failed: {e}")))?;

    Ok(ControlReply::CheckpointCaptured {
        vm_state_bytes,
        guest_rootfs_path: guest_rootfs_path.map(Path::to_path_buf),
    })
}

/// Krun handles VM execution using the libkrun hypervisor.
///
/// This engine is responsible for creating Box instances with the provided
/// configuration. The actual VM execution happens when `VmmInstance::enter()`
/// is called, which performs process takeover via libkrun's `krun_start_enter()`.
pub struct Krun {
    #[allow(dead_code)]
    options: VmmConfig,
}

impl Krun {
    /// Create a new Krun engine with the specified options.
    ///
    /// # Arguments
    /// * `options` - Engine configuration options
    ///
    /// # Returns
    /// * `Ok(Krun)` - Successfully created engine
    /// * `Err(...)` - Failed to detect libkrun library
    pub fn new(options: VmmConfig) -> BoxliteResult<Self> {
        Ok(Self { options })
    }

    fn set_entrypoint(config: &InstanceSpec, ctx: &KrunContext) -> Result<(), BoxliteError> {
        // Prepare entrypoint - the VM runs the guest agent which will:
        // 1. Mount virtiofs shares
        // 2. Create overlayfs from layers
        // 3. Execute the container entrypoint inside the mounted filesystem
        let guest_executable = &config.guest_entrypoint.executable;

        // Transform guest arguments (engine handles transport-specific transformations)
        let guest_args =
            crate::vmm::guest_args::transform_guest_args(config.guest_entrypoint.args.clone());
        tracing::debug!(executable = %guest_executable,
                            args_count = guest_args.len(),
                            "Configuring entrypoint");
        for (i, arg) in guest_args.iter().enumerate() {
            tracing::trace!(index = i, arg = ?arg, "Entrypoint argument");
        }

        // Set executable and arguments with provided environment
        unsafe {
            ctx.set_exec(guest_executable, &guest_args, &config.guest_entrypoint.env)?;
        }
        Ok(())
    }

    fn set_kernel(config: &InstanceSpec, ctx: &KrunContext) -> BoxliteResult<()> {
        let Some(kernel) = &config.kernel else {
            return Ok(());
        };

        let format = match kernel.format {
            KernelFormat::Auto => {
                return Err(BoxliteError::Engine(
                    "custom kernel format was not resolved".to_string(),
                ));
            }
            KernelFormat::Raw => libkrun_sys::KRUN_KERNEL_FORMAT_RAW,
            KernelFormat::Elf => libkrun_sys::KRUN_KERNEL_FORMAT_ELF,
            KernelFormat::PeGz => libkrun_sys::KRUN_KERNEL_FORMAT_PE_GZ,
            KernelFormat::ImageBz2 => libkrun_sys::KRUN_KERNEL_FORMAT_IMAGE_BZ2,
            KernelFormat::ImageGz => libkrun_sys::KRUN_KERNEL_FORMAT_IMAGE_GZ,
            KernelFormat::ImageZstd => libkrun_sys::KRUN_KERNEL_FORMAT_IMAGE_ZSTD,
        };
        let kernel_path = kernel.path.to_str().ok_or_else(|| {
            BoxliteError::Engine(format!(
                "custom kernel path is not valid UTF-8: {}",
                kernel.path.display()
            ))
        })?;
        let initramfs = kernel
            .initramfs
            .as_deref()
            .map(|path| {
                path.to_str().ok_or_else(|| {
                    BoxliteError::Engine(format!(
                        "custom initramfs path is not valid UTF-8: {}",
                        path.display()
                    ))
                })
            })
            .transpose()?;

        tracing::info!(
            kernel = %kernel.path.display(),
            format = kernel.format.as_str(),
            initramfs = ?kernel.initramfs,
            has_custom_command_line = kernel.command_line.is_some(),
            "Configuring custom guest kernel"
        );
        unsafe {
            ctx.set_kernel(
                kernel_path,
                format,
                initramfs,
                kernel.command_line.as_deref(),
            )?;
        }
        Ok(())
    }
}

impl Vmm for Krun {
    fn create(&mut self, config: InstanceSpec) -> BoxliteResult<VmmInstance> {
        tracing::trace!("Step into Krun::create");

        // Validate filesystem shares exist
        for share in config.fs_shares.shares() {
            if !share.host_path.exists() {
                return Err(BoxliteError::Engine(format!(
                    "Filesystem share directory '{}' not found: {}",
                    share.tag,
                    share.host_path.display()
                )));
            }
            tracing::debug!(
                tag = %share.tag,
                path = %share.host_path.display(),
                read_only = share.read_only,
                "Validated filesystem share"
            );
        }

        // Validate disk images exist
        for block_device in config.block_devices.devices() {
            if !block_device.disk_path.exists() {
                return Err(BoxliteError::Engine(format!(
                    "Disk image not found: {}",
                    block_device.disk_path.display()
                )));
            }
            tracing::debug!(
                block_id = %block_device.block_id,
                path = %block_device.disk_path.display(),
                format = %block_device.format.as_str(),
                read_only = block_device.read_only,
                "Validated disk image"
            );
        }

        // Validate checkpoint restore path if requested.
        if let Some(ref checkpoint_path) = config.checkpoint_restore {
            if !checkpoint_path.exists() {
                return Err(BoxliteError::Engine(format!(
                    "Checkpoint state file not found: {}",
                    checkpoint_path.display()
                )));
            }
            if config.nested_virtualization {
                return Err(BoxliteError::Unsupported(
                    "checkpoint restore does not support nested virtualization".into(),
                ));
            }
        }

        let is_restore = config.checkpoint_restore.is_some();

        // Create and configure libkrun context
        let ctx = unsafe {
            tracing::debug!("Initializing libkrun logging system");
            if let Err(e) = KrunContext::init_logging() {
                tracing::warn!("Failed to initialize libkrun logging: {}", e);
            }

            tracing::debug!("Creating libkrun context");
            let ctx = KrunContext::create()?;

            tracing::debug!(
                cpus = config.cpus.unwrap_or(DEFAULT_CPUS),
                memory_mib = config.memory_mib.unwrap_or(DEFAULT_MEMORY_MIB),
                "Setting VM config"
            );
            ctx.set_vm_config(
                config.cpus.unwrap_or(DEFAULT_CPUS),
                config.memory_mib.unwrap_or(DEFAULT_MEMORY_MIB),
            )?;

            if !is_restore {
                Self::set_kernel(&config, &ctx)?;
                if config.nested_virtualization {
                    ctx.enable_nested_virtualization()?;
                }
            }

            // Configure net from connection info passed by parent process
            if let Some(connection) = &config.network_backend_endpoint {
                tracing::info!(connection = ?connection, "Configuring network connection");

                match connection {
                    crate::net::NetworkBackendEndpoint::UnixSocket {
                        path,
                        connection_type,
                        mac_address,
                    } => {
                        // Pass the Unix socket path to libkrun
                        // IMPORTANT: We pass the PATH, not a connected FD, so that libkrun can:
                        //  1. Connect to the socket itself
                        //  2. Send the VFKit magic handshake at the right time (when NET_FLAG_VFKIT is set)
                        tracing::info!(
                            path = ?path,
                            connection_type = ?connection_type,
                            mac_address = ?mac_address,
                            "Configuring Unix socket net"
                        );

                        // Convert path to string for FFI
                        let socket_path_str = path.to_str().ok_or_else(|| {
                            BoxliteError::Network(format!(
                                "Socket path contains invalid UTF-8: {}",
                                path.display()
                            ))
                        })?;

                        // Configure virtio-net feature flags
                        use crate::vmm::krun::constants::network_features::*;
                        let features = NET_FEATURE_CSUM
                            | NET_FEATURE_GUEST_CSUM
                            | NET_FEATURE_GUEST_TSO4
                            | NET_FEATURE_GUEST_UFO
                            | NET_FEATURE_HOST_TSO4
                            | NET_FEATURE_HOST_UFO;

                        // Pass the socket path to libkrun (not FD)
                        // libkrun will connect and send the VFKit magic handshake if needed
                        ctx.add_net_path(
                            socket_path_str,
                            features,
                            *connection_type,
                            *mac_address,
                        )?;

                        tracing::debug!("Successfully configured Unix socket net");
                    }
                }
            } else if config.disable_network {
                // Replace the implicit vsock (which has TSI hijacking) with an
                // explicit one that has zero TSI features. Vsock IPC ports still
                // work for host-guest gRPC, but guest AF_INET/AF_UNIX sockets
                // are no longer transparently forwarded through the host.
                use crate::vmm::krun::constants::TsiFeatures;
                ctx.disable_implicit_vsock()?;
                ctx.add_vsock(TsiFeatures::None)?;
                tracing::info!("Network disabled: vsock with TSI disabled");
            } else {
                // No network connection specified - use libkrun's built-in TSI net
                tracing::debug!("No network backend - using libkrun's built-in TSI net");
            }

            // Raise RLIMIT_NOFILE to maximum - CRITICAL for virtio-fs!
            // This must be done BEFORE mounting virtiofs shares
            tracing::debug!("Raising RLIMIT_NOFILE for virtio-fs");
            #[cfg(unix)]
            {
                use libc::{RLIMIT_NOFILE, getrlimit, rlimit, setrlimit};
                let mut rlim = rlimit {
                    rlim_cur: 0,
                    rlim_max: 0,
                };
                if getrlimit(RLIMIT_NOFILE, &mut rlim) == 0 {
                    rlim.rlim_cur = rlim.rlim_max;
                    if setrlimit(RLIMIT_NOFILE, &rlim) != 0 {
                        tracing::warn!("Failed to raise RLIMIT_NOFILE");
                    } else {
                        tracing::debug!(limit = rlim.rlim_cur, "RLIMIT_NOFILE raised");
                    }
                } else {
                    tracing::warn!("Failed to get RLIMIT_NOFILE");
                }
            }

            // Configure rlimits that will be set in the guest (cold boot only; restored from checkpoint state).
            if !is_restore {
                let rlimits = vec![
                    "6=4096:8192".to_string(),       // RLIMIT_NPROC = 6
                    "7=1048576:1048576".to_string(), // RLIMIT_NOFILE = 7
                ];
                tracing::debug!("Configuring guest rlimits: {:?}", rlimits);
                ctx.set_rlimits(&rlimits)?;
            }

            // Add filesystem shares via virtiofs
            tracing::info!("Adding filesystem shares via virtiofs:");
            for share in config.fs_shares.shares() {
                let path_str = share.host_path.to_str().ok_or_else(|| {
                    BoxliteError::Engine(format!("Invalid path: {}", share.host_path.display()))
                })?;

                tracing::info!(
                    "  {} → {} ({})",
                    share.tag,
                    share.host_path.display(),
                    if share.read_only { "ro" } else { "rw" }
                );
                ctx.add_virtiofs(&share.tag, path_str, share.read_only)?;
            }

            // Attach disk images via virtio-blk
            if !config.block_devices.devices().is_empty() {
                tracing::info!("Attaching block devices:");
                for disk in config.block_devices.devices() {
                    let path_str = disk.disk_path.to_str().ok_or_else(|| {
                        BoxliteError::Engine(format!(
                            "Invalid disk path: {}",
                            disk.disk_path.display()
                        ))
                    })?;

                    tracing::info!(
                        "  {} → {} ({}, {})",
                        disk.block_id,
                        disk.disk_path.display(),
                        disk.format.as_str(),
                        if disk.read_only {
                            "read-only"
                        } else {
                            "read-write"
                        }
                    );

                    ctx.add_disk_with_format(
                        &disk.block_id,
                        path_str,
                        disk.read_only,
                        disk.format.as_str(),
                    )?;
                }
            }

            // Cold boot only: rootfs remount, workdir, and entrypoint are restored from checkpoint state.
            if !is_restore {
                // Configure root filesystem based on guest rootfs strategy
                if let crate::rootfs::guest::Strategy::Disk {
                    device_path: Some(device_path),
                    ..
                } = &config.guest_rootfs.strategy
                {
                    // Disk-based boot: use set_root_disk_remount, mounting read-only.
                    tracing::info!("Configuring guest rootfs disk remount: {}", device_path);
                    ctx.set_root_disk_remount(device_path, Some("ext4"), Some("ro"))?;
                } else {
                    // Virtiofs-based boot: use set_rootfs
                    let rootfs_str = config.guest_rootfs.path.to_str().ok_or_else(|| {
                        BoxliteError::Engine(format!(
                            "Invalid rootfs path: {}",
                            config.guest_rootfs.path.display()
                        ))
                    })?;
                    tracing::debug!("Setting box root filesystem (virtiofs): {}", rootfs_str);
                    ctx.set_rootfs(rootfs_str)?;
                }

                tracing::debug!("Setting working directory to /");
                // Set working directory (default to root if not specified)
                ctx.set_workdir("/boxlite")?;

                Self::set_entrypoint(&config, &ctx)?;
            }

            // Configure gRPC communication channel (Unix socket bridged to vsock)
            // listen=true: libkrun creates socket, host connects, guest accepts via vsock
            let grpc_socket_path = match &config.transport {
                boxlite_shared::BoxTransport::Unix { socket_path } => socket_path
                    .to_str()
                    .ok_or_else(|| BoxliteError::Engine("invalid gRPC socket path".into()))?,
                _ => {
                    return Err(BoxliteError::Engine(
                        "gRPC transport must be Unix socket on host side".into(),
                    ));
                }
            };
            tracing::debug!(
                socket_path = grpc_socket_path,
                guest_port = network::GUEST_AGENT_PORT,
                "Configuring vsock bridge for gRPC"
            );
            ctx.add_vsock_port(network::GUEST_AGENT_PORT, grpc_socket_path, true)?;

            // Configure ready notification channel (Unix socket bridged to vsock)
            // listen=false: host creates socket and listens, guest connects via vsock
            let ready_socket_path = match &config.ready_transport {
                boxlite_shared::BoxTransport::Unix { socket_path } => socket_path
                    .to_str()
                    .ok_or_else(|| BoxliteError::Engine("invalid ready socket path".into()))?,
                _ => {
                    return Err(BoxliteError::Engine(
                        "ready transport must be Unix socket on host side".into(),
                    ));
                }
            };
            tracing::debug!(
                socket_path = ready_socket_path,
                guest_port = network::GUEST_READY_PORT,
                "Configuring vsock bridge for ready notification"
            );
            ctx.add_vsock_port(network::GUEST_READY_PORT, ready_socket_path, false)?;

            // Configure console output redirection if specified
            if let Some(console_path) = &config.console_output {
                let console_path_str = console_path.to_str().ok_or_else(|| {
                    BoxliteError::Engine(format!(
                        "Invalid console output path: {}",
                        console_path.display()
                    ))
                })?;
                tracing::info!(console_path = console_path_str, "Console output configured");
                ctx.set_console_output(console_path_str)?;
            }

            if let Some(ref checkpoint_path) = config.checkpoint_restore {
                tracing::info!(
                    checkpoint = %checkpoint_path.display(),
                    "Configuring libkrun restore from checkpoint"
                );
                ctx.build_from_checkpoint(checkpoint_path).map_err(|e| {
                    BoxliteError::Engine(format!(
                        "krun_build_from_checkpoint({}) failed: {e}",
                        checkpoint_path.display()
                    ))
                })?;
            }

            ctx
        };

        let box_dir = config
            .exit_file
            .parent()
            .ok_or_else(|| BoxliteError::Engine("the exit file has no box directory".into()))?;
        let vmm_socket_path = crate::net::socket_path::BoxSockets::new(
            config.box_id.clone(),
            box_dir.join(crate::runtime::layout::dirs::SOCKETS_DIR),
        )
        .vmm_sock();
        let box_tmp_dir = box_dir.join("tmp");
        let container_disk_path = config
            .block_devices
            .devices()
            .iter()
            .find(|d| d.block_id == "vda")
            .map(|d| d.disk_path.clone());
        let guest_rootfs_path = config
            .block_devices
            .devices()
            .iter()
            .find(|d| d.block_id == "vdb")
            .map(|d| d.disk_path.clone())
            .or_else(|| match &config.guest_rootfs.strategy {
                crate::rootfs::guest::Strategy::Disk { disk_path, .. } => Some(disk_path.clone()),
                _ => None,
            });

        // Return a VmmInstance that wraps the configured context
        // The actual VM start will happen when enter() is called
        let instance = KrunVmmInstance {
            context: Arc::new(ctx),
            probe: crate::system_check::hypervisor_probe(),
            vmm_socket_path,
            box_tmp_dir,
            container_disk_path,
            guest_rootfs_path,
        };
        Ok(VmmInstance::new(Box::new(instance)))
    }
}

#[cfg(all(test, unix))]
#[path = "tests/checkpoint.rs"]
mod checkpoint_tests;
