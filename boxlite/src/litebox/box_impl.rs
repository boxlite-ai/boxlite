//! Box implementation - holds config, state, and lazily-initialized VM resources.

// ============================================================================
// IMPORTS
// ============================================================================

use std::sync::Arc;
use std::sync::atomic::Ordering;

use parking_lot::RwLock;
use tar;
use tokio::sync::OnceCell;
use tokio_util::sync::CancellationToken;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::config::BoxConfig;
use super::exec::{BoxCommand, ExecStderr, ExecStdin, ExecStdout, Execution};
use super::state::BoxState;
use crate::disk::Disk;
#[cfg(target_os = "linux")]
use crate::fs::BindMountHandle;
use crate::litebox::copy::CopyOptions;
use crate::lock::LockGuard;
use crate::metrics::{BoxMetrics, BoxMetricsStorage};
use crate::portal::GuestSession;
use crate::runtime::rt_impl::SharedRuntimeImpl;
use crate::runtime::types::BoxStatus;
use crate::vmm::controller::VmmHandler;
use crate::{BoxID, BoxInfo};

// ============================================================================
// TYPE ALIASES
// ============================================================================

/// Shared reference to BoxImpl.
pub type SharedBoxImpl = Arc<BoxImpl>;

// ============================================================================
// LIVE STATE
// ============================================================================

/// Live state - lazily initialized when VM is started.
///
/// Contains all resources related to a running VM instance.
/// Separated from BoxImpl to allow operations like `info()` without initializing LiveState.
pub(crate) struct LiveState {
    // VM process control
    handler: std::sync::Mutex<Box<dyn VmmHandler>>,
    guest_session: GuestSession,

    // Metrics
    metrics: BoxMetricsStorage,

    // Disk resources (kept for lifecycle management)
    _container_rootfs_disk: Disk,
    #[allow(dead_code)]
    guest_rootfs_disk: Option<Disk>,

    // Platform-specific
    #[cfg(target_os = "linux")]
    #[allow(dead_code)]
    bind_mount: Option<BindMountHandle>,
}

impl LiveState {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        handler: Box<dyn VmmHandler>,
        guest_session: GuestSession,
        metrics: BoxMetricsStorage,
        container_rootfs_disk: Disk,
        guest_rootfs_disk: Option<Disk>,
        #[cfg(target_os = "linux")] bind_mount: Option<BindMountHandle>,
    ) -> Self {
        Self {
            handler: std::sync::Mutex::new(handler),
            guest_session,
            metrics,
            _container_rootfs_disk: container_rootfs_disk,
            guest_rootfs_disk,
            #[cfg(target_os = "linux")]
            bind_mount,
        }
    }
}

// ============================================================================
// BOX IMPL
// ============================================================================

/// Box implementation - created immediately, holds config and state.
///
/// VM resources are held in LiveState and lazily initialized on first use.
pub(crate) struct BoxImpl {
    // --- Always available ---
    pub(crate) config: BoxConfig,
    pub(crate) state: RwLock<BoxState>,
    pub(crate) runtime: SharedRuntimeImpl,
    /// Cancellation token for this box (child of runtime's token).
    /// When cancelled (via stop() or runtime shutdown), all operations abort gracefully.
    pub(crate) shutdown_token: CancellationToken,

    // --- Lazily initialized ---
    live: OnceCell<LiveState>,
}

impl BoxImpl {
    // ========================================================================
    // CONSTRUCTION
    // ========================================================================

    /// Create BoxImpl with config and state (LiveState not initialized yet).
    ///
    /// LiveState will be lazily initialized when operations requiring it are called.
    ///
    /// # Arguments
    /// * `config` - Box configuration
    /// * `state` - Initial box state
    /// * `runtime` - Shared runtime reference
    /// * `shutdown_token` - Child token from runtime for coordinated shutdown
    pub(crate) fn new(
        config: BoxConfig,
        state: BoxState,
        runtime: SharedRuntimeImpl,
        shutdown_token: CancellationToken,
    ) -> Self {
        Self {
            config,
            state: RwLock::new(state),
            runtime,
            shutdown_token,
            live: OnceCell::new(),
        }
    }

    // ========================================================================
    // ACCESSORS (no LiveState required)
    // ========================================================================

    pub(crate) fn id(&self) -> &BoxID {
        &self.config.id
    }

    pub(crate) fn container_id(&self) -> &str {
        self.config.container.id.as_str()
    }

