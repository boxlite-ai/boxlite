use crate::db::{BoxStore, Database};
use crate::images::{ImageDiskManager, ImageManager};
use crate::litebox::config::BoxConfig;
use crate::litebox::{BoxHandle, BoxManager, LiteBox, SharedBoxHandle, SharedBoxImpl, StopCause};
use crate::lock::{
    FileLockManager, LockId, LockManager, acquire_owned_lock, acquire_owned_lock_or_cancel,
};
use crate::metrics::{RuntimeMetrics, RuntimeMetricsStorage};
use crate::rootfs::guest::{GuestRootfs, GuestRootfsManager};
use crate::runtime::advanced_options::{RestartPolicy, calculate_backoff};
use crate::runtime::id::{BoxID, BoxIDMint};
use crate::runtime::layout::dirs::EXIT_FILE;
use crate::runtime::layout::{BoxFilesystemLayout, FilesystemLayout, FsLayoutConfig};
use crate::runtime::lock::RuntimeLock;
use crate::runtime::options::{BoxArchive, BoxOptions, BoxliteOptions};
use crate::runtime::signal_handler::timeout_to_duration;
use crate::runtime::types::{BoxInfo, BoxState, BoxStatus, ContainerID};
use crate::vmm::controller::{ShimHandler, VmmHandler};
use crate::vmm::{ExitInfo, VmmKind};
use boxlite_shared::{BoxliteError, BoxliteResult};
use chrono::Utc;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock, Weak};
use tokio::sync::{Mutex as AsyncMutex, OnceCell, mpsc};
use tokio::task::{Id as TaskId, JoinHandle, JoinSet};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

const CRASH_COORDINATOR_GRACE_PERIOD: std::time::Duration = std::time::Duration::from_secs(5);

fn litebox_from_handle(handle: SharedBoxHandle) -> LiteBox {
    // Every handle this runtime hands out starts following its box's main
    // command, if the box is running and nobody is following it yet.
    //
    // `start()` arms the watcher for boxes *we* start. This covers the ones we
    // merely adopt — recovered from a previous process, already Running with a
    // live shim. That is what a long-lived runtime meets on every restart
    // (`boxlite serve`, the cloud), and without it such a box would run to
    // completion entirely unobserved and be reported Running forever: exactly
    // the lie the watcher exists to stop telling.
    handle.current().arm_watcher(None);

    let box_backend: Arc<dyn crate::runtime::backend::BoxBackend> = handle.clone();
    let network_backend: Arc<dyn crate::runtime::backend::BoxNetworkBackend> = handle.clone();
    let snapshot_backend: Arc<dyn crate::runtime::backend::SnapshotBackend> = handle;
    LiteBox::new(box_backend, network_backend, snapshot_backend)
}

/// Record that the box's main command is over, taking its exit code from the
/// guest-written exit file.
///
/// Two callers reach this from opposite directions and must agree: the live
/// watcher in `BoxImpl` (a long-lived runtime sees the shim die) and
/// `recover_boxes` (a fresh process finds a Running box with a dead shim).
/// A missing record leaves `exit_code` as None rather than inventing a 0 —
/// the box stopped, but nobody witnessed how.
pub(crate) fn record_main_command_exit(state: &mut BoxState, exit_file: &std::path::Path) {
    if let Some(record) = boxlite_shared::layout::ExitRecord::read(exit_file) {
        state.exit_code = Some(record.exit_code);
        state.stop_info.exit_code = Some(record.exit_code);
    }
    state.mark_stop();
}

/// Archive the active exit file as `exit.previous`, freeing the canonical
/// slot for the next crash. Single-slot rotation — any prior `exit.previous`
/// is overwritten. NotFound on source is tolerated.
pub(crate) fn stash_exit_file(layout: &BoxFilesystemLayout) {
    let src = layout.exit_file_path();
    let dst = layout.exit_previous_path();
    match std::fs::rename(&src, &dst) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!(
            error = %e,
            src = %src.display(),
            "Failed to stash exit file"
        ),
    }
}

/// Move a directory tree, falling back to recursive copy + remove if rename
/// fails with EXDEV. The import/clone staging dir and the canonical boxes dir
/// can live on different filesystems (e.g. a tmpfs scratch area vs the on-disk
/// data dir), where a plain `rename()` fails with "Invalid cross-device link".
fn move_dir_cross_fs(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    match std::fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
            copy_dir_recursive(src, dst)?;
            std::fs::remove_dir_all(src)
        }
        Err(e) => Err(e),
    }
}

