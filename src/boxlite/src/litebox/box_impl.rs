//! Box implementation - holds config, state, and lazily-initialized VM resources.

// ============================================================================
// IMPORTS
// ============================================================================

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use parking_lot::RwLock;
use tokio::sync::OnceCell;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::config::BoxConfig;
use super::exec::{BoxCommand, ExecStderr, ExecStdin, ExecStdout, Execution};
use super::state::BoxState;
use crate::disk::Disk;
use crate::event_listener::EventListener;
#[cfg(target_os = "linux")]
use crate::fs::BindMountHandle;
use crate::litebox::copy::CopyOptions;
use crate::lock::LockGuard;
use crate::metrics::{BoxMetrics, BoxMetricsStorage};
use crate::portal::GuestSession;
use crate::portal::interfaces::GuestInterface;
use crate::runtime::rt_impl::SharedRuntimeImpl;
use crate::runtime::types::BoxStatus;
use crate::vmm::controller::VmmHandler;
use crate::{BoxID, BoxInfo, HealthCheckOptions, HealthState};

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
    pub(crate) state: Arc<RwLock<BoxState>>,
    pub(crate) runtime: SharedRuntimeImpl,
    /// Cancellation token for this box (child of runtime's token).
    /// When cancelled (via stop() or runtime shutdown), all operations abort gracefully.
    pub(crate) shutdown_token: CancellationToken,
    /// Serializes disk-mutating snapshot/clone/export operations.
    /// Prevents concurrent disk mutations (rename, delete, flatten) from racing.
    pub(crate) disk_ops: tokio::sync::Mutex<()>,

    /// Event listeners (from runtime options).
    pub(crate) event_listeners: Vec<std::sync::Arc<dyn EventListener>>,

    // --- Lazily initialized ---
    live: OnceCell<LiveState>,

    health_check_task: RwLock<Option<JoinHandle<()>>>,
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
            state: Arc::new(RwLock::new(state)),
            runtime,
            shutdown_token,
            disk_ops: tokio::sync::Mutex::new(()),
            event_listeners: Vec::new(), // populated from runtime options
            live: OnceCell::new(),
            health_check_task: RwLock::new(None),
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
        let t0 = Instant::now();

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

        for listener in &self.event_listeners {
            listener.on_box_started(&self.config.id);
        }

        tracing::info!(
            box_id = %self.config.id,
            elapsed_ms = t0.elapsed().as_millis() as u64,
            "Box started"
        );
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

        for listener in &self.event_listeners {
            listener.on_exec_started(&self.config.id, &command.command, &command.args);
        }

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
        let t0 = Instant::now();

        // Early exit if already stopped (idempotent, prevents double-counting)
        // Note: We check status, not shutdown_token, because the token may be cancelled
        // by runtime.shutdown() before stop() is called on each box.
        if self.state.read().status == BoxStatus::Stopped {
            return Ok(());
        }

        // Cancel health check task first (if running)
        // This prevents the task from continuing after stop() completes
        if let Some(task) = self.health_check_task.write().take() {
            tracing::debug!(
                box_id = %self.config.id,
                "Aborting health check task"
            );
            task.abort();
        }

        // Clear health status (box is no longer running)
        {
            let mut state = self.state.write();
            state.clear_health_status();
        }

        // Cancel the token - signals all in-flight operations to abort
        self.shutdown_token.cancel();

        // Only try to stop VM if LiveState exists
        if let Some(live) = self.live.get() {
            // Gracefully shut down guest (with timeout to avoid hanging on unresponsive guests)
            let guest_shutdown = async {
                if let Ok(mut guest) = live.guest_session.guest().await {
                    let _ = guest.shutdown().await;
                }
            };
            if tokio::time::timeout(Duration::from_secs(10), guest_shutdown)
                .await
                .is_err()
            {
                tracing::warn!(box_id = %self.config.id, "Guest shutdown timed out after 10s");
            }

            // Stop handler
            if let Ok(mut handler) = live.handler.lock() {
                handler.stop()?;
            }
        } else if let Some(pid) = self.state.read().pid {
            // Recovered box path: this BoxImpl was constructed for a box that
            // was already Running before this runtime instance started, so
            // self.live was never initialized. The original shim process is
            // still alive under state.pid — signal it directly, otherwise the
            // box transitions to Stopped while the process keeps running and
            // we leak an orphan.
            crate::util::kill_process(pid);
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

        for listener in &self.event_listeners {
            listener.on_box_stopped(&self.config.id, None);
        }

        tracing::info!(
            box_id = %self.config.id,
            elapsed_ms = t0.elapsed().as_millis() as u64,
            "Box stopped"
        );

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
        let t0 = Instant::now();

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

        let temp_tar = self.runtime.layout.temp_dir().join(format!(
            "cp-in-{}-{}.tar",
            self.config.id.as_str(),
            uuid::Uuid::new_v4()
        ));

        boxlite_shared::tar::pack(
            host_src.to_path_buf(),
            temp_tar.clone(),
            boxlite_shared::tar::PackContext {
                follow_symlinks: opts.follow_symlinks,
                include_parent: opts.include_parent,
            },
        )
        .await?;

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

        for listener in &self.event_listeners {
            listener.on_file_copied_in(
                &self.config.id,
                &host_src.display().to_string(),
                container_dst,
            );
        }

        tracing::info!(
            box_id = %self.config.id,
            elapsed_ms = t0.elapsed().as_millis() as u64,
            src = %host_src.display(),
            dst = container_dst,
            "copy_into completed"
        );
        Ok(())
    }

    pub(crate) async fn copy_out(
        &self,
        container_src: &str,
        host_dst: &std::path::Path,
        opts: CopyOptions,
    ) -> BoxliteResult<()> {
        let t0 = Instant::now();

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

        let temp_tar = self.runtime.layout.temp_dir().join(format!(
            "cp-out-{}-{}.tar",
            self.config.id.as_str(),
            uuid::Uuid::new_v4()
        ));

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

        boxlite_shared::tar::unpack(
            temp_tar.clone(),
            host_dst.to_path_buf(),
            boxlite_shared::tar::UnpackContext {
                overwrite: opts.overwrite,
                mkdir_parents: true,
                force_directory: false,
            },
        )
        .await?;
        let _ = tokio::fs::remove_file(&temp_tar).await;

        for listener in &self.event_listeners {
            listener.on_file_copied_out(
                &self.config.id,
                container_src,
                &host_dst.display().to_string(),
            );
        }

        tracing::info!(
            box_id = %self.config.id,
            elapsed_ms = t0.elapsed().as_millis() as u64,
            src = container_src,
            dst = %host_dst.display(),
            "copy_out completed"
        );
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

            // Initialize health status if health check is configured
            if self.config.options.advanced.health_check.is_some() {
                state.init_health_status();
            }

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

        // Start health check task if configured
        if let Some(ref health_config) = self.config.options.advanced.health_check {
            // Get guest interface from session
            let guest = live_state.guest_session.guest().await?;

            // Spawn health check task
            let health_task = self.spawn_health_check(
                Arc::clone(&self.state),
                self.config.id.clone(),
                health_config.to_owned(),
                guest,
                self.shutdown_token.child_token(),
                Arc::clone(&self.runtime),
            );
            *self.health_check_task.write() = Some(health_task);
        }

        tracing::info!(
            box_id = %self.config.id,
            "Box started successfully (first_start={})",
            is_first_start
        );
        // Lock is automatically released when _guard drops
        Ok(live_state)
    }

    pub fn spawn_health_check(
        &self,
        state: Arc<RwLock<BoxState>>,
        box_id: BoxID,
        health_config: HealthCheckOptions,
        mut guest: GuestInterface,
        shutdown_token: CancellationToken,
        runtime: SharedRuntimeImpl,
    ) -> JoinHandle<()> {
        let interval = health_config.interval;
        let check_timeout = health_config.timeout;
        let retries = health_config.retries;
        let start_period = health_config.start_period;

        tokio::spawn(async move {
            let start_time = Instant::now();
            let mut last_health_state = state.read().health_status;

            tracing::info!(
                box_id = %box_id,
                interval_secs = interval.as_secs(),
                timeout_secs = check_timeout.as_secs(),
                retries,
                start_period_secs = start_period.as_secs(),
                "Health check task started"
            );

            loop {
                tokio::select! {
                    _ = tokio::time::sleep(interval) => {},
                    _ = shutdown_token.cancelled() => {
                        tracing::debug!(
                            box_id = %box_id,
                            "Health check task received shutdown signal during sleep"
                        );
                        break;
                    }
                }

                let elapsed = start_time.elapsed();
                let result = if elapsed < start_period {
                    tracing::debug!(
                        box_id = %box_id,
                        elapsed_ms = elapsed.as_millis(),
                        start_period_ms = start_period.as_millis(),
                        "In start period, skipping health check"
                    );

                    Ok(())
                } else {
                    let ping_result = timeout(check_timeout, guest.ping()).await;

                    match ping_result {
                        Ok(Ok(_)) => {
                            // Calculate new state
                            let new_state = HealthState::Healthy;
                            let new_failures = 0;

                            // Only update if state actually changed
                            if last_health_state.state != new_state
                                || last_health_state.failures != new_failures
                            {
                                let mut state_guard = state.write();
                                state_guard.mark_health_check_success();

                                if let Err(e) = runtime.box_manager.save_box(&box_id, &state_guard)
                                {
                                    tracing::error!(
                                        box_id = %box_id,
                                        error = %e,
                                        "Failed to persist health check success to database"
                                    );
                                }

                                // Update cache
                                last_health_state = state_guard.health_status;
                            }

                            Ok(())
                        }
                        Ok(Err(e)) => Err(e),
                        Err(_) => Err(BoxliteError::Internal(format!(
                            "Health check timed out after {}s",
                            check_timeout.as_secs()
                        ))),
                    }
                };

                // Update health status on failure and check if shim died
                if let Err(e) = result {
                    tracing::warn!(
                        box_id = %box_id,
                        error = %e,
                        "Health check failed"
                    );

                    // Step 1: Read pid (brief read lock)
                    let pid = state.read().pid;

                    // Step 2: Check if shim is alive (without holding lock)
                    let shim_died = if let Some(pid) = pid
                        && !crate::util::is_process_alive(pid)
                    {
                        tracing::error!(
                            box_id = %box_id,
                            pid,
                            "Shim process died, marking box as Stopped and Unhealthy"
                        );
                        true
                    } else {
                        false
                    };

                    // If shim died, mark as Unhealthy and stop health check immediately
                    if shim_died {
                        let mut state_guard = state.write();
                        state_guard.force_status(crate::litebox::BoxStatus::Stopped);
                        state_guard.set_pid(None);
                        state_guard.health_status.state = crate::litebox::HealthState::Unhealthy;

                        if let Err(db_err) = runtime.box_manager.save_box(&box_id, &state_guard) {
                            tracing::error!(
                                box_id = %box_id,
                                error = %db_err,
                                "Failed to persist health check state to database"
                            );
                        }
                        break;
                    }

                    // Step 3: Calculate new state (shim is still alive)
                    let new_failures = last_health_state.failures + 1;
                    let new_state = if new_failures >= retries {
                        HealthState::Unhealthy
                    } else {
                        last_health_state.state
                    };

                    // Step 4: Only update if state would actually change
                    if last_health_state.state != new_state
                        || last_health_state.failures != new_failures
                    {
                        let mut state_guard = state.write();
                        let became_unhealthy = state_guard.mark_health_check_failure(retries);

                        if let Err(db_err) = runtime.box_manager.save_box(&box_id, &state.read()) {
                            tracing::error!(
                                box_id = %box_id,
                                error = %db_err,
                                "Failed to persist health check state to database"
                            );
                        }

                        // Update cache
                        last_health_state = state_guard.health_status;

                        // Step 5: Stop health check task if became unhealthy
                        if became_unhealthy {
                            break;
                        }
                    }
                }
            }

            tracing::debug!(
                box_id = %box_id,
                "Health check task stopped"
            );
        })
    }
}