    pub(crate) fn info(&self) -> BoxInfo {
        let state = self.state.read();
        BoxInfo::new(&self.config, &state)
    }

    // ========================================================================
    // OPERATIONS (require LiveState)
    // ========================================================================

    /// Start the box (initialize VM).
    ///
    /// For Configured boxes: full pipeline (filesystem, rootfs, spawn, connect, init)
    /// For Stopped boxes: restart pipeline (reuse rootfs, spawn, connect, init)
    ///
    /// This is idempotent - calling start() on a Running box is a no-op.
    pub(crate) async fn start(&self) -> BoxliteResult<()> {
        // Check if already shutdown (via stop() or runtime shutdown)
        if self.shutdown_token.is_cancelled() {
            return Err(BoxliteError::Stopped(
                "Handle invalidated after stop(). Use runtime.get() to get a new handle.".into(),
            ));
        }

        // Check current status
        let status = self.state.read().status;

        // Idempotent: already running
        if status == BoxStatus::Running {
            return Ok(());
        }

        // Check if startable
        if !status.can_start() {
            return Err(BoxliteError::InvalidState(format!(
                "Cannot start box in {} state",
                status
            )));
        }

        // Trigger lazy initialization (this does the actual work)
        let _ = self.live_state().await?;

        Ok(())
    }

    pub(crate) async fn exec(&self, command: BoxCommand) -> BoxliteResult<Execution> {
        use boxlite_shared::constants::executor as executor_const;

        // Check if box is stopped before proceeding (via stop() or runtime shutdown)
        if self.shutdown_token.is_cancelled() {
            return Err(BoxliteError::Stopped(
                "Handle invalidated after stop(). Use runtime.get() to get a new handle.".into(),
            ));
        }

        let live = self.live_state().await?;

        // Inject container ID into environment if not already set
        let command = if command
            .env
            .as_ref()
            .map(|env| env.iter().any(|(k, _)| k == executor_const::ENV_VAR))
            .unwrap_or(false)
        {
            command
        } else {
            command.env(
                executor_const::ENV_VAR,
                format!("{}={}", executor_const::CONTAINER_KEY, self.container_id()),
            )
        };

        // Set working directory from BoxOptions if not set in command
        let command = match (&command.working_dir, &self.config.options.working_dir) {
            (None, Some(dir)) => command.working_dir(dir),
            _ => command,
        };

        let mut exec_interface = live.guest_session.execution().await?;
        let result = exec_interface
            .exec(command, self.shutdown_token.clone())
            .await;

        // Instrument metrics
        live.metrics.increment_commands_executed();
        self.runtime
            .runtime_metrics
            .total_commands
            .fetch_add(1, Ordering::Relaxed);

        if result.is_err() {
            live.metrics.increment_exec_errors();
            self.runtime
                .runtime_metrics
                .total_exec_errors
                .fetch_add(1, Ordering::Relaxed);
        }

        let components = result?;
        Ok(Execution::new(
            components.execution_id,
            Box::new(exec_interface),
            components.result_rx,
            Some(ExecStdin::new(components.stdin_tx)),
            Some(ExecStdout::new(components.stdout_rx)),
            Some(ExecStderr::new(components.stderr_rx)),
        ))
    }

    pub(crate) async fn metrics(&self) -> BoxliteResult<BoxMetrics> {
        // Check if box is stopped before proceeding (via stop() or runtime shutdown)
        if self.shutdown_token.is_cancelled() {
            return Err(BoxliteError::Stopped(
                "Handle invalidated after stop(). Use runtime.get() to get a new handle.".into(),
            ));
        }

        let live = self.live_state().await?;
        let handler = live
            .handler
            .lock()
            .map_err(|e| BoxliteError::Internal(format!("handler lock poisoned: {}", e)))?;
        let raw = handler.metrics()?;

        Ok(BoxMetrics::from_storage(
            &live.metrics,
            raw.cpu_percent,
            raw.memory_bytes,
            None,
            None,
            None,
            None,
        ))
    }

