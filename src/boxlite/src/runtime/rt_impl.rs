use crate::db::{BoxStore, Database};
use crate::images::{ImageDiskManager, ImageManager};
use crate::init_logging_for;
use crate::litebox::config::BoxConfig;
use crate::litebox::{BoxManager, LiteBox, LocalSnapshotBackend, SharedBoxImpl, StopCause};
use crate::lock::{FileLockManager, LockManager};
use crate::metrics::{RuntimeMetrics, RuntimeMetricsStorage};
use crate::rootfs::guest::{GuestRootfs, GuestRootfsManager};
use crate::runtime::advanced_options::{RestartPolicy, calculate_backoff};
use crate::runtime::constants::filenames;
use crate::runtime::id::{BoxID, BoxIDMint};
use crate::runtime::layout::dirs::EXIT_FILE;
use crate::runtime::layout::{FilesystemLayout, FsLayoutConfig};
use crate::runtime::lock::RuntimeLock;
use crate::runtime::options::{BoxArchive, BoxOptions, BoxliteOptions};
use crate::runtime::signal_handler::timeout_to_duration;
use crate::runtime::types::{BoxInfo, BoxState, BoxStatus, ContainerID};
use crate::vmm::{ExitInfo, VmmKind};
use boxlite_shared::{BoxliteError, BoxliteResult, Transport};
use chrono::Utc;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, RwLock, Weak};
use tokio::sync::{OnceCell, mpsc};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

fn litebox_from_impl(box_impl: SharedBoxImpl) -> LiteBox {
    let box_backend: Arc<dyn crate::runtime::backend::BoxBackend> = box_impl.clone();
    let snapshot_backend: Arc<dyn crate::runtime::backend::SnapshotBackend> =
        Arc::new(LocalSnapshotBackend::new(box_impl));
    LiteBox::new(box_backend, snapshot_backend)
}

fn read_box_exit_code(box_home: &Path) -> Option<i32> {
    let exit_file = box_home.join(EXIT_FILE);
    ExitInfo::from_file(&exit_file).map(|info| info.exit_code())
}

fn stop_cause_when_restart_denied(
    restart_policy: Option<&RestartPolicy>,
    exit_code: Option<i32>,
    max_retries_exhausted: bool,
) -> StopCause {
    match restart_policy {
        None | Some(RestartPolicy::No) => StopCause::CrashedNoPolicy,
        Some(RestartPolicy::OnFailure { .. }) if exit_code == Some(0) => StopCause::Normal,
        Some(RestartPolicy::OnFailure { .. }) if max_retries_exhausted => {
            StopCause::MaxRetriesExceeded
        }
        Some(RestartPolicy::OnFailure { .. }) => {
            // This branch should be unreachable:
            // - exit_code != 0 (caught by guard above)
            // - !max_retries_exhausted (caught by guard above)
            // For OnFailure, non-zero exit + under max_retries should restart, not deny.
            tracing::error!(
                exit_code = ?exit_code,
                max_retries_exhausted,
                "BUG: Unreachable branch reached in stop_cause_when_restart_denied"
            );
            debug_assert!(false, "Unreachable branch reached");
            StopCause::Unknown
        }
        Some(RestartPolicy::Always) => {
            // Always policy should never deny restart - this is a bug
            tracing::error!("BUG: Always policy should not reach stop_cause_when_restart_denied");
            debug_assert!(false, "Always policy should never deny restart");
            StopCause::Unknown
        }
        Some(RestartPolicy::UnlessStopped) => {
            // UnlessStopped only denies restart when user explicitly stopped (cause == Normal)
            // At this point, exit_code == 0 indicates a clean exit from user stop
            StopCause::Normal
        }
    }
}

/// Internal runtime state protected by single lock.
///
/// **Shared via Arc**: This is the actual shared state that can be cloned cheaply.
pub type SharedRuntimeImpl = Arc<RuntimeImpl>;

/// Runtime inner implementation.
///
/// **Locking Strategy**:
/// - `sync_state`: Empty coordination lock - acquire when multi-step operations
///   on box_manager/image_manager need atomicity
/// - All managers have internal locking for individual operations
/// - Immutable fields: No lock needed - never change after creation
/// - Atomic fields: Lock-free (RuntimeMetricsStorage uses AtomicU64)
pub struct RuntimeImpl {
    /// Coordination lock for multi-step atomic operations.
    /// Acquire this BEFORE accessing box_manager/image_manager
    /// when you need atomicity across multiple operations.
    pub(crate) sync_state: RwLock<SynchronizedState>,

    // ========================================================================
    // COORDINATION REQUIRED: Acquire sync_state lock for multi-step operations
    // ========================================================================
    /// Box manager with integrated persistence (has internal RwLock)
    pub(crate) box_manager: BoxManager,
    /// Image management (has internal RwLock via ImageStore)
    pub(crate) image_manager: ImageManager,

    // ========================================================================
    // NO COORDINATION NEEDED: Immutable or internally synchronized
    // ========================================================================
    /// Filesystem layout (immutable after init)
    pub(crate) layout: FilesystemLayout,
    /// Pure image disk cache manager (image layers → ext4, no guest binary)
    pub(crate) image_disk_mgr: ImageDiskManager,
    /// Versioned guest rootfs manager (image disk + guest binary → ext4)
    pub(crate) guest_rootfs_mgr: GuestRootfsManager,
    /// Guest rootfs lazy initialization (Arc<OnceCell>)
    pub(crate) guest_rootfs: Arc<OnceCell<GuestRootfs>>,
    /// Runtime-wide metrics (AtomicU64 based, lock-free)
    pub(crate) runtime_metrics: RuntimeMetricsStorage,

    /// Base disk manager for clone base lifecycle and ref-count tracking.
    pub(crate) base_disk_mgr: crate::disk::BaseDiskManager,

    /// Snapshot manager for per-box snapshot lifecycle (create, remove, restore).
    pub(crate) snapshot_mgr: crate::litebox::snapshot_mgr::SnapshotManager,

    /// Per-entity lock manager for multiprocess-safe locking.
    ///
    /// Provides locks for individual entities (boxes, volumes, etc.) that work
    /// across multiple processes. Similar to Podman's lock manager.
    pub(crate) lock_manager: Arc<dyn LockManager>,

    /// Runtime filesystem lock (held for lifetime). Prevent from multiple process run on same
    /// BOXLITE_HOME directory
    pub(crate) _runtime_lock: RuntimeLock,

    // ========================================================================
    // SHUTDOWN COORDINATION
    // ========================================================================
    /// Cancellation token for coordinated shutdown.
    /// When cancelled, all in-flight operations should terminate gracefully.
    /// Use `.is_cancelled()` for sync checks, `.cancelled()` for async select!.
    /// Child tokens are passed to each box via `.child_token()`.
    pub(crate) shutdown_token: CancellationToken,

    // ========================================================================
    // CRASH HANDLER
    // ========================================================================
    /// Channel sender for box crash notifications.
    /// Used by health check tasks to notify runtime of crashes.
    crash_tx: mpsc::Sender<BoxID>,

    /// Handle to the crash handler task (for graceful shutdown).
    crash_handler_handle: RwLock<Option<JoinHandle<()>>>,

    /// Tracks in-flight crash handling per box.
    /// Prevents duplicate concurrent handling of the same box crash.
    /// Entry is inserted before spawning a per-crash task and removed
    /// when the task completes (via RAII guard).
    pending_crashes: RwLock<HashSet<BoxID>>,

    /// JoinHandles for in-flight per-crash tasks spawned by the crash handler.
    /// Tracked so shutdown can await them instead of leaving fire-and-forget tasks
    /// that hold Arc<RuntimeImpl> and delay drop.
    crash_task_handles: RwLock<Vec<JoinHandle<()>>>,

    /// Pending crash notification receiver, consumed once by `ensure_services_started`.
    pending_crash_rx: std::sync::Mutex<Option<mpsc::Receiver<BoxID>>>,

    /// Boxes queued for auto-restart during recovery, consumed once by
    /// `ensure_services_started`.
    recovery_queue: std::sync::Mutex<Vec<(BoxID, BoxState)>>,

    /// One-time gate for background services initialization (crash handler,
    /// recovery auto-restarts). Spawned lazily on first async method call.
    services_started: tokio::sync::OnceCell<()>,
}

/// Synchronized state protected by RwLock.
///
/// Acquire this when you need atomicity across multiple operations on
/// box_manager or image_manager.
pub struct SynchronizedState {
    /// Cache of active BoxImpl instances by ID.
    /// Uses Weak to allow automatic cleanup when all handles are dropped.
    active_boxes_by_id: HashMap<BoxID, Weak<crate::litebox::box_impl::BoxImpl>>,
    /// Cache of active BoxImpl instances by name (only for named boxes).
    active_boxes_by_name: HashMap<String, Weak<crate::litebox::box_impl::BoxImpl>>,
}

impl RuntimeImpl {
    // ========================================================================
    // CONSTRUCTION
    // ========================================================================