/// Recursively copy a directory tree, preserving symlinks as symlinks.
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if ty.is_symlink() {
            let target = std::fs::read_link(&from)?;
            std::os::unix::fs::symlink(target, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn read_box_exit_code(config: &BoxConfig) -> Option<i32> {
    let container_exit_file =
        boxlite_shared::layout::SharedGuestLayout::new(config.box_home.join("shared"))
            .container(config.container.id.as_str())
            .exit_file();

    boxlite_shared::layout::ExitRecord::read(&container_exit_file)
        .map(|record| record.exit_code)
        .or_else(|| {
            let shim_exit_file = config.box_home.join(EXIT_FILE);
            ExitInfo::from_file(&shim_exit_file).map(|info| info.exit_code())
        })
}

fn crash_restart_matches_plan(state: &BoxState, expected_epoch: u64) -> bool {
    state.lifecycle_epoch() == expected_epoch
        && matches!(state.status, BoxStatus::Crashed | BoxStatus::Restarting)
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

struct CrashRestartPlan {
    restart_policy: Option<RestartPolicy>,
    expected_epoch: u64,
    current_restart_count: u32,
    new_restart_count: u32,
    exit_code: Option<i32>,
}

enum RestartOutcome {
    Stale,
    Started {
        box_impl: SharedBoxImpl,
        lock_id: LockId,
    },
}

struct CrashCoordinator {
    runtime: Weak<RuntimeImpl>,
    shutdown_token: CancellationToken,
    force_cancel_token: CancellationToken,
    crash_rx: mpsc::Receiver<BoxID>,
    crash_rx_closed: bool,
    pending_crashes: HashSet<BoxID>,
    running_crashes: JoinSet<BoxID>,
    task_boxes: HashMap<TaskId, BoxID>,
}

impl CrashCoordinator {
    fn new(runtime: SharedRuntimeImpl, crash_rx: mpsc::Receiver<BoxID>) -> Self {
        let shutdown_token = runtime.shutdown_token.clone();
        let force_cancel_token = runtime.crash_force_cancel_token.clone();
        Self {
            runtime: Arc::downgrade(&runtime),
            shutdown_token,
            force_cancel_token,
            crash_rx,
            crash_rx_closed: false,
            pending_crashes: HashSet::new(),
            running_crashes: JoinSet::new(),
            task_boxes: HashMap::new(),
        }
    }

    fn spawn(runtime: SharedRuntimeImpl, crash_rx: mpsc::Receiver<BoxID>) -> JoinHandle<()> {
        tokio::spawn(async move {
            Self::new(runtime, crash_rx).run().await;
        })
    }

    async fn run(mut self) {
        tracing::info!("Crash coordinator task started");
        let mut force_cancelled = false;

        loop {
            if !force_cancelled && self.force_cancel_token.is_cancelled() {
                self.abort_running_crashes();
                force_cancelled = true;
            }

            let accepting_crashes = !self.shutdown_token.is_cancelled() && !self.crash_rx_closed;
            if (!accepting_crashes || self.crash_rx_closed) && self.running_crashes.is_empty() {
                break;
            }

            tokio::select! {
                crash = self.crash_rx.recv(), if accepting_crashes => {
                    match crash {
                        Some(box_id) => {
                            self.schedule_crash(box_id);
                        }
                        None => {
                            tracing::debug!("Crash notification channel closed");
                            self.crash_rx_closed = true;
                        }
                    }
                }
                result = self.running_crashes.join_next_with_id(), if !self.running_crashes.is_empty() => {
                    if let Some(result) = result {
                        self.finish_crash_task(result);
                    }
                }
                _ = self.shutdown_token.cancelled(), if !self.shutdown_token.is_cancelled() => {
                    tracing::debug!("Crash coordinator received shutdown signal");
                }
                _ = self.force_cancel_token.cancelled(), if !force_cancelled => {
                    self.abort_running_crashes();
                    force_cancelled = true;
                }
            }
        }

        tracing::info!("Crash coordinator task stopped");
    }

    fn abort_running_crashes(&mut self) {
        tracing::warn!(
            task_count = self.running_crashes.len(),
            "Crash coordinator grace period expired; aborting crash tasks"
        );
        self.running_crashes.abort_all();
    }

    fn schedule_crash(&mut self, box_id: BoxID) -> bool {
        if !Self::mark_pending_crash(&mut self.pending_crashes, &box_id) {
            tracing::debug!(
                box_id = %box_id,
                "Crash already being handled, skipping duplicate notification"
            );
            return false;
        }

        tracing::info!(box_id = %box_id, "Received crash notification");

        if self.runtime.upgrade().is_none() {
            tracing::debug!(
                box_id = %box_id,
                "Runtime already dropped, skipping crash notification"
            );
            self.pending_crashes.remove(&box_id);
            self.crash_rx_closed = true;
            return false;
        }

        let runtime_weak = Weak::clone(&self.runtime);
        let shutdown_token = self.shutdown_token.clone();
        let task_box_id = box_id.clone();
        let abort_handle = self.running_crashes.spawn(async move {
            RuntimeImpl::handle_box_crash(runtime_weak, shutdown_token, task_box_id.clone()).await;
            task_box_id
        });
        self.task_boxes.insert(abort_handle.id(), box_id);
        true
    }

    fn finish_crash_task(&mut self, result: Result<(TaskId, BoxID), tokio::task::JoinError>) {
        match result {
            Ok((task_id, returned_box_id)) => {
                let box_id = self.task_boxes.remove(&task_id).unwrap_or_else(|| {
                    tracing::error!(
                        task_id = %task_id,
                        box_id = %returned_box_id,
                        "Completed crash task was not tracked"
                    );
                    returned_box_id
                });
                self.pending_crashes.remove(&box_id);
            }
            Err(error) => {
                let task_id = error.id();
                if let Some(box_id) = self.task_boxes.remove(&task_id) {
                    self.pending_crashes.remove(&box_id);
                    tracing::error!(
                        task_id = %task_id,
                        box_id = %box_id,
                        is_cancelled = error.is_cancelled(),
                        is_panic = error.is_panic(),
                        error = %error,
                        "Crash handler task failed"
                    );
                } else {
                    tracing::error!(
                        task_id = %task_id,
                        error = %error,
                        "Untracked crash handler task failed"
                    );
                }
            }
        }
    }

    fn mark_pending_crash(pending_crashes: &mut HashSet<BoxID>, box_id: &BoxID) -> bool {
        pending_crashes.insert(box_id.clone())
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

    /// Abstract factory for boxes' network control backends (the one place a
    /// concrete backend is chosen). Boxes create their backend through this, so
    /// no call site names a concrete backend — see [`crate::net::NetworkBackendFactory`].
    pub(crate) network_factory: Arc<dyn crate::net::NetworkBackendFactory>,

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

    /// Handle to the crash coordinator task (for graceful shutdown).
    crash_handler_handle: AsyncMutex<Option<JoinHandle<()>>>,

    /// Requests forced cancellation of supervised crash tasks after the
    /// cooperative shutdown grace period expires.
    crash_force_cancel_token: CancellationToken,

    /// Pending crash notification receiver, consumed once when the coordinator starts.
    pending_crash_rx: std::sync::Mutex<Option<mpsc::Receiver<BoxID>>>,

    /// One-time gate for lazy background task initialization.
    ///
    /// `new()` is synchronous and may run outside a Tokio runtime, so background
    /// tasks are spawned by the first async runtime method instead.
    services_started: tokio::sync::OnceCell<()>,
}

/// Synchronized state protected by RwLock.
///
/// Acquire this when you need atomicity across multiple operations on
/// box_manager or image_manager.
pub struct SynchronizedState {
    /// Cache of active BoxHandle instances by ID.
    /// Uses Weak to allow automatic cleanup when all handles are dropped.
    active_handles_by_id: HashMap<BoxID, Weak<BoxHandle>>,
    /// Cache of active BoxHandle instances by name (only for named boxes).
    active_handles_by_name: HashMap<String, Weak<BoxHandle>>,
    /// Strong runtime ownership for boxes kept alive by restart policy.
    ///
    /// Each entry is keyed by Box ID, so repeated restarts of the same box
    /// replace the existing handle instead of growing this map. Entries are
    /// removed when the box is explicitly stopped or removed via
    /// `invalidate_box_handle`.
    restart_owned_handles_by_id: HashMap<BoxID, SharedBoxHandle>,
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

        // Sweep socket binding symlinks whose boxes are gone (crash leftovers
        // that per-box removal never saw).
        crate::net::socket_path::BoxSockets::sweep_stale();

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
                active_handles_by_id: HashMap::new(),
                active_handles_by_name: HashMap::new(),
                restart_owned_handles_by_id: HashMap::new(),
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
            network_factory: crate::net::default_factory(),
            _runtime_lock: runtime_lock,
            shutdown_token: CancellationToken::new(),
            crash_tx,
            crash_handler_handle: AsyncMutex::new(None),
            crash_force_cancel_token: CancellationToken::new(),
            pending_crash_rx: std::sync::Mutex::new(Some(crash_rx)),
            services_started: tokio::sync::OnceCell::new(),
        });

        tracing::debug!("initialized runtime");

        // Recover boxes from database
        inner.recover_boxes()?;

        Ok(inner)
    }

    // ========================================================================
    // CRASH HANDLER
    // ========================================================================

    /// Spawn the central crash coordinator task.
    fn spawn_crash_handler(
        runtime: SharedRuntimeImpl,
        crash_rx: mpsc::Receiver<BoxID>,
    ) -> JoinHandle<()> {
        CrashCoordinator::spawn(runtime, crash_rx)
    }

    /// Handle a single box crash (driven by the crash coordinator).
    async fn handle_box_crash(
        runtime_weak: Weak<RuntimeImpl>,
        shutdown_token: CancellationToken,
        box_id: BoxID,
    ) {
        let plan = {
            let Some(runtime_impl) = runtime_weak.upgrade() else {
                tracing::debug!(box_id = %box_id, "Runtime dropped before crash handling");
                return;
            };

            let Some(plan) = Self::record_crash_and_plan_restart(&runtime_impl, &box_id).await
            else {
                return;
            };
            plan
        };

        tracing::info!(
            box_id = %box_id,
            restart_count = plan.new_restart_count,
            exit_code = ?plan.exit_code,
            "Box crashed, scheduling restart with backoff"
        );

        Self::run_restart_loop(runtime_weak, shutdown_token, box_id, plan).await;
    }

    async fn record_crash_and_plan_restart(
        runtime: &RuntimeImpl,
        box_id: &BoxID,
    ) -> Option<CrashRestartPlan> {
        let state = match runtime.box_manager.box_by_id(box_id) {
            Ok(Some((_, s))) => s,
            Ok(None) => {
                tracing::debug!(box_id = %box_id, "Box not found, ignoring crash");
                return None;
            }
            Err(e) => {
                tracing::error!(box_id = %box_id, error = %e, "Failed to read box state");
                return None;
            }
        };

        let lock_id = match state.lock_id {
            Some(id) => id,
            None => {
                tracing::warn!(box_id = %box_id, "Box has no lock_id");
                return None;
            }
        };

        let locker = match runtime.lock_manager.retrieve(lock_id) {
            Ok(l) => l,
            Err(e) => {
                tracing::error!(box_id = %box_id, error = %e, "Failed to retrieve lock");
                return None;
            }
        };

        let _lock_guard = match acquire_owned_lock_or_cancel(
            locker,
            &runtime.shutdown_token,
            format!("Runtime is shutting down while waiting to record crash for box {box_id}"),
        )
        .await
        {
            Ok(guard) => guard,
            Err(BoxliteError::Stopped(_)) => {
                tracing::debug!(box_id = %box_id, "Shutdown while waiting for lock");
                return None;
            }
            Err(e) => {
                tracing::error!(box_id = %box_id, error = %e, "Failed to acquire lock");
                return None;
            }
        };

        let (config, mut state) = match runtime.box_manager.box_by_id(box_id) {
            Ok(Some((c, s))) => (c, s),
            Ok(None) => {
                tracing::debug!(box_id = %box_id, "Box removed before crash handling");
                return None;
            }
            Err(e) => {
                tracing::error!(box_id = %box_id, error = %e, "Failed to re-read box state");
                return None;
            }
        };

        match state.status {
            BoxStatus::Running | BoxStatus::Crashed => {}
            BoxStatus::Restarting => {
                tracing::debug!(box_id = %box_id, "Box already restarting, ignoring");
                return None;
            }
            _ => {
                tracing::debug!(
                    box_id = %box_id,
                    status = ?state.status,
                    "Box not running, ignoring crash"
                );
                return None;
            }
        }

        let exit_code = read_box_exit_code(&config);
        let restart_policy = config.options.advanced.restart_policy.clone();
        let current_restart_count = state.stop_info.restart_count;
        let expected_epoch = state.lifecycle_epoch();
        let new_restart_count = state.stop_info.restart_count.saturating_add(1);
        let max_retries_exhausted = matches!(
            restart_policy.as_ref(),
            Some(RestartPolicy::OnFailure { max_retries }) if current_restart_count >= *max_retries
        );

        state.force_status(BoxStatus::Crashed);
        state.set_pid(None);
        state.exit_code = exit_code;
        state.health_status.state = crate::litebox::HealthState::Unhealthy;
        state.stop_info = crate::litebox::StopInfo {
            cause: StopCause::CrashedNoPolicy,
            exit_code,
            exit_time: Some(Utc::now()),
            restart_count: new_restart_count,
            restarted_at: None,
        };

        if let Err(e) = runtime.box_manager.save_box(box_id, &state) {
            tracing::error!(box_id = %box_id, error = %e, "Failed to save crashed state");
        }

        let should_restart = restart_policy
            .as_ref()
            .map(|policy| policy.should_restart(exit_code, current_restart_count))
            .unwrap_or(false);

        if !should_restart {
            Self::mark_restart_denied(
                runtime,
                box_id,
                state,
                config.name.as_deref(),
                restart_policy.as_ref(),
                exit_code,
                max_retries_exhausted,
            );
            return None;
        }

        Some(CrashRestartPlan {
            restart_policy,
            expected_epoch,
            current_restart_count,
            new_restart_count,
            exit_code,
        })
    }

    async fn commit_crash_restart_state(
        runtime: &RuntimeImpl,
        box_id: &BoxID,
        expected_epoch: u64,
        update_state: impl FnOnce(&mut BoxState),
    ) -> BoxliteResult<bool> {
        let Some((_, state)) = runtime.box_manager.box_by_id(box_id)? else {
            tracing::debug!(
                box_id = %box_id,
                "Crash restart state commit skipped because box was removed"
            );
            return Ok(false);
        };

        let lock_id = state
            .lock_id
            .ok_or_else(|| BoxliteError::Internal(format!("box {box_id} has no lock_id")))?;
        let locker = runtime.lock_manager.retrieve(lock_id)?;
        let _lock_guard = acquire_owned_lock(locker).await?;

        let Some((_, mut state)) = runtime.box_manager.box_by_id(box_id)? else {
            tracing::debug!(
                box_id = %box_id,
                "Crash restart state commit skipped because box was removed"
            );
            return Ok(false);
        };

        if !crash_restart_matches_plan(&state, expected_epoch) {
            if state.lifecycle_epoch() != expected_epoch {
                tracing::debug!(
                    box_id = %box_id,
                    expected_epoch,
                    actual_epoch = state.lifecycle_epoch(),
                    "Crash restart state commit skipped because lifecycle epoch changed"
                );
            } else {
                tracing::debug!(
                    box_id = %box_id,
                    status = ?state.status,
                    "Crash restart state commit skipped because box state changed"
                );
            }
            return Ok(false);
        }

        update_state(&mut state);
        runtime.box_manager.save_box(box_id, &state)?;
        Ok(true)
    }

    async fn commit_restart_success(
        runtime: &RuntimeImpl,
        box_id: &BoxID,
        expected_epoch: u64,
        box_impl: &SharedBoxImpl,
        lock_id: LockId,
    ) -> BoxliteResult<bool> {
        let locker = runtime.lock_manager.retrieve(lock_id)?;
        let _lock_guard = acquire_owned_lock_or_cancel(
            locker,
            &runtime.shutdown_token,
            "Runtime is shutting down while finalizing restarted box",
        )
        .await?;

        // The swapped-in BoxImpl is the live source here: update its in-memory
        // state, then persist that snapshot. A DB-only update would leave
        // existing handles stale.
        let final_state = {
            let mut state = box_impl.state.write();
            if state.lifecycle_epoch() != expected_epoch || state.status != BoxStatus::Running {
                tracing::debug!(
                    box_id = %box_id,
                    expected_epoch,
                    actual_epoch = state.lifecycle_epoch(),
                    status = ?state.status,
                    "Restart success state commit skipped because box state changed"
                );
                return Ok(false);
            }
            state.stop_info = crate::litebox::StopInfo::default();
            state.stop_info.restarted_at = Some(chrono::Utc::now());
            state.clone()
        };

        runtime.box_manager.save_box(box_id, &final_state)?;
        Ok(true)
    }

    async fn run_restart_loop(
        runtime_weak: Weak<RuntimeImpl>,
        shutdown_token: CancellationToken,
        box_id: BoxID,
        plan: CrashRestartPlan,
    ) {
        let mut attempt = plan.current_restart_count;
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
                    let Some(this) = runtime_weak.upgrade() else {
                        tracing::debug!(box_id = %box_id, "Runtime dropped during restart backoff");
                        return;
                    };

                    // Re-read state after backoff: a manual stop/remove/restart may have happened.
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

                    match current_status {
                        BoxStatus::Running => {
                            tracing::debug!(
                                box_id = %box_id,
                                "Box already running (manual restart), skipping auto-restart"
                            );
                            return;
                        }
                        BoxStatus::Crashed | BoxStatus::Restarting => {}
                        status => {
                            tracing::debug!(
                                box_id = %box_id,
                                status = ?status,
                                "Box state changed during backoff, skipping auto-restart"
                            );
                            return;
                        }
                    }

                    tracing::info!(box_id = %box_id, attempt, "Executing restart");

                    match this.restart(&box_id, plan.expected_epoch).await {
                        Ok(RestartOutcome::Started { box_impl, lock_id }) => {
                            match Self::commit_restart_success(
                                &this,
                                &box_id,
                                plan.expected_epoch,
                                &box_impl,
                                lock_id,
                            )
                            .await
                            {
                                Ok(true) => tracing::info!(
                                    box_id = %box_id,
                                    attempt,
                                    "Box restarted successfully"
                                ),
                                Ok(false) => {
                                    tracing::debug!(
                                        box_id = %box_id,
                                        attempt,
                                        "Restart success commit became stale"
                                    );
                                    return;
                                }
                                Err(e) => tracing::error!(
                                    box_id = %box_id,
                                    attempt,
                                    error = %e,
                                    "Box restarted but success state commit failed"
                                ),
                            }
                            break;
                        }
                        Ok(RestartOutcome::Stale) => {
                            tracing::debug!(
                                box_id = %box_id,
                                attempt,
                                "Crash restart attempt became stale"
                            );
                            return;
                        }
                        Err(e) => {
                            tracing::error!(
                                box_id = %box_id,
                                attempt,
                                error = %e,
                                "Restart attempt failed"
                            );

                            let should_retry = plan.restart_policy
                                .as_ref()
                                .map(|p| p.should_restart(plan.exit_code, attempt))
                                .unwrap_or(false);

                            if should_retry {
                                match Self::mark_restart_failed(
                                    &this,
                                    &box_id,
                                    plan.expected_epoch,
                                    attempt,
                                )
                                .await
                                {
                                    Ok(true) => {}
                                    Ok(false) => return,
                                    Err(e) => tracing::error!(
                                        box_id = %box_id,
                                        attempt,
                                        error = %e,
                                        "Failed to save restart failure state"
                                    ),
                                }
                            } else {
                                tracing::info!(box_id = %box_id, attempt, "Max retries exceeded");

                                if let Err(e) = Self::commit_crash_restart_state(
                                    &this,
                                    &box_id,
                                    plan.expected_epoch,
                                    |state| {
                                        state.force_status(BoxStatus::Stopped);
                                        state.stop_info.restart_count = attempt;
                                        state.stop_info.cause = StopCause::MaxRetriesExceeded;
                                    },
                                ).await {
                                    tracing::error!(
                                        box_id = %box_id,
                                        attempt,
                                        error = %e,
                                        "Failed to save max-retries-exceeded state"
                                    );
                                }
                                break;  // Give up
                            }
                            // Continue loop for retry (_lock_guard dropped here)
                        }
                    }
                    // _lock_guard dropped here
                }
                _ = shutdown_token.cancelled() => {
                    tracing::debug!(box_id = %box_id, "Restart cancelled (shutdown)");
                    if let Some(this) = runtime_weak.upgrade()
                        && let Err(e) = Self::commit_crash_restart_state(
                            &this,
                            &box_id,
                            plan.expected_epoch,
                            |state| {
                                state.force_status(BoxStatus::Stopped);
                                state.stop_info.restart_count = attempt;
                                state.stop_info.cause = StopCause::Normal;
                            },
                        ).await {
                        tracing::error!(
                            box_id = %box_id,
                            attempt,
                            error = %e,
                            "Failed to save cancelled restart state"
                        );
                    }
                    break;
                }
            }
        }
    }

    fn mark_restart_denied(
        runtime: &RuntimeImpl,
        box_id: &BoxID,
        mut state: BoxState,
        box_name: Option<&str>,
        restart_policy: Option<&RestartPolicy>,
        exit_code: Option<i32>,
        max_retries_exhausted: bool,
    ) {
        tracing::info!(
            box_id = %box_id,
            policy = ?restart_policy,
            "No restart policy or max retries exceeded, marking as stopped"
        );

        state.force_status(BoxStatus::Stopped);
        state.stop_info.cause =
            stop_cause_when_restart_denied(restart_policy, exit_code, max_retries_exhausted);

        if let Err(e) = runtime.box_manager.save_box(box_id, &state) {
            tracing::error!(box_id = %box_id, error = %e, "Failed to save stopped state");
        }

        runtime.retire_cached_box_after_crash(box_id, box_name, &state);
    }

    fn retire_cached_box_after_crash(
        &self,
        box_id: &BoxID,
        box_name: Option<&str>,
        stopped_state: &BoxState,
    ) {
        let handle = {
            let sync = self.sync_state.read().unwrap();
            sync.active_handles_by_id
                .get(box_id)
                .and_then(|weak| weak.upgrade())
        };

        if let Some(handle) = handle {
            let box_impl = handle.current();
            box_impl.abort_health_check();
            box_impl.shutdown_token.cancel();
            *box_impl.state.write() = stopped_state.clone();
        }

        self.invalidate_box_handle(box_id, box_name);
    }

    async fn mark_restart_failed(
        runtime: &RuntimeImpl,
        box_id: &BoxID,
        expected_epoch: u64,
        attempt: u32,
    ) -> BoxliteResult<bool> {
        Self::commit_crash_restart_state(runtime, box_id, expected_epoch, |state| {
            state.force_status(BoxStatus::Crashed);
            state.stop_info.restart_count = attempt;
            state.stop_info.cause = StopCause::RestartFailed;
        })
        .await
    }

    /// Get crash sender for health check tasks.
    pub(crate) fn crash_sender(&self) -> mpsc::Sender<BoxID> {
        self.crash_tx.clone()
    }

    // ========================================================================
    // LAZY SERVICES INITIALIZATION
    // ========================================================================

    /// Ensure the crash coordinator task is started.
    ///
    /// This is called lazily on the first async method, guaranteeing a Tokio
    /// runtime exists. Uses `OnceCell` to record exactly one successful start.
    async fn ensure_services_started(self: &Arc<Self>) {
        let _ = self
            .services_started
            .get_or_try_init(|| {
                let rt = Arc::clone(self);
                async move {
                    let mut handle_slot = rt.crash_handler_handle.lock().await;
                    if handle_slot.is_some() {
                        return Ok(());
                    }
                    if rt.shutdown_token.is_cancelled() {
                        return Err(());
                    }
                    let crash_rx = rt
                        .pending_crash_rx
                        .lock()
                        .unwrap()
                        .take()
                        .expect("pending_crash_rx consumed twice");
                    let handle = Self::spawn_crash_handler(Arc::clone(&rt), crash_rx);
                    *handle_slot = Some(handle);
                    Ok(())
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
                let (handle, _) = self.get_or_create_box_handle(config, state);
                return Ok((litebox_from_handle(handle), false));
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
                let (handle, _) = self.get_or_create_box_handle(config, state);
                return Ok((litebox_from_handle(handle), false));
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
        let (handle, inserted) = self.get_or_create_box_handle(config, state);
        if !inserted {
            return Err(BoxliteError::InvalidArgument(
                "box with this name already exists".into(),
            ));
        }

        // Increment boxes_created counter (lock-free!)
        self.runtime_metrics
            .boxes_created
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        Ok((litebox_from_handle(handle), true))
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
                && let Some(weak) = sync.active_handles_by_id.get(&box_id)
                && let Some(strong) = weak.upgrade()
            {
                tracing::trace!(box_id = %box_id, "Found box in cache by ID");
                return Ok(Some(litebox_from_handle(strong)));
            }

            // Try as name
            if let Some(weak) = sync.active_handles_by_name.get(id_or_name)
                && let Some(strong) = weak.upgrade()
            {
                tracing::trace!(name = %id_or_name, "Found box in cache by name");
                return Ok(Some(litebox_from_handle(strong)));
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

            let (handle, _) = self.get_or_create_box_handle(config, state);
            tracing::trace!(id_or_name = %id_or_name, "LiteBox created successfully");
            return Ok(Some(litebox_from_handle(handle)));
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
                && let Some(weak) = sync.active_handles_by_id.get(&box_id)
                && let Some(strong) = weak.upgrade()
            {
                return Ok(Some(strong.info()));
            }

            // Try as name
            if let Some(weak) = sync.active_handles_by_name.get(id_or_name)
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
            for (box_id, weak) in &sync.active_handles_by_id {
                if !seen_ids.contains(box_id)
                    && let Some(strong) = weak.upgrade()
                {
                    infos.push(strong.info());
                    seen_ids.insert(box_id.clone());
                }
            }
        }

        // Sort by creation time (newest first)
        infos.sort_by_key(|b| std::cmp::Reverse(b.created_at));
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
                && let Some(weak) = sync.active_handles_by_id.get(&box_id)
                && weak.upgrade().is_some()
            {
                return Ok(true);
            }

            // Try as name
            if let Some(weak) = sync.active_handles_by_name.get(id_or_name)
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
    /// * `timeout` - Total shutdown deadline in seconds. None=10s,
    ///   Some(-1)=infinite
    ///
    /// # Returns
    /// Ok(()) if all boxes stopped successfully, Err if any box failed to stop.
    pub async fn shutdown(&self, timeout: Option<i32>) -> BoxliteResult<()> {
        let shutdown_deadline =
            timeout_to_duration(timeout).map(|duration| Instant::now() + duration);

        // Check if already shut down (idempotent)
        if self.shutdown_token.is_cancelled() {
            self.drain_crash_coordinator(shutdown_deadline).await;
            return Ok(());
        }

        tracing::info!("Initiating runtime shutdown");

        // Cancel the shutdown token - marks shutdown and signals all in-flight operations
        self.shutdown_token.cancel();

        // Collect all active non-detached boxes
        let active_boxes: Vec<SharedBoxImpl> = {
            let sync = self.sync_state.read().unwrap();
            sync.active_handles_by_id
                .values()
                .filter_map(|weak| weak.upgrade())
                .map(|handle| handle.current())
                .filter(|box_impl| !box_impl.config.options.detach)
                .collect()
        };

        if active_boxes.is_empty() {
            tracing::info!("No active boxes to shutdown");
            self.drain_crash_coordinator(shutdown_deadline).await;
            return Ok(());
        }

        tracing::info!(count = active_boxes.len(), "Stopping active boxes");

        // Stop all boxes concurrently
        let stop_futures = active_boxes.iter().map(|box_impl| {
            let box_id = box_impl.id().to_string();
            async move {
                let result = if let Some(deadline) = shutdown_deadline {
                    tokio::time::timeout_at(deadline, box_impl.stop()).await
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

        self.drain_crash_coordinator(shutdown_deadline).await;

        if errors.is_empty() {
            Ok(())
        } else {
            Err(BoxliteError::Internal(format!(
                "Shutdown completed with errors: {}",
                errors.join(", ")
            )))
        }
    }

    /// Wait for the crash coordinator within the remaining shutdown budget.
    ///
    /// If the grace period expires, the coordinator is asked to abort its
    /// supervised tasks. Its handle remains stored so a later shutdown call can
    /// reap it without detaching the coordinator.
    async fn drain_crash_coordinator(&self, shutdown_deadline: Option<Instant>) {
        let grace_deadline = shutdown_deadline
            .map(|deadline| deadline.min(Instant::now() + CRASH_COORDINATOR_GRACE_PERIOD));

        let mut crash_handle = match grace_deadline {
            Some(deadline) => {
                match tokio::time::timeout_at(deadline, self.crash_handler_handle.lock()).await {
                    Ok(handle) => handle,
                    Err(_) => {
                        self.crash_force_cancel_token.cancel();
                        tracing::warn!(
                            "Shutdown deadline reached while waiting to join crash coordinator"
                        );
                        return;
                    }
                }
            }
            None => self.crash_handler_handle.lock().await,
        };

        let Some(handle) = crash_handle.as_mut() else {
            return;
        };

        let join_result = match grace_deadline {
            Some(deadline) => tokio::time::timeout_at(deadline, &mut *handle).await.ok(),
            None => Some((&mut *handle).await),
        };

        match join_result {
            Some(Ok(())) => {
                tracing::debug!("Crash coordinator stopped gracefully");
                *crash_handle = None;
            }
            Some(Err(e)) => {
                tracing::warn!("Crash coordinator panicked: {:?}", e);
                *crash_handle = None;
            }
            None => {
                self.crash_force_cancel_token.cancel();
                tracing::warn!(
                    "Crash coordinator grace period expired; cancellation requested in background"
                );
            }
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

            let box_layout = self
                .layout
                .box_layout(config.id.as_str(), false)
                .expect("box_layout is infallible");

            // The third way a box dies, and it must report the exit code like the
            // other two. `stop()` records it, and so does the live watcher — but
            // this path is the one a *non-detached* box takes when its runtime
            // goes away, which is every `boxlite create` + `boxlite start`. Left
            // as a bare `mark_stop()`, it marked the box Stopped with no code, and
            // `recover_boxes` could not backfill it afterwards (its branch only
            // fires on a box still marked Running). `inspect .State.ExitCode`
            // answered 0 for a command that exited 23.
            record_main_command_exit(
                &mut state,
                &box_layout.container_exit_file(config.container.id.as_str()),
            );
            let _ = self.box_manager.save_box(&config.id, &state);

            let _ = std::fs::remove_file(box_layout.pid_file_path());
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
                && let Some(weak) = sync.active_handles_by_id.get(&box_id)
                && weak.upgrade().is_some()
            {
                return Ok(box_id);
            }

            // Try as name
            if let Some(weak) = sync.active_handles_by_name.get(id_or_name)
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
    /// and `LiteBox::stop()` when its removal policy is enabled.
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
            if state.status.is_active() || state.pid.is_some() {
                if force {
                    // Stop the box's whole process tree through the same handler
                    // teardown `LiteBox::stop()` uses: it SIGTERMs the recorded
                    // pid (the outer launcher), then reaps any survivors of a
                    // detached box's inner pid-ns tree (inner bwrap + shim + VM) —
                    // which a single-pid kill misses, since #851 stopped tying
                    // detached boxes to the launcher's lifetime.
                    if let Some(pid) = state.pid {
                        tracing::info!(box_id = %id, pid = pid, "Force stopping box process tree");
                        let mut handler = ShimHandler::from_pid(pid, config.id.clone());
                        let _ = handler.stop();
                    }
                    // Update status to stopped and save
                    state.set_status(BoxStatus::Stopped);
                    state.set_pid(None);
                    self.box_manager.save_box(id, &state)?;
                } else {
                    // Non-force mode: error on active box
                    return Err(BoxliteError::InvalidState(format!(
                        "cannot remove box {} with live pid {:?} (status: {:?}). Use force=true to stop first",
                        id, state.pid, state.status
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

            // Delete box directory + its socket binding symlink
            config.sockets().remove();
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
            self.invalidate_box_handle(id, config.name.as_deref());

            tracing::info!(box_id = %id, "Removed box");
            return Ok(());
        }

        // Box not in database - check in-memory cache
        let box_impl = {
            let sync = self.sync_state.read().unwrap();
            sync.active_handles_by_id
                .get(id)
                .and_then(|weak| weak.upgrade())
                .map(|handle| handle.current())
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
            self.invalidate_box_handle(id, box_impl.config.name.as_deref());

            // Delete box directory + its socket binding symlink
            box_impl.config.sockets().remove();
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
        // Create container runtime config
        let container = ContainerRuntimeConfig { id: container_id };

        // Create config with defaults + user options. Socket paths are NOT
        // stored — they derive from (box_home, id) at point of use via
        // BoxConfig::sockets(), so they can never go stale.
        let config = BoxConfig {
            id: box_id,
            name,
            created_at: now,
            container,
            options: options.clone(),
            engine_kind: VmmKind::Libkrun,
            box_home,
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

        // Move staging dir to canonical path (cross-fs safe: staging may be on
        // a different filesystem than the boxes dir).
        let box_home = self.layout.boxes_dir().join(box_id.as_str());
        move_dir_cross_fs(&staging_dir, &box_home).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to move {} to {}: {}",
                staging_dir.display(),
                box_home.display(),
                e
            ))
        })?;

        let config = BoxConfig {
            id: box_id.clone(),
            name,
            created_at: now,
            container: ContainerRuntimeConfig { id: container_id },
            options,
            engine_kind: VmmKind::Libkrun,
            box_home,
        };

        let mut state = BoxState::new();
        state.set_status(initial_status);

        let lock_id = self.lock_manager.allocate()?;
        state.set_lock_id(lock_id);

        if let Err(e) = self.box_manager.add_box(&config, &state) {
            let _ = self.lock_manager.free(lock_id);
            let _ = std::fs::remove_dir_all(&config.box_home);
            config.sockets().remove();
            return Err(e);
        }

        self.get(box_id.as_str()).await?.ok_or_else(|| {
            BoxliteError::Internal("Provisioned box not found after persist".to_string())
        })
    }

    /// Recover boxes from persistent storage on runtime startup.
    fn recover_boxes(&self) -> BoxliteResult<()> {
        use crate::util::{PidFileReader, ProcessIdentity};

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
        // - remove-on-stop boxes (auto_delete): ephemeral, shouldn't survive restarts
        // - Orphaned active boxes: was Running but directory is missing (crashed mid-operation)
        //
        // Note: We don't remove Configured or Stopped boxes without directories because:
        // - Configured boxes: created but never started, no directory yet (this is valid)
        // - Stopped boxes: might not have a directory if never started
        // - Only Running boxes must have a directory
        let mut boxes_to_remove = Vec::new();
        for (config, state) in &persisted {
            let should_remove = if config.options.removes_on_stop() {
                tracing::info!(
                    box_id = %config.id,
                    "Removing ephemeral (remove-on-stop) box during recovery"
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
                // Clean up box directory + binding symlink if they exist
                config.sockets().remove();
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
                "Cleaned up {} boxes during recovery (remove-on-stop or orphaned)",
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

        for (config, mut state) in persisted {
            let box_id = &config.id;
            let original_status = state.status;
            let original_pid = state.pid;

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

            let box_layout = self.layout.box_layout(box_id.as_str(), false)?;
            let pid_path = box_layout.pid_file_path();
            let exit_path = box_layout.exit_file_path();
            let had_stale_exit = exit_path.exists();

            // Truth-source precedence: a live shim (ProcessIdentity) is
            // ground truth. The exit file is at-best an artifact of a past
            // lifecycle, so it only matters when no shim is alive.
            match PidFileReader::at(&pid_path).process_identity() {
                ProcessIdentity::Verified(pid) => {
                    state.set_pid(Some(pid));
                    state.set_status(BoxStatus::Running);
                    // Live shim wins — archive any prior-lifecycle exit
                    // file so the next crash gets the canonical slot.
                    if had_stale_exit {
                        stash_exit_file(&box_layout);
                        tracing::warn!(
                            box_id = %box_id,
                            pid,
                            "Stale exit file alongside live shim; stashed to exit.previous \
                             (post-start cleanup may have been skipped or external interference)"
                        );
                    }
                    tracing::info!(
                        box_id = %box_id,
                        pid,
                        "Recovered running box from PID file"
                    );
                }
                ProcessIdentity::Legacy(pid) => {
                    // Pre-fingerprint PID file. Adopt the live PID so VMs
                    // aren't lost on upgrade; the next stop/start writes a
                    // two-line file and the fingerprint check takes over.
                    state.set_pid(Some(pid));
                    state.set_status(BoxStatus::Running);
                    if had_stale_exit {
                        stash_exit_file(&box_layout);
                        tracing::warn!(
                            box_id = %box_id,
                            pid,
                            "Stale exit file alongside live (legacy) shim; stashed to exit.previous"
                        );
                    }
                    tracing::warn!(
                        box_id = %box_id,
                        pid,
                        "Recovered legacy box without start-time fingerprint; \
                         restart to upgrade"
                    );
                }
                ProcessIdentity::Absent => {
                    // PID is dead or missing — clean the stale PID file.
                    let _ = std::fs::remove_file(&pid_path);

                    if had_stale_exit && crate::vmm::ExitInfo::from_file(&exit_path).is_some() {
                        // Shim crashed in a prior lifecycle. Surface as
                        // Failed with the crash report; the exit file
                        // stays as the failure artifact (active slot).
                        let report = crate::litebox::CrashReport::from_exit_file(
                            &exit_path,
                            &box_layout.console_output_path(),
                            &box_layout.stderr_file_path(),
                            box_id.as_str(),
                            None,
                        );
                        state.mark_failed(&report.user_message);
                        tracing::warn!(
                            box_id = %box_id,
                            "Box crashed; marked Failed with crash report"
                        );
                    } else if state.status == BoxStatus::Running {
                        // A Running box whose shim is gone: the guest powered
                        // off because its main command exited (docker
                        // semantics), and no live watcher was around to see it
                        // — this process was not running at the time. Take the
                        // exit code from the record the guest left behind.
                        //
                        // The container id lives in the box *config*
                        // (BoxState.container_id is never persisted).
                        record_main_command_exit(
                            &mut state,
                            &box_layout.container_exit_file(config.container.id.as_str()),
                        );
                        tracing::warn!(
                            box_id = %box_id,
                            exit_code = ?state.exit_code,
                            "Shim not verifiable (file missing, process dead, or PID reuse); \
                             marked Stopped"
                        );
                    } else if state.status == BoxStatus::Restarting {
                        state.force_status(BoxStatus::Stopped);
                        state.stop_info.cause = StopCause::RestartFailed;
                        state.stop_info.exit_time = Some(Utc::now());
                        tracing::warn!(
                            box_id = %box_id,
                            "Interrupted restart found during recovery; marked Stopped"
                        );
                    }
                }
            }

            // Save updated state to database if changed
            if state.status != original_status || state.pid != original_pid {
                self.box_manager.save_box(box_id, &state)?;
            }
        }

        // GC unreferenced guest rootfs entries
        if let Err(e) = self.guest_rootfs_mgr.gc(&self.layout.boxes_dir()) {
            tracing::warn!("Guest rootfs GC failed: {}", e);
        }

        tracing::info!("Box recovery complete");
        Ok(())
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

            crate::net::socket_path::BoxSockets::new(
                orphan_id.clone(),
                orphan_dir.join(crate::runtime::layout::dirs::SOCKETS_DIR),
            )
            .remove();
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

    /// Restart a box after crash handling if the lifecycle epoch still matches.
    ///
    /// Creates a fresh BoxImpl, starts it, and swaps it into the stable
    /// BoxHandle so existing LiteBox handles continue to target the restarted
    /// VM. The fresh BoxImpl has an empty OnceCell, so start() triggers
    /// init_live_state() which runs the Restarting execution plan (same as
    /// Stopped - reuse COW disks, spawn new VM).
    ///
    /// This method owns the per-box locking needed for the restart transition.
    /// It holds the lock only while replacing cached state with Restarting, then
    /// releases it before start(), because start() acquires the same lock while
    /// rebuilding the VM.
    ///
    /// Returns `RestartOutcome::Stale` when a user lifecycle operation made
    /// this delayed crash-restart attempt stale before it could start a VM.
    /// The caller owns the success-state commit after `Started` is returned.
    async fn restart(
        self: &Arc<Self>,
        box_id: &BoxID,
        expected_epoch: u64,
    ) -> BoxliteResult<RestartOutcome> {
        use crate::litebox::BoxStatus;

        tracing::info!(box_id = %box_id, "Restarting box");

        // 1. Look up existing box config and state from DB
        let Some((_, state)) = self.box_manager.box_by_id(box_id)? else {
            tracing::debug!(box_id = %box_id, "Crash restart skipped because box was removed");
            return Ok(RestartOutcome::Stale);
        };

        let lock_id = state
            .lock_id
            .ok_or_else(|| BoxliteError::Internal(format!("box {box_id} has no lock_id")))?;
        let locker = self.lock_manager.retrieve(lock_id)?;

        let box_impl = {
            let _lock_guard = acquire_owned_lock_or_cancel(
                locker,
                &self.shutdown_token,
                "Runtime is shutting down while waiting to restart box",
            )
            .await?;

            // 2. Re-read under the lock, then replace cached state with Restarting.
            let Some((config, mut state)) = self.box_manager.box_by_id(box_id)? else {
                tracing::debug!(box_id = %box_id, "Crash restart skipped because box was removed");
                return Ok(RestartOutcome::Stale);
            };

            if !crash_restart_matches_plan(&state, expected_epoch) {
                if state.lifecycle_epoch() != expected_epoch {
                    tracing::debug!(
                        box_id = %box_id,
                        expected_epoch,
                        actual_epoch = state.lifecycle_epoch(),
                        "Crash restart skipped because lifecycle epoch changed"
                    );
                } else {
                    tracing::debug!(
                        box_id = %box_id,
                        status = ?state.status,
                        "Crash restart skipped because box state changed"
                    );
                }
                return Ok(RestartOutcome::Stale);
            }

            // 3. Get the stable handle and retire its current BoxImpl.
            // The handle remains cached so existing LiteBox values can observe the
            // fresh BoxImpl after restart succeeds.
            let (handle, _) = self.get_or_create_box_handle(config.clone(), state.clone());
            let old_box_impl = handle.current();
            old_box_impl.abort_health_check();
            old_box_impl.shutdown_token.cancel();

            // 4. Update state to Restarting and persist
            state.force_status(BoxStatus::Restarting);
            state.set_pid(None);
            state.clear_health_status();
            self.box_manager.save_box(box_id, &state)?;

            // 5. Create fresh BoxImpl with updated state. The transition lock is
            // released at the end of this block before start() takes the same
            // lock for VM rebuild.
            let box_impl = self.create_box_impl(config, state);
            let _old_box_impl = handle.swap_current(Arc::clone(&box_impl));
            {
                let mut sync = self.sync_state.write().unwrap();
                sync.restart_owned_handles_by_id
                    .insert(box_id.clone(), handle);
            }
            box_impl
        };

        // 6. Call start() on fresh BoxImpl → empty OnceCell → init_live_state()
        //    BoxBuilder sees status=Restarting → same pipeline as Stopped
        box_impl.start().await?;

        Ok(RestartOutcome::Started { box_impl, lock_id })
    }

    // ========================================================================
    // INTERNAL - BOX IMPL CACHE
    // ========================================================================

    /// Create a fresh BoxImpl that is not installed in the handle cache.
    fn create_box_impl(self: &Arc<Self>, config: BoxConfig, state: BoxState) -> SharedBoxImpl {
        use crate::litebox::box_impl::BoxImpl;

        let box_token = self.shutdown_token.child_token();
        Arc::new(BoxImpl::new(config, state, Arc::clone(self), box_token))
    }

    /// Get existing BoxHandle from cache or create new one.
    ///
    /// Returns `(SharedBoxHandle, inserted)` where `inserted` is true if a new BoxHandle
    /// was created, false if an existing one was returned.
    ///
    /// Checks both by name (if provided) and by ID. This prevents duplicate names
    /// even for boxes not yet persisted to database.
    fn get_or_create_box_handle(
        self: &Arc<Self>,
        config: BoxConfig,
        state: BoxState,
    ) -> (SharedBoxHandle, bool) {
        let box_id = config.id.clone();
        let box_name = config.name.clone();

        let mut sync = self.sync_state.write().unwrap();

        // Check by name first (if provided) - prevents duplicate names
        if let Some(ref name) = box_name
            && let Some(weak) = sync.active_handles_by_name.get(name)
        {
            if let Some(strong) = weak.upgrade() {
                tracing::trace!(name = %name, "Reusing cached BoxHandle by name");
                return (strong, false);
            }
            // Dead weak ref, clean it up
            sync.active_handles_by_name.remove(name);
        }

        // Check by ID
        if let Some(weak) = sync.active_handles_by_id.get(&box_id) {
            if let Some(strong) = weak.upgrade() {
                tracing::trace!(box_id = %box_id, "Reusing cached BoxHandle by ID");
                return (strong, false);
            }
            // Dead weak ref, clean it up
            sync.active_handles_by_id.remove(&box_id);
        }

        // Create new BoxImpl, wrap it in a stable handle, and cache the handle
        // in both maps.
        let box_impl = self.create_box_impl(config, state);
        let handle = Arc::new(BoxHandle::new(box_impl));
        let weak = Arc::downgrade(&handle);

        sync.active_handles_by_id
            .insert(box_id.clone(), weak.clone());
        if let Some(name) = box_name {
            sync.active_handles_by_name.insert(name.clone(), weak);
            tracing::trace!(box_id = %box_id, name = %name, "Created and cached new BoxHandle");
        } else {
            tracing::trace!(box_id = %box_id, "Created and cached new BoxHandle (unnamed)");
        }

        (handle, true)
    }

    /// Remove BoxHandle from cache.
    ///
    /// Called when box is stopped or removed. Existing handles become stale;
    /// new handles from runtime.get() will get a fresh BoxHandle.
    pub(crate) fn invalidate_box_handle(&self, box_id: &BoxID, box_name: Option<&str>) {
        let mut sync = self.sync_state.write().unwrap();
        sync.active_handles_by_id.remove(box_id);
        sync.restart_owned_handles_by_id.remove(box_id);
        if let Some(name) = box_name {
            sync.active_handles_by_name.remove(name);
        }
        tracing::trace!(box_id = %box_id, name = ?box_name, "Invalidated BoxHandle cache");
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

fn reject_local_lifecycle_policy(options: &BoxOptions) -> BoxliteResult<()> {
    // Local runtimes support auto_delete as a remove-on-stop policy, but AutoPause
    // needs a sweeper that the local runtime does not have, so it stays REST-only.
    if options.auto_pause.is_some_and(|seconds| seconds > 0) {
        return Err(BoxliteError::Unsupported(
            "AutoPause is only supported by REST runtimes".into(),
        ));
    }
    Ok(())
}
#[async_trait::async_trait]
impl super::backend::RuntimeBackend for LocalRuntime {
    async fn create(&self, options: BoxOptions, name: Option<String>) -> BoxliteResult<LiteBox> {
        reject_local_lifecycle_policy(&options)?;
        self.0.create(options, name).await
    }

    async fn get_or_create(
        &self,
        options: BoxOptions,
        name: Option<String>,
    ) -> BoxliteResult<(LiteBox, bool)> {
        reject_local_lifecycle_policy(&options)?;
        self.0.get_or_create(options, name).await
    }

    async fn get(&self, id_or_name: &str) -> BoxliteResult<Option<LiteBox>> {
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

    async fn metrics(&self) -> BoxliteResult<RuntimeMetrics> {
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
    ) -> BoxliteResult<LiteBox> {
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
        if self.0.shutdown_token.is_cancelled() {
            return Err(BoxliteError::Stopped(
                "Cannot pull image: runtime has been shut down".into(),
            ));
        }
        self.0.image_manager.pull(image_ref).await
    }

    async fn list_images(&self) -> BoxliteResult<Vec<crate::runtime::types::ImageInfo>> {
        if self.0.shutdown_token.is_cancelled() {
            return Err(BoxliteError::Stopped(
                "Cannot list images: runtime has been shut down".into(),
            ));
        }
        self.0.image_manager.list().await
    }
}

// Named-volume operations (separate from RuntimeBackend). The concrete backend
// is not yet implemented: the local filesystem store was removed in favor of a
// future managed volume backend, so every operation returns `Unsupported`.
#[async_trait::async_trait]
impl super::volumes::VolumeBackend for LocalRuntime {
    async fn create_volume(&self) -> BoxliteResult<crate::volumes::VolumeInfo> {
        Err(volumes_unsupported())
    }

    async fn list_volumes(&self) -> BoxliteResult<Vec<crate::volumes::VolumeInfo>> {
        Err(volumes_unsupported())
    }

    async fn get_volume(&self, _id: &str) -> BoxliteResult<crate::volumes::VolumeInfo> {
        Err(volumes_unsupported())
    }

    async fn remove_volume(&self, _id: &str, _force: bool) -> BoxliteResult<()> {
        Err(volumes_unsupported())
    }
}

/// Error returned by every named-volume operation until a volume backend is
/// wired up.
fn volumes_unsupported() -> BoxliteError {
    BoxliteError::Unsupported("named volumes are not supported yet".to_string())
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
    use crate::runtime::backend::RuntimeBackend;
    use crate::runtime::images::ImageBackend;
    use crate::runtime::options::RootfsSpec;
    use tempfile::TempDir;

    #[test]
    fn local_runtime_rejects_explicit_lifecycle_policy() {
        let mut options = BoxOptions::default();
        assert!(reject_local_lifecycle_policy(&options).is_ok());

        options.auto_pause = Some(0);
        assert!(reject_local_lifecycle_policy(&options).is_ok());

        options.auto_pause = Some(1);
        assert!(matches!(
            reject_local_lifecycle_policy(&options),
            Err(BoxliteError::Unsupported(_))
        ));
        options.auto_pause = None;
        options.auto_delete = Some(3600);
        assert!(reject_local_lifecycle_policy(&options).is_ok());
    }
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

    fn create_state_commit_test_runtime() -> (SharedRuntimeImpl, TempDir) {
        let temp_dir = TempDir::new_in("/tmp").expect("Failed to create temp dir");
        let fs_config = FsLayoutConfig::without_bind_mount();
        let layout = FilesystemLayout::new(temp_dir.path().to_path_buf(), fs_config);
        layout.prepare().expect("prepare layout");
        let runtime_lock = RuntimeLock::acquire(layout.home_dir()).expect("acquire runtime lock");
        let db = Database::open(&layout.db_dir().join("boxlite.db")).expect("open database");
        let image_manager = ImageManager::new(layout.images_dir(), db.clone(), vec![])
            .expect("create image manager");
        let base_disk_store = crate::db::BaseDiskStore::new(db.clone());
        let base_disk_mgr =
            crate::disk::BaseDiskManager::new(layout.bases_dir(), base_disk_store.clone());
        let snapshot_store = crate::db::SnapshotStore::new(db.clone());
        let snapshot_mgr = crate::litebox::snapshot_mgr::SnapshotManager::new(snapshot_store);
        let box_store = BoxStore::new(db);
        let lock_manager: Arc<dyn LockManager> =
            Arc::new(FileLockManager::new(layout.locks_dir()).expect("create lock manager"));
        let image_disk_mgr =
            ImageDiskManager::new(layout.image_layout().disk_images_dir(), layout.temp_dir());
        let guest_rootfs_mgr = GuestRootfsManager::new(base_disk_mgr.clone(), layout.temp_dir());
        let (crash_tx, crash_rx) = mpsc::channel::<BoxID>(100);

        let runtime = Arc::new(RuntimeImpl {
            sync_state: RwLock::new(SynchronizedState {
                active_handles_by_id: HashMap::new(),
                active_handles_by_name: HashMap::new(),
                restart_owned_handles_by_id: HashMap::new(),
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
            network_factory: crate::net::default_factory(),
            _runtime_lock: runtime_lock,
            shutdown_token: CancellationToken::new(),
            crash_tx,
            crash_handler_handle: AsyncMutex::new(None),
            crash_force_cancel_token: CancellationToken::new(),
            pending_crash_rx: std::sync::Mutex::new(Some(crash_rx)),
            services_started: tokio::sync::OnceCell::new(),
        });

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
                auto_delete: Some(0),
                ..Default::default()
            },
            engine_kind: VmmKind::Libkrun,
            box_home: std::path::PathBuf::from("/tmp/test-box"),
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
                auto_delete: Some(0),
                ..Default::default()
            },
            engine_kind: VmmKind::Libkrun,
            box_home,
        }
    }

    // ====================================================================
    // shutdown() tests
    // ====================================================================

    #[test]
    fn test_new_does_not_start_background_tasks() {
        let (runtime, _dir) = create_test_runtime();

        // new() is sync — no crash coordinator or recovery tasks should be spawned
        assert!(runtime.crash_handler_handle.try_lock().unwrap().is_none());
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
        assert!(runtime.crash_handler_handle.lock().await.is_some());
    }

    #[tokio::test]
    async fn test_cancelled_service_initialization_preserves_crash_receiver() {
        let (runtime, _dir) = create_state_commit_test_runtime();
        let handle_slot = runtime.crash_handler_handle.lock().await;
        let task_runtime = Arc::clone(&runtime);
        let initialization = tokio::spawn(async move {
            task_runtime.ensure_services_started().await;
        });
        tokio::task::yield_now().await;

        assert!(runtime.pending_crash_rx.lock().unwrap().is_some());
        initialization.abort();
        assert!(
            initialization
                .await
                .expect_err("initialization should be cancelled")
                .is_cancelled()
        );
        drop(handle_slot);

        assert!(runtime.services_started.get().is_none());
        runtime.ensure_services_started().await;
        assert!(runtime.services_started.get().is_some());
        assert!(runtime.pending_crash_rx.lock().unwrap().is_none());
        assert!(runtime.crash_handler_handle.lock().await.is_some());

        runtime.shutdown(None).await.unwrap();
    }

    #[tokio::test]
    async fn test_shutdown_during_service_initialization_preserves_crash_receiver() {
        let (runtime, _dir) = create_state_commit_test_runtime();
        let handle_slot = runtime.crash_handler_handle.lock().await;
        let task_runtime = Arc::clone(&runtime);
        let initialization = tokio::spawn(async move {
            task_runtime.ensure_services_started().await;
        });
        tokio::task::yield_now().await;

        runtime.shutdown_token.cancel();
        drop(handle_slot);
        initialization.await.unwrap();

        assert!(runtime.services_started.get().is_none());
        assert!(runtime.pending_crash_rx.lock().unwrap().is_some());
        assert!(runtime.crash_handler_handle.lock().await.is_none());
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
        let (runtime, _dir) = create_state_commit_test_runtime();
        let coordinator_drained = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let task_drained = Arc::clone(&coordinator_drained);
        let task_shutdown = runtime.shutdown_token.clone();
        *runtime.crash_handler_handle.lock().await = Some(tokio::spawn(async move {
            task_shutdown.cancelled().await;
            task_drained.store(true, std::sync::atomic::Ordering::SeqCst);
        }));

        // No boxes created — shutdown should complete cleanly
        let result = runtime.shutdown(Some(1)).await;
        assert!(result.is_ok());
        assert!(coordinator_drained.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn test_repeated_shutdown_drains_remaining_crash_coordinator() {
        let (runtime, _dir) = create_state_commit_test_runtime();
        runtime.shutdown_token.cancel();
        let coordinator_drained = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let task_drained = Arc::clone(&coordinator_drained);
        *runtime.crash_handler_handle.lock().await = Some(tokio::spawn(async move {
            tokio::task::yield_now().await;
            task_drained.store(true, std::sync::atomic::Ordering::SeqCst);
        }));

        runtime.shutdown(None).await.unwrap();

        assert!(coordinator_drained.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn test_shutdown_timeout_does_not_wait_forever_for_crash_coordinator() {
        let (runtime, _dir) = create_state_commit_test_runtime();
        let release_coordinator = Arc::new(tokio::sync::Semaphore::new(0));
        let task_release = Arc::clone(&release_coordinator);
        *runtime.crash_handler_handle.lock().await = Some(tokio::spawn(async move {
            let _permit = task_release
                .acquire()
                .await
                .expect("release semaphore open");
        }));

        tokio::time::timeout(std::time::Duration::from_secs(2), runtime.shutdown(Some(1)))
            .await
            .expect("shutdown should respect its timeout")
            .expect("shutdown should succeed without active boxes");
        assert!(
            runtime.crash_handler_handle.lock().await.is_some(),
            "timed-out coordinator handle must remain supervised"
        );

        release_coordinator.add_permits(1);
        runtime
            .shutdown(Some(1))
            .await
            .expect("later shutdown should reap coordinator");
        assert!(runtime.crash_handler_handle.lock().await.is_none());
    }

    #[tokio::test]
    async fn test_infinite_crash_coordinator_drain_waits_for_task() {
        let (runtime, _dir) = create_state_commit_test_runtime();
        let coordinator_drained = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let task_drained = Arc::clone(&coordinator_drained);
        *runtime.crash_handler_handle.lock().await = Some(tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            task_drained.store(true, std::sync::atomic::Ordering::SeqCst);
        }));

        runtime.drain_crash_coordinator(None).await;

        assert!(coordinator_drained.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn test_cancelled_drain_keeps_handle_for_concurrent_caller() {
        let (runtime, _dir) = create_state_commit_test_runtime();
        let release_coordinator = Arc::new(tokio::sync::Semaphore::new(0));
        let task_release = Arc::clone(&release_coordinator);
        let coordinator_drained = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let task_drained = Arc::clone(&coordinator_drained);
        *runtime.crash_handler_handle.lock().await = Some(tokio::spawn(async move {
            let _permit = task_release
                .acquire()
                .await
                .expect("release semaphore open");
            task_drained.store(true, std::sync::atomic::Ordering::SeqCst);
        }));

        let mut first_drain = Box::pin(runtime.drain_crash_coordinator(None));
        assert!(
            futures::poll!(&mut first_drain).is_pending(),
            "first drain should wait for the coordinator"
        );
        assert!(
            runtime.crash_handler_handle.try_lock().is_err(),
            "first drain should own the handle lock"
        );

        let mut second_drain = Box::pin(runtime.drain_crash_coordinator(None));
        assert!(
            futures::poll!(&mut second_drain).is_pending(),
            "concurrent drain must wait for the same coordinator handle"
        );

        drop(first_drain);
        release_coordinator.add_permits(1);
        tokio::time::timeout(std::time::Duration::from_secs(1), second_drain)
            .await
            .expect("second drain should take over the coordinator handle");

        assert!(coordinator_drained.load(std::sync::atomic::Ordering::SeqCst));
        assert!(runtime.crash_handler_handle.lock().await.is_none());
    }

    // ====================================================================
    // crash coordinator tests
    // ====================================================================

    #[test]
    fn test_crash_coordinator_marks_each_box_pending_once() {
        let mut pending_crashes = HashSet::new();
        let box_id = BoxIDMint::mint();

        assert!(CrashCoordinator::mark_pending_crash(
            &mut pending_crashes,
            &box_id
        ));
        assert!(!CrashCoordinator::mark_pending_crash(
            &mut pending_crashes,
            &box_id
        ));
        assert_eq!(pending_crashes.len(), 1);
    }

    #[test]
    fn test_crash_coordinator_skips_when_runtime_dropped() {
        let (_tx, rx) = mpsc::channel(1);
        let mut coordinator = CrashCoordinator {
            runtime: Weak::new(),
            shutdown_token: CancellationToken::new(),
            force_cancel_token: CancellationToken::new(),
            crash_rx: rx,
            crash_rx_closed: false,
            pending_crashes: HashSet::new(),
            running_crashes: JoinSet::new(),
            task_boxes: HashMap::new(),
        };
        let box_id = BoxIDMint::mint();

        assert!(!coordinator.schedule_crash(box_id));
        assert!(coordinator.pending_crashes.is_empty());
        assert!(coordinator.crash_rx_closed);
        assert!(coordinator.running_crashes.is_empty());
        assert!(coordinator.task_boxes.is_empty());
    }

    #[tokio::test]
    async fn test_crash_coordinator_force_cancel_aborts_supervised_tasks() {
        let (runtime, _dir) = create_state_commit_test_runtime();
        let (tx, rx) = mpsc::channel(1);
        let mut coordinator = CrashCoordinator::new(runtime, rx);
        let box_id = BoxIDMint::mint();
        coordinator.pending_crashes.insert(box_id.clone());
        let abort_handle = coordinator
            .running_crashes
            .spawn(std::future::pending::<BoxID>());
        coordinator.task_boxes.insert(abort_handle.id(), box_id);
        coordinator.force_cancel_token.cancel();
        drop(tx);

        tokio::time::timeout(std::time::Duration::from_secs(1), coordinator.run())
            .await
            .expect("forced cancellation should drain crash tasks");
    }

    #[tokio::test]
    async fn test_crash_coordinator_cleans_up_completed_task() {
        let (runtime, _dir) = create_state_commit_test_runtime();
        let (_tx, rx) = mpsc::channel(1);
        let mut coordinator = CrashCoordinator::new(runtime, rx);
        let box_id = BoxIDMint::mint();
        coordinator.pending_crashes.insert(box_id.clone());
        let task_box_id = box_id.clone();
        let abort_handle = coordinator
            .running_crashes
            .spawn(async move { task_box_id });
        coordinator
            .task_boxes
            .insert(abort_handle.id(), box_id.clone());

        let result = coordinator
            .running_crashes
            .join_next_with_id()
            .await
            .expect("completed task");
        coordinator.finish_crash_task(result);

        assert!(!coordinator.pending_crashes.contains(&box_id));
        assert!(coordinator.task_boxes.is_empty());
        assert!(CrashCoordinator::mark_pending_crash(
            &mut coordinator.pending_crashes,
            &box_id
        ));
    }

    #[tokio::test]
    async fn test_crash_coordinator_cleans_up_panicked_task() {
        let (runtime, _dir) = create_state_commit_test_runtime();
        let (_tx, rx) = mpsc::channel(1);
        let mut coordinator = CrashCoordinator::new(runtime, rx);
        let box_id = BoxIDMint::mint();
        coordinator.pending_crashes.insert(box_id.clone());
        let abort_handle = coordinator
            .running_crashes
            .spawn(async move { panic!("test crash handler panic") });
        coordinator
            .task_boxes
            .insert(abort_handle.id(), box_id.clone());

        let result = coordinator
            .running_crashes
            .join_next_with_id()
            .await
            .expect("panicked task");
        coordinator.finish_crash_task(result);

        assert!(!coordinator.pending_crashes.contains(&box_id));
        assert!(coordinator.task_boxes.is_empty());
    }

    #[tokio::test]
    async fn test_crash_coordinator_cleans_up_cancelled_task() {
        let (runtime, _dir) = create_state_commit_test_runtime();
        let (_tx, rx) = mpsc::channel(1);
        let mut coordinator = CrashCoordinator::new(runtime, rx);
        let box_id = BoxIDMint::mint();
        coordinator.pending_crashes.insert(box_id.clone());
        let task_box_id = box_id.clone();
        let abort_handle = coordinator.running_crashes.spawn(async move {
            std::future::pending::<()>().await;
            task_box_id
        });
        coordinator
            .task_boxes
            .insert(abort_handle.id(), box_id.clone());
        abort_handle.abort();

        let result = coordinator
            .running_crashes
            .join_next_with_id()
            .await
            .expect("cancelled task");
        coordinator.finish_crash_task(result);

        assert!(!coordinator.pending_crashes.contains(&box_id));
        assert!(coordinator.task_boxes.is_empty());
    }

    #[tokio::test]
    async fn test_crash_coordinator_drains_supervised_tasks_on_shutdown() {
        let (runtime, _dir) = create_state_commit_test_runtime();
        let (_tx, rx) = mpsc::channel(1);
        let mut coordinator = CrashCoordinator::new(runtime, rx);
        let box_id = BoxIDMint::mint();
        coordinator.pending_crashes.insert(box_id.clone());
        let task_box_id = box_id.clone();
        let task_shutdown = coordinator.shutdown_token.clone();
        let abort_handle = coordinator.running_crashes.spawn(async move {
            task_shutdown.cancelled().await;
            task_box_id
        });
        coordinator.task_boxes.insert(abort_handle.id(), box_id);
        coordinator.shutdown_token.cancel();

        tokio::time::timeout(std::time::Duration::from_secs(1), coordinator.run())
            .await
            .expect("coordinator should drain cancelled crash tasks");
    }

    // ====================================================================
    // crash restart epoch tests
    // ====================================================================

    #[test]
    fn test_crash_restart_plan_rejects_stale_lifecycle_epoch() {
        let mut state = BoxState::new();
        state.force_status(BoxStatus::Crashed);
        state.lifecycle_epoch = 7;

        assert!(!crash_restart_matches_plan(&state, 6));
    }

    #[test]
    fn test_crash_restart_plan_rejects_user_stopped_state() {
        let mut state = BoxState::new();
        state.force_status(BoxStatus::Stopped);
        state.lifecycle_epoch = 3;

        assert!(!crash_restart_matches_plan(&state, 3));
    }

    #[test]
    fn test_crash_restart_plan_accepts_current_crashed_state() {
        let mut state = BoxState::new();
        state.force_status(BoxStatus::Crashed);
        state.lifecycle_epoch = 3;

        assert!(crash_restart_matches_plan(&state, 3));
    }

    #[test]
    fn test_crash_restart_plan_accepts_current_restarting_state() {
        let mut state = BoxState::new();
        state.force_status(BoxStatus::Restarting);
        state.lifecycle_epoch = 3;

        assert!(crash_restart_matches_plan(&state, 3));
    }

    fn add_state_commit_test_box(
        runtime: &RuntimeImpl,
        status: BoxStatus,
        lifecycle_epoch: u64,
    ) -> BoxConfig {
        let config = test_box_config(false);
        let mut state = BoxState::new();
        state.force_status(status);
        state.lifecycle_epoch = lifecycle_epoch;
        state.stop_info.cause = StopCause::Normal;
        let lock_id = runtime.lock_manager.allocate().expect("allocate lock");
        state.set_lock_id(lock_id);

        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("add box");
        config
    }

    #[tokio::test]
    async fn test_commit_restart_success_resets_stop_info() {
        let (runtime, _dir) = create_state_commit_test_runtime();
        let config = test_box_config(false);
        let mut state = BoxState::new();
        state.force_status(BoxStatus::Running);
        state.lifecycle_epoch = 3;
        state.stop_info.cause = StopCause::RestartFailed;
        state.stop_info.exit_code = Some(1);
        state.stop_info.restart_count = 2;
        let lock_id = runtime.lock_manager.allocate().expect("allocate lock");
        state.set_lock_id(lock_id);
        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("add box");
        let box_impl = runtime.create_box_impl(config.clone(), state);

        let committed =
            RuntimeImpl::commit_restart_success(&runtime, &config.id, 3, &box_impl, lock_id)
                .await
                .expect("commit restart success");

        assert!(committed);
        let in_memory = box_impl.state.read().clone();
        let (_, persisted) = runtime
            .box_manager
            .box_by_id(&config.id)
            .expect("load box")
            .expect("box exists");
        assert_eq!(in_memory.stop_info.cause, StopCause::Normal);
        assert_eq!(in_memory.stop_info.exit_code, None);
        assert_eq!(in_memory.stop_info.restart_count, 0);
        assert!(in_memory.stop_info.restarted_at.is_some());
        assert_eq!(persisted.stop_info.cause, in_memory.stop_info.cause);
        assert_eq!(persisted.stop_info.exit_code, in_memory.stop_info.exit_code);
        assert_eq!(persisted.stop_info.exit_time, in_memory.stop_info.exit_time);
        assert_eq!(
            persisted.stop_info.restart_count,
            in_memory.stop_info.restart_count
        );
        assert_eq!(
            persisted.stop_info.restarted_at,
            in_memory.stop_info.restarted_at
        );
    }

    #[tokio::test]
    async fn test_commit_restart_success_rejects_stale_epoch() {
        let (runtime, _dir) = create_state_commit_test_runtime();
        let config = test_box_config(false);
        let mut state = BoxState::new();
        state.force_status(BoxStatus::Running);
        state.lifecycle_epoch = 4;
        state.stop_info.cause = StopCause::RestartFailed;
        state.stop_info.restart_count = 2;
        let lock_id = runtime.lock_manager.allocate().expect("allocate lock");
        state.set_lock_id(lock_id);
        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("add box");
        let box_impl = runtime.create_box_impl(config.clone(), state);

        let committed =
            RuntimeImpl::commit_restart_success(&runtime, &config.id, 3, &box_impl, lock_id)
                .await
                .expect("commit restart success");

        assert!(!committed);
        let in_memory = box_impl.state.read().clone();
        let (_, persisted) = runtime
            .box_manager
            .box_by_id(&config.id)
            .expect("load box")
            .expect("box exists");
        assert_eq!(in_memory.stop_info.cause, StopCause::RestartFailed);
        assert_eq!(in_memory.stop_info.restart_count, 2);
        assert_eq!(persisted.stop_info.cause, in_memory.stop_info.cause);
        assert_eq!(
            persisted.stop_info.restart_count,
            in_memory.stop_info.restart_count
        );
    }

    #[tokio::test]
    async fn test_commit_restart_success_rejects_stopped_state() {
        let (runtime, _dir) = create_state_commit_test_runtime();
        let config = test_box_config(false);
        let mut state = BoxState::new();
        state.force_status(BoxStatus::Stopped);
        state.lifecycle_epoch = 3;
        state.stop_info.cause = StopCause::RestartFailed;
        state.stop_info.restart_count = 2;
        let lock_id = runtime.lock_manager.allocate().expect("allocate lock");
        state.set_lock_id(lock_id);
        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("add box");
        let box_impl = runtime.create_box_impl(config.clone(), state);

        let committed =
            RuntimeImpl::commit_restart_success(&runtime, &config.id, 3, &box_impl, lock_id)
                .await
                .expect("commit restart success");

        assert!(!committed);
        let in_memory = box_impl.state.read().clone();
        let (_, persisted) = runtime
            .box_manager
            .box_by_id(&config.id)
            .expect("load box")
            .expect("box exists");
        assert_eq!(in_memory.stop_info.cause, StopCause::RestartFailed);
        assert_eq!(in_memory.stop_info.restart_count, 2);
        assert_eq!(persisted.stop_info.cause, in_memory.stop_info.cause);
        assert_eq!(
            persisted.stop_info.restart_count,
            in_memory.stop_info.restart_count
        );
    }

    #[tokio::test]
    async fn test_commit_crash_restart_state_rejects_stale_lifecycle_epoch() {
        let (runtime, _dir) = create_state_commit_test_runtime();
        let config = add_state_commit_test_box(&runtime, BoxStatus::Crashed, 4);

        let committed = RuntimeImpl::commit_crash_restart_state(&runtime, &config.id, 3, |state| {
            state.stop_info.cause = StopCause::RestartFailed;
        })
        .await
        .expect("commit state");

        let (_, saved_state) = runtime
            .box_manager
            .box_by_id(&config.id)
            .expect("load box")
            .expect("box exists");
        assert!(!committed);
        assert_eq!(saved_state.status, BoxStatus::Crashed);
        assert_eq!(saved_state.stop_info.cause, StopCause::Normal);
    }

    #[tokio::test]
    async fn test_commit_crash_restart_state_rejects_stopped_state_at_same_epoch() {
        let (runtime, _dir) = create_state_commit_test_runtime();
        let config = add_state_commit_test_box(&runtime, BoxStatus::Stopped, 3);

        let committed = RuntimeImpl::commit_crash_restart_state(&runtime, &config.id, 3, |state| {
            state.stop_info.cause = StopCause::RestartFailed;
        })
        .await
        .expect("commit state");

        let (_, saved_state) = runtime
            .box_manager
            .box_by_id(&config.id)
            .expect("load box")
            .expect("box exists");
        assert!(!committed);
        assert_eq!(saved_state.status, BoxStatus::Stopped);
        assert_eq!(saved_state.stop_info.cause, StopCause::Normal);
    }

    #[tokio::test]
    async fn test_commit_crash_restart_state_accepts_current_crashed_state() {
        let (runtime, _dir) = create_state_commit_test_runtime();
        let config = add_state_commit_test_box(&runtime, BoxStatus::Crashed, 3);

        let committed = RuntimeImpl::commit_crash_restart_state(&runtime, &config.id, 3, |state| {
            state.force_status(BoxStatus::Stopped);
            state.stop_info.cause = StopCause::MaxRetriesExceeded;
        })
        .await
        .expect("commit state");

        let (_, saved_state) = runtime
            .box_manager
            .box_by_id(&config.id)
            .expect("load box")
            .expect("box exists");
        assert!(committed);
        assert_eq!(saved_state.status, BoxStatus::Stopped);
        assert_eq!(saved_state.stop_info.cause, StopCause::MaxRetriesExceeded);
    }

    #[tokio::test]
    async fn test_commit_crash_restart_state_accepts_current_restarting_state() {
        let (runtime, _dir) = create_state_commit_test_runtime();
        let config = add_state_commit_test_box(&runtime, BoxStatus::Restarting, 3);

        let committed = RuntimeImpl::commit_crash_restart_state(&runtime, &config.id, 3, |state| {
            state.force_status(BoxStatus::Stopped);
            state.stop_info.cause = StopCause::Normal;
        })
        .await
        .expect("commit state");

        let (_, saved_state) = runtime
            .box_manager
            .box_by_id(&config.id)
            .expect("load box")
            .expect("box exists");
        assert!(committed);
        assert_eq!(saved_state.status, BoxStatus::Stopped);
        assert_eq!(saved_state.stop_info.cause, StopCause::Normal);
    }

    #[tokio::test]
    async fn test_mark_restart_failed_does_not_overwrite_stale_stopped_state() {
        let (runtime, _dir) = create_state_commit_test_runtime();
        let config = test_box_config(false);
        let mut state = BoxState::new();
        state.force_status(BoxStatus::Stopped);
        state.lifecycle_epoch = 4;
        state.stop_info.cause = StopCause::Normal;
        let lock_id = runtime.lock_manager.allocate().expect("allocate lock");
        state.set_lock_id(lock_id);

        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("add box");

        let committed = RuntimeImpl::mark_restart_failed(&runtime, &config.id, 3, 5)
            .await
            .expect("mark restart failed");

        let (_, saved_state) = runtime
            .box_manager
            .box_by_id(&config.id)
            .expect("load box")
            .expect("box exists");
        assert!(!committed);
        assert_eq!(saved_state.status, BoxStatus::Stopped);
        assert_eq!(saved_state.stop_info.cause, StopCause::Normal);
    }

    #[tokio::test]
    async fn test_cancelled_crash_restart_does_not_overwrite_stale_stopped_state() {
        let (runtime, _dir) = create_state_commit_test_runtime();
        let config = test_box_config(false);
        let mut state = BoxState::new();
        state.force_status(BoxStatus::Stopped);
        state.lifecycle_epoch = 4;
        state.stop_info.cause = StopCause::SystemReboot;
        state.stop_info.restart_count = 99;
        let lock_id = runtime.lock_manager.allocate().expect("allocate lock");
        state.set_lock_id(lock_id);

        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("add box");

        let shutdown_token = CancellationToken::new();
        shutdown_token.cancel();
        RuntimeImpl::run_restart_loop(
            Arc::downgrade(&runtime),
            shutdown_token,
            config.id.clone(),
            CrashRestartPlan {
                restart_policy: Some(RestartPolicy::Always),
                expected_epoch: 3,
                current_restart_count: 0,
                new_restart_count: 1,
                exit_code: Some(1),
            },
        )
        .await;

        let (_, saved_state) = runtime
            .box_manager
            .box_by_id(&config.id)
            .expect("load box")
            .expect("box exists");
        assert_eq!(saved_state.status, BoxStatus::Stopped);
        assert_eq!(saved_state.lifecycle_epoch(), 4);
        assert_eq!(saved_state.stop_info.cause, StopCause::SystemReboot);
        assert_eq!(saved_state.stop_info.restart_count, 99);
    }

    #[test]
    fn test_restart_denied_stop_cause_for_no_policy() {
        assert_eq!(
            stop_cause_when_restart_denied(None, Some(1), false),
            StopCause::CrashedNoPolicy
        );
        assert_eq!(
            stop_cause_when_restart_denied(Some(&RestartPolicy::No), Some(1), false),
            StopCause::CrashedNoPolicy
        );
    }

    #[test]
    fn test_restart_denied_stop_cause_for_on_failure_clean_exit() {
        assert_eq!(
            stop_cause_when_restart_denied(
                Some(&RestartPolicy::OnFailure { max_retries: 3 }),
                Some(0),
                false,
            ),
            StopCause::Normal
        );
    }

    #[test]
    fn test_restart_denied_stop_cause_for_on_failure_max_retries() {
        assert_eq!(
            stop_cause_when_restart_denied(
                Some(&RestartPolicy::OnFailure { max_retries: 3 }),
                Some(1),
                true,
            ),
            StopCause::MaxRetriesExceeded
        );
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
        let layout = runtime
            .layout
            .box_layout(config.id.as_str(), false)
            .expect("box_layout is infallible");
        std::fs::create_dir_all(layout.root()).expect("Failed to create box directory");
        let pid_file = layout.pid_file_path();
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

    #[cfg(target_os = "linux")]
    #[test]
    fn test_recovery_marks_unverified_live_shim_running() {
        use std::os::unix::process::CommandExt;

        let (runtime, _dir) = create_test_runtime();

        let mut child = std::process::Command::new("sleep")
            .arg0("boxlite-shim")
            .arg("300")
            .spawn()
            .expect("Failed to spawn legacy shim process");
        let pid = child.id();

        let config = test_box_config_in_layout(false, &runtime);
        let state = running_state(pid);

        let layout = runtime
            .layout
            .box_layout(config.id.as_str(), false)
            .expect("box_layout is infallible");
        std::fs::create_dir_all(layout.root()).expect("Failed to create box directory");
        let pid_file = layout.pid_file_path();
        std::fs::write(&pid_file, pid.to_string()).expect("Failed to write PID file");

        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("Failed to add box");

        runtime.recover_boxes().expect("Failed to recover boxes");

        let (_, db_state) = runtime.box_manager.box_by_id(&config.id).unwrap().unwrap();
        assert_eq!(db_state.status, BoxStatus::Running);
        assert_eq!(db_state.pid, Some(pid));
        assert!(
            pid_file.exists(),
            "Unverified live shim PID file should be preserved"
        );

        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn test_remove_box_refuses_live_pid_without_force_even_unknown() {
        let (runtime, _dir) = create_test_runtime();

        let (pid, mut child) = spawn_dummy_process();
        let config = test_box_config_in_layout(false, &runtime);
        let mut state = BoxState::new();
        state.set_status(BoxStatus::Unknown);
        state.set_pid(Some(pid));
        let lock_id = runtime
            .lock_manager
            .allocate()
            .expect("Failed to allocate lock");
        state.set_lock_id(lock_id);

        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("Failed to add box");

        let result = runtime.remove_box(&config.id, false);
        assert!(result.is_err());
        assert!(
            crate::util::is_process_alive(pid),
            "Non-force remove must not orphan or kill the live process"
        );
        assert!(
            runtime.box_manager.box_by_id(&config.id).unwrap().is_some(),
            "Box should remain in DB after rejected remove"
        );

        runtime
            .remove_box(&config.id, true)
            .expect("Force remove should kill process and remove box");
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(
            !crate::util::is_process_alive(pid),
            "Force remove should kill the live process"
        );
        assert!(runtime.box_manager.box_by_id(&config.id).unwrap().is_none());

        child.wait().ok();
    }

    /// Write a two-line `shim.pid` whose start-time matches the live PID
    /// so the recovery and stop fingerprint checks adopt it.
    fn write_pid_file_with_fingerprint(pid_file: &std::path::Path, pid: u32) {
        if let Some(parent) = pid_file.parent() {
            std::fs::create_dir_all(parent).expect("create box directory");
        }
        let st = crate::util::process_start_time(pid).expect("OS reports start_time");
        std::fs::write(pid_file, format!("{pid}\n{st}\n")).expect("write shim.pid");
    }

    #[tokio::test]
    async fn test_stop_kills_recovered_pid_without_live_state() {
        let (runtime, _dir) = create_test_runtime();
        let config = test_box_config_in_layout(false, &runtime);

        let (pid, mut child) = spawn_dummy_process();
        let mut state = running_state(pid);
        let lock_id = runtime
            .lock_manager
            .allocate()
            .expect("Failed to allocate lock");
        state.set_lock_id(lock_id);

        let layout = runtime
            .layout
            .box_layout(config.id.as_str(), false)
            .expect("box_layout is infallible");
        let pid_file = layout.pid_file_path();
        write_pid_file_with_fingerprint(&pid_file, pid);

        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("Failed to add box");

        let litebox = runtime
            .get(config.id.as_str())
            .await
            .expect("Failed to get box")
            .expect("Box should exist");

        litebox.stop().await.expect("Stop should succeed");

        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(
            !crate::util::is_process_alive(pid),
            "Stop should kill recovered process when no LiveState is cached"
        );
        assert!(!pid_file.exists(), "PID file should be removed on stop");

        let (_, db_state) = runtime.box_manager.box_by_id(&config.id).unwrap().unwrap();
        assert_eq!(db_state.status, BoxStatus::Stopped);
        assert!(db_state.pid.is_none());

        child.wait().ok();
    }

    #[tokio::test]
    async fn test_exec_unknown_state_returns_error_without_panic() {
        use crate::litebox::BoxCommand;

        let (runtime, _dir) = create_test_runtime();

        let config = test_box_config_in_layout(false, &runtime);
        let mut state = BoxState::new();
        state.set_status(BoxStatus::Unknown);
        let lock_id = runtime
            .lock_manager
            .allocate()
            .expect("Failed to allocate lock");
        state.set_lock_id(lock_id);

        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("Failed to add box");

        let litebox = runtime
            .get(config.id.as_str())
            .await
            .expect("Failed to get box")
            .expect("Box should exist");

        // Refused by the status gate on `exec` (BoxStatus::can_exec), before any
        // attempt to boot a VM. It used to be refused a layer deeper, by the
        // init pipeline's plan lookup ("Cannot initialize box in Unknown
        // state"); the gate now catches it first, because a lazy boot is no
        // longer a harmless thing to attempt — it runs the box's main command.
        let result = litebox.exec(BoxCommand::new("true")).await;
        match result {
            Err(BoxliteError::InvalidState(msg)) => {
                assert!(
                    msg.contains("unknown"),
                    "the refusal must name the state that caused it, got: {msg}"
                );
            }
            Err(other) => panic!("Expected InvalidState error, got: {other}"),
            Ok(_) => panic!("Expected InvalidState error, got success"),
        }
    }

    // ====================================================================
    // Reproducer tests for follow-up fixes (see PR #492 review)
    //
    // These tests assert the *desired* behavior, not the current behavior.
    // They are written before the implementing fix so reviewers can `git
    // checkout <test commit>~1` and observe the failure mode.
    // ====================================================================

    /// REPRO: stop() must not kill a PID that does not belong to this box.
    ///
    /// Today the recovered-pid branch in `BoxImpl::stop` kills any non-
    /// `Configured|Stopped` PID without verifying the process is ours, which
    /// is a PID-reuse hazard. The fix is to call `process_identity` first.
    #[tokio::test]
    async fn test_stop_does_not_kill_unrelated_process_repro() {
        let (runtime, _dir) = create_test_runtime();

        // Spawn a plain `sleep` (NOT a boxlite-shim) — recovery should treat
        // its PID as foreign.
        let (pid, mut child) = spawn_dummy_process();
        let config = test_box_config_in_layout(false, &runtime);
        let mut state = running_state(pid);
        let lock_id = runtime
            .lock_manager
            .allocate()
            .expect("Failed to allocate lock");
        state.set_lock_id(lock_id);

        let layout = runtime
            .layout
            .box_layout(config.id.as_str(), false)
            .expect("box_layout is infallible");
        std::fs::create_dir_all(layout.root()).expect("Failed to create box directory");
        let pid_file = layout.pid_file_path();
        // Write a two-line PID file with a DELIBERATELY WRONG start_time.
        // This simulates PID reuse: the recorded fingerprint won't match
        // the OS's current reading for `pid`, so ProcessIdentity is
        // Absent and stop() must not kill the foreign process.
        let wrong_start_time = crate::util::process_start_time(pid)
            .map(|st| st.wrapping_add(1))
            .unwrap_or(u64::MAX);
        std::fs::write(&pid_file, format!("{pid}\n{wrong_start_time}\n"))
            .expect("Failed to write PID file");

        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("Failed to add box");

        let litebox = runtime
            .get(config.id.as_str())
            .await
            .expect("Failed to get box")
            .expect("Box should exist");

        // The fix will return Ok and leave the foreign process alone.
        let _ = litebox.stop().await;

        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(
            crate::util::is_process_alive(pid),
            "stop() killed a process that did not belong to this box (PID-reuse hazard)"
        );

        let _ = child.kill();
        let _ = child.wait();
    }

    /// REPRO: a box in `Failed` state must be retryable.
    ///
    /// `BoxStatus::can_start()` and the `Failed` doc both promise retry.
    /// Today `init_live_state` rejects `Failed` with "Cannot initialize box
    /// <id> in failed state" before reaching the restart pipeline.
    #[tokio::test]
    async fn test_failed_state_is_retryable_repro() {
        use crate::litebox::BoxCommand;

        let (runtime, _dir) = create_test_runtime();

        let config = test_box_config_in_layout(false, &runtime);
        let mut state = BoxState::new();
        state.set_status(BoxStatus::Failed);
        let lock_id = runtime
            .lock_manager
            .allocate()
            .expect("Failed to allocate lock");
        state.set_lock_id(lock_id);

        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("Failed to add box");

        let litebox = runtime
            .get(config.id.as_str())
            .await
            .expect("Failed to get box")
            .expect("Box should exist");

        let result = litebox.exec(BoxCommand::new("true")).await;
        if let Err(BoxliteError::InvalidState(msg)) = &result {
            assert!(
                !msg.contains("in failed state"),
                "Failed-state retry was rejected by the init_live_state guard \
                 (PR #492 added this guard but Failed should still be retryable per \
                 BoxStatus::can_start). Error: {msg}"
            );
        }
        // Other errors (Engine/Internal/etc.) are fine — they mean we got past
        // the guard and into the real pipeline, which is the desired behavior.
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

    #[tokio::test]
    async fn test_pull_image_after_shutdown_returns_stopped() {
        let (runtime, _dir) = create_test_runtime();
        let local_runtime = LocalRuntime(runtime.clone());

        runtime.shutdown(None).await.unwrap();

        let result = local_runtime.pull_image("alpine:latest").await;

        match result {
            Err(BoxliteError::Stopped(msg)) => {
                assert!(
                    msg.contains("shut down"),
                    "Error should mention 'shut down': {msg}"
                );
            }
            Err(other) => panic!("Expected Stopped error, got: {other}"),
            Ok(_) => panic!("pull_image should fail after shutdown"),
        }
    }

    #[tokio::test]
    async fn test_list_images_after_shutdown_returns_stopped() {
        let (runtime, _dir) = create_test_runtime();
        let local_runtime = LocalRuntime(runtime.clone());

        runtime.shutdown(None).await.unwrap();

        let result = local_runtime.list_images().await;

        match result {
            Err(BoxliteError::Stopped(msg)) => {
                assert!(
                    msg.contains("shut down"),
                    "Error should mention 'shut down': {msg}"
                );
            }
            Err(other) => panic!("Expected Stopped error, got: {other}"),
            Ok(_) => panic!("list_images should fail after shutdown"),
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

        // The socket binding symlink must be removed with the box.
        config.sockets().ensure().unwrap();
        let binding_dir = config.sockets().binding_dir();
        assert!(std::fs::symlink_metadata(&binding_dir).is_ok());

        let result = runtime.remove_box(&config.id, false);
        assert!(result.is_ok());
        assert!(
            std::fs::symlink_metadata(&binding_dir).is_err(),
            "remove_box must unlink the socket binding symlink"
        );
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

    // ====================================================================
    // Stop spawn-guard: stop() on non-Running states must not spawn a VM.
    // The state.status pre-filter in stop() prevents live_state() from
    // routing through init_live_state -> BoxBuilder for Configured/Failed
    // boxes, which would otherwise trigger the full spawn pipeline.
    // ====================================================================

    #[tokio::test]
    async fn test_stop_configured_does_not_spawn() {
        let (runtime, _dir) = create_test_runtime();
        let config = test_box_config_in_layout(false, &runtime);
        let mut state = BoxState::new();
        // BoxState::new defaults to Configured
        assert_eq!(state.status, BoxStatus::Configured);
        let lock_id = runtime
            .lock_manager
            .allocate()
            .expect("Failed to allocate lock");
        state.set_lock_id(lock_id);
        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("Failed to add box");

        let litebox = runtime
            .get(config.id.as_str())
            .await
            .expect("get")
            .expect("Box should exist");

        let start = std::time::Instant::now();
        let _ = litebox.stop().await;
        let elapsed = start.elapsed();

        // Fast path — no spawn attempted. A real spawn takes seconds (rootfs
        // prep + libkrun init); the no-spawn cleanup path completes in
        // milliseconds. 2s is a generous upper bound.
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "stop() on Configured took {:?}; likely triggered spawn pipeline",
            elapsed
        );

        // mark_stop is gated on !is_configured, so state stays Configured.
        let (_, db_state) = runtime.box_manager.box_by_id(&config.id).unwrap().unwrap();
        assert_eq!(db_state.status, BoxStatus::Configured);
    }

    #[tokio::test]
    async fn test_stop_failed_does_not_spawn() {
        let (runtime, _dir) = create_test_runtime();
        let config = test_box_config_in_layout(false, &runtime);
        let mut state = BoxState::new();
        state.mark_failed("simulated prior failure");
        assert_eq!(state.status, BoxStatus::Failed);
        let lock_id = runtime
            .lock_manager
            .allocate()
            .expect("Failed to allocate lock");
        state.set_lock_id(lock_id);
        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("Failed to add box");

        let litebox = runtime
            .get(config.id.as_str())
            .await
            .expect("get")
            .expect("Box should exist");

        let start = std::time::Instant::now();
        let _ = litebox.stop().await;
        let elapsed = start.elapsed();

        // Fast path — no spawn attempted. Stop on Failed boxes should be a
        // cleanup-only operation since there is no live shim to attach.
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "stop() on Failed took {:?}; likely triggered spawn pipeline",
            elapsed
        );

        // mark_stop runs for non-Configured states; Failed -> Stopped.
        let (_, db_state) = runtime.box_manager.box_by_id(&config.id).unwrap().unwrap();
        assert_eq!(db_state.status, BoxStatus::Stopped);
    }
}