    pub(crate) async fn stop(&self) -> BoxliteResult<()> {
        // Early exit if already stopped (idempotent, prevents double-counting)
        // Note: We check status, not shutdown_token, because the token may be cancelled
        // by runtime.shutdown() before stop() is called on each box.
        if self.state.read().status == BoxStatus::Stopped {
            return Ok(());
        }

        // Cancel the token - signals all in-flight operations to abort
        self.shutdown_token.cancel();

        // Only try to stop VM if LiveState exists
        if let Some(live) = self.live.get() {
            // Gracefully shut down guest
            if let Ok(mut guest) = live.guest_session.guest().await {
                let _ = guest.shutdown().await;
            }

            // Stop handler
            if let Ok(mut handler) = live.handler.lock() {
                handler.stop()?;
            }
        }

        // Clean up PID file (single source of truth)
        let pid_file = self
            .runtime
            .layout
            .boxes_dir()
            .join(self.config.id.as_str())
            .join("shim.pid");
        if pid_file.exists()
            && let Err(e) = std::fs::remove_file(&pid_file)
        {
            tracing::warn!(
                box_id = %self.config.id,
                path = %pid_file.display(),
                error = %e,
                "Failed to remove PID file"
            );
        }

        // Check if box was persisted
        let was_persisted = self.state.read().lock_id.is_some();

        // Update state
        {
            let mut state = self.state.write();

            // Only transition to Stopped if we were Running (or other active state).
            // If we were Configured (never started), stay Configured so next start()
            // triggers full initialization (creating disks).
            if !state.status.is_configured() {
                state.mark_stop();
            }

            if was_persisted {
                // Box was persisted - sync to DB
                // Note: If the box was already removed (e.g., by cleanup after init failure),
                // this will return NotFound. We ignore that error since the box is already gone.
                match self.runtime.box_manager.save_box(&self.config.id, &state) {
                    Ok(()) => {}
                    Err(BoxliteError::NotFound(_)) => {
                        tracing::debug!(
                            box_id = %self.config.id,
                            "Box already removed from DB during stop (likely cleanup after init failure)"
                        );
                        return Ok(());
                    }
                    Err(e) => return Err(e),
                }
            } else {
                // Box was never started - persist now so it survives restarts
                self.runtime.box_manager.add_box(&self.config, &state)?;
            }
        }

        // Invalidate cache so new handles get fresh BoxImpl
        self.runtime
            .invalidate_box_impl(self.id(), self.config.name.as_deref());

        tracing::info!("Stopped box {}", self.id());

        // Increment runtime-wide stopped counter
        self.runtime
            .runtime_metrics
            .boxes_stopped
            .fetch_add(1, Ordering::Relaxed);

        if self.config.options.auto_remove {
            self.runtime.remove_box(self.id(), false)?;
        }

        Ok(())
    }

    // ========================================================================
    // FILE COPY
    // ========================================================================

    // NOTE(copy_in): copy_in cannot write to tmpfs-mounted destinations (e.g. /tmp, /dev/shm).
    //
    // Extraction happens on the rootfs layer, but tmpfs mounts inside the container
    // hide those files. This is the same limitation as `docker cp`.
    // See: https://github.com/moby/moby/issues/22020
    //
    // Workaround: use exec() to pipe tar into the container:
    //   exec(["tar", "xf", "-", "-C", "/tmp"]) + stream tar bytes via stdin
    pub(crate) async fn copy_into(
        &self,
        host_src: &std::path::Path,
        container_dst: &str,
        opts: CopyOptions,
    ) -> BoxliteResult<()> {
        // Check if box is stopped before proceeding
        if self.shutdown_token.is_cancelled() {
            return Err(BoxliteError::Stopped(
                "Handle invalidated after stop(). Use runtime.get() to get a new handle.".into(),
            ));
        }

        // Ensure box is running
        let live = self.live_state().await?;

        if host_src.is_dir() {
            opts.validate_for_dir()?;
        }

        if container_dst.is_empty() {
            return Err(BoxliteError::Config(
                "destination path cannot be empty".into(),
            ));
        }

        let temp_tar = self
            .runtime
            .layout
            .temp_dir()
            .join(format!("cp-in-{}.tar", self.config.id.as_str()));

        build_tar_from_host(host_src, &temp_tar, &opts)?;

        let mut files_iface = live.guest_session.files().await?;
        files_iface
            .upload_tar(
                &temp_tar,
                container_dst,
                Some(self.container_id()),
                true,
                opts.overwrite,
            )
            .await?;

        let _ = tokio::fs::remove_file(&temp_tar).await;
        Ok(())
    }