    /// Create a new RuntimeInnerImpl with the provided options.
    ///
    /// Performs all initialization: filesystem setup, locks, managers, and box recovery.
    pub fn new(options: BoxliteOptions) -> BoxliteResult<SharedRuntimeImpl> {
        let _sys = crate::system_check::SystemCheck::run()?;

        // Validate Early: Check preconditions before expensive work
        if !options.home_dir.is_absolute() {
            return Err(BoxliteError::Internal(format!(
                "home_dir must be absolute path, got: {}",
                options.home_dir.display()
            )));
        }

        // Configure bind mount support based on platform
        #[cfg(target_os = "linux")]
        let fs_config = FsLayoutConfig::with_bind_mount();
        #[cfg(not(target_os = "linux"))]
        let fs_config = FsLayoutConfig::without_bind_mount();

        let layout = FilesystemLayout::new(options.home_dir.clone(), fs_config);

        layout.prepare().map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to initialize filesystem at {}: {}",
                layout.home_dir().display(),
                e
            ))
        })?;

        init_logging_for(&layout)?;

        let runtime_lock = RuntimeLock::acquire(layout.home_dir()).map_err(|e| {
            BoxliteError::Internal(format!(
                "Failed to acquire runtime lock at {}: {}",
                layout.home_dir().display(),
                e
            ))
        })?;

        // Clean temp dir contents to avoid stale files from previous runs
        if let Ok(entries) = std::fs::read_dir(layout.temp_dir()) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let _ = std::fs::remove_dir_all(&path);
                } else {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }

        let db = Database::open(&layout.db_dir().join("boxlite.db")).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to initialize database at {}: {}",
                layout.db_dir().join("boxlite.db").display(),
                e
            ))
        })?;

        let image_manager =
            ImageManager::new(layout.images_dir(), db.clone(), options.image_registries).map_err(
                |e| {
                    BoxliteError::Storage(format!(
                        "Failed to initialize image manager at {}: {}",
                        layout.images_dir().display(),
                        e
                    ))
                },
            )?;

        let base_disk_store = crate::db::BaseDiskStore::new(db.clone());
        let base_disk_mgr =
            crate::disk::BaseDiskManager::new(layout.bases_dir(), base_disk_store.clone());
        let snapshot_store = crate::db::SnapshotStore::new(db.clone());
        let snapshot_mgr = crate::litebox::snapshot_mgr::SnapshotManager::new(snapshot_store);
        let box_store = BoxStore::new(db);

        // Initialize lock manager for per-entity multiprocess-safe locking
        let lock_manager: Arc<dyn LockManager> =
            Arc::new(FileLockManager::new(layout.locks_dir()).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to initialize lock manager at {}: {}",
                    layout.locks_dir().display(),
                    e
                ))
            })?);

        tracing::debug!(
            lock_dir = %layout.locks_dir().display(),
            "Initialized lock manager"
        );

        let image_disk_mgr =
            ImageDiskManager::new(layout.image_layout().disk_images_dir(), layout.temp_dir());
        let guest_rootfs_mgr = GuestRootfsManager::new(base_disk_mgr.clone(), layout.temp_dir());

        // Create crash notification channel
        let (crash_tx, crash_rx) = mpsc::channel::<BoxID>(100);

        let inner = Arc::new(Self {
            sync_state: RwLock::new(SynchronizedState {
                active_boxes_by_id: HashMap::new(),
                active_boxes_by_name: HashMap::new(),
            }),
            box_manager: BoxManager::new(box_store),
            image_manager,
            layout,
            image_disk_mgr,
            guest_rootfs_mgr,
            guest_rootfs: Arc::new(OnceCell::new()),
            runtime_metrics: RuntimeMetricsStorage::new(),
            base_disk_mgr,
            snapshot_mgr,
            lock_manager,
            _runtime_lock: runtime_lock,
            shutdown_token: CancellationToken::new(),
            crash_tx,
            crash_handler_handle: RwLock::new(None),
            pending_crashes: RwLock::new(HashSet::new()),
            crash_task_handles: RwLock::new(Vec::new()),
            pending_crash_rx: std::sync::Mutex::new(Some(crash_rx)),
            recovery_queue: std::sync::Mutex::new(Vec::new()),
            services_started: tokio::sync::OnceCell::new(),
        });

        tracing::debug!("initialized runtime");

        // Recover boxes from database
        let boxes_to_restart = inner.recover_boxes()?;

        // Store recovery queue for lazy initialization by ensure_services_started.
        // The crash handler and recovery tasks will be spawned on the first async call.
        if !boxes_to_restart.is_empty() {
            tracing::info!(
                count = boxes_to_restart.len(),
                "Queued boxes for auto-restart (will start on first async operation)"
            );
            *inner.recovery_queue.lock().unwrap() = boxes_to_restart;
        }

        Ok(inner)
    }

    // ========================================================================
    // CRASH HANDLER
    // ========================================================================

    /// Spawn the central crash handler task.
    fn spawn_crash_handler(
        runtime: SharedRuntimeImpl,
        mut crash_rx: mpsc::Receiver<BoxID>,
    ) -> JoinHandle<()> {
        tokio::spawn(async move {
            tracing::info!("Crash handler task started");

            loop {
                tokio::select! {
                    Some(box_id) = crash_rx.recv() => {
                        // Check runtime is not shutting down
                        if runtime.shutdown_token.is_cancelled() {
                            tracing::debug!("Runtime shutting down, ignoring crash notification");
                            continue;
                        }

                        // Deduplication: skip if already handling a crash for this box
                        if runtime.pending_crashes.read().unwrap().contains(&box_id) {
                            tracing::debug!(
                                box_id = %box_id,
                                "Crash already being handled, skipping duplicate notification"
                            );
                            continue;
                        }

                        tracing::info!(box_id = %box_id, "Received crash notification");

                        // Register in pending_crashes before spawning
                        runtime.pending_crashes.write().unwrap().insert(box_id.clone());

                        // Spawn task to handle this crash
                        let rt = Arc::clone(&runtime);
                        let rt_for_cleanup = Arc::clone(&runtime);
                        let box_id_for_cleanup = box_id.clone();
                        let handle = tokio::spawn(async move {
                            Self::handle_box_crash(rt, box_id).await;
                            // Always remove from pending_crashes when done
                            rt_for_cleanup
                                .pending_crashes
                                .write()
                                .unwrap()
                                .remove(&box_id_for_cleanup);
                        });
                        let mut handles = runtime.crash_task_handles.write().unwrap();
                        handles.retain(|h| !h.is_finished());
                        handles.push(handle);
                    }
                    _ = runtime.shutdown_token.cancelled() => {
                        tracing::debug!("Crash handler received shutdown signal");
                        break;
                    }
                }
            }

            tracing::info!("Crash handler task stopped");
        })
    }

    /// Handle a single box crash (runs in spawned task).
    async fn handle_box_crash(this: SharedRuntimeImpl, box_id: BoxID) {
        use crate::litebox::BoxStatus;

        // ── Phase 1: State mutation (under box lock) ──

        let (config, mut state) = match this.box_manager.box_by_id(&box_id) {
            Ok(Some((c, s))) => (c, s),
            Ok(None) => {
                tracing::debug!(box_id = %box_id, "Box not found, ignoring crash");
                return;
            }
            Err(e) => {
                tracing::error!(box_id = %box_id, error = %e, "Failed to read box state");
                return;
            }
        };

        // Acquire box lock for state mutation
        let lock_id = match state.lock_id {
            Some(id) => id,
            None => {
                tracing::warn!(box_id = %box_id, "Box has no lock_id");
                return;
            }
        };

        let locker = match this.lock_manager.retrieve(lock_id) {
            Ok(l) => l,
            Err(e) => {
                tracing::error!(box_id = %box_id, error = %e, "Failed to retrieve lock");
                return;
            }
        };

        let _lock_guard = loop {
            if let Some(guard) = crate::lock::LockGuard::try_new(&*locker) {
                break guard;
            }

            if this.shutdown_token.is_cancelled() {
                tracing::debug!(box_id = %box_id, "Shutdown while waiting for lock");
                return;
            }

            tokio::task::yield_now().await;
        };

        // State check: only handle crashes for boxes that were running
        match state.status {
            BoxStatus::Running | BoxStatus::Crashed => {}
            BoxStatus::Restarting => {
                tracing::debug!(box_id = %box_id, "Box already restarting, ignoring");
                return;
            }
            _ => {
                tracing::debug!(
                    box_id = %box_id,
                    status = ?state.status,
                    "Box not running, ignoring crash"
                );
                return;
            }
        }

        // Read exit info. No file means normal exit (shim wrote nothing on success).
        let exit_code = read_box_exit_code(&config.box_home).or(Some(0));
        let restart_policy = &config.options.advanced.restart_policy;
        let current_restart_count = state.stop_info.restart_count;
        let exit_time = Utc::now();
        let new_restart_count = state.stop_info.restart_count.saturating_add(1);
        let max_retries_exhausted = matches!(
            restart_policy.as_ref(),
            Some(RestartPolicy::OnFailure { max_retries }) if current_restart_count >= *max_retries
        );

        // Persist the crash before evaluating restart policy so recovery sees
        // the updated exit metadata and retry count even if this task is interrupted.
        state.force_status(BoxStatus::Crashed);
        state.set_pid(None);
        state.health_status.state = crate::litebox::HealthState::Unhealthy;
        state.stop_info = crate::litebox::StopInfo {
            cause: StopCause::CrashedNoPolicy,
            exit_code,
            exit_time: Some(exit_time),
            restart_count: new_restart_count,
            restarted_at: None,
        };

        if let Err(e) = this.box_manager.save_box(&box_id, &state) {
            tracing::error!(box_id = %box_id, error = %e, "Failed to save crashed state");
        }

        // Evaluate restart policy
        let should_restart = restart_policy
            .as_ref()
            .map(|policy| policy.should_restart(exit_code, current_restart_count))
            .unwrap_or(false);

        if !should_restart {
            tracing::info!(
                box_id = %box_id,
                policy = ?restart_policy,
                "No restart policy or max retries exceeded, marking as stopped"
            );

            state.force_status(BoxStatus::Stopped);
            state.stop_info.cause = stop_cause_when_restart_denied(
                restart_policy.as_ref(),
                exit_code,
                max_retries_exhausted,
            );

            if let Err(e) = this.box_manager.save_box(&box_id, &state) {
                tracing::error!(box_id = %box_id, error = %e, "Failed to save stopped state");
            }
            return;
        }

        // Lock released here (end of _lock_guard scope).
        // The restart_policy is cloned out so we don't need the lock for the backoff loop.

        // ── Phase 2: Backoff + restart loop (lock acquired per attempt) ──

        let restart_policy = restart_policy.clone();

        tracing::info!(
            box_id = %box_id,
            restart_count = new_restart_count,
            exit_code = ?exit_code,
            "Box crashed, scheduling restart with backoff"
        );

        let mut attempt = current_restart_count;
        loop {
            let backoff = calculate_backoff(attempt);
            attempt += 1;

            tracing::info!(
                box_id = %box_id,
                attempt,
                backoff_ms = backoff.as_millis() as u64,
                "Scheduling restart attempt"
            );

            tokio::select! {
                _ = tokio::time::sleep(backoff) => {
                    // Re-acquire box lock for this restart attempt
                    let (_, state) = match this.box_manager.box_by_id(&box_id) {
                        Ok(Some(pair)) => pair,
                        Ok(None) => {
                            tracing::debug!(box_id = %box_id, "Box removed during backoff");
                            return;
                        }
                        Err(e) => {
                            tracing::error!(box_id = %box_id, error = %e, "Failed to read state");
                            return;
                        }
                    };

                    let lock_id = match state.lock_id {
                        Some(id) => id,
                        None => {
                            tracing::warn!(box_id = %box_id, "Box has no lock_id");
                            return;
                        }
                    };

                    let locker = match this.lock_manager.retrieve(lock_id) {
                        Ok(l) => l,
                        Err(e) => {
                            tracing::error!(box_id = %box_id, error = %e, "Failed to retrieve lock");
                            return;
                        }
                    };

                    let _lock_guard = loop {
                        if let Some(guard) = crate::lock::LockGuard::try_new(locker.as_ref()) {
                            break guard;
                        }

                        if this.shutdown_token.is_cancelled() {
                            tracing::debug!(
                                box_id = %box_id,
                                "Shutdown while waiting for lock (restart attempt)"
                            );
                            return;
                        }

                        tokio::task::yield_now().await;
                    };

                    // Re-read state after acquiring lock: manual restart() may have succeeded
                    let current_status = match this.box_manager.box_by_id(&box_id) {
                        Ok(Some((_, s))) => s.status,
                        Ok(None) => {
                            tracing::debug!(box_id = %box_id, "Box removed during backoff");
                            return;
                        }
                        Err(e) => {
                            tracing::error!(box_id = %box_id, error = %e, "Failed to read state");
                            return;
                        }
                    };

                    if current_status == BoxStatus::Running {
                        tracing::debug!(
                            box_id = %box_id,
                            "Box already running (manual restart), skipping auto-restart"
                        );
                        return;
                    }

                    tracing::info!(box_id = %box_id, attempt, "Executing restart");

                    match this.restart(&box_id).await {
                        Ok(()) => {
                            tracing::info!(
                                box_id = %box_id,
                                attempt,
                                "Box restarted successfully"
                            );
                            break;  // Success
                        }
                        Err(e) => {
                            tracing::error!(
                                box_id = %box_id,
                                attempt,
                                error = %e,
                                "Restart attempt failed"
                            );

                            // Update state with new attempt count and failure cause
                            if let Ok(Some((_, mut state))) = this.box_manager.box_by_id(&box_id) {
                                state.stop_info.restart_count = attempt;
                                state.stop_info.cause = StopCause::RestartFailed;
                                let _ = this.box_manager.save_box(&box_id, &state);
                            }

                            // Check if should retry
                            let should_retry = restart_policy
                                .as_ref()
                                .map(|p| p.should_restart(exit_code, attempt))
                                .unwrap_or(false);

                            if !should_retry {
                                tracing::info!(box_id = %box_id, attempt, "Max retries exceeded");

                                if let Ok(Some((_, mut state))) = this.box_manager.box_by_id(&box_id) {
                                    state.force_status(BoxStatus::Stopped);
                                    state.stop_info.cause = StopCause::MaxRetriesExceeded;
                                    let _ = this.box_manager.save_box(&box_id, &state);
                                }
                                break;  // Give up
                            }
                            // Continue loop for retry (_lock_guard dropped here)
                        }
                    }
                    // _lock_guard dropped here
                }
                _ = this.shutdown_token.cancelled() => {
                    tracing::debug!(box_id = %box_id, "Restart cancelled (shutdown)");
                    if let Ok(Some((_, mut state))) = this.box_manager.box_by_id(&box_id) {
                        state.force_status(BoxStatus::Stopped);
                        state.stop_info.restart_count = attempt;
                        state.stop_info.cause = StopCause::Normal;
                        let _ = this.box_manager.save_box(&box_id, &state);
                    }
                    break;
                }
            }
        }
    }

    /// Get crash sender for health check tasks.
    pub(crate) fn crash_sender(&self) -> mpsc::Sender<BoxID> {
        self.crash_tx.clone()
    }

    // ========================================================================
    // LAZY SERVICES INITIALIZATION
    // ========================================================================

    /// Ensure background services are started (crash handler, recovery tasks).
    ///
    /// This is called lazily on the first async method, guaranteeing a tokio
    /// runtime exists. Uses `OnceCell` to ensure exactly-once execution.
    async fn ensure_services_started(self: &Arc<Self>) {
        self.services_started
            .get_or_init(|| {
                let rt = Arc::clone(self);
                async move {
                    // 1. Spawn crash handler
                    let crash_rx = rt
                        .pending_crash_rx
                        .lock()
                        .unwrap()
                        .take()
                        .expect("pending_crash_rx consumed twice");
                    let handle = Self::spawn_crash_handler(Arc::clone(&rt), crash_rx);
                    *rt.crash_handler_handle.write().unwrap() = Some(handle);

                    // 2. Spawn recovery auto-restart tasks
                    let queue: Vec<_> = rt.recovery_queue.lock().unwrap().drain(..).collect();
                    if !queue.is_empty() {
                        tracing::info!(
                            count = queue.len(),
                            "Starting auto-restart for boxes with Always/UnlessStopped policy"
                        );
                        let rt_for_restart = Arc::clone(&rt);
                        tokio::spawn(async move {
                            for (box_id, mut state) in queue {
                                tracing::info!(
                                    box_id = %box_id,
                                    "Auto-restarting box after runtime recovery"
                                );

                                // Acquire per-box lock before calling restart()
                                let lock_id = match state.lock_id {
                                    Some(id) => id,
                                    None => {
                                        tracing::warn!(
                                            box_id = %box_id,
                                            "Box has no lock_id, skipping auto-restart"
                                        );
                                        continue;
                                    }
                                };
                                let locker = match rt_for_restart.lock_manager.retrieve(lock_id) {
                                    Ok(l) => l,
                                    Err(e) => {
                                        tracing::error!(
                                            box_id = %box_id,
                                            error = %e,
                                            "Failed to retrieve lock"
                                        );
                                        continue;
                                    }
                                };

                                let mut acquired = false;
                                let _lock_guard = loop {
                                    if let Some(guard) =
                                        crate::lock::LockGuard::try_new(locker.as_ref())
                                    {
                                        acquired = true;
                                        break guard;
                                    }
                                    if rt_for_restart.shutdown_token.is_cancelled() {
                                        tracing::debug!(
                                            box_id = %box_id,
                                            "Shutdown while waiting for lock (recovery)"
                                        );
                                        break crate::lock::LockGuard::new(locker.as_ref());
                                    }
                                    tokio::task::yield_now().await;
                                };

                                if !acquired {
                                    continue;
                                }

                                match rt_for_restart.restart(&box_id).await {
                                    Ok(()) => {
                                        tracing::info!(
                                            box_id = %box_id,
                                            "Auto-restart succeeded during recovery"
                                        );
                                    }
                                    Err(e) => {
                                        let error_msg = format!("{}", e);
                                        tracing::error!(
                                            box_id = %box_id,
                                            error = %error_msg,
                                            "Auto-restart failed during recovery"
                                        );
                                        state.last_restart_error = Some(error_msg);
                                        let _ =
                                            rt_for_restart.box_manager.save_box(&box_id, &state);
                                    }
                                }
                            }
                        });
                    }
                }
            })
            .await;
    }

    // ========================================================================
    // PUBLIC API - BOX OPERATIONS
    // ========================================================================

    /// Create a box handle.
    ///
    /// Allocates lock, persists to database with Configured status, and returns
    /// a LiteBox handle. The VM is not started until start() or exec() is called.
    ///
    /// This method is async for API consistency with other runtime methods.
    pub async fn create(
        self: &Arc<Self>,
        options: BoxOptions,
        name: Option<String>,
    ) -> BoxliteResult<LiteBox> {
        self.ensure_services_started().await;
        let (litebox, _created) = self.create_inner(options, name, false).await?;
        Ok(litebox)
    }

    /// Get an existing box by name, or create a new one if it doesn't exist.
    ///
    /// Returns `(LiteBox, true)` if a new box was created, or `(LiteBox, false)`
    /// if an existing box with the given name was found. When an existing box is
    /// returned, the provided `options` are ignored (no config drift validation).
    pub async fn get_or_create(
        self: &Arc<Self>,
        options: BoxOptions,
        name: Option<String>,
    ) -> BoxliteResult<(LiteBox, bool)> {
        self.ensure_services_started().await;
        self.create_inner(options, name, true).await
    }

    /// Import a box from a `.boxlite` archive.
    ///
    /// Creates a new box with a new ID from archived disk images and
    /// configuration. The imported box starts in `Stopped` state.
    pub async fn import_box(
        self: &Arc<Self>,
        archive: BoxArchive,
        name: Option<String>,
    ) -> BoxliteResult<LiteBox> {
        self.ensure_services_started().await;
        super::import::import_box(self, archive, name).await
    }

    /// Inner create logic shared by `create()` and `get_or_create()`.
    ///
    /// When `reuse_existing` is false, returns an error if a box with the same
    /// name already exists (standard create behavior). When true, returns the
    /// existing box with `created=false`.
    async fn create_inner(
        self: &Arc<Self>,
        options: BoxOptions,
        name: Option<String>,
        reuse_existing: bool,
    ) -> BoxliteResult<(LiteBox, bool)> {
        // Check if runtime has been shut down
        if self.shutdown_token.is_cancelled() {
            return Err(BoxliteError::Stopped(
                "Cannot create box: runtime has been shut down".into(),
            ));
        }

        // Check DB for existing name — use lookup_box to get full (config, state)
        // so we can build the LiteBox directly without a second lookup
        if let Some(ref name) = name
            && let Some((config, state)) = self.box_manager.lookup_box(name)?
        {
            if reuse_existing {
                let (box_impl, _) = self.get_or_create_box_impl(config, state);
                return Ok((litebox_from_impl(box_impl), false));
            } else {
                return Err(BoxliteError::InvalidArgument(format!(
                    "box with name '{}' already exists",
                    name
                )));
            }
        }

        // Initialize box variables with defaults
        let (config, mut state) = self.init_box_variables(&options, name.clone());

        // Allocate lock for this box
        let lock_id = self.lock_manager.allocate()?;
        state.set_lock_id(lock_id);

        // Persist to database immediately (status = Configured)
        if let Err(e) = self.box_manager.add_box(&config, &state) {
            // Clean up the allocated lock on failure
            if let Err(free_err) = self.lock_manager.free(lock_id) {
                tracing::error!(
                    lock_id = %lock_id,
                    error = %free_err,
                    "Failed to free lock after DB persist error"
                );
            }

            // TOCTOU race recovery: lookup_box (line ~268) and add_box are
            // separate non-atomic operations. Between them, another concurrent
            // caller can complete the full create path and persist first:
            //
            //   Task A: lookup("w") → None     Task B: lookup("w") → None
            //   Task A: add_box() → Ok         Task B: add_box() → Err (duplicate)
            //
            // When reuse_existing=true, recover by re-reading the winner's box.
            if reuse_existing
                && let Some(ref name) = name
                && let Some((config, state)) = self.box_manager.lookup_box(name)?
            {
                let (box_impl, _) = self.get_or_create_box_impl(config, state);
                return Ok((litebox_from_impl(box_impl), false));
            }

            return Err(e);
        }

        tracing::debug!(
            box_id = %config.id,
            lock_id = %lock_id,
            "Created box with Configured status"
        );

        // Create LiteBox handle with shared BoxImpl
        // This also checks in-memory cache for duplicate names
        let (box_impl, inserted) = self.get_or_create_box_impl(config, state);
        if !inserted {
            return Err(BoxliteError::InvalidArgument(
                "box with this name already exists".into(),
            ));
        }

        // Increment boxes_created counter (lock-free!)
        self.runtime_metrics
            .boxes_created
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        Ok((litebox_from_impl(box_impl), true))
    }

    /// Get a handle to an existing box by ID or name.
    ///
    /// Returns a LiteBox handle that can be used to operate on the box.
    /// Checks in-memory cache first (for boxes not yet persisted), then DB.
    ///
    /// If another handle to the same box exists, they share the same BoxImpl
    /// (and thus the same LiveState if initialized).
    pub async fn get(self: &Arc<Self>, id_or_name: &str) -> BoxliteResult<Option<LiteBox>> {
        self.ensure_services_started().await;
        tracing::trace!(id_or_name = %id_or_name, "RuntimeInnerImpl::get called");

        // Check in-memory cache first (for boxes created but not yet persisted)
        {
            let sync = self.sync_state.read().unwrap();

            // Try as BoxID first
            if let Some(box_id) = BoxID::parse(id_or_name)
                && let Some(weak) = sync.active_boxes_by_id.get(&box_id)
                && let Some(strong) = weak.upgrade()
            {
                tracing::trace!(box_id = %box_id, "Found box in cache by ID");
                return Ok(Some(litebox_from_impl(strong)));
            }

            // Try as name
            if let Some(weak) = sync.active_boxes_by_name.get(id_or_name)
                && let Some(strong) = weak.upgrade()
            {
                tracing::trace!(name = %id_or_name, "Found box in cache by name");
                return Ok(Some(litebox_from_impl(strong)));
            }
        }

        // Fall back to DB lookup (for persisted boxes) - run on blocking thread pool
        let this = Arc::clone(self);
        let id_or_name_owned = id_or_name.to_string();
        let db_result =
            tokio::task::spawn_blocking(move || this.box_manager.lookup_box(&id_or_name_owned))
                .await
                .map_err(|e| BoxliteError::Internal(format!("spawn_blocking failed: {}", e)))??;

        if let Some((config, state)) = db_result {
            tracing::trace!(
                box_id = %config.id,
                name = ?config.name,
                "Retrieved box from DB, getting or creating BoxImpl"
            );

            let (box_impl, _) = self.get_or_create_box_impl(config, state);
            tracing::trace!(id_or_name = %id_or_name, "LiteBox created successfully");
            return Ok(Some(litebox_from_impl(box_impl)));
        }

        tracing::trace!(id_or_name = %id_or_name, "Box not found");
        Ok(None)
    }

    /// Remove a box completely by ID or name.
    pub fn remove(&self, id_or_name: &str, force: bool) -> BoxliteResult<()> {
        let box_id = self.resolve_id(id_or_name)?;
        self.remove_box(&box_id, force)
    }

    // ========================================================================
    // PUBLIC API - QUERY OPERATIONS
    // ========================================================================

    /// Get information about a specific box by ID or name (without creating a handle).
    ///
    /// Checks in-memory cache first (for boxes not yet persisted), then database.
    pub async fn get_info(self: &Arc<Self>, id_or_name: &str) -> BoxliteResult<Option<BoxInfo>> {
        self.ensure_services_started().await;
        // Check in-memory cache first (for boxes created but not yet persisted)
        {
            let sync = self.sync_state.read().unwrap();

            // Try as BoxID first
            if let Some(box_id) = BoxID::parse(id_or_name)
                && let Some(weak) = sync.active_boxes_by_id.get(&box_id)
                && let Some(strong) = weak.upgrade()
            {
                return Ok(Some(strong.info()));
            }

            // Try as name
            if let Some(weak) = sync.active_boxes_by_name.get(id_or_name)
                && let Some(strong) = weak.upgrade()
            {
                return Ok(Some(strong.info()));
            }
        }

        // Fall back to DB lookup - run on blocking thread pool
        let this = Arc::clone(self);
        let id_or_name_owned = id_or_name.to_string();
        let db_result =
            tokio::task::spawn_blocking(move || this.box_manager.lookup_box(&id_or_name_owned))
                .await
                .map_err(|e| BoxliteError::Internal(format!("spawn_blocking failed: {}", e)))??;

        if let Some((config, state)) = db_result {
            return Ok(Some(BoxInfo::new(&config, &state)));
        }
        Ok(None)
    }

    /// List all boxes, sorted by creation time (newest first).
    ///
    /// Includes both persisted boxes (from database) and in-memory boxes
    /// (created but not yet persisted).
    pub async fn list_info(self: &Arc<Self>) -> BoxliteResult<Vec<BoxInfo>> {
        self.ensure_services_started().await;
        use std::collections::HashSet;

        // Get boxes from database - run on blocking thread pool
        let this = Arc::clone(self);
        let db_boxes = tokio::task::spawn_blocking(move || this.box_manager.all_boxes(true))
            .await
            .map_err(|e| BoxliteError::Internal(format!("spawn_blocking failed: {}", e)))??;

        let mut seen_ids: HashSet<BoxID> = db_boxes.iter().map(|(c, _)| c.id.clone()).collect();
        let mut infos: Vec<_> = db_boxes
            .into_iter()
            .map(|(config, state)| BoxInfo::new(&config, &state))
            .collect();

        // Add in-memory boxes not yet persisted
        {
            let sync = self.sync_state.read().unwrap();
            for (box_id, weak) in &sync.active_boxes_by_id {
                if !seen_ids.contains(box_id)
                    && let Some(strong) = weak.upgrade()
                {
                    infos.push(strong.info());
                    seen_ids.insert(box_id.clone());
                }
            }
        }

        // Sort by creation time (newest first)
        infos.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(infos)
    }

    /// Check if a box with the given ID or name exists.
    ///
    /// Checks in-memory cache first (for boxes not yet persisted), then database.
    pub async fn exists(self: &Arc<Self>, id_or_name: &str) -> BoxliteResult<bool> {
        self.ensure_services_started().await;
        // Check in-memory cache first
        {
            let sync = self.sync_state.read().unwrap();

            // Try as BoxID first
            if let Some(box_id) = BoxID::parse(id_or_name)
                && let Some(weak) = sync.active_boxes_by_id.get(&box_id)
                && weak.upgrade().is_some()
            {
                return Ok(true);
            }

            // Try as name
            if let Some(weak) = sync.active_boxes_by_name.get(id_or_name)
                && weak.upgrade().is_some()
            {
                return Ok(true);
            }
        }

        // Fall back to DB lookup - run on blocking thread pool
        let this = Arc::clone(self);
        let id_or_name_owned = id_or_name.to_string();
        let db_result =
            tokio::task::spawn_blocking(move || this.box_manager.lookup_box_id(&id_or_name_owned))
                .await
                .map_err(|e| BoxliteError::Internal(format!("spawn_blocking failed: {}", e)))??;

        Ok(db_result.is_some())
    }

    // ========================================================================
    // PUBLIC API - METRICS
    // ========================================================================

    /// Get runtime-wide metrics.
    pub async fn metrics(&self) -> RuntimeMetrics {
        RuntimeMetrics::new(self.runtime_metrics.clone())
    }

    // ========================================================================
    // PUBLIC API - SHUTDOWN
    // ========================================================================

    /// Gracefully shutdown all non-detached boxes in this runtime.
    ///
    /// This method:
    /// 1. Marks the runtime as shut down (no new operations allowed)
    /// 2. Cancels the shutdown token (signals in-flight operations)
    /// 3. Stops all active non-detached boxes with the given timeout
    ///
    /// Detached boxes (`detach=true`) are skipped — they are designed to
    /// survive parent process exit and runtime shutdown.
    ///
    /// # Arguments
    /// * `timeout` - Seconds before force-kill. None=10s, Some(-1)=infinite
    ///
    /// # Returns
    /// Ok(()) if all boxes stopped successfully, Err if any box failed to stop.
    pub async fn shutdown(&self, timeout: Option<i32>) -> BoxliteResult<()> {
        // Check if already shut down (idempotent)
        if self.shutdown_token.is_cancelled() {
            return Ok(());
        }

        tracing::info!("Initiating runtime shutdown");

        // Cancel the shutdown token - marks shutdown and signals all in-flight operations
        self.shutdown_token.cancel();

        // Collect all active non-detached boxes
        let active_boxes: Vec<SharedBoxImpl> = {
            let sync = self.sync_state.read().unwrap();
            sync.active_boxes_by_id
                .values()
                .filter_map(|weak| weak.upgrade())
                .filter(|box_impl| !box_impl.config.options.detach)
                .collect()
        };

        if active_boxes.is_empty() {
            tracing::info!("No active boxes to shutdown");
            return Ok(());
        }

        tracing::info!(count = active_boxes.len(), "Stopping active boxes");

        // Convert timeout to duration
        let timeout_duration = timeout_to_duration(timeout);

        // Stop all boxes concurrently
        let stop_futures = active_boxes.iter().map(|box_impl| {
            let box_id = box_impl.id().to_string();
            async move {
                let result = if let Some(duration) = timeout_duration {
                    tokio::time::timeout(duration, box_impl.stop()).await
                } else {
                    // Infinite timeout
                    Ok(box_impl.stop().await)
                };
                (box_id, result)
            }
        });

        let results = futures::future::join_all(stop_futures).await;

        // Check for errors
        let mut errors = Vec::new();
        for (box_id, result) in results {
            match result {
                Ok(Ok(())) => {
                    tracing::debug!(box_id = %box_id, "Box stopped gracefully");
                }
                Ok(Err(e)) => {
                    tracing::warn!(box_id = %box_id, error = %e, "Box stop failed");
                    errors.push(format!("{}: {}", box_id, e));
                }
                Err(_) => {
                    tracing::warn!(box_id = %box_id, "Box stop timed out");
                    errors.push(format!("{}: timeout", box_id));
                }
            }
        }

        if errors.is_empty() {
            tracing::info!("Runtime shutdown complete");
        } else {
            tracing::warn!("Shutdown completed with errors: {}", errors.join(", "));
        }

        // Stop crash handler
        drop(self.crash_tx.clone()); // Drop all senders to close channel
        let crash_handle = self.crash_handler_handle.write().unwrap().take();
        if let Some(handle) = crash_handle {
            match tokio::time::timeout(std::time::Duration::from_secs(5), handle).await {
                Ok(Ok(())) => tracing::debug!("Crash handler stopped gracefully"),
                Ok(Err(e)) => tracing::warn!("Crash handler panicked: {:?}", e),
                Err(_) => tracing::warn!("Crash handler stop timeout"),
            }
        }

        // Await in-flight per-crash tasks. The shutdown_token is already
        // cancelled so these tasks will exit their backoff loops promptly.
        let crash_tasks: Vec<JoinHandle<()>> =
            self.crash_task_handles.write().unwrap().drain(..).collect();
        if !crash_tasks.is_empty() {
            tracing::debug!(
                count = crash_tasks.len(),
                "Waiting for in-flight crash tasks to finish"
            );
            for handle in crash_tasks {
                match tokio::time::timeout(std::time::Duration::from_secs(5), handle).await {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => tracing::warn!("Crash task panicked: {:?}", e),
                    Err(_) => tracing::warn!("Crash task stop timeout"),
                }
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(BoxliteError::Internal(format!(
                "Shutdown completed with errors: {}",
                errors.join(", ")
            )))
        }
    }

    /// Synchronous shutdown for atexit/Drop contexts.
    ///
    /// At atexit/Drop time, all `LiteBox` handles are gone (Weak refs dead),
    /// so async `shutdown()` would find nothing. This method queries the DB
    /// directly and sends SIGTERM to shim processes. The shim's SIGTERM handler
    /// does graceful Guest.Shutdown() RPC (qcow2 flush) before exiting.
    ///
    /// Detached boxes are skipped (same contract as async `shutdown()`).
    pub(crate) fn shutdown_sync(&self) {
        if self.shutdown_token.is_cancelled() {
            return;
        }
        self.shutdown_token.cancel();

        let boxes = match self.box_manager.all_boxes(true) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("[boxlite] Failed to query boxes during sync shutdown: {e}");
                return;
            }
        };

        for (config, mut state) in boxes {
            if state.status != BoxStatus::Running || config.options.detach {
                continue;
            }
            let Some(pid) = state.pid else { continue };
            if !crate::util::is_process_alive(pid) {
                continue;
            }

            eprintln!(
                "[boxlite] Auto-stopping non-detached box: id={}, pid={pid}",
                config.id
            );

            // SIGTERM triggers shim's graceful shutdown handler (Guest.Shutdown RPC)
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }

            // Wait for shim to finish graceful shutdown (3s guest RPC + margin)
            let start = std::time::Instant::now();
            let timeout = std::time::Duration::from_secs(5);
            loop {
                if !crate::util::is_process_alive(pid) {
                    break;
                }
                if start.elapsed() > timeout {
                    eprintln!(
                        "[boxlite] Shim didn't exit after SIGTERM, force killing: id={}, pid={pid}",
                        config.id
                    );
                    crate::util::kill_process(pid);
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }

            state.mark_stop();
            let _ = self.box_manager.save_box(&config.id, &state);
            let pid_file = self
                .layout
                .boxes_dir()
                .join(config.id.as_str())
                .join("shim.pid");
            let _ = std::fs::remove_file(&pid_file);
        }
    }

    // ========================================================================
    // INTERNAL - BOX OPERATIONS
    // ========================================================================

    /// Resolve an ID or name to the actual box ID.
    ///
    /// Checks in-memory cache first (for boxes not yet persisted), then database.
    fn resolve_id(&self, id_or_name: &str) -> BoxliteResult<BoxID> {
        // Check in-memory cache first
        {
            let sync = self.sync_state.read().unwrap();

            // Try as BoxID first
            if let Some(box_id) = BoxID::parse(id_or_name)
                && let Some(weak) = sync.active_boxes_by_id.get(&box_id)
                && weak.upgrade().is_some()
            {
                return Ok(box_id);
            }

            // Try as name
            if let Some(weak) = sync.active_boxes_by_name.get(id_or_name)
                && let Some(strong) = weak.upgrade()
            {
                return Ok(strong.id().clone());
            }
        }

        // Fall back to DB lookup
        self.box_manager
            .lookup_box_id(id_or_name)?
            .ok_or_else(|| BoxliteError::NotFound(id_or_name.to_string()))
    }

    /// Remove a box from the runtime (internal implementation).
    ///
    /// This is the internal implementation called by both `BoxliteRuntime::remove()`
    /// and `LiteBox::stop()` (when `auto_remove=true`).
    ///
    /// Handles both persisted boxes (in database) and in-memory-only boxes
    /// (created but not yet started).
    ///
    /// # Arguments
    /// * `id` - Box ID to remove
    /// * `force` - If true, kill the process first if running
    ///
    /// # Errors
    /// - Box not found
    /// - Box is active and force=false
    pub(crate) fn remove_box(&self, id: &BoxID, force: bool) -> BoxliteResult<()> {
        tracing::debug!(box_id = %id, force = force, "RuntimeInnerImpl::remove_box called");

        // Try to get box from database first
        if let Some((config, state)) = self.box_manager.box_by_id(id)? {
            // Box exists in database - handle as before
            let mut state = state;
            if state.status.is_active() {
                if force {
                    // Force mode: kill the process directly
                    if let Some(pid) = state.pid {
                        tracing::info!(box_id = %id, pid = pid, "Force killing active box");
                        crate::util::kill_process(pid);
                    }
                    // Update status to stopped and save
                    state.set_status(BoxStatus::Stopped);
                    state.set_pid(None);
                    self.box_manager.save_box(id, &state)?;
                } else {
                    // Non-force mode: error on active box
                    return Err(BoxliteError::InvalidState(format!(
                        "cannot remove active box {} (status: {:?}). Use force=true to stop first",
                        id, state.status
                    )));
                }
            }

            // Check if other boxes depend on this box's disks (COW backing references).
            if !force {
                let dependents = find_boxes_depending_on(self, id.as_ref())?;
                if !dependents.is_empty() {
                    return Err(BoxliteError::InvalidState(format!(
                        "Cannot remove box: boxes [{}] have clone dependencies on it. \
                         Remove those first or use force=true.",
                        dependents.join(", ")
                    )));
                }
            }

            // Remove from BoxManager (database-first)
            self.box_manager.remove_box(id)?;

            // Free the lock if one was allocated
            if let Some(lock_id) = state.lock_id {
                if let Err(e) = self.lock_manager.free(lock_id) {
                    tracing::warn!(
                        box_id = %id,
                        lock_id = %lock_id,
                        error = %e,
                        "Failed to free lock for removed box"
                    );
                } else {
                    tracing::debug!(
                        box_id = %id,
                        lock_id = %lock_id,
                        "Freed lock for removed box"
                    );
                }
            }

            // 1. Remove all base disk refs for this box (returns affected base IDs for GC)
            let affected_base_ids = self
                .base_disk_mgr
                .store()
                .remove_all_refs_for_box(id.as_ref())
                .unwrap_or_default();

            // 2. Delete container disk file
            let disks_dir = config.box_home.join("disks");
            let container = disks_dir.join(crate::disk::constants::filenames::CONTAINER_DISK);
            let _ = std::fs::remove_file(&container);

            // 3. Remove all snapshots for this box (files + DB records).
            self.snapshot_mgr
                .remove_all_for_box(id.as_ref(), &config.box_home);

            // 4. GC each affected base (may cascade to parents)
            for base_id in affected_base_ids {
                self.base_disk_mgr.try_gc_base(&base_id);
            }

            // Delete box directory
            let box_home = config.box_home;
            if box_home.exists()
                && let Err(e) = std::fs::remove_dir_all(&box_home)
            {
                tracing::warn!(
                    box_id = %id,
                    path = %box_home.display(),
                    error = %e,
                    "Failed to cleanup box directory"
                );
            }

            // Invalidate cache
            self.invalidate_box_impl(id, config.name.as_deref());

            tracing::info!(box_id = %id, "Removed box");
            return Ok(());
        }

        // Box not in database - check in-memory cache
        let box_impl = {
            let sync = self.sync_state.read().unwrap();
            sync.active_boxes_by_id
                .get(id)
                .and_then(|weak| weak.upgrade())
        };

        if let Some(box_impl) = box_impl {
            // Box exists in-memory only (not yet started/persisted)
            let state = box_impl.state.read();
            if state.status.is_active() && !force {
                return Err(BoxliteError::InvalidState(format!(
                    "cannot remove active box {} (status: {:?}). Use force=true to stop first",
                    id, state.status
                )));
            }
            drop(state);

            // 1. Remove all base disk refs for this box (returns affected base IDs for GC)
            let affected_base_ids = self
                .base_disk_mgr
                .store()
                .remove_all_refs_for_box(id.as_ref())
                .unwrap_or_default();

            // 2. Delete container disk file
            let disks_dir = box_impl.config.box_home.join("disks");
            let container = disks_dir.join(crate::disk::constants::filenames::CONTAINER_DISK);
            let _ = std::fs::remove_file(&container);

            // 3. Remove all snapshots for this box (files + DB records).
            self.snapshot_mgr
                .remove_all_for_box(id.as_ref(), &box_impl.config.box_home);

            // 4. GC each affected base (may cascade to parents)
            for base_id in affected_base_ids {
                self.base_disk_mgr.try_gc_base(&base_id);
            }

            // Invalidate cache (removes from in-memory maps)
            self.invalidate_box_impl(id, box_impl.config.name.as_deref());

            // Delete box directory if it exists
            let box_home = &box_impl.config.box_home;
            if box_home.exists()
                && let Err(e) = std::fs::remove_dir_all(box_home)
            {
                tracing::warn!(
                    box_id = %id,
                    path = %box_home.display(),
                    error = %e,
                    "Failed to cleanup box directory"
                );
            }

            tracing::info!(box_id = %id, "Removed in-memory box");
            return Ok(());
        }

        // Box not found anywhere
        Err(BoxliteError::NotFound(id.to_string()))
    }

    // ========================================================================
    // INTERNAL - INITIALIZATION
    // ========================================================================

    /// Initialize box variables with defaults.
    ///
    /// Creates config and state for a new box. State starts with Configured status.
    /// Lock allocation and DB persistence happen in create() immediately after this.
    fn init_box_variables(
        &self,
        options: &BoxOptions,
        name: Option<String>,
    ) -> (BoxConfig, BoxState) {
        use crate::litebox::config::ContainerRuntimeConfig;

        // Generate unique box ID (12-char Base62)
        let box_id = BoxIDMint::mint();

        // Generate container ID (64-char hex)
        let container_id = ContainerID::new();

        // Record creation timestamp
        let now = Utc::now();

        // Derive paths from ID (computed from layout + ID)
        let box_home = self.layout.boxes_dir().join(box_id.as_str());
        let socket_path = filenames::unix_socket_path(self.layout.home_dir(), box_id.as_str());
        let ready_socket_path = box_home.join("sockets").join("ready.sock");

        // Create container runtime config
        let container = ContainerRuntimeConfig { id: container_id };

        // Create config with defaults + user options
        let config = BoxConfig {
            id: box_id,
            name,
            created_at: now,
            container,
            options: options.clone(),
            engine_kind: VmmKind::Libkrun,
            transport: Transport::unix(socket_path),
            box_home,
            ready_socket_path,
        };

        // Create initial state (status = Configured)
        let state = BoxState::new();

        (config, state)
    }

    /// Provision a new box: create identity, persist config+state, return LiteBox.
    ///
    /// Caller provides `staging_dir` (already created with disks in place) and
    /// `options` for the box configuration. The staging directory is renamed to
    /// the canonical `boxes_dir/<box_id>` path. The box is persisted with the
    /// given `initial_status` (typically `Stopped` for clone/import operations).
    ///
    /// On failure, cleans up the allocated lock and box directory.
    pub(crate) async fn provision_box(
        self: &Arc<Self>,
        staging_dir: std::path::PathBuf,
        name: Option<String>,
        options: BoxOptions,
        initial_status: BoxStatus,
    ) -> BoxliteResult<LiteBox> {
        self.ensure_services_started().await;
        use crate::litebox::config::ContainerRuntimeConfig;

        let box_id = BoxIDMint::mint();
        let container_id = ContainerID::new();
        let now = Utc::now();

        // Move staging dir to canonical path.
        let box_home = self.layout.boxes_dir().join(box_id.as_str());
        std::fs::rename(&staging_dir, &box_home).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to rename {} to {}: {}",
                staging_dir.display(),
                box_home.display(),
                e
            ))
        })?;

        let socket_path = filenames::unix_socket_path(self.layout.home_dir(), box_id.as_str());
        let ready_socket_path = box_home.join("sockets").join("ready.sock");

        let config = BoxConfig {
            id: box_id.clone(),
            name,
            created_at: now,
            container: ContainerRuntimeConfig { id: container_id },
            options,
            engine_kind: VmmKind::Libkrun,
            transport: Transport::unix(socket_path),
            box_home,
            ready_socket_path,
        };

        let mut state = BoxState::new();
        state.set_status(initial_status);

        let lock_id = self.lock_manager.allocate()?;
        state.set_lock_id(lock_id);

        if let Err(e) = self.box_manager.add_box(&config, &state) {
            let _ = self.lock_manager.free(lock_id);
            let _ = std::fs::remove_dir_all(&config.box_home);
            return Err(e);
        }

        self.get(box_id.as_str()).await?.ok_or_else(|| {
            BoxliteError::Internal("Provisioned box not found after persist".to_string())
        })
    }

    /// Recover boxes from persistent storage on runtime startup.
    /// Returns list of (box_id, state) tuples that need auto-restart (Always/UnlessStopped policy).
    fn recover_boxes(&self) -> BoxliteResult<Vec<(BoxID, BoxState)>> {
        use crate::util::{is_process_alive, is_same_process};

        // Check for system reboot and reset active boxes
        self.box_manager.check_and_handle_reboot()?;

        // Clear all locks before recovery - safe because we hold the runtime lock.
        // This ensures a clean slate for lock allocation during recovery.
        self.lock_manager.clear_all_locks()?;

        // Phase 0: Scan filesystem for orphaned directories (no DB record)
        // These can occur when:
        // - Box creation succeeded but DB persist failed
        // - Process crashed after directory creation but before DB insert
        // - Old boxes from before persistence was implemented
        self.cleanup_orphaned_directories()?;

        let persisted = self.box_manager.all_boxes(true)?;

        // Phase 1: Clean up boxes that shouldn't persist
        // - auto_remove=true boxes: these are ephemeral and shouldn't survive restarts
        // - Orphaned active boxes: was Running but directory is missing (crashed mid-operation)
        //
        // Note: We don't remove Configured or Stopped boxes without directories because:
        // - Configured boxes: created but never started, no directory yet (this is valid)
        // - Stopped boxes: might not have a directory if never started
        // - Only Running boxes must have a directory
        let mut boxes_to_remove = Vec::new();
        for (config, state) in &persisted {
            let should_remove = if config.options.auto_remove {
                tracing::info!(
                    box_id = %config.id,
                    "Removing auto_remove=true box during recovery"
                );
                true
            } else if state.status.is_active() && !config.box_home.exists() {
                // Only remove orphaned boxes that were in an active state
                // Stopped boxes might not have a directory if never started
                tracing::warn!(
                    box_id = %config.id,
                    status = ?state.status,
                    box_home = %config.box_home.display(),
                    "Removing orphaned active box (directory missing) during recovery"
                );
                true
            } else {
                false
            };

            if should_remove {
                boxes_to_remove.push(config.id.clone());
            }
        }

        // Remove invalid boxes from database and cleanup their directories
        for box_id in &boxes_to_remove {
            // Find the config to get box_home path
            if let Some((config, _)) = persisted.iter().find(|(c, _)| &c.id == box_id) {
                // Clean up box directory if it exists
                if config.box_home.exists()
                    && let Err(e) = std::fs::remove_dir_all(&config.box_home)
                {
                    tracing::warn!(
                        box_id = %box_id,
                        path = %config.box_home.display(),
                        error = %e,
                        "Failed to cleanup box directory during recovery"
                    );
                }
            }

            // Remove from database
            if let Err(e) = self.box_manager.remove_box(box_id) {
                tracing::warn!(
                    box_id = %box_id,
                    error = %e,
                    "Failed to remove box from database during recovery cleanup"
                );
            }
        }

        if !boxes_to_remove.is_empty() {
            tracing::info!(
                "Cleaned up {} boxes during recovery (auto_remove or orphaned)",
                boxes_to_remove.len()
            );
        }

        // Phase 1.5: Recover any pending snapshots that were interrupted by a crash.
        {
            let boxes_dir = self.layout.boxes_dir();
            if boxes_dir.exists()
                && let Ok(entries) = std::fs::read_dir(&boxes_dir)
            {
                for entry in entries.flatten() {
                    if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                        crate::litebox::local_snapshot::recover_pending_snapshot(&entry.path());
                    }
                }
            }
        }

        // Phase 2: Recover remaining valid boxes
        let persisted = self.box_manager.all_boxes(true)?;

        tracing::info!("Recovering {} boxes from database", persisted.len());

        // Collect boxes that need auto-restart (Crashed/Restarting with Always/UnlessStopped policy)
        let mut boxes_to_auto_restart: Vec<(BoxID, BoxState)> = Vec::new();

        for (config, mut state) in persisted {
            let box_id = &config.id;
            let original_status = state.status;

            // Reclaim the lock for this box if one was allocated
            if let Some(lock_id) = state.lock_id {
                match self.lock_manager.allocate_and_retrieve(lock_id) {
                    Ok(_) => {
                        tracing::debug!(
                            box_id = %box_id,
                            lock_id = %lock_id,
                            "Reclaimed lock for recovered box"
                        );
                    }
                    Err(e) => {
                        tracing::warn!(
                            box_id = %box_id,
                            lock_id = %lock_id,
                            error = %e,
                            "Failed to reclaim lock for recovered box"
                        );
                    }
                }
            }

            // Check if box is actually running (single source of truth: PID file + process check)
            let pid_file = self
                .layout
                .boxes_dir()
                .join(box_id.as_str())
                .join("shim.pid");

            let is_running = if pid_file.exists() {
                match crate::util::read_pid_file(&pid_file) {
                    Ok(pid) => {
                        if is_process_alive(pid) && is_same_process(pid, box_id.as_str()) {
                            // Process is alive and it's our boxlite-shim
                            state.set_pid(Some(pid));
                            state.set_status(BoxStatus::Running);
                            tracing::info!(
                                box_id = %box_id,
                                pid = pid,
                                "Recovered running box from PID file"
                            );
                            true
                        } else {
                            // Process died or PID was reused
                            let _ = std::fs::remove_file(&pid_file);
                            tracing::warn!(
                                box_id = %box_id,
                                pid = pid,
                                "Box process dead, cleaned up stale PID file"
                            );
                            false
                        }
                    }
                    Err(e) => {
                        // Can't read PID file
                        let _ = std::fs::remove_file(&pid_file);
                        tracing::warn!(
                            box_id = %box_id,
                            error = %e,
                            "Failed to read PID file"
                        );
                        false
                    }
                }
            } else {
                // No PID file - box was stopped gracefully or never started
                if state.status == BoxStatus::Running {
                    tracing::warn!(
                        box_id = %box_id,
                        "Box was Running but no PID file found"
                    );
                }
                false
            };

            // If box is not running, decide whether recovery should auto-restart it.
            if !is_running {
                let should_evaluate_restart = matches!(
                    original_status,
                    BoxStatus::Running | BoxStatus::Crashed | BoxStatus::Restarting
                );

                if should_evaluate_restart {
                    let restart_policy = config.options.advanced.restart_policy.as_ref();
                    // Read exit code from file. If no file (clean exit), default to 0.
                    let exit_code = read_box_exit_code(&config.box_home).or(Some(0));
                    let max_retries_exhausted = matches!(
                        restart_policy,
                        Some(RestartPolicy::OnFailure { max_retries })
                            if state.stop_info.restart_count >= *max_retries
                    );

                    // Evaluate whether to auto-restart during recovery
                    let should_auto_restart = match restart_policy {
                        None => false,
                        Some(RestartPolicy::UnlessStopped) => {
                            state.stop_info.cause != StopCause::Normal
                        }
                        Some(policy) => {
                            policy.should_restart(exit_code, state.stop_info.restart_count)
                        }
                    };

                    if should_auto_restart {
                        // Queue for auto-restart
                        boxes_to_auto_restart.push((box_id.clone(), state.clone()));
                        tracing::info!(
                            box_id = %box_id,
                            previous_status = ?original_status,
                            restart_count = state.stop_info.restart_count,
                            exit_code = ?exit_code,
                            "Box queued for auto-restart during recovery"
                        );
                    } else {
                        state.force_status(BoxStatus::Stopped);
                        state.set_pid(None);
                        state.stop_info.cause = stop_cause_when_restart_denied(
                            restart_policy,
                            exit_code,
                            max_retries_exhausted,
                        );
                        state.stop_info.exit_code = exit_code;
                        state.stop_info.exit_time.get_or_insert(Utc::now());
                        tracing::warn!(
                            box_id = %box_id,
                            previous_status = ?original_status,
                            exit_code = ?exit_code,
                            "Box not running at recovery, marked as Stopped for manual recovery"
                        );
                    }
                }
            }

            // Save updated state to database if changed
            if state.status != original_status {
                self.box_manager.save_box(box_id, &state)?;
            }
        }

        // GC unreferenced guest rootfs entries
        if let Err(e) = self.guest_rootfs_mgr.gc(&self.layout.boxes_dir()) {
            tracing::warn!("Guest rootfs GC failed: {}", e);
        }

        tracing::info!(
            "Box recovery complete, {} boxes queued for auto-restart",
            boxes_to_auto_restart.len()
        );
        Ok(boxes_to_auto_restart)
    }

    /// Scan filesystem for orphaned box directories and remove them.
    ///
    /// Orphaned directories are those that exist in ~/.boxlite/boxes/
    /// but have no corresponding record in the database. This can occur when:
    /// - Box creation succeeded but database persist failed
    /// - Process crashed after directory creation but before DB insert
    /// - Old boxes from before persistence was implemented
    fn cleanup_orphaned_directories(&self) -> BoxliteResult<()> {
        use std::collections::HashSet;

        let boxes_dir = self.layout.boxes_dir();
        if !boxes_dir.exists() {
            return Ok(());
        }

        // Scan filesystem for box directories
        let fs_box_ids: HashSet<String> = match std::fs::read_dir(&boxes_dir) {
            Ok(entries) => entries
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false))
                .filter_map(|entry| entry.file_name().to_str().map(String::from))
                .collect(),
            Err(e) => {
                tracing::warn!(
                    path = %boxes_dir.display(),
                    error = %e,
                    "Failed to scan boxes directory for orphans"
                );
                return Ok(()); // Non-fatal, continue with recovery
            }
        };

        if fs_box_ids.is_empty() {
            return Ok(());
        }

        // Load all box IDs from database
        let db_box_ids: HashSet<String> = self
            .box_manager
            .all_boxes(false)?
            .into_iter()
            .map(|(cfg, _)| cfg.id.to_string())
            .collect();

        // Find orphaned directories (exist on filesystem but not in DB)
        let orphaned: Vec<_> = fs_box_ids.difference(&db_box_ids).collect();

        if orphaned.is_empty() {
            return Ok(());
        }

        tracing::info!(
            count = orphaned.len(),
            "Found orphaned box directories (no DB record)"
        );

        for orphan_id in orphaned {
            let orphan_dir = boxes_dir.join(orphan_id);
            tracing::warn!(
                box_id = %orphan_id,
                path = %orphan_dir.display(),
                "Removing orphaned box directory (no database record)"
            );

            if let Err(e) = std::fs::remove_dir_all(&orphan_dir) {
                tracing::error!(
                    box_id = %orphan_id,
                    path = %orphan_dir.display(),
                    error = %e,
                    "Failed to remove orphaned box directory"
                );
            }
        }

        Ok(())
    }

    // ========================================================================
    // RESTART
    // ========================================================================

    /// Restart a box by ID.
    ///
    /// Follows the same pattern as stop(): invalidate old BoxImpl from cache,
    /// create a fresh BoxImpl, and call start() on it. The fresh BoxImpl has
    /// an empty OnceCell, so start() triggers init_live_state() which runs
    /// the Restarting execution plan (same as Stopped - reuse COW disks, spawn new VM).
    ///
    /// **Callers must hold the per-box lock** to ensure mutual exclusion with
    /// crash handling. This function does NOT acquire the lock internally.
    pub(crate) async fn restart(self: &Arc<Self>, box_id: &BoxID) -> BoxliteResult<()> {
        use crate::litebox::BoxStatus;

        tracing::info!(box_id = %box_id, "Restarting box");

        // 1. Look up existing box config and state from DB
        let (config, mut state) = self
            .box_manager
            .box_by_id(box_id)?
            .ok_or_else(|| BoxliteError::NotFound(box_id.to_string()))?;

        // 2. If there's an active BoxImpl in cache, abort its health check and cancel it
        {
            let sync = self.sync_state.read().unwrap();
            if let Some(weak) = sync.active_boxes_by_id.get(box_id)
                && let Some(strong) = weak.upgrade()
            {
                // Abort health check task
                strong.abort_health_check();
                // Cancel shutdown token (makes old BoxImpl unusable)
                strong.shutdown_token.cancel();
            }
        }

        // 3. Invalidate old BoxImpl from cache
        self.invalidate_box_impl(box_id, config.name.as_deref());

        // 4. Update state to Restarting and persist
        state.force_status(BoxStatus::Restarting);
        state.set_pid(None);
        state.clear_health_status();
        self.box_manager.save_box(box_id, &state)?;

        // 5. Create fresh BoxImpl with updated state
        let (box_impl, _) = self.get_or_create_box_impl(config, state);

        // 6. Call start() on fresh BoxImpl → empty OnceCell → init_live_state()
        //    BoxBuilder sees status=Restarting → same pipeline as Stopped
        box_impl.start().await?;

        // 7. Reset stop info — previous crash/restart history is no longer relevant
        {
            let mut state = box_impl.state.write();
            state.stop_info = crate::litebox::StopInfo::default();
            state.stop_info.restarted_at = Some(chrono::Utc::now());
            if let Err(e) = self.box_manager.save_box(box_id, &state) {
                tracing::warn!(
                    box_id = %box_id,
                    error = %e,
                    "Failed to persist restart success state"
                );
            }
        }

        tracing::info!(box_id = %box_id, "Box restarted successfully");
        Ok(())
    }

    // ========================================================================
    // INTERNAL - BOX IMPL CACHE
    // ========================================================================

    /// Get existing BoxImpl from cache or create new one.
    ///
    /// Returns `(SharedBoxImpl, inserted)` where `inserted` is true if a new BoxImpl
    /// was created, false if an existing one was returned.
    ///
    /// Checks both by name (if provided) and by ID. This prevents duplicate names
    /// even for boxes not yet persisted to database.
    fn get_or_create_box_impl(
        self: &Arc<Self>,
        config: BoxConfig,
        state: BoxState,
    ) -> (SharedBoxImpl, bool) {
        use crate::litebox::box_impl::BoxImpl;

        let box_id = config.id.clone();
        let box_name = config.name.clone();

        let mut sync = self.sync_state.write().unwrap();

        // Check by name first (if provided) - prevents duplicate names
        if let Some(ref name) = box_name
            && let Some(weak) = sync.active_boxes_by_name.get(name)
        {
            if let Some(strong) = weak.upgrade() {
                tracing::trace!(name = %name, "Reusing cached BoxImpl by name");
                return (strong, false);
            }
            // Dead weak ref, clean it up
            sync.active_boxes_by_name.remove(name);
        }

        // Check by ID
        if let Some(weak) = sync.active_boxes_by_id.get(&box_id) {
            if let Some(strong) = weak.upgrade() {
                tracing::trace!(box_id = %box_id, "Reusing cached BoxImpl by ID");
                return (strong, false);
            }
            // Dead weak ref, clean it up
            sync.active_boxes_by_id.remove(&box_id);
        }

        // Create new BoxImpl and cache in both maps
        // Pass a child token so box can be cancelled independently or via runtime shutdown
        let box_token = self.shutdown_token.child_token();
        let box_impl = Arc::new(BoxImpl::new(config, state, Arc::clone(self), box_token));
        let weak = Arc::downgrade(&box_impl);

        sync.active_boxes_by_id.insert(box_id.clone(), weak.clone());
        if let Some(name) = box_name {
            sync.active_boxes_by_name.insert(name.clone(), weak);
            tracing::trace!(box_id = %box_id, name = %name, "Created and cached new BoxImpl");
        } else {
            tracing::trace!(box_id = %box_id, "Created and cached new BoxImpl (unnamed)");
        }

        (box_impl, true)
    }

    /// Remove BoxImpl from cache.
    ///
    /// Called when box is stopped or removed. Existing handles become stale;
    /// new handles from runtime.get() will get a fresh BoxImpl.
    pub(crate) fn invalidate_box_impl(&self, box_id: &BoxID, box_name: Option<&str>) {
        let mut sync = self.sync_state.write().unwrap();
        sync.active_boxes_by_id.remove(box_id);
        if let Some(name) = box_name {
            sync.active_boxes_by_name.remove(name);
        }
        tracing::trace!(box_id = %box_id, name = ?box_name, "Invalidated BoxImpl cache");
    }

    /// Acquire coordination lock for multi-step atomic operations.
    ///
    /// Use this when you need atomicity across multiple operations on
    /// box_manager or image_manager.
    #[allow(unused)]
    pub(crate) fn acquire_write(
        &self,
    ) -> BoxliteResult<std::sync::RwLockWriteGuard<'_, SynchronizedState>> {
        self.sync_state
            .write()
            .map_err(|e| BoxliteError::Internal(format!("Coordination lock poisoned: {}", e)))
    }
}

