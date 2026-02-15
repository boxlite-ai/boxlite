use crate::db::{BoxStore, Database};
use crate::images::{ImageDiskManager, ImageManager};
use crate::init_logging_for;
use crate::litebox::config::BoxConfig;
use crate::litebox::{BoxManager, LiteBox, SharedBoxImpl};
use crate::lock::{FileLockManager, LockManager};
use crate::metrics::{RuntimeMetrics, RuntimeMetricsStorage};
use crate::runtime::constants::filenames;
use crate::runtime::guest_rootfs::GuestRootfs;
use crate::runtime::guest_rootfs_manager::GuestRootfsManager;
use crate::runtime::layout::{FilesystemLayout, FsLayoutConfig};
use crate::runtime::lock::RuntimeLock;
use crate::runtime::options::{BoxOptions, BoxliteOptions};
use crate::runtime::signal_handler::timeout_to_duration;
use crate::runtime::types::{BoxID, BoxInfo, BoxState, BoxStatus, ContainerID};
use crate::vmm::VmmKind;
use boxlite_shared::{BoxliteError, BoxliteResult, Transport};
use chrono::Utc;
use std::collections::HashMap;
use std::sync::{Arc, RwLock, Weak};
use tokio::sync::OnceCell;
use tokio_util::sync::CancellationToken;

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
        let vmm_support = crate::vmm::host_check::check_virtualization_support().map_err(|e| {
            BoxliteError::Internal(format!("Failed to check virtualization support: {}", e))
        })?;

        tracing::info!(
            reason = %vmm_support.reason,
            "Virtualization support verified"
        );

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
        let guest_rootfs_mgr =
            GuestRootfsManager::new(layout.guest_rootfs_dir(), layout.temp_dir());

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
            lock_manager,
            _runtime_lock: runtime_lock,
            shutdown_token: CancellationToken::new(),
        });

        tracing::debug!("initialized runtime");

        // Recover boxes from database
        inner.recover_boxes()?;

        Ok(inner)
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
        self.create_inner(options, name, true).await
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
                return Ok((LiteBox::new(box_impl), false));
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
                return Ok((LiteBox::new(box_impl), false));
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

        Ok((LiteBox::new(box_impl), true))
    }

    /// Get a handle to an existing box by ID or name.
    ///
    /// Returns a LiteBox handle that can be used to operate on the box.
    /// Checks in-memory cache first (for boxes not yet persisted), then DB.
    ///
    /// If another handle to the same box exists, they share the same BoxImpl
    /// (and thus the same LiveState if initialized).
    pub async fn get(self: &Arc<Self>, id_or_name: &str) -> BoxliteResult<Option<LiteBox>> {
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
                return Ok(Some(LiteBox::new(strong)));
            }

            // Try as name
            if let Some(weak) = sync.active_boxes_by_name.get(id_or_name)
                && let Some(strong) = weak.upgrade()
            {
                tracing::trace!(name = %id_or_name, "Found box in cache by name");
                return Ok(Some(LiteBox::new(strong)));
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
            return Ok(Some(LiteBox::new(box_impl)));
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
                tracing::warn!("Failed to query boxes during sync shutdown: {e}");
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

            tracing::info!(box_id = %config.id, pid, "Auto-stopping non-detached box");

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
                    tracing::warn!(box_id = %config.id, pid, "Shim didn't exit after SIGTERM, force killing");
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

        // Generate unique ID (26 chars, ULID format, sortable by time)
        let box_id = BoxID::new();

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

    /// Recover boxes from persistent storage on runtime startup.
    fn recover_boxes(&self) -> BoxliteResult<()> {
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

        // Phase 2: Recover remaining valid boxes
        let persisted = self.box_manager.all_boxes(true)?;

        tracing::info!("Recovering {} boxes from database", persisted.len());

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

            // Check PID file (single source of truth for running processes)
            let pid_file = self
                .layout
                .boxes_dir()
                .join(box_id.as_str())
                .join("shim.pid");

            if pid_file.exists() {
                match crate::util::read_pid_file(&pid_file) {
                    Ok(pid) => {
                        if is_process_alive(pid) && is_same_process(pid, box_id.as_str()) {
                            // Process is alive and it's our boxlite-shim - box stays Running
                            state.set_pid(Some(pid));
                            state.set_status(BoxStatus::Running);
                            tracing::info!(
                                box_id = %box_id,
                                pid = pid,
                                "Recovered running box from PID file"
                            );
                        } else {
                            // Process died or PID was reused - clean up and mark as Stopped
                            let _ = std::fs::remove_file(&pid_file);
                            state.mark_stop();
                            tracing::warn!(
                                box_id = %box_id,
                                pid = pid,
                                "Box process dead, cleaned up stale PID file"
                            );
                        }
                    }
                    Err(e) => {
                        // Can't read PID file - clean up and mark as Stopped
                        let _ = std::fs::remove_file(&pid_file);
                        state.mark_stop();
                        tracing::warn!(
                            box_id = %box_id,
                            error = %e,
                            "Failed to read PID file, marking as Stopped"
                        );
                    }
                }
            } else {
                // No PID file - box was stopped gracefully or never started
                // Note: Configured boxes won't have a PID file (this is expected)
                if state.status == BoxStatus::Running {
                    state.set_status(BoxStatus::Stopped);
                    tracing::warn!(
                        box_id = %box_id,
                        "Box was Running but no PID file found, marked as Stopped"
                    );
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

    fn shutdown_sync(&self) {
        self.0.shutdown_sync();
    }
}

// Image operations (separate from RuntimeBackend)
#[async_trait::async_trait]
impl super::images::ImageManager for LocalRuntime {
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
            id: BoxID::new(),
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
        let id = BoxID::new();
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
}