    pub(crate) async fn copy_out(
        &self,
        container_src: &str,
        host_dst: &std::path::Path,
        opts: CopyOptions,
    ) -> BoxliteResult<()> {
        // Check if box is stopped before proceeding
        if self.shutdown_token.is_cancelled() {
            return Err(BoxliteError::Stopped(
                "Handle invalidated after stop(). Use runtime.get() to get a new handle.".into(),
            ));
        }

        // Ensure box is running
        let live = self.live_state().await?;

        if container_src.is_empty() {
            return Err(BoxliteError::Config("source path cannot be empty".into()));
        }

        let temp_tar = self
            .runtime
            .layout
            .temp_dir()
            .join(format!("cp-out-{}.tar", self.config.id.as_str()));

        let mut files_iface = live.guest_session.files().await?;
        files_iface
            .download_tar(
                container_src,
                Some(self.container_id()),
                opts.include_parent,
                opts.follow_symlinks,
                &temp_tar,
            )
            .await?;

        extract_tar_to_host(&temp_tar, host_dst, opts.overwrite)?;
        let _ = tokio::fs::remove_file(&temp_tar).await;
        Ok(())
    }

    // ========================================================================
    // LIVE STATE INITIALIZATION (internal)
    // ========================================================================

    /// Get LiveState, lazily initializing it if needed.
    async fn live_state(&self) -> BoxliteResult<&LiveState> {
        self.live.get_or_try_init(|| self.init_live_state()).await
    }

    /// Initialize LiveState via BoxBuilder.
    ///
    /// BoxBuilder handles all status types with different execution plans:
    /// - Configured: full pipeline (filesystem, rootfs, spawn, connect, init)
    /// - Stopped: restart pipeline (reuse rootfs, spawn, connect, init)
    /// - Running: attach pipeline (attach, connect)
    ///
    /// Note: Lock is allocated in create(), not here. DB persistence also
    /// happens in create().
    async fn init_live_state(&self) -> BoxliteResult<LiveState> {
        use super::BoxBuilder;
        use crate::util::read_pid_file;
        use std::sync::Arc;

        let state = self.state.read().clone();
        let is_first_start = state.status == BoxStatus::Configured;

        // Retrieve the lock (allocated in create())
        let lock_id = state.lock_id.ok_or_else(|| {
            BoxliteError::Internal(format!(
                "box {} is missing lock_id (status: {:?})",
                self.config.id, state.status
            ))
        })?;
        let locker = self.runtime.lock_manager.retrieve(lock_id)?;
        tracing::debug!(
            box_id = %self.config.id,
            lock_id = %lock_id,
            "Acquired lock for box (first_start={})",
            is_first_start
        );

        // Hold the lock for the duration of build operations.
        // LockGuard acquires lock on creation and releases on drop.
        let _guard = LockGuard::new(&*locker);

        // Build the box (lock is held)
        // The returned cleanup_guard stays armed until we disarm it after all
        // operations succeed. If any operation fails, the guard's Drop will
        // cleanup the VM process and directory.
        let builder = BoxBuilder::new(Arc::clone(&self.runtime), self.config.clone(), state)?;
        let (live_state, mut cleanup_guard) = builder.build().await?;

        // Read PID from file (single source of truth) and update state.
        //
        // The PID file is written by pre_exec hook immediately after fork().
        // This is crash-safe: if we reach this point, the shim is running
        // and the PID file exists.
        //
        // For reattach (status=Running), the PID file was written during
        // the original spawn and is still valid.
        {
            let pid_file = self
                .runtime
                .layout
                .boxes_dir()
                .join(self.config.id.as_str())
                .join("shim.pid");

            let pid = read_pid_file(&pid_file)?;

            let mut state = self.state.write();
            state.set_pid(Some(pid));
            state.set_status(BoxStatus::Running);

            // Save to DB (cache for queries and recovery)
            self.runtime.box_manager.save_box(&self.config.id, &state)?;

            tracing::debug!(
                box_id = %self.config.id,
                pid = pid,
                "Read PID from file and saved to DB"
            );
        }

        // All operations succeeded - disarm the cleanup guard
        cleanup_guard.disarm();

        tracing::info!(
            box_id = %self.config.id,
            "Box started successfully (first_start={})",
            is_first_start
        );

        // Lock is automatically released when _guard drops
        Ok(live_state)
    }
}

// ============================================================================
// BoxBackend trait implementation
// ============================================================================

#[async_trait::async_trait]
impl crate::runtime::backend::BoxBackend for BoxImpl {
    fn id(&self) -> &BoxID {
        self.id()
    }

    fn name(&self) -> Option<&str> {
        self.config.name.as_deref()
    }

    fn info(&self) -> BoxInfo {
        self.info()
    }