/// Find boxes that depend on bases created from this box.
///
/// Uses the `base_disk_ref` table: looks up bases where `source_box_id` matches,
/// then finds other boxes that reference those bases.
///
/// Used to prevent removing a box that other boxes depend on (COW clones).
fn find_boxes_depending_on(runtime: &RuntimeImpl, box_id: &str) -> BoxliteResult<Vec<String>> {
    use std::collections::HashSet;

    let bases = runtime.base_disk_mgr.store().list_by_box(box_id, None)?;

    let mut dependents = HashSet::new();
    for base in &bases {
        for dep_box_id in runtime.base_disk_mgr.store().dependent_boxes(base.id())? {
            if dep_box_id != box_id {
                dependents.insert(dep_box_id);
            }
        }
    }
    Ok(dependents.into_iter().collect())
}

/// Reject qcow2 disks that contain backing file references.
///
/// Imported disks must be standalone — a backing reference could point to
/// arbitrary host files (e.g. /etc/shadow) and leak their contents.
impl std::fmt::Debug for RuntimeImpl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeInner")
            .field("home_dir", &self.layout.home_dir())
            .finish()
    }
}

// ============================================================================
// LocalRuntime — RuntimeBackend adapter for local VM execution
// ============================================================================

/// Adapter bridging `RuntimeImpl` (Arc-receiver methods) to `RuntimeBackend` trait.
///
/// `RuntimeImpl` methods use `self: &Arc<Self>` for back-references from `BoxImpl`.
/// Trait methods use `&self`. This newtype holds the Arc as a field to bridge the gap.
pub(crate) struct LocalRuntime(pub(crate) SharedRuntimeImpl);

