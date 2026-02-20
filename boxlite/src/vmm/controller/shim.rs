//! ShimController and ShimHandler - Universal process management for all Box engines.

use std::{io::Write, path::Path, path::PathBuf, process::Child, sync::Mutex, time::Instant};

use crate::{
    BoxID,
    runtime::layout::BoxFilesystemLayout,
    vmm::{InstanceSpec, VmmKind},
};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::{VmmController, VmmHandler as VmmHandlerTrait, VmmMetrics, spawn::spawn_subprocess};

// ============================================================================
// SHIM HANDLER - Runtime operations on running VM
// ============================================================================

/// Runtime handler for a running VM subprocess.
///
/// Provides lifecycle operations (stop, metrics, status) for a VM identified by PID.
/// Works for both spawned VMs and reconnected VMs (same operations).
pub struct ShimHandler {
    pid: u32,
    #[allow(dead_code)]
    box_id: BoxID,
    /// Child process handle for proper lifecycle management.
    /// When we spawn the process, we keep the Child to properly wait() on stop.
    /// When we attach to an existing process, this is None.
    process: Option<Child>,
    /// Shared System instance for CPU metrics calculation across calls.
    /// CPU usage requires comparing snapshots over time, so we must reuse the same System.
    metrics_sys: Mutex<sysinfo::System>,
}

impl ShimHandler {
    /// Create a handler for a spawned VM with process ownership.
    ///
    /// This constructor takes ownership of the Child process handle for proper
    /// lifecycle management (clean shutdown with wait()).
    ///
    /// # Arguments
    /// * `process` - The spawned subprocess (Child handle)
    /// * `box_id` - Box identifier (for logging)
    pub fn from_child(process: Child, box_id: BoxID) -> Self {
        let pid = process.id();
        Self {
            pid,
            box_id,
            process: Some(process),
            metrics_sys: Mutex::new(sysinfo::System::new()),
        }
    }

    /// Create a handler for an existing VM (attach mode).
    ///
    /// Used when reconnecting to a running box. We don't have a Child handle,
    /// so we manage the process by PID only.
    ///
    /// # Arguments
    /// * `pid` - Process ID of the running VM
    /// * `box_id` - Box identifier (for logging)
    pub fn from_pid(pid: u32, box_id: BoxID) -> Self {
        Self {
            pid,
            box_id,
            process: None,
            metrics_sys: Mutex::new(sysinfo::System::new()),
        }
    }
}

impl VmmHandlerTrait for ShimHandler {
    fn pid(&self) -> u32 {
        self.pid
    }