    async fn start(&self) -> BoxliteResult<()> {
        self.start().await
    }

    async fn exec(&self, command: BoxCommand) -> BoxliteResult<Execution> {
        self.exec(command).await
    }

    async fn metrics(&self) -> BoxliteResult<BoxMetrics> {
        self.metrics().await
    }

    async fn stop(&self) -> BoxliteResult<()> {
        self.stop().await
    }

    async fn copy_into(
        &self,
        host_src: &std::path::Path,
        container_dst: &str,
        opts: CopyOptions,
    ) -> BoxliteResult<()> {
        self.copy_into(host_src, container_dst, opts).await
    }

    async fn copy_out(
        &self,
        container_src: &str,
        host_dst: &std::path::Path,
        opts: CopyOptions,
    ) -> BoxliteResult<()> {
        self.copy_out(container_src, host_dst, opts).await
    }
}

fn build_tar_from_host(
    src: &std::path::Path,
    tar_path: &std::path::Path,
    opts: &CopyOptions,
) -> BoxliteResult<()> {
    let src = src.to_path_buf();
    let tar_path = tar_path.to_path_buf();
    let follow = opts.follow_symlinks;
    let include_parent = opts.include_parent;

    tokio::task::block_in_place(|| {
        let tar_file = std::fs::File::create(&tar_path).map_err(|e| {
            BoxliteError::Storage(format!(
                "failed to create tar {}: {}",
                tar_path.display(),
                e
            ))
        })?;
        let mut builder = tar::Builder::new(tar_file);
        builder.follow_symlinks(follow);

        if src.is_dir() {
            let base = if include_parent {
                src.file_name()
                    .map(|s| s.to_owned())
                    .unwrap_or_else(|| std::ffi::OsStr::new("root").to_owned())
            } else {
                std::ffi::OsStr::new(".").to_owned()
            };
            builder
                .append_dir_all(base, &src)
                .map_err(|e| BoxliteError::Storage(format!("failed to archive dir: {}", e)))?;
        } else {
            let name = src
                .file_name()
                .ok_or_else(|| BoxliteError::Config("source file has no name".into()))?;
            builder
                .append_path_with_name(&src, name)
                .map_err(|e| BoxliteError::Storage(format!("failed to archive file: {}", e)))?;
        }

        builder
            .finish()
            .map_err(|e| BoxliteError::Storage(format!("failed to finish tar: {}", e)))
    })
}

/// Whether to extract as a single file or into a directory.
enum ExtractionMode {
    /// Destination is a file path — extract the single tar entry directly to it.
    FileToFile,
    /// Destination is a directory — extract all tar entries into it.
    IntoDirectory,
}

/// Inspect the destination path and tar contents to decide extraction mode.
///
/// Rules (evaluated in order):
/// 1. Dest path has trailing `/` → directory mode
/// 2. Dest exists as a directory → directory mode
/// 3. Tar contains exactly one regular file → file-to-file mode
/// 4. Fallback → directory mode
fn determine_extraction_mode(
    dest: &std::path::Path,
    tar_path: &std::path::Path,
) -> BoxliteResult<ExtractionMode> {
    if dest.as_os_str().to_string_lossy().ends_with('/') {
        return Ok(ExtractionMode::IntoDirectory);
    }
    if dest.is_dir() {
        return Ok(ExtractionMode::IntoDirectory);
    }
    let tar_file = std::fs::File::open(tar_path).map_err(|e| {
        BoxliteError::Storage(format!("failed to open tar {}: {}", tar_path.display(), e))
    })?;
    let mut archive = tar::Archive::new(tar_file);
    if let Ok(entries) = archive.entries() {
        let mut count = 0u32;
        let mut is_regular = false;
        for entry in entries {
            count += 1;
            if count > 1 {
                break;
            }
            if let Ok(e) = entry {
                is_regular = e.header().entry_type() == tar::EntryType::Regular;
            }
        }
        if count == 1 && is_regular {
            return Ok(ExtractionMode::FileToFile);
        }
    }
    Ok(ExtractionMode::IntoDirectory)
}