#[async_trait::async_trait]
impl super::backend::RuntimeBackend for LocalRuntime {
    async fn create(
        &self,
        options: BoxOptions,
        name: Option<String>,
    ) -> BoxliteResult<crate::litebox::LiteBox> {
        self.0.create(options, name).await
    }

    async fn get_or_create(
        &self,
        options: BoxOptions,
        name: Option<String>,
    ) -> BoxliteResult<(crate::litebox::LiteBox, bool)> {
        self.0.get_or_create(options, name).await
    }

    async fn get(&self, id_or_name: &str) -> BoxliteResult<Option<crate::litebox::LiteBox>> {
        self.0.get(id_or_name).await
    }

    async fn get_info(&self, id_or_name: &str) -> BoxliteResult<Option<BoxInfo>> {
        self.0.get_info(id_or_name).await
    }

    async fn list_info(&self) -> BoxliteResult<Vec<BoxInfo>> {
        self.0.list_info().await
    }

    async fn exists(&self, id_or_name: &str) -> BoxliteResult<bool> {
        self.0.exists(id_or_name).await
    }

    async fn metrics(&self) -> BoxliteResult<crate::metrics::RuntimeMetrics> {
        Ok(self.0.metrics().await)
    }

    async fn remove(&self, id_or_name: &str, force: bool) -> BoxliteResult<()> {
        self.0.remove(id_or_name, force)
    }