    fn stop(&mut self) -> BoxliteResult<()> {
        // Graceful shutdown: SIGTERM first, wait, then SIGKILL if needed.
        // This gives libkrun time to flush its virtio-blk buffers to disk,
        // preventing qcow2 corruption.
        const GRACEFUL_SHUTDOWN_TIMEOUT_MS: u64 = 2000;

        if let Some(mut process) = self.process.take() {
            // Step 1: Send SIGTERM for graceful shutdown
            let pid = process.id();
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }

            // Step 2: Wait with timeout for process to exit
            let start = std::time::Instant::now();
            loop {
                match process.try_wait() {
                    Ok(Some(_)) => {
                        // Process exited gracefully
                        return Ok(());
                    }
                    Ok(None) => {
                        // Still running, check timeout
                        if start.elapsed().as_millis() > GRACEFUL_SHUTDOWN_TIMEOUT_MS as u128 {
                            // Timeout - force kill
                            let _ = process.kill();
                            let _ = process.wait();
                            return Ok(());
                        }
                        // Brief sleep before checking again
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    Err(_) => {
                        // Error checking status - try to kill anyway
                        let _ = process.kill();
                        let _ = process.wait();
                        return Ok(());
                    }
                }
            }
        } else {
            // Attached mode: use SIGTERM then SIGKILL with polling
            // We don't have a Child handle, so we use waitpid/kill directly
            unsafe {
                libc::kill(self.pid as i32, libc::SIGTERM);
            }

            // Poll for exit with timeout
            let start = std::time::Instant::now();
            loop {
                let mut status: i32 = 0;
                let result = unsafe { libc::waitpid(self.pid as i32, &mut status, libc::WNOHANG) };

                if result > 0 {
                    // Process exited gracefully (we reaped it)
                    return Ok(());
                }
                if result < 0 {
                    // Error - process may not be our child (common in attached mode)
                    // Fall back to checking if process still exists
                    let exists = crate::util::is_process_alive(self.pid);
                    if !exists {
                        return Ok(()); // Already dead
                    }
                }
                // result == 0 means still running

                if start.elapsed().as_millis() > GRACEFUL_SHUTDOWN_TIMEOUT_MS as u128 {
                    // Timeout - force kill
                    unsafe {
                        libc::kill(self.pid as i32, libc::SIGKILL);
                    }
                    return Ok(());
                }

                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }

        #[allow(unreachable_code)]
        Ok(())
    }

    fn metrics(&self) -> BoxliteResult<VmmMetrics> {
        use sysinfo::Pid;

        let pid = Pid::from_u32(self.pid);

        // Use the shared System instance for stateful CPU tracking
        let mut sys = self
            .metrics_sys
            .lock()
            .map_err(|e| BoxliteError::Internal(format!("metrics_sys lock poisoned: {}", e)))?;

        // Refresh process info - this updates the internal state for delta calculation
        sys.refresh_process(pid);

        // Try to get process information
        if let Some(proc_info) = sys.process(pid) {
            return Ok(VmmMetrics {
                cpu_percent: Some(proc_info.cpu_usage()),
                memory_bytes: Some(proc_info.memory()),
                disk_bytes: None, // Not available from process-level APIs
            });
        }

        // Process not found or not running - return empty metrics
        Ok(VmmMetrics::default())
    }

    fn is_running(&self) -> bool {
        crate::util::is_process_alive(self.pid)
    }
}

// ============================================================================
// SHIM CONTROLLER - Spawning operations
// ============================================================================

/// Controller for spawning VM subprocesses.
///
/// Spawns the `boxlite-shim` binary in a subprocess and returns a ShimHandler
/// for runtime operations. The subprocess isolation ensures that VM process
/// takeover doesn't affect the host application.
pub struct ShimController {
    binary_path: PathBuf,
    engine_type: VmmKind,
    box_id: BoxID,
    /// Box options (includes security and volumes for jailer isolation)
    options: crate::runtime::options::BoxOptions,
    /// Box filesystem layout (provides paths for stderr, sockets, etc.)
    layout: BoxFilesystemLayout,
}

impl ShimController {
    /// Create a new ShimController.
    ///
    /// # Arguments
    /// * `binary_path` - Path to the boxlite-shim binary
    /// * `engine_type` - Type of VM engine to use (libkrun, firecracker, etc.)
    /// * `box_id` - Unique identifier for this box
    /// * `options` - Box options (includes security and volumes)
    /// * `layout` - Box filesystem layout
    ///
    /// # Returns
    /// * `Ok(ShimController)` - Successfully created controller
    /// * `Err(...)` - Failed to create controller (e.g., binary not found)
    pub fn new(
        binary_path: PathBuf,
        engine_type: VmmKind,
        box_id: BoxID,
        options: crate::runtime::options::BoxOptions,
        layout: BoxFilesystemLayout,
    ) -> BoxliteResult<Self> {
        // Verify that the shim binary exists
        if !binary_path.exists() {
            return Err(BoxliteError::Engine(format!(
                "Box runner binary not found: {}",
                binary_path.display()
            )));
        }

        Ok(Self {
            binary_path,
            engine_type,
            box_id,
            options,
            layout,
        })
    }
}

#[async_trait::async_trait]
impl VmmController for ShimController {
    async fn start(&mut self, config: &InstanceSpec) -> BoxliteResult<Box<dyn VmmHandlerTrait>> {
        tracing::debug!(
            "Preparing config: entrypoint.executable={}, entrypoint.args={:?}",
            config.guest_entrypoint.executable,
            config.guest_entrypoint.args
        );

        let serializable_config = InstanceSpec {
            // Box identification and security (from ShimController)
            box_id: self.box_id.to_string(),
            security: self.options.advanced.security.clone(),
            // VM configuration
            cpus: config.cpus,
            memory_mib: config.memory_mib,
            fs_shares: config.fs_shares.clone(),
            block_devices: config.block_devices.clone(),
            guest_entrypoint: config.guest_entrypoint.clone(),
            transport: config.transport.clone(),
            ready_transport: config.ready_transport.clone(),
            guest_rootfs: config.guest_rootfs.clone(),
            network_config: config.network_config.clone(), // Pass port mappings to subprocess (shim creates gvproxy)
            network_backend_endpoint: None, // Will be populated by shim (not serialized)
            home_dir: config.home_dir.clone(),
            console_output: config.console_output.clone(),
            exit_file: config.exit_file.clone(),
            detach: config.detach,
        };

        let config_path = self.layout.shim_config_path();
        write_instance_spec_file(&serializable_config, &config_path)?;

        // Clean up stale socket file if it exists (defense in depth)
        // Only relevant for Unix sockets
        if let boxlite_shared::Transport::Unix { socket_path } = &config.transport
            && socket_path.exists()
        {
            tracing::warn!("Removing stale Unix socket: {}", socket_path.display());
            let _ = std::fs::remove_file(socket_path);
        }

        // Spawn Box subprocess with piped stdio
        tracing::info!(
            engine = ?self.engine_type,
            transport = ?config.transport,
            "Starting Box subprocess"
        );
        tracing::debug!(binary = %self.binary_path.display(), "Box runner binary");
        tracing::trace!(config_path = %config_path.display(), "Box configuration file");

        // Measure subprocess spawn time
        let shim_spawn_start = Instant::now();
        let child = spawn_subprocess(
            &self.binary_path,
            self.engine_type,
            &config_path,
            &self.layout,
            self.box_id.as_str(),
            &self.options,
        )?;
        // spawn_duration: time to create Box subprocess
        let shim_spawn_duration = shim_spawn_start.elapsed();

        let pid = child.id();
        tracing::info!(
            box_id = %self.box_id,
            pid = pid,
            shim_spawn_duration_ms = shim_spawn_duration.as_millis(),
            "boxlite-shim subprocess spawned"
        );

        // Note: We don't wait for guest readiness here anymore.
        // GuestConnectTask handles waiting for guest readiness,
        // which allows reusing that task across spawn/restart/reconnect.

        // Create handler for the running VM
        // Note: stdio is null (no pipes), so no LogStreamHandler needed
        let handler = ShimHandler::from_child(child, self.box_id.clone());

        tracing::info!(
            box_id = %self.box_id,
            "VM subprocess started successfully"
        );

        // Note: Child is dropped here, but process continues running
        // Handler manages it by PID
        Ok(Box::new(handler))
    }
}

fn write_instance_spec_file(config: &InstanceSpec, config_path: &Path) -> BoxliteResult<()> {
    let config_json = serde_json::to_vec(config)
        .map_err(|e| BoxliteError::Engine(format!("Failed to serialize shim config: {}", e)))?;

    let config_dir = config_path.parent().ok_or_else(|| {
        BoxliteError::Storage(format!(
            "Invalid shim config path (missing parent): {}",
            config_path.display()
        ))
    })?;

    let mut temp_file = tempfile::NamedTempFile::new_in(config_dir).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to create temporary shim config in {}: {}",
            config_dir.display(),
            e
        ))
    })?;

    temp_file.write_all(&config_json).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to write temporary shim config {}: {}",
            config_path.display(),
            e
        ))
    })?;
    temp_file.flush().map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to flush temporary shim config {}: {}",
            config_path.display(),
            e
        ))
    })?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        temp_file
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to set permissions on temporary shim config {}: {}",
                    config_path.display(),
                    e
                ))
            })?;
    }

    temp_file.persist(config_path).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to persist shim config {}: {}",
            config_path.display(),
            e.error
        ))
    })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jailer::SecurityOptions;
    use crate::runtime::guest_rootfs::{GuestRootfs, Strategy};
    use crate::vmm::{BlockDevices, Entrypoint, FsShares};
    use std::sync::{Mutex, OnceLock};
    use std::thread;

    fn test_instance_spec() -> InstanceSpec {
        InstanceSpec {
            box_id: "box-test".to_string(),
            security: SecurityOptions::default(),
            cpus: None,
            memory_mib: None,
            fs_shares: FsShares::default(),
            block_devices: BlockDevices::default(),
            guest_entrypoint: Entrypoint {
                executable: "/boxlite/bin/boxlite-guest".to_string(),
                args: vec!["--listen".to_string(), "vsock://2695".to_string()],
                env: vec![("RUST_LOG".to_string(), "info".to_string())],
            },
            transport: boxlite_shared::Transport::unix(PathBuf::from("/tmp/box.sock")),
            ready_transport: boxlite_shared::Transport::unix(PathBuf::from("/tmp/ready.sock")),
            guest_rootfs: GuestRootfs {
                path: PathBuf::from("/tmp/rootfs"),
                strategy: Strategy::Direct,
                kernel: None,
                initrd: None,
                env: vec![],
            },
            network_config: None,
            network_backend_endpoint: None,
            home_dir: PathBuf::from("/tmp/home"),
            console_output: Some(PathBuf::from("/tmp/console.log")),
            exit_file: PathBuf::from("/tmp/exit"),
            detach: false,
        }
    }

    #[test]
    fn write_instance_spec_file_persists_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shim-config.json");
        let spec = test_instance_spec();

        write_instance_spec_file(&spec, &path).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        let parsed: InstanceSpec = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed.box_id, "box-test");
        assert_eq!(
            parsed.guest_entrypoint.executable,
            "/boxlite/bin/boxlite-guest"
        );
    }

    fn fd_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
    }

    fn count_open_fds() -> usize {
        #[cfg(target_os = "linux")]
        {
            if let Ok(entries) = std::fs::read_dir("/proc/self/fd") {
                return entries.count();
            }
        }

        std::fs::read_dir("/dev/fd")
            .map(|entries| entries.count())
            .unwrap_or(0)
    }

    #[test]
    fn write_instance_spec_file_concurrent_writes_are_isolated() {
        let dir = tempfile::tempdir().unwrap();
        let mut handles = Vec::new();
        let mut expected = Vec::new();

        for i in 0..16 {
            let box_id = format!("box-concurrent-{i}");
            let path = dir.path().join(format!("shim-config-{i}.json"));
            let path_for_thread = path.clone();
            let box_id_for_thread = box_id.clone();
            expected.push((box_id, path));

            handles.push(thread::spawn(move || {
                let mut spec = test_instance_spec();
                spec.box_id = box_id_for_thread;
                write_instance_spec_file(&spec, &path_for_thread).unwrap();
            }));
        }

        for handle in handles {
            handle.join().unwrap();
        }

        for (expected_box_id, path) in expected {
            let content = std::fs::read_to_string(&path).unwrap();
            let parsed: InstanceSpec = serde_json::from_str(&content).unwrap();
            assert_eq!(parsed.box_id, expected_box_id);
            assert_eq!(
                parsed.guest_entrypoint.executable,
                "/boxlite/bin/boxlite-guest"
            );
        }
    }

    #[test]
    fn write_instance_spec_file_persist_failure_does_not_leak_fds() {
        let _guard = fd_test_lock();
        let dir = tempfile::tempdir().unwrap();
        let target_dir = dir.path().join("target-as-dir");
        std::fs::create_dir_all(&target_dir).unwrap();
        let spec = test_instance_spec();

        let baseline = count_open_fds();
        for _ in 0..50 {
            let err = write_instance_spec_file(&spec, &target_dir).unwrap_err();
            let msg = err.to_string();
            assert!(msg.contains("Failed to persist shim config"), "{msg}");
        }
        let after = count_open_fds();

        assert!(
            after <= baseline + 4,
            "FD count grew unexpectedly: baseline={baseline}, after={after}"
        );
    }
}