fn extract_tar_to_host(
    tar_path: &std::path::Path,
    dest: &std::path::Path,
    overwrite: bool,
) -> BoxliteResult<()> {
    tokio::task::block_in_place(|| {
        let mode = determine_extraction_mode(dest, tar_path)?;

        match mode {
            ExtractionMode::FileToFile => {
                if !overwrite && dest.exists() {
                    return Err(BoxliteError::Storage(format!(
                        "destination {} exists and overwrite=false",
                        dest.display()
                    )));
                }
                if let Some(parent) = dest.parent()
                    && !parent.exists()
                {
                    std::fs::create_dir_all(parent).map_err(|e| {
                        BoxliteError::Storage(format!(
                            "failed to create parent dir {}: {}",
                            parent.display(),
                            e
                        ))
                    })?;
                }
                let tar_file = std::fs::File::open(tar_path).map_err(|e| {
                    BoxliteError::Storage(format!(
                        "failed to open tar {}: {}",
                        tar_path.display(),
                        e
                    ))
                })?;
                let mut archive = tar::Archive::new(tar_file);
                let mut entries = archive.entries().map_err(|e| {
                    BoxliteError::Storage(format!("failed to read tar entries: {}", e))
                })?;
                if let Some(entry) = entries.next() {
                    let mut entry = entry.map_err(|e| {
                        BoxliteError::Storage(format!("failed to read tar entry: {}", e))
                    })?;
                    entry.unpack(dest).map_err(|e| {
                        BoxliteError::Storage(format!(
                            "failed to unpack file to {}: {}",
                            dest.display(),
                            e
                        ))
                    })?;
                }
                Ok(())
            }
            ExtractionMode::IntoDirectory => {
                if dest.exists() && !overwrite {
                    return Err(BoxliteError::Storage(format!(
                        "destination {} exists and overwrite=false",
                        dest.display()
                    )));
                }
                let tar_file = std::fs::File::open(tar_path).map_err(|e| {
                    BoxliteError::Storage(format!(
                        "failed to open tar {}: {}",
                        tar_path.display(),
                        e
                    ))
                })?;
                let mut archive = tar::Archive::new(tar_file);
                archive
                    .unpack(dest)
                    .map_err(|e| BoxliteError::Storage(format!("failed to extract archive: {}", e)))
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn tar_roundtrip_file() {
        // Multi-threaded runtime required for block_in_place
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();

        rt.block_on(async {
            let tmp = TempDir::new().unwrap();
            let src_dir = tmp.path().join("src");
            std::fs::create_dir(&src_dir).unwrap();
            let file = src_dir.join("hello.txt");
            std::fs::write(&file, b"hello").unwrap();

            let tar_path = tmp.path().join("out.tar");
            let opts = CopyOptions {
                include_parent: true,
                ..CopyOptions::default()
            };
            build_tar_from_host(&src_dir, &tar_path, &opts).unwrap();

            let dest_dir = tmp.path().join("dest");
            std::fs::create_dir(&dest_dir).unwrap();
            extract_tar_to_host(&tar_path, &dest_dir, true).unwrap();

            let extracted = dest_dir.join("src").join("hello.txt");
            let data = std::fs::read_to_string(extracted).unwrap();
            assert_eq!(data, "hello");
        });
    }

    /// Helper: create a tar containing a single file with the given entry name and content.
    fn create_single_file_tar(tar_path: &std::path::Path, entry_name: &str, content: &[u8]) {
        let tar_file = std::fs::File::create(tar_path).unwrap();
        let mut builder = tar::Builder::new(tar_file);
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, entry_name, content)
            .unwrap();
        builder.finish().unwrap();
    }

    /// Helper: create a tar containing a directory with files inside.
    fn create_dir_tar(tar_path: &std::path::Path) {
        let tar_file = std::fs::File::create(tar_path).unwrap();
        let mut builder = tar::Builder::new(tar_file);

        // Add a directory entry
        let mut dir_header = tar::Header::new_gnu();
        dir_header.set_entry_type(tar::EntryType::Directory);
        dir_header.set_size(0);
        dir_header.set_mode(0o755);
        dir_header.set_cksum();
        builder
            .append_data(&mut dir_header, "mydir/", &[] as &[u8])
            .unwrap();

        // Add a file inside the directory
        let content = b"inside dir";
        let mut file_header = tar::Header::new_gnu();
        file_header.set_size(content.len() as u64);
        file_header.set_mode(0o644);
        file_header.set_cksum();
        builder
            .append_data(&mut file_header, "mydir/file.txt", &content[..])
            .unwrap();

        builder.finish().unwrap();
    }

    #[test]
    fn extraction_mode_single_file_no_trailing_slash() {
        let tmp = TempDir::new().unwrap();
        let tar_path = tmp.path().join("single.tar");
        create_single_file_tar(&tar_path, "hello.txt", b"hello");

        let dest = tmp.path().join("output.txt");
        let mode = determine_extraction_mode(&dest, &tar_path).unwrap();
        assert!(matches!(mode, ExtractionMode::FileToFile));
    }

    #[test]
    fn extraction_mode_single_file_trailing_slash() {
        let tmp = TempDir::new().unwrap();
        let tar_path = tmp.path().join("single.tar");
        create_single_file_tar(&tar_path, "hello.txt", b"hello");

        // Trailing slash → directory mode even for single-file tar
        let dest = std::path::Path::new("/tmp/some_dir/");
        let mode = determine_extraction_mode(dest, &tar_path).unwrap();
        assert!(matches!(mode, ExtractionMode::IntoDirectory));
    }

    #[test]
    fn extraction_mode_single_file_dest_is_existing_dir() {
        let tmp = TempDir::new().unwrap();
        let tar_path = tmp.path().join("single.tar");
        create_single_file_tar(&tar_path, "hello.txt", b"hello");

        // Dest exists as a directory → directory mode
        let dest = tmp.path(); // this IS a directory
        let mode = determine_extraction_mode(dest, &tar_path).unwrap();
        assert!(matches!(mode, ExtractionMode::IntoDirectory));
    }

    #[test]
    fn extraction_mode_multi_entry_tar() {
        let tmp = TempDir::new().unwrap();
        let tar_path = tmp.path().join("multi.tar");
        create_dir_tar(&tar_path);

        let dest = tmp.path().join("output");
        let mode = determine_extraction_mode(&dest, &tar_path).unwrap();
        assert!(matches!(mode, ExtractionMode::IntoDirectory));
    }

    #[test]
    fn extract_single_file_to_file_path() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();

        rt.block_on(async {
            let tmp = TempDir::new().unwrap();

            // Create a single-file tar
            let src_file = tmp.path().join("source.py");
            std::fs::write(&src_file, b"print('hello')").unwrap();
            let tar_path = tmp.path().join("file.tar");
            let opts = CopyOptions::default();
            build_tar_from_host(&src_file, &tar_path, &opts).unwrap();

            // Extract to a file path (not a directory)
            let dest_file = tmp.path().join("dest_dir").join("script.py");
            extract_tar_to_host(&tar_path, &dest_file, true).unwrap();

            // Verify it's a file, not a directory
            assert!(dest_file.is_file(), "dest should be a regular file");
            let data = std::fs::read_to_string(&dest_file).unwrap();
            assert_eq!(data, "print('hello')");
        });
    }

    #[test]
    fn extract_single_file_to_existing_dir() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();

        rt.block_on(async {
            let tmp = TempDir::new().unwrap();

            // Create a single-file tar
            let src_file = tmp.path().join("source.py");
            std::fs::write(&src_file, b"print('hello')").unwrap();
            let tar_path = tmp.path().join("file.tar");
            let opts = CopyOptions::default();
            build_tar_from_host(&src_file, &tar_path, &opts).unwrap();

            // Extract to an existing directory — should copy INTO the dir
            let dest_dir = tmp.path().join("workspace");
            std::fs::create_dir(&dest_dir).unwrap();
            extract_tar_to_host(&tar_path, &dest_dir, true).unwrap();

            // File should be inside the directory with its original name
            let extracted = dest_dir.join("source.py");
            assert!(extracted.is_file(), "file should be inside the directory");
            let data = std::fs::read_to_string(&extracted).unwrap();
            assert_eq!(data, "print('hello')");
        });
    }

    /// Regression test for #238: copy_in creates directory when destination is a file path.
    /// This is the exact scenario from the issue report.
    #[test]
    fn issue_238_file_to_file_path_not_directory() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();

        rt.block_on(async {
            let tmp = TempDir::new().unwrap();

            // Create source file (simulating /tmp/test_copy/script.py)
            let src_file = tmp.path().join("script.py");
            std::fs::write(&src_file, b"print('hello')\n").unwrap();

            let tar_path = tmp.path().join("issue238.tar");
            let opts = CopyOptions::default();
            build_tar_from_host(&src_file, &tar_path, &opts).unwrap();

            // Extract to /workspace/script.py — the bug created a DIRECTORY here
            let workspace = tmp.path().join("workspace");
            std::fs::create_dir(&workspace).unwrap();
            let dest_file = workspace.join("script.py");
            extract_tar_to_host(&tar_path, &dest_file, true).unwrap();

            // MUST be a regular file, NOT a directory
            assert!(
                dest_file.is_file(),
                "script.py should be a file, not a directory (issue #238)"
            );
            assert!(
                !dest_file.is_dir(),
                "script.py must NOT be a directory (issue #238)"
            );
            let data = std::fs::read_to_string(&dest_file).unwrap();
            assert_eq!(data, "print('hello')\n");
        });
    }

    #[test]
    fn extract_file_to_file_creates_parent_dirs() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();

        rt.block_on(async {
            let tmp = TempDir::new().unwrap();
            let tar_path = tmp.path().join("file.tar");
            create_single_file_tar(&tar_path, "data.txt", b"content");

            // Deep nested path — parent dirs should be created automatically
            let dest = tmp.path().join("a").join("b").join("c").join("data.txt");
            extract_tar_to_host(&tar_path, &dest, true).unwrap();

            assert!(dest.is_file());
            assert_eq!(std::fs::read_to_string(&dest).unwrap(), "content");
        });
    }

    #[test]
    fn extract_file_to_file_overwrite_false_rejects_existing() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();

        rt.block_on(async {
            let tmp = TempDir::new().unwrap();
            let tar_path = tmp.path().join("file.tar");
            create_single_file_tar(&tar_path, "data.txt", b"new content");

            // Create existing file at dest
            let dest = tmp.path().join("data.txt");
            std::fs::write(&dest, b"old content").unwrap();

            // overwrite=false should fail
            let result = extract_tar_to_host(&tar_path, &dest, false);
            assert!(
                result.is_err(),
                "should reject overwrite when overwrite=false"
            );

            // Original content preserved
            assert_eq!(std::fs::read_to_string(&dest).unwrap(), "old content");
        });
    }

    #[test]
    fn extract_file_to_file_overwrite_true_replaces_existing() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();

        rt.block_on(async {
            let tmp = TempDir::new().unwrap();
            let tar_path = tmp.path().join("file.tar");
            create_single_file_tar(&tar_path, "data.txt", b"new content");

            // Create existing file at dest
            let dest = tmp.path().join("data.txt");
            std::fs::write(&dest, b"old content").unwrap();

            // overwrite=true should succeed
            extract_tar_to_host(&tar_path, &dest, true).unwrap();
            assert_eq!(std::fs::read_to_string(&dest).unwrap(), "new content");
        });
    }

    #[test]
    fn extract_dir_tar_into_directory() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();

        rt.block_on(async {
            let tmp = TempDir::new().unwrap();
            let tar_path = tmp.path().join("dir.tar");
            create_dir_tar(&tar_path);

            // Extract multi-entry tar to a directory — should use directory mode
            let dest = tmp.path().join("output");
            std::fs::create_dir(&dest).unwrap();
            extract_tar_to_host(&tar_path, &dest, true).unwrap();

            let extracted = dest.join("mydir").join("file.txt");
            assert!(extracted.is_file());
            assert_eq!(std::fs::read_to_string(&extracted).unwrap(), "inside dir");
        });
    }

    #[test]
    fn extraction_mode_single_dir_entry() {
        let tmp = TempDir::new().unwrap();
        let tar_path = tmp.path().join("dir_only.tar");

        // Create a tar with a single directory entry (not a regular file)
        let tar_file = std::fs::File::create(&tar_path).unwrap();
        let mut builder = tar::Builder::new(tar_file);
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Directory);
        header.set_size(0);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, "somedir/", &[] as &[u8])
            .unwrap();
        builder.finish().unwrap();

        let dest = tmp.path().join("output");
        let mode = determine_extraction_mode(&dest, &tar_path).unwrap();
        // Single directory entry → NOT file-to-file, should be directory mode
        assert!(matches!(mode, ExtractionMode::IntoDirectory));
    }

    #[test]
    fn extraction_mode_empty_tar() {
        let tmp = TempDir::new().unwrap();
        let tar_path = tmp.path().join("empty.tar");

        // Create an empty tar
        let tar_file = std::fs::File::create(&tar_path).unwrap();
        let builder = tar::Builder::new(tar_file);
        builder.into_inner().unwrap();

        let dest = tmp.path().join("output");
        let mode = determine_extraction_mode(&dest, &tar_path).unwrap();
        // Empty tar → directory mode (fallback)
        assert!(matches!(mode, ExtractionMode::IntoDirectory));
    }
}