    async fn shutdown(&self, timeout: Option<i32>) -> BoxliteResult<()> {
        self.0.shutdown(timeout).await
    }

    async fn import_box(
        &self,
        archive: BoxArchive,
        name: Option<String>,
    ) -> BoxliteResult<crate::litebox::LiteBox> {
        self.0.import_box(archive, name).await
    }

    fn shutdown_sync(&self) {
        self.0.shutdown_sync();
    }
}

// Image operations (separate from RuntimeBackend)
#[async_trait::async_trait]
impl super::images::ImageBackend for LocalRuntime {
    async fn pull_image(&self, image_ref: &str) -> BoxliteResult<crate::images::ImageObject> {
        self.0.image_manager.pull(image_ref).await
    }

    async fn list_images(&self) -> BoxliteResult<Vec<crate::runtime::types::ImageInfo>> {
        self.0.image_manager.list().await
    }
}

// ============================================================================
// Drop — Safety net for non-default runtimes
// ============================================================================

impl Drop for RuntimeImpl {
    fn drop(&mut self) {
        if self.shutdown_token.is_cancelled() {
            return; // shutdown() was already called
        }
        // Safety net: stop non-detached boxes if shutdown() wasn't called.
        // shutdown_sync() logs per-box when it actually stops something.
        self.shutdown_sync();
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::litebox::config::{BoxConfig, ContainerRuntimeConfig};
    use crate::runtime::advanced_options::RestartPolicy;
    use crate::runtime::backend::RuntimeBackend;
    use crate::runtime::options::RootfsSpec;
    use tempfile::TempDir;

    /// Create a RuntimeImpl with isolated temp directory.
    fn create_test_runtime() -> (SharedRuntimeImpl, TempDir) {
        let temp_dir = TempDir::new_in("/tmp").expect("Failed to create temp dir");
        let options = BoxliteOptions {
            home_dir: temp_dir.path().to_path_buf(),
            image_registries: vec![],
        };
        let runtime = RuntimeImpl::new(options).expect("Failed to create runtime");
        (runtime, temp_dir)
    }

    /// Create a minimal BoxConfig for testing.
    fn test_box_config(detach: bool) -> BoxConfig {
        BoxConfig {
            id: BoxIDMint::mint(),
            name: None,
            created_at: Utc::now(),
            container: ContainerRuntimeConfig {
                id: ContainerID::new(),
            },
            options: BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                detach,
                auto_remove: false,
                ..Default::default()
            },
            engine_kind: VmmKind::Libkrun,
            transport: Transport::Unix {
                socket_path: "/tmp/test.sock".into(),
            },
            box_home: std::path::PathBuf::from("/tmp/test-box"),
            ready_socket_path: std::path::PathBuf::from("/tmp/test-ready.sock"),
        }
    }