// ============================================================================
// QUIESCE / THAW (QEMU+libvirt style bracket pattern)
// ============================================================================

impl BoxImpl {
    /// Execute a future with the VM quiesced for point-in-time consistency.
    ///
    /// Follows the QEMU+libvirt quiesce protocol:
    ///   1. Guest Quiesce RPC (FIFREEZE — flush dirty pages + block new writes)
    ///   2. SIGSTOP shim process (pause vCPUs)
    ///   3. `fut` — caller's operation (disk copy, export, etc.)
    ///   4. SIGCONT shim process (resume vCPUs)
    ///   5. Guest Thaw RPC (FITHAW — unblock writes)
    ///
    /// If the VM is not running, `fut` is executed directly with no quiesce.
    /// Guest RPCs are best-effort with timeout — failure degrades to
    /// crash-consistent (SIGSTOP-only), not operation failure.
    pub(crate) async fn with_quiesce_async<Fut, R>(&self, fut: Fut) -> BoxliteResult<R>
    where
        Fut: std::future::Future<Output = BoxliteResult<R>>,
    {
        let (pid, was_running) = {
            let state = self.state.read();
            let running = state.status.is_running();
            let pid = if running {
                state.pid.map(|p| p as i32)
            } else {
                None
            };
            (pid, running)
        };

        let Some(pid) = pid else {
            if was_running {
                return Err(BoxliteError::Internal(
                    "Box is running but has no PID".to_string(),
                ));
            }
            // Not running — execute directly, no quiesce needed.
            return fut.await;
        };

        let t0 = Instant::now();

        // Phase 1: Freeze guest I/O (best-effort, 5s timeout)
        let t_quiesce = Instant::now();
        let frozen = self.guest_quiesce().await;
        let quiesce_ms = t_quiesce.elapsed().as_millis() as u64;

        // Phase 2: SIGSTOP — pause vCPUs
        // SAFETY: sending SIGSTOP to a known valid PID that we own (shim process).
        let ret = unsafe { libc::kill(pid, libc::SIGSTOP) };
        if ret != 0 {
            // If SIGSTOP fails, thaw before returning error
            if frozen {
                self.guest_thaw().await;
            }
            return Err(BoxliteError::Internal(format!(
                "Failed to SIGSTOP shim process (pid={}): {}",
                pid,
                std::io::Error::last_os_error()
            )));
        }
        {
            let mut state = self.state.write();
            state.force_status(BoxStatus::Paused);
            let _ = self.runtime.box_manager.save_box(self.id(), &state);
        }

        // Phase 3: Caller's operation
        let t_op = Instant::now();
        let result = fut.await;
        let operation_ms = t_op.elapsed().as_millis() as u64;

        // Phase 4: SIGCONT — resume vCPUs (always, even if f() failed)
        // SAFETY: Always send SIGCONT — harmless ESRCH if process already dead.
        unsafe {
            libc::kill(pid, libc::SIGCONT);
        }
        // Only transition to Running if process is still alive after resume.
        if unsafe { libc::kill(pid, 0) } == 0 {
            let mut state = self.state.write();
            state.force_status(BoxStatus::Running);
            let _ = self.runtime.box_manager.save_box(self.id(), &state);
        }

        // Phase 5: Thaw guest I/O (always, best-effort)
        let t_thaw = Instant::now();
        if frozen {
            self.guest_thaw().await;
        }
        let thaw_ms = t_thaw.elapsed().as_millis() as u64;

        tracing::info!(
            box_id = %self.id(),
            total_ms = t0.elapsed().as_millis() as u64,
            quiesce_ms,
            operation_ms,
            thaw_ms,
            frozen,
            "Quiesce bracket completed"
        );

        result
    }