    /// Create a BoxState with Running status and a given PID.
    fn running_state(pid: u32) -> BoxState {
        let mut state = BoxState::new();
        state.status = BoxStatus::Running;
        state.pid = Some(pid);
        state
    }

    /// Spawn a dummy sleep process and return its PID.
    fn spawn_dummy_process() -> (u32, std::process::Child) {
        let child = std::process::Command::new("sleep")
            .arg("300")
            .spawn()
            .expect("Failed to spawn dummy process");
        let pid = child.id();
        (pid, child)
    }

    /// Spawn a process that ignores SIGTERM (for force-kill testing).
    fn spawn_sigterm_ignoring_process() -> (u32, std::process::Child) {
        let child = std::process::Command::new("sh")
            .arg("-c")
            .arg("trap '' TERM; sleep 300")
            .spawn()
            .expect("Failed to spawn SIGTERM-ignoring process");
        let pid = child.id();
        // Wait for the trap to be installed
        std::thread::sleep(std::time::Duration::from_millis(200));
        (pid, child)
    }

    /// Create a BoxConfig whose box_home aligns with the runtime's layout.
    /// This is needed for tests that verify PID file operations.
    fn test_box_config_in_layout(detach: bool, runtime: &RuntimeImpl) -> BoxConfig {
        let id = BoxIDMint::mint();
        let box_home = runtime.layout.boxes_dir().join(id.as_str());
        BoxConfig {
            id,
            name: None,
            created_at: Utc::now(),
            container: ContainerRuntimeConfig {
                id: ContainerID::new(),
            },
            options: BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                detach,
                auto_remove: false,
                ..Default::default()
            },
            engine_kind: VmmKind::Libkrun,
            transport: Transport::Unix {
                socket_path: "/tmp/test.sock".into(),
            },
            box_home,
            ready_socket_path: std::path::PathBuf::from("/tmp/test-ready.sock"),
        }
    }

    // ====================================================================
    // shutdown() tests
    // ====================================================================

    #[test]
    fn test_new_does_not_start_background_tasks() {
        let (runtime, _dir) = create_test_runtime();

        // new() is sync — no crash handler or recovery tasks should be spawned
        assert!(runtime.crash_handler_handle.read().unwrap().is_none());
        assert!(runtime.services_started.get().is_none());
    }

    #[tokio::test]
    async fn test_async_call_starts_background_services() {
        let (runtime, _dir) = create_test_runtime();

        // Before any async call, services are not started
        assert!(runtime.services_started.get().is_none());

        // Calling an async method triggers lazy initialization
        runtime.list_info().await.unwrap();

        // Services should now be started
        assert!(runtime.services_started.get().is_some());
        assert!(runtime.crash_handler_handle.read().unwrap().is_some());
    }

    #[test]
    fn test_new_without_tokio_with_recovery_candidate_does_not_panic() {
        let temp_dir = TempDir::new_in("/tmp").expect("Failed to create temp dir");
        let options = BoxliteOptions {
            home_dir: temp_dir.path().to_path_buf(),
            image_registries: vec![],
        };

        let box_id = {
            let runtime = RuntimeImpl::new(options.clone()).expect("Failed to create seed runtime");

            let mut config = test_box_config_in_layout(false, &runtime);
            config.options.advanced.restart_policy = Some(RestartPolicy::Always);
            std::fs::create_dir_all(&config.box_home).expect("Failed to create box home");

            let mut state = BoxState::new();
            state.status = BoxStatus::Crashed;
            state.set_lock_id(
                runtime
                    .lock_manager
                    .allocate()
                    .expect("Failed to allocate lock"),
            );

            let box_id = config.id.clone();
            runtime
                .box_manager
                .add_box(&config, &state)
                .expect("Failed to add box");
            drop(runtime);
            box_id
        };

        let runtime = RuntimeImpl::new(options).expect("Failed to recover runtime");

        // Recovery queue should be populated but not yet processed (no tokio runtime)
        assert_eq!(runtime.recovery_queue.lock().unwrap().len(), 1);

        let (_, recovered_state) = runtime
            .box_manager
            .box_by_id(&box_id)
            .expect("Failed to read recovered box")
            .expect("Recovered box should exist");
        assert_eq!(recovered_state.status, BoxStatus::Crashed);
        assert!(recovered_state.last_restart_error.is_none());
    }

    #[tokio::test]
    async fn test_shutdown_is_idempotent() {
        let (runtime, _dir) = create_test_runtime();

        // First shutdown should succeed
        let result1 = runtime.shutdown(None).await;
        assert!(result1.is_ok());
        assert!(runtime.shutdown_token.is_cancelled());

        // Second shutdown should also succeed (no-op)
        let result2 = runtime.shutdown(None).await;
        assert!(result2.is_ok());
    }

    #[tokio::test]
    async fn test_shutdown_cancels_token() {
        let (runtime, _dir) = create_test_runtime();

        assert!(!runtime.shutdown_token.is_cancelled());
        runtime.shutdown(None).await.unwrap();
        assert!(runtime.shutdown_token.is_cancelled());
    }

    #[tokio::test]
    async fn test_shutdown_with_empty_active_boxes() {
        let (runtime, _dir) = create_test_runtime();

        // No boxes created — shutdown should complete cleanly
        let result = runtime.shutdown(Some(1)).await;
        assert!(result.is_ok());
    }

    // ====================================================================
    // shutdown_sync() tests
    // ====================================================================

    #[test]
    fn test_shutdown_sync_cancels_token() {
        let (runtime, _dir) = create_test_runtime();

        assert!(!runtime.shutdown_token.is_cancelled());
        runtime.shutdown_sync();
        assert!(runtime.shutdown_token.is_cancelled());
    }

    #[test]
    fn test_shutdown_sync_is_idempotent() {
        let (runtime, _dir) = create_test_runtime();

        runtime.shutdown_sync();
        assert!(runtime.shutdown_token.is_cancelled());

        // Second call should be no-op (token already cancelled)
        runtime.shutdown_sync();
        assert!(runtime.shutdown_token.is_cancelled());
    }

    #[test]
    fn test_shutdown_sync_stops_non_detached_running_box() {
        let (runtime, _dir) = create_test_runtime();

        // Spawn a dummy process to simulate a shim
        let (pid, mut child) = spawn_dummy_process();

        // Insert a non-detached Running box into the DB
        let config = test_box_config(false); // detach=false
        let state = running_state(pid);
        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("Failed to add box");

        // shutdown_sync should kill the process
        runtime.shutdown_sync();

        // Process should be dead
        let wait_result = child.try_wait().expect("Failed to check child");
        // Give a moment for the process to die
        if wait_result.is_none() {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        assert!(
            !crate::util::is_process_alive(pid),
            "Non-detached process should be killed by shutdown_sync"
        );

        // Verify DB state updated to Stopped
        let (_, updated_state) = runtime
            .box_manager
            .box_by_id(&config.id)
            .expect("Failed to query box")
            .expect("Box should exist");
        assert_eq!(updated_state.status, BoxStatus::Stopped);
        assert!(updated_state.pid.is_none());
    }

    #[test]
    fn test_shutdown_sync_skips_detached_box() {
        let (runtime, _dir) = create_test_runtime();

        // Spawn a dummy process to simulate a detached shim
        let (pid, mut child) = spawn_dummy_process();

        // Insert a detached Running box into the DB
        let config = test_box_config(true); // detach=true
        let state = running_state(pid);
        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("Failed to add box");

        // shutdown_sync should skip detached boxes
        runtime.shutdown_sync();

        // Process should still be alive
        assert!(
            crate::util::is_process_alive(pid),
            "Detached process should NOT be killed by shutdown_sync"
        );

        // Verify DB state NOT changed (still Running)
        let (_, db_state) = runtime
            .box_manager
            .box_by_id(&config.id)
            .expect("Failed to query box")
            .expect("Box should exist");
        assert_eq!(db_state.status, BoxStatus::Running);
        assert_eq!(db_state.pid, Some(pid));

        // Cleanup
        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn test_shutdown_sync_skips_stopped_box() {
        let (runtime, _dir) = create_test_runtime();

        // Insert a Stopped box into the DB
        let config = test_box_config(false);
        let mut state = BoxState::new();
        state.status = BoxStatus::Stopped;
        state.pid = None;
        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("Failed to add box");

        // shutdown_sync should skip non-running boxes
        runtime.shutdown_sync();

        // Verify DB state unchanged
        let (_, db_state) = runtime
            .box_manager
            .box_by_id(&config.id)
            .expect("Failed to query box")
            .expect("Box should exist");
        assert_eq!(db_state.status, BoxStatus::Stopped);
    }

    #[test]
    fn test_shutdown_sync_skips_dead_pid() {
        let (runtime, _dir) = create_test_runtime();

        // Use an invalid PID (not a real process)
        let dead_pid = 999_999_999u32;

        let config = test_box_config(false);
        let state = running_state(dead_pid);
        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("Failed to add box");

        // shutdown_sync should skip dead PIDs without errors
        runtime.shutdown_sync();

        // DB state should NOT be updated (process was already dead)
        let (_, db_state) = runtime
            .box_manager
            .box_by_id(&config.id)
            .expect("Failed to query box")
            .expect("Box should exist");
        assert_eq!(db_state.status, BoxStatus::Running);
    }

    #[test]
    fn test_shutdown_sync_mixed_boxes() {
        let (runtime, _dir) = create_test_runtime();

        // Spawn two dummy processes
        let (pid_regular, mut child_regular) = spawn_dummy_process();
        let (pid_detached, mut child_detached) = spawn_dummy_process();

        // Non-detached running box
        let config_regular = test_box_config(false);
        let state_regular = running_state(pid_regular);
        runtime
            .box_manager
            .add_box(&config_regular, &state_regular)
            .unwrap();

        // Detached running box
        let config_detached = test_box_config(true);
        let state_detached = running_state(pid_detached);
        runtime
            .box_manager
            .add_box(&config_detached, &state_detached)
            .unwrap();

        // Stopped box (should be skipped regardless)
        let config_stopped = test_box_config(false);
        let mut state_stopped = BoxState::new();
        state_stopped.status = BoxStatus::Stopped;
        runtime
            .box_manager
            .add_box(&config_stopped, &state_stopped)
            .unwrap();

        runtime.shutdown_sync();

        // Non-detached box: killed, DB updated
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(
            !crate::util::is_process_alive(pid_regular),
            "Non-detached box should be killed"
        );
        let (_, db_regular) = runtime
            .box_manager
            .box_by_id(&config_regular.id)
            .unwrap()
            .unwrap();
        assert_eq!(db_regular.status, BoxStatus::Stopped);

        // Detached box: still alive, DB unchanged
        assert!(
            crate::util::is_process_alive(pid_detached),
            "Detached box should survive"
        );
        let (_, db_detached) = runtime
            .box_manager
            .box_by_id(&config_detached.id)
            .unwrap()
            .unwrap();
        assert_eq!(db_detached.status, BoxStatus::Running);

        // Stopped box: DB unchanged
        let (_, db_stopped) = runtime
            .box_manager
            .box_by_id(&config_stopped.id)
            .unwrap()
            .unwrap();
        assert_eq!(db_stopped.status, BoxStatus::Stopped);

        // Cleanup
        child_regular.kill().ok();
        child_regular.wait().ok();
        child_detached.kill().ok();
        child_detached.wait().ok();
    }

    // ====================================================================
    // Drop tests
    // ====================================================================

    #[test]
    fn test_drop_triggers_shutdown_sync_when_not_cancelled() {
        let (runtime, _dir) = create_test_runtime();

        // Spawn a dummy process
        let (pid, mut child) = spawn_dummy_process();

        let config = test_box_config(false);
        let state = running_state(pid);
        runtime.box_manager.add_box(&config, &state).unwrap();

        // Drop the runtime without calling shutdown
        drop(runtime);

        // Process should be killed by Drop → shutdown_sync
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(
            !crate::util::is_process_alive(pid),
            "Drop should trigger shutdown_sync and kill the process"
        );

        // Cleanup
        child.kill().ok();
        child.wait().ok();
    }

    #[tokio::test]
    async fn test_drop_skips_when_shutdown_already_called() {
        let (runtime, _dir) = create_test_runtime();

        // Spawn a dummy process for a detached box
        let (pid, mut child) = spawn_dummy_process();

        let config = test_box_config(true); // detached
        let state = running_state(pid);
        runtime.box_manager.add_box(&config, &state).unwrap();

        // Call shutdown explicitly (async) — skips detached boxes
        runtime.shutdown(None).await.unwrap();

        // Token is now cancelled
        assert!(runtime.shutdown_token.is_cancelled());

        // Drop should be no-op since token is already cancelled
        drop(runtime);

        // Detached process should still be alive
        assert!(
            crate::util::is_process_alive(pid),
            "Detached process should survive both shutdown() and Drop"
        );

        // Cleanup
        child.kill().ok();
        child.wait().ok();
    }

    // ====================================================================
    // shutdown() detach filter tests (async, uses in-memory cache)
    // ====================================================================

    #[tokio::test]
    async fn test_shutdown_with_no_boxes_returns_ok() {
        let (runtime, _dir) = create_test_runtime();
        let result = runtime.shutdown(None).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_shutdown_then_shutdown_sync_is_noop() {
        let (runtime, _dir) = create_test_runtime();

        // Async shutdown first
        runtime.shutdown(None).await.unwrap();
        assert!(runtime.shutdown_token.is_cancelled());

        // Sync shutdown should be no-op
        runtime.shutdown_sync();
        assert!(runtime.shutdown_token.is_cancelled());
    }

    #[test]
    fn test_shutdown_sync_then_async_shutdown_is_noop() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let (runtime, _dir) = create_test_runtime();

        // Sync shutdown first
        runtime.shutdown_sync();
        assert!(runtime.shutdown_token.is_cancelled());

        // Async shutdown should be no-op
        let result = rt.block_on(runtime.shutdown(None));
        assert!(result.is_ok());
    }

    // ====================================================================
    // PID file removal
    // ====================================================================

    #[test]
    fn test_shutdown_sync_removes_pid_file() {
        let (runtime, _dir) = create_test_runtime();

        let (pid, mut child) = spawn_dummy_process();

        // Use config with box_home aligned to runtime layout
        let config = test_box_config_in_layout(false, &runtime);
        let state = running_state(pid);

        // Create the box directory and PID file
        let box_dir = runtime.layout.boxes_dir().join(config.id.as_str());
        std::fs::create_dir_all(&box_dir).expect("Failed to create box directory");
        let pid_file = box_dir.join("shim.pid");
        std::fs::write(&pid_file, pid.to_string()).expect("Failed to write PID file");
        assert!(pid_file.exists(), "PID file should exist before shutdown");

        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("Failed to add box");

        runtime.shutdown_sync();

        // PID file should be removed
        assert!(
            !pid_file.exists(),
            "PID file should be removed after shutdown_sync"
        );

        // Process should be dead
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!crate::util::is_process_alive(pid));

        // DB should be updated to Stopped
        let (_, db_state) = runtime.box_manager.box_by_id(&config.id).unwrap().unwrap();
        assert_eq!(db_state.status, BoxStatus::Stopped);
        assert!(db_state.pid.is_none());

        child.kill().ok();
        child.wait().ok();
    }

    // ====================================================================
    // Edge case: Running box with no PID
    // ====================================================================

    #[test]
    fn test_shutdown_sync_skips_running_box_with_no_pid() {
        let (runtime, _dir) = create_test_runtime();

        // Running box with pid=None (anomalous but possible after crash)
        let config = test_box_config(false);
        let mut state = BoxState::new();
        state.status = BoxStatus::Running;
        state.pid = None;

        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("Failed to add box");

        // Should not panic — the `let Some(pid) = state.pid else { continue }` skips it
        runtime.shutdown_sync();

        // DB state should remain unchanged (continue skips mark_stop)
        let (_, db_state) = runtime.box_manager.box_by_id(&config.id).unwrap().unwrap();
        assert_eq!(db_state.status, BoxStatus::Running);
        assert!(db_state.pid.is_none());
    }

    // ====================================================================
    // Force-kill path (SIGTERM timeout → SIGKILL)
    // ====================================================================

    #[test]
    fn test_shutdown_sync_force_kills_stuck_process() {
        let (runtime, _dir) = create_test_runtime();

        // Spawn a process that ignores SIGTERM
        let (pid, mut child) = spawn_sigterm_ignoring_process();

        let config = test_box_config(false);
        let state = running_state(pid);
        runtime.box_manager.add_box(&config, &state).unwrap();

        let start = std::time::Instant::now();
        runtime.shutdown_sync();
        let elapsed = start.elapsed();

        // Should have waited ~5s before force killing
        assert!(
            elapsed >= std::time::Duration::from_secs(4),
            "Expected ~5s timeout before force kill, got {:?}",
            elapsed
        );

        // Process must be dead (SIGKILL)
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(
            !crate::util::is_process_alive(pid),
            "Process should be force-killed after SIGTERM timeout"
        );

        // DB should be updated to Stopped
        let (_, db_state) = runtime.box_manager.box_by_id(&config.id).unwrap().unwrap();
        assert_eq!(db_state.status, BoxStatus::Stopped);

        child.kill().ok();
        child.wait().ok();
    }

    // ====================================================================
    // Backend trait delegation
    // ====================================================================

    #[test]
    fn test_shutdown_sync_delegates_through_local_runtime() {
        let (runtime, _dir) = create_test_runtime();

        let (pid, mut child) = spawn_dummy_process();

        let config = test_box_config(false);
        let state = running_state(pid);
        runtime.box_manager.add_box(&config, &state).unwrap();

        // Wrap in LocalRuntime (the backend wrapper) and call via trait
        let local = LocalRuntime(Arc::clone(&runtime));
        RuntimeBackend::shutdown_sync(&local);

        // Token should be cancelled (proves delegation to RuntimeImpl)
        assert!(runtime.shutdown_token.is_cancelled());

        // Process should be dead
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!crate::util::is_process_alive(pid));

        // DB should be updated
        let (_, db_state) = runtime.box_manager.box_by_id(&config.id).unwrap().unwrap();
        assert_eq!(db_state.status, BoxStatus::Stopped);

        child.kill().ok();
        child.wait().ok();
    }

    #[tokio::test]
    async fn test_import_box_delegates_through_local_runtime() {
        let (runtime, dir) = create_test_runtime();
        let missing_archive = dir.path().join("missing.boxlite");

        let local = LocalRuntime(Arc::clone(&runtime));
        let result = RuntimeBackend::import_box(
            &local,
            BoxArchive::new(missing_archive),
            Some("imported".to_string()),
        )
        .await;

        match result {
            Err(BoxliteError::NotFound(msg)) => {
                assert!(
                    msg.contains("Archive not found"),
                    "Expected archive-not-found error, got: {msg}"
                );
            }
            _ => panic!("Expected NotFound for missing archive"),
        }
    }

    // ====================================================================
    // Post-shutdown operation rejection
    // ====================================================================

    #[tokio::test]
    async fn test_create_after_shutdown_returns_stopped() {
        let (runtime, _dir) = create_test_runtime();

        // Shutdown the runtime
        runtime.shutdown(None).await.unwrap();

        // Attempt to create a box — should be rejected
        let result = runtime
            .create_inner(
                BoxOptions {
                    rootfs: RootfsSpec::Image("alpine:latest".into()),
                    ..Default::default()
                },
                Some("test-box".into()),
                false,
            )
            .await;

        match result {
            Err(BoxliteError::Stopped(msg)) => {
                assert!(
                    msg.contains("shut down"),
                    "Error should mention 'shut down': {msg}"
                );
            }
            Err(other) => panic!("Expected Stopped error, got: {other}"),
            Ok(_) => panic!("create should fail after shutdown"),
        }
    }

    // ====================================================================
    // Remove box clone dependency guard (Fix #7)
    // ====================================================================

    #[test]
    fn test_remove_box_blocked_by_clone_dependency() {
        let (runtime, _dir) = create_test_runtime();

        // Create box A with a disk.
        let config_a = test_box_config_in_layout(false, &runtime);
        let state_a = BoxState::new();
        let disks_a = config_a.box_home.join("disks");
        std::fs::create_dir_all(&disks_a).unwrap();

        // Create a standalone qcow2 for box A.
        let disk_a = disks_a.join("disk.qcow2");
        crate::disk::qcow2::write_test_qcow2(&disk_a, None);

        runtime.box_manager.add_box(&config_a, &state_a).unwrap();

        // Create box B.
        let config_b = test_box_config_in_layout(false, &runtime);
        let state_b = BoxState::new();
        let disks_b = config_b.box_home.join("disks");
        std::fs::create_dir_all(&disks_b).unwrap();

        let disk_b = disks_b.join("disk.qcow2");
        crate::disk::qcow2::write_test_qcow2(&disk_b, None);

        runtime.box_manager.add_box(&config_b, &state_b).unwrap();

        // Simulate a clone dependency: create a base_disk record from A,
        // then add a ref from B to that base (B is a clone of A).
        let base_disk = crate::disk::BaseDisk {
            id: crate::BaseDiskID::parse("testB001").unwrap(),
            source_box_id: config_a.id.to_string(),
            name: None,
            kind: crate::disk::BaseDiskKind::CloneBase,
            disk_info: crate::disk::DiskInfo {
                base_path: disk_a.to_string_lossy().to_string(),
                container_disk_bytes: 0,
                size_bytes: 0,
            },
            created_at: 0,
        };
        runtime.base_disk_mgr.store().insert(&base_disk).unwrap();
        runtime
            .base_disk_mgr
            .store()
            .add_ref(
                &crate::BaseDiskID::parse("testB001").unwrap(),
                config_b.id.as_ref(),
            )
            .unwrap();

        // Try to remove box A (non-force) — should fail.
        let result = runtime.remove_box(&config_a.id, false);
        assert!(result.is_err());
        let msg = format!("{}", result.unwrap_err());
        assert!(
            msg.contains("clone dependencies"),
            "Expected dependency error, got: {msg}"
        );
        assert!(msg.contains(&config_b.id.to_string()));
    }

    #[test]
    fn test_remove_box_succeeds_when_no_dependents() {
        let (runtime, _dir) = create_test_runtime();

        let config = test_box_config_in_layout(false, &runtime);
        let state = BoxState::new();
        let disks_dir = config.box_home.join("disks");
        std::fs::create_dir_all(&disks_dir).unwrap();

        // Standalone disk (no backing).
        let disk = disks_dir.join("disk.qcow2");
        crate::disk::qcow2::write_test_qcow2(&disk, None);

        runtime.box_manager.add_box(&config, &state).unwrap();

        let result = runtime.remove_box(&config.id, false);
        assert!(result.is_ok());
    }

    #[test]
    fn test_remove_box_with_force_ignores_dependents() {
        let (runtime, _dir) = create_test_runtime();

        // Create box A.
        let config_a = test_box_config_in_layout(false, &runtime);
        let state_a = BoxState::new();
        let disks_a = config_a.box_home.join("disks");
        std::fs::create_dir_all(&disks_a).unwrap();
        let disk_a = disks_a.join("disk.qcow2");
        crate::disk::qcow2::write_test_qcow2(&disk_a, None);
        runtime.box_manager.add_box(&config_a, &state_a).unwrap();

        // Create box B.
        let config_b = test_box_config_in_layout(false, &runtime);
        let state_b = BoxState::new();
        let disks_b = config_b.box_home.join("disks");
        std::fs::create_dir_all(&disks_b).unwrap();
        let disk_b = disks_b.join("disk.qcow2");
        crate::disk::qcow2::write_test_qcow2(&disk_b, None);
        runtime.box_manager.add_box(&config_b, &state_b).unwrap();

        // Simulate clone dependency via DB refs (B depends on base from A).
        let base_disk = crate::disk::BaseDisk {
            id: crate::BaseDiskID::parse("testB002").unwrap(),
            source_box_id: config_a.id.to_string(),
            name: None,
            kind: crate::disk::BaseDiskKind::CloneBase,
            disk_info: crate::disk::DiskInfo {
                base_path: disk_a.to_string_lossy().to_string(),
                container_disk_bytes: 0,
                size_bytes: 0,
            },
            created_at: 0,
        };
        runtime.base_disk_mgr.store().insert(&base_disk).unwrap();
        runtime
            .base_disk_mgr
            .store()
            .add_ref(
                &crate::BaseDiskID::parse("testB002").unwrap(),
                config_b.id.as_ref(),
            )
            .unwrap();

        // Force remove should succeed despite dependency.
        let result = runtime.remove_box(&config_a.id, true);
        assert!(result.is_ok());
    }
}