    /// Best-effort guest filesystem quiesce (FIFREEZE) with timeout.
    /// Returns true if quiesce succeeded.
    async fn guest_quiesce(&self) -> bool {
        let Ok(live) = self.live_state().await else {
            tracing::warn!("Cannot quiesce: LiveState not available");
            return false;
        };

        let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let mut guest = live.guest_session.guest().await?;
            guest.quiesce().await
        })
        .await;

        match result {
            Ok(Ok(count)) => {
                tracing::debug!(frozen_count = count, "Guest filesystems quiesced");
                true
            }
            Ok(Err(e)) => {
                tracing::warn!(
                    "Guest quiesce RPC failed: {}, proceeding with crash-consistent snapshot",
                    e
                );
                false
            }
            Err(_) => {
                tracing::warn!(
                    "Guest quiesce timed out, proceeding with crash-consistent snapshot"
                );
                false
            }
        }
    }

    /// Best-effort guest filesystem thaw (FITHAW) with timeout.
    async fn guest_thaw(&self) {
        let Ok(live) = self.live_state().await else {
            tracing::warn!("Cannot thaw: LiveState not available");
            return;
        };

        let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let mut guest = live.guest_session.guest().await?;
            guest.thaw().await
        })
        .await;

        match result {
            Ok(Ok(count)) => {
                tracing::debug!(thawed_count = count, "Guest filesystems thawed");
            }
            Ok(Err(e)) => {
                tracing::warn!("Guest thaw RPC failed: {}", e);
            }
            Err(_) => {
                tracing::warn!("Guest thaw timed out");
            }
        }
    }
}

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

    async fn clone_box(
        &self,
        options: crate::runtime::options::CloneOptions,
        name: Option<String>,
    ) -> BoxliteResult<crate::LiteBox> {
        BoxImpl::clone_box(self, options, name).await
    }

    async fn clone_boxes(
        &self,
        options: crate::runtime::options::CloneOptions,
        count: usize,
        names: Vec<String>,
    ) -> BoxliteResult<Vec<crate::LiteBox>> {
        BoxImpl::clone_boxes(self, options, count, names).await
    }

    async fn export_box(
        &self,
        options: crate::runtime::options::ExportOptions,
        dest: &std::path::Path,
    ) -> BoxliteResult<crate::runtime::options::BoxArchive> {
        BoxImpl::export_box(self, options, dest).await
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::litebox::config::ContainerRuntimeConfig;
    use crate::runtime::id::BoxIDMint;
    use crate::runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec};
    use crate::runtime::rt_impl::RuntimeImpl;
    use crate::runtime::types::ContainerID;
    use crate::util::is_process_alive;
    use crate::vmm::VmmKind;
    use boxlite_shared::Transport;
    use chrono::Utc;
    use tempfile::TempDir;

    /// RAII guard so a panic between spawn and the end of the test still
    /// reaps the helper process — without it a failed assertion would leak a
    /// `sleep 300` for five minutes.
    struct ChildGuard(std::process::Child);

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    // Regression test for the silent-orphan bug in stop().
    //
    // Invariant: when stop() is called on a box whose self.live is None (the
    // recovered-box path — process started by a prior runtime instance, live
    // state never re-initialized in this one), the shim process recorded in
    // state.pid must be terminated. Otherwise the box transitions to Stopped
    // while the process keeps running and the runtime loses track of it.
    #[tokio::test]
    async fn test_stop_recovered_box_kills_orphan_process() {
        // Stand-in for a recovered shim: a sleeping process whose PID we'll record.
        let child = ChildGuard(
            std::process::Command::new("sleep")
                .arg("300")
                .spawn()
                .expect("spawn dummy process"),
        );
        let pid = child.0.id();

        let temp_dir = TempDir::new_in("/tmp").expect("create temp dir");
        let runtime = RuntimeImpl::new(BoxliteOptions {
            home_dir: temp_dir.path().to_path_buf(),
            image_registries: vec![],
        })
        .expect("create runtime");

        // Build a BoxConfig whose box_home lives under the runtime's layout.
        let id = BoxIDMint::mint();
        let box_home = runtime.layout.boxes_dir().join(id.as_str());
        let config = BoxConfig {
            id: id.clone(),
            name: None,
            created_at: Utc::now(),
            container: ContainerRuntimeConfig {
                id: ContainerID::new(),
            },
            options: BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                detach: false,
                auto_remove: false,
                ..Default::default()
            },
            engine_kind: VmmKind::Libkrun,
            transport: Transport::Unix {
                socket_path: "/tmp/test.sock".into(),
            },
            box_home: box_home.clone(),
            ready_socket_path: std::path::PathBuf::from("/tmp/test-ready.sock"),
        };

        // Simulate a recovered Running box: status=Running, pid set, lock + pid file present.
        let mut state = BoxState::new();
        state.status = BoxStatus::Running;
        state.pid = Some(pid);
        let lock_id = runtime.lock_manager.allocate().expect("allocate lock");
        state.set_lock_id(lock_id);

        std::fs::create_dir_all(&box_home).expect("create box dir");
        let pid_file = box_home.join("shim.pid");
        std::fs::write(&pid_file, pid.to_string()).expect("write pid file");

        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("add box to manager");

        // runtime.get returns a fresh LiteBox — its inner BoxImpl has self.live = OnceCell::new().
        // This is the precondition that exercises the recovered-box branch in stop().
        let litebox = runtime
            .get(config.id.as_str())
            .await
            .expect("get box")
            .expect("box exists");

        litebox.stop().await.expect("stop should succeed");

        // Give SIGKILL a moment to land.
        std::thread::sleep(std::time::Duration::from_millis(200));

        assert!(
            !is_process_alive(pid),
            "stop() must kill the recovered shim process when self.live is None"
        );

        // ChildGuard's Drop reaps the (now-dead) child.
        drop(child);
    }
}
