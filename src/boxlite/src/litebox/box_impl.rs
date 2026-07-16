//! Box implementation - holds config, state, and lazily-initialized VM resources.

// ============================================================================
// IMPORTS
// ============================================================================

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use parking_lot::RwLock;
use tokio::sync::OnceCell;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::config::BoxConfig;
use super::exec::{BoxCommand, ExecStderr, ExecStdin, ExecStdout, Execution};
use super::state::BoxState;
use crate::disk::Disk;
use crate::event_listener::EventListener;
#[cfg(target_os = "linux")]
use crate::fs::BindMountHandle;
use crate::litebox::BoxTunnel;
use crate::litebox::copy::CopyOptions;
use crate::lock::LockGuard;
use crate::metrics::{BoxMetrics, BoxMetricsStorage};
use crate::net::NetworkBackend;
use crate::portal::GuestSession;
use crate::runtime::layout::BoxFilesystemLayout;
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

    /// Host-side network control backend (gvproxy ServicesMux client), owned
    /// beside `guest_session`. `None` when the box was created network-disabled.
    /// Read via [`BoxImpl::network`]; the first caller lands with the outer
    /// (SDK/CLI) layer — held now so the box owns the abstraction from birth.
    #[allow(dead_code)]
    network: Option<Arc<dyn NetworkBackend>>,

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
        network: Option<Box<dyn NetworkBackend>>,
        metrics: BoxMetricsStorage,
        container_rootfs_disk: Disk,
        guest_rootfs_disk: Option<Disk>,
        #[cfg(target_os = "linux")] bind_mount: Option<BindMountHandle>,
    ) -> Self {
        Self {
            handler: std::sync::Mutex::new(handler),
            guest_session,
            network: network.map(Arc::from),
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
    pub(crate) layout: BoxFilesystemLayout,
    /// Cancellation token for this box (child of runtime's token).
    /// When cancelled (via stop() or runtime shutdown), all operations abort gracefully.
    pub(crate) shutdown_token: CancellationToken,
    /// Serializes disk-mutating snapshot/clone/export operations.
    /// Prevents concurrent disk mutations (rename, delete, flatten) from racing.
    pub(crate) disk_ops: tokio::sync::Mutex<()>,

    /// Event listeners (from runtime options).
    pub(crate) event_listeners: Vec<Arc<dyn EventListener>>,

    // --- Lazily initialized ---
    live: OnceCell<LiveState>,

    /// The box's [`BoxWatcher`](super::watcher::BoxWatcher) task. Set once, on the
    /// first arm — `arm_watcher` is called on every handle the runtime hands out
    /// (and on start), so the `OnceLock` makes "one watcher per box" race-free,
    /// exactly as [`Self::live`] does for the VM. Held so `stop()` can abort it.
    watcher: std::sync::OnceLock<JoinHandle<()>>,

    /// Runs the container's init exactly once. Booting only *creates* the
    /// container now (docker's create); running its init is a separate step so a
    /// client can attach first. This single-flights that step across every
    /// implicit-boot caller and an explicit `start()`, and is pre-set when we
    /// reattach to a box whose init is already running.
    container_start: OnceCell<()>,
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
        let layout = runtime
            .layout
            .box_layout(config.id.as_str(), config.options.advanced.isolate_mounts)
            .expect(
                "box_layout is structurally infallible — only warns on isolate_mounts mismatch",
            );
        Self {
            config,
            state: Arc::new(RwLock::new(state)),
            runtime,
            layout,
            shutdown_token,
            disk_ops: tokio::sync::Mutex::new(()),
            event_listeners: Vec::new(), // populated from runtime options
            live: OnceCell::new(),
            watcher: std::sync::OnceLock::new(),
            container_start: OnceCell::new(),
        }
    }

    /// Watch this box's main command, if it is running and nobody is watching it
    /// yet.
    ///
    /// Armed both when we start a box — with `health` = a guest probe when a
    /// HEALTHCHECK is configured — and when the runtime adopts one already
    /// running (`health` = None: adopted boxes are watched exit-only by design;
    /// only a fresh boot installs a probe). Without the second case, a long-lived
    /// runtime that never touches such a box (`boxlite serve` after a restart,
    /// the cloud) would keep reporting it Running behind a main command that
    /// exited hours ago — the lie [`BoxWatcher`](super::watcher::BoxWatcher)
    /// exists to stop telling.
    ///
    /// Must be called from a tokio context.
    pub(crate) fn arm_watcher(&self, health: Option<super::watcher::HealthProbe>) {
        let Some(shim_pid) = self.state.read().pid else {
            return;
        };
        if self.state.read().status != BoxStatus::Running {
            return;
        }
        self.spawn_watcher_once(shim_pid, health);
    }

    /// Spawn the box's watcher exactly once, whatever `health` the caller brings —
    /// the `OnceLock` makes it race-free across the many `arm_watcher` calls the
    /// runtime makes (one per handle handout, plus start), the same "init once"
    /// the `live` cell gives the VM. `init_live_state` calls this directly, under
    /// the state lock that publishes Running, so a concurrent exit-only handout
    /// cannot win the cell ahead of it and strand the health probe.
    fn spawn_watcher_once(&self, shim_pid: u32, health: Option<super::watcher::HealthProbe>) {
        self.watcher
            .get_or_init(|| super::watcher::BoxWatcher::new(self, shim_pid, health).spawn());
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

        let status = self.state.read().status;

        // `Running` is admitted alongside `can_start()` on purpose: a box brought
        // up by a bare `attach()` reports Running with its container *created but
        // not started*, and this call is what runs it. A spent handle (initialized
        // but no longer Running) is still refused, by `ensure_booted` below.
        if status != BoxStatus::Running && !status.can_start() {
            return Err(BoxliteError::InvalidState(format!(
                "Cannot start box in {} state",
                status
            )));
        }

        // Boot creates the container; running its init is the separate step that
        // makes `run` docker-shaped — create, attach, then start. `run` slips the
        // attach between these two calls; every other caller just wants both.
        let live = self.ensure_booted().await?;
        let started_now = self.ensure_container_started(live).await?;

        // Announce the start only when *this* call actually ran init — not on an
        // idempotent re-`start()` or a reattach to an already-running box.
        if started_now {
            for listener in &self.event_listeners {
                listener.on_box_started(&self.config.id);
            }
            tracing::info!(
                box_id = %self.config.id,
                elapsed_ms = t0.elapsed().as_millis() as u64,
                "Box started"
            );
        }
        Ok(())
    }

    /// Guard every operation that would lazily boot the VM.
    ///
    /// Booting is no longer neutral. The box's init *is* its main command now,
    /// so a lazy start re-runs the user's workload — and `live_state()` both
    /// boots silently, from any status `can_start()` admits, *and* runs init.
    /// `exec` / `cp` / `metrics` on a box that already ran to completion would
    /// therefore execute it a second time:
    ///
    ///   boxlite run --name job alpine sh -c 'send-payment'   # runs, exits
    ///   boxlite cp job:/receipt .                            # sends it again
    ///
    /// The hazard is not "the box is stopped" — it is "restarting it would run
    /// the user's workload again", and only a box with an explicit `cmd` has
    /// that property. Its init *is* that command. A box without one boots the
    /// image's own default (a daemon, an agent), and restarting that is not just
    /// harmless but load-bearing:
    ///
    /// - the SDK's create-then-exec model boots a `Configured` box on first use;
    /// - the cloud stops idle boxes on a reaper and revives them on the next SDK
    ///   call, which goes straight to `/exec` and never calls start.
    ///
    /// So the gate keys on the config, not just the status. A stopped *job* is
    /// refused (docker refuses `exec` on a non-running container too); a stopped
    /// *box* is still woken up.
    fn ensure_usable_without_rerunning_main(&self, op: &str) -> BoxliteResult<()> {
        let status = self.state.read().status;

        // Already up: nothing to boot, nothing to re-run.
        if status == BoxStatus::Running {
            return Ok(());
        }

        if !status.can_exec() {
            return Err(BoxliteError::InvalidState(format!(
                "Cannot {op} box {}: it is {}",
                self.config.id, status
            )));
        }

        // Startable, but not up — so this call would boot the box, which runs the
        // container's init. If the user chose that command, running it is a
        // *decision*, and an exec or a file copy is not the place to make it on
        // their behalf. Not once, and certainly not twice:
        //
        //   boxlite run --name job alpine sh -c 'send-payment'  # runs, exits
        //   boxlite cp job:/receipt .                           # must not re-send
        //
        //   boxlite create --name job alpine sh -c 'send-payment'
        //   boxlite cp ./input job:/in                          # must not send at all
        //
        // A box with no command of its own boots the image's default — the
        // cloud's agent daemon, the SDK's boot-and-exec — and waking that is the
        // whole point of the implicit start, so it stays.
        if self.has_user_main_command() {
            let already = if status == BoxStatus::Stopped {
                "its main command has already run, and starting the box again would run it \
                 a second time"
            } else {
                "starting the box would run its main command"
            };
            return Err(BoxliteError::InvalidState(format!(
                "Cannot {op} box {}: it is {}, and {}. That is a decision for you, not for \
                 a side effect — start the box explicitly if it is what you want.",
                self.config.id, status, already
            )));
        }

        Ok(())
    }

    /// Whether this box's init is a command the *user* chose.
    ///
    /// Both `cmd` and `entrypoint` land in init's argv — `final_cmd()` is
    /// entrypoint ++ cmd — so either one makes init the user's workload, and
    /// restarting the box re-runs it. Keying only on `cmd` would miss
    /// `run --entrypoint /bin/send-payment`, whose init is *entirely* the
    /// user's command and whose `cmd` is None.
    ///
    /// A box with neither boots the image's own default, which is the cloud's
    /// agent daemon and the SDK's boot-and-exec model: restarting it is intended.
    fn has_user_main_command(&self) -> bool {
        self.config.options.cmd.is_some() || self.config.options.entrypoint.is_some()
    }

    pub(crate) async fn exec(&self, command: BoxCommand) -> BoxliteResult<Execution> {
        use boxlite_shared::constants::executor as executor_const;

        // Check if box is stopped before proceeding (via stop() or runtime shutdown)
        if self.shutdown_token.is_cancelled() {
            return Err(BoxliteError::Stopped(
                "Handle invalidated after stop(). Use runtime.get() to get a new handle.".into(),
            ));
        }
        self.ensure_usable_without_rerunning_main("exec")?;

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

    /// Make the main command's exit code survive the VM's power-off.
    ///
    /// The guest powers the VM off the moment init exits, which can cut the
    /// in-flight `Wait` RPC — and the portal then reports `-1`
    /// (`portal/interfaces/exec.rs::spawn_wait`), so `boxlite run` would give
    /// the user a status the process never returned. That is the headline
    /// behaviour of this whole change, and it must not hang on an RPC beating a
    /// reboot.
    ///
    /// It does not have to. The guest writes the real code to the exit file
    /// *before* powering off, so it is already on disk — just read it back.
    ///
    /// The trigger is any **negative** code, not the `-1` specifically. A real
    /// process exit is 0-255, so a negative value always means the portal had no
    /// exit code to give: either it lost the Wait, or it is encoding a signal
    /// death as `-signal` (`map_wait_response`) — and those two overlap exactly
    /// at `-1`, since SIGHUP is signal 1. The exit file is the right answer to
    /// both, because the guest records the docker-convention code (`128 + n` for
    /// a signal), which is what every consumer of this already expects.
    fn exit_code_from_file_when_portal_has_none(
        &self,
        mut upstream: tokio::sync::mpsc::UnboundedReceiver<crate::litebox::ExecResult>,
    ) -> tokio::sync::mpsc::UnboundedReceiver<crate::litebox::ExecResult> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let exit_file = self.layout.container_exit_file(self.container_id());

        tokio::spawn(async move {
            while let Some(mut result) = upstream.recv().await {
                if result.exit_code < 0
                    && let Some(record) = Self::read_exit_record_soon(&exit_file).await
                {
                    tracing::debug!(
                        portal_code = result.exit_code,
                        recovered = record.exit_code,
                        "portal had no exit code for the main command; took it from the exit file"
                    );
                    result.exit_code = record.exit_code;
                    // error_message is left alone: if the portal had something
                    // to say about how the wait ended, it is still true.
                }
                if tx.send(result).is_err() {
                    break;
                }
            }
        });

        rx
    }

    /// Read the exit record, polling briefly for the guest's asynchronous write.
    ///
    /// On a signal death the guest's Wait RPC returns a clean `-n` before its
    /// watcher has finished writing the exit file — nothing orders the two,
    /// unlike the poweroff path where `sync()` precedes power-off. A bounded poll
    /// closes that window; if the record never lands (a hard stop that wrote
    /// nothing), the caller keeps the honest negative code.
    async fn read_exit_record_soon(
        exit_file: &std::path::Path,
    ) -> Option<boxlite_shared::layout::ExitRecord> {
        const ATTEMPTS: u32 = 10;
        const INTERVAL: Duration = Duration::from_millis(20);
        for attempt in 0..ATTEMPTS {
            if let Some(record) = boxlite_shared::layout::ExitRecord::read(exit_file) {
                return Some(record);
            }
            if attempt + 1 < ATTEMPTS {
                tokio::time::sleep(INTERVAL).await;
            }
        }
        None
    }

    /// Attach to a session in the box. Only the main command session (`None`) is
    /// attachable locally: an in-process exec keeps the `Execution` it was created
    /// with and never drops its stream, so there is nothing to reattach to by id.
    ///
    /// For `None`, the guest registers the container init under execution_id =
    /// container_id — this is how `run` follows the user command now that it *is*
    /// init (docker semantics), reusing the exact stream plumbing of exec().
    /// Boots the box if needed but only *creates* the container — it does not run
    /// init. That is what lets `run` be create → attach → start: attach here,
    /// then `start()`, so a command that finishes instantly cannot outrun the
    /// stream. Because attaching never runs the user's command, it needs no
    /// re-run guard (unlike `exec`/`cp`, which do start it).
    pub(crate) async fn attach(&self, execution_id: Option<&str>) -> BoxliteResult<Execution> {
        if execution_id.is_some() {
            return Err(BoxliteError::Unsupported(
                "the local backend does not support reattaching to executions by id".into(),
            ));
        }

        if self.shutdown_token.is_cancelled() {
            return Err(BoxliteError::Stopped(
                "Handle invalidated after stop(). Use runtime.get() to get a new handle.".into(),
            ));
        }

        // Attach follows a box that is running or about to be started (`run`
        // boots a fresh, `Configured` one and starts it right after). A box that
        // already stopped has no session to follow, and rebooting it to attach
        // would be a surprise — refuse it, as docker refuses attaching to a
        // stopped container.
        let status = self.state.read().status;
        if !matches!(
            status,
            BoxStatus::Configured | BoxStatus::Running | BoxStatus::Paused
        ) {
            return Err(BoxliteError::InvalidState(format!(
                "Cannot attach to box {}: it is {}",
                self.config.id, status
            )));
        }

        let live = self.ensure_booted().await?;
        let mut exec_interface = live.guest_session.execution().await?;
        let components = exec_interface
            .attach_existing(self.container_id(), self.shutdown_token.clone())
            .await?;

        let result_rx = self.exit_code_from_file_when_portal_has_none(components.result_rx);

        Ok(Execution::new(
            components.execution_id,
            Box::new(exec_interface),
            result_rx,
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
        self.ensure_usable_without_rerunning_main("metrics")?;

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

        // Abort the box watcher (if armed) so it does not run past stop().
        // `stop()` also cancels the shutdown token the watcher selects on, but the
        // abort stops it immediately even if it is mid-probe. `abort` takes `&self`,
        // so the `OnceLock` need not be emptied.
        if let Some(task) = self.watcher.get() {
            tracing::debug!(
                box_id = %self.config.id,
                "Aborting box watcher"
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

        // Only attempt graceful shutdown for boxes that should have a live
        // shim. Calling live_state() on Configured/Failed would route
        // through the restart pipeline and spawn a new VM — exactly what
        // stop() must NOT do.
        let should_attach = self.state.read().status == BoxStatus::Running;
        if should_attach && let Ok(live) = self.live_state().await {
            // Recovered boxes lazy-attach here via vmm_attach (now
            // ProcessIdentity-gated). Live boxes hit the cached LiveState.
            // Either way the teardown is identical:
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
        }
        // If live_state() failed (vmm_attach said Absent — shim is gone),
        // or status wasn't Running, fall through to cleanup.

        // Clean up PID file (single source of truth)
        let pid_path = self.layout.pid_file_path();
        match std::fs::remove_file(&pid_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => tracing::warn!(
                box_id = %self.config.id,
                path = %pid_path.display(),
                error = %e,
                "Failed to remove PID file"
            ),
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
                // Take the exit code the guest recorded on its way down, as
                // docker does: `docker stop` leaves ExitCode 137, not 0. The
                // guest writes the exit file when init dies — including when it
                // dies because *we* killed it — before it checks whether the
                // teardown was host-driven. The watcher cannot do this: stop()
                // cancels its token, and it stands down precisely so it does not
                // race this path.
                crate::runtime::rt_impl::record_main_command_exit(
                    &mut state,
                    &self
                        .layout
                        .container_exit_file(self.config.container.id.as_str()),
                );
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
        self.ensure_usable_without_rerunning_main("copy into")?;

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
        self.ensure_usable_without_rerunning_main("copy out")?;

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

    /// The implicit-boot funnel: boot the box and make sure its container's init
    /// is running. `exec`, `metrics`, `copy_into` and `copy_out` pass through
    /// here and, as before, get a box whose container is *running* — booting and
    /// running init used to be one pipeline step. Now booting only creates the
    /// container, so this starts it (once, and safely alongside an explicit
    /// `start()`). `attach` deliberately does *not* use this: it boots without
    /// running init, so a client can attach before `start()`.
    async fn live_state(&self) -> BoxliteResult<&LiveState> {
        let live = self.ensure_booted().await?;
        self.ensure_container_started(live).await?;
        Ok(live)
    }

    /// Boot the box to the point its container is *created* — VM up, guest
    /// connected, `Container.Init` done — without running init.
    ///
    /// Refuses to hand back a **spent** handle. A box can now stop *itself* — its
    /// main command exits, the guest powers the VM off, the watcher marks it
    /// Stopped — and this `OnceCell` still holds that dead VM's `LiveState`.
    /// `OnceCell` cannot be re-initialized, so `get_or_try_init` would return the
    /// corpse and the promised restart would silently not happen. The guard lives
    /// here, at the one funnel `live_state` and `attach` share.
    ///
    /// A `Stopped` box whose cell is empty is fine: that is a fresh handle, and
    /// booting it is the restart. Only an *initialized* cell on a box that is no
    /// longer Running means the VM behind it is dead.
    async fn ensure_booted(&self) -> BoxliteResult<&LiveState> {
        if self.live.initialized() && self.state.read().status != BoxStatus::Running {
            return Err(BoxliteError::Stopped(format!(
                "Box {} is no longer running and this handle is spent — it still holds the \
                 stopped VM, and cannot boot another. Drop it and call runtime.get() for a \
                 fresh one; the runtime hands back the same handle while any reference to it \
                 is alive.",
                self.config.id
            )));
        }

        self.live.get_or_try_init(|| self.init_live_state()).await
    }

    /// Run the container's init exactly once, returning whether *this* call did
    /// it (vs. finding it already running). Booting only creates the container;
    /// this is the separate `Container.Start`. Single-flighted via `OnceCell`, so
    /// the implicit-boot funnel and an explicit `start()` cannot double-run it,
    /// and a box reattached with init already running pre-sets the cell.
    async fn ensure_container_started(&self, live: &LiveState) -> BoxliteResult<bool> {
        // `get_or_try_init` single-flights the closure but hands every concurrent
        // caller the same `Ok`, so it cannot tell the winner from the waiters. A
        // closure-local flag is set only inside the body that actually runs, so
        // exactly one caller reports that it started the container (and a cell
        // already set — e.g. a reattached, still-running box — leaves it false).
        let mut started_here = false;
        self.container_start
            .get_or_try_init(|| async {
                live.guest_session
                    .container()
                    .await?
                    .start(self.container_id())
                    .await?;
                started_here = true;
                Ok::<(), BoxliteError>(())
            })
            .await?;
        Ok(started_here)
    }

    /// The box's network control backend (gvproxy ServicesMux client), owned in
    /// `LiveState` beside `guest_session`. Lazily starts the box like any live
    /// operation. `Unsupported` when the box was created network-disabled.
    ///
    /// The owner accessor; the first caller lands with the outer SDK/CLI layer.
    #[allow(dead_code)]
    pub(crate) async fn network(&self) -> BoxliteResult<&dyn NetworkBackend> {
        self.live_state()
            .await?
            .network
            .as_deref()
            .ok_or_else(|| BoxliteError::Unsupported("box networking is disabled".into()))
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
        use std::sync::Arc;

        let state = self.state.read().clone();
        let is_first_start = state.status == BoxStatus::Configured;
        // Reattaching to a live box: its init is already running, so mark the
        // container-start done up front — `ensure_container_started` must not try
        // to run it a second time.
        let adopting_running = state.status == BoxStatus::Running;

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

        // The box is up. If we adopted one whose init was already running, that
        // init needs no `Container.Start`; recording it now keeps
        // `ensure_container_started` a no-op for this handle.
        if adopting_running {
            let _ = self.container_start.set(());
        }

        // Read PID from file (single source of truth) and update state.
        //
        // The PID file is written by pre_exec hook immediately after fork().
        // This is crash-safe: if we reach this point, the shim is running
        // and the PID file exists.
        //
        // For reattach (status=Running), the PID file was written during
        // the original spawn and is still valid.
        // Only a *fresh boot* (Configured/Stopped → start) gets a health probe.
        // An adopted box — already Running when we reached here — was armed
        // exit-only by the handout that first observed it, so a probe built here
        // would be stranded (the watcher's cell is already taken). Adopted boxes
        // are exit-only by design; see [`BoxWatcher`](super::watcher::BoxWatcher).
        // Gating here also skips a guest fetch whose result we would discard.
        //
        // Fetched before the state lock — the await must not run under it — and
        // before publishing Running below.
        let health_guest =
            if self.config.options.advanced.health_check.is_some() && !adopting_running {
                Some(live_state.guest_session.guest().await?)
            } else {
                None
            };

        {
            // PidFile is the single source of truth for shim identity
            // (PID + optional starttime fingerprint). The starttime is
            // consumed by recovery, not stored in the DB.
            let pid_path = self.layout.pid_file_path();
            let record = crate::util::PidFileReader::at(&pid_path).read()?;
            let pid = record.pid;

            let mut state = self.state.write();
            state.set_pid(Some(pid));
            state.set_status(BoxStatus::Running);
            // This is a fresh run of the box's main command, so the exit code
            // recorded for the previous one no longer describes it (docker
            // clears ExitCode on start too). The guest drops its matching
            // exit file in Container.Init.
            state.exit_code = None;

            // Initialize health status if health check is configured
            if self.config.options.advanced.health_check.is_some() {
                state.init_health_status();
            }

            // Save to DB (cache for queries and recovery)
            self.runtime.box_manager.save_box(&self.config.id, &state)?;

            // Arm the watcher under the *same* lock that publishes Running+pid.
            // A concurrent handout runs `arm_watcher(None)`, which reads the state
            // first: it either sees a not-yet-Running box and skips, or blocks
            // here and finds the watcher already armed. So it can never slip an
            // exit-only watcher in ahead of us and strand the health probe.
            let health = health_guest.map(|guest| {
                super::watcher::HealthProbe::new(
                    guest,
                    self.config
                        .options
                        .advanced
                        .health_check
                        .clone()
                        .expect("guest is fetched only when a health check is configured"),
                    state.health_status,
                )
            });
            self.spawn_watcher_once(pid, health);

            tracing::debug!(
                box_id = %self.config.id,
                pid = pid,
                "Read PID from file and saved to DB"
            );
        }

        // All operations succeeded - disarm the cleanup guard
        cleanup_guard.disarm();

        // Archive any leftover crash artifact from a prior lifecycle so
        // the next attach preflight doesn't trip on stale evidence.
        // Stash (rename → exit.previous) preserves forensic data.
        crate::runtime::rt_impl::stash_exit_file(&self.layout);

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
        Fut: Future<Output = BoxliteResult<R>>,
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

        let result = tokio::time::timeout(Duration::from_secs(5), async {
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

        let result = tokio::time::timeout(Duration::from_secs(5), async {
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

    async fn attach(&self, execution_id: Option<&str>) -> BoxliteResult<Execution> {
        self.attach(execution_id).await
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

#[async_trait::async_trait]
impl crate::runtime::backend::BoxNetworkBackend for BoxImpl {
    async fn tunnel(&self, target: SocketAddr) -> BoxliteResult<BoxTunnel> {
        // Local boxes have no public URL; the tunnel carries a connector that
        // opens the raw stream through the guest-network backend on demand.
        let network = self
            .live_state()
            .await?
            .network
            .clone()
            .ok_or_else(|| BoxliteError::Unsupported("box networking is disabled".into()))?;
        Ok(BoxTunnel::new(
            None,
            Arc::new(move || {
                let network = Arc::clone(&network);
                Box::pin(async move { network.tunnel(target).await })
            }),
        ))
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
        let temp_dir = TempDir::new_in("/tmp").expect("create temp dir");
        let runtime = RuntimeImpl::new(BoxliteOptions {
            home_dir: temp_dir.path().to_path_buf(),
            image_registries: vec![],
        })
        .expect("create runtime");

        // Plain sleep — identity is established by the start-time
        // fingerprint we write into shim.pid below.
        let child = ChildGuard(
            std::process::Command::new("sleep")
                .arg("300")
                .spawn()
                .expect("spawn stand-in process"),
        );
        let pid = child.0.id();

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
            box_home: box_home.clone(),
        };

        let mut state = BoxState::new();
        state.status = BoxStatus::Running;
        state.pid = Some(pid);
        let lock_id = runtime.lock_manager.allocate().expect("allocate lock");
        state.set_lock_id(lock_id);

        std::fs::create_dir_all(&box_home).expect("create box dir");
        let st = crate::util::process_start_time(pid).expect("OS reports start_time");
        let layout = runtime
            .layout
            .box_layout(config.id.as_str(), false)
            .expect("box_layout is infallible");
        let pid_file = layout.pid_file_path();
        std::fs::write(&pid_file, format!("{pid}\n{st}\n")).expect("write pid file");

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
        tokio::time::sleep(Duration::from_millis(200)).await;

        assert!(
            !is_process_alive(pid),
            "stop() must kill the recovered shim process when self.live is None"
        );

        // ChildGuard's Drop reaps the (now-dead) child.
        drop(child);
    }

    /// Set up a Running box backed by a live stand-in process (the fake shim),
    /// with the exit record the guest would have written. `runtime.get()` on it
    /// arms a `BoxWatcher` on the stand-in — exactly the adopt path. Returns the
    /// child (keep it alive), the box id, and the shim pid.
    fn running_box_with_standin(
        runtime: &SharedRuntimeImpl,
        auto_remove: bool,
        exit_code: i32,
    ) -> (ChildGuard, BoxID, u32) {
        let child = ChildGuard(
            std::process::Command::new("sleep")
                .arg("300")
                .spawn()
                .expect("spawn stand-in process"),
        );
        let pid = child.0.id();

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
                auto_remove,
                ..Default::default()
            },
            engine_kind: VmmKind::Libkrun,
            box_home: box_home.clone(),
        };

        let mut state = BoxState::new();
        state.status = BoxStatus::Running;
        state.pid = Some(pid);
        state.set_lock_id(runtime.lock_manager.allocate().expect("allocate lock"));

        std::fs::create_dir_all(&box_home).expect("create box dir");
        let st = crate::util::process_start_time(pid).expect("OS reports start_time");
        let layout = runtime
            .layout
            .box_layout(config.id.as_str(), false)
            .expect("box_layout is infallible");
        std::fs::write(layout.pid_file_path(), format!("{pid}\n{st}\n")).expect("write pid file");

        // The exit record the guest writes on its way down — what on_shim_exit
        // reads for the code.
        let exit_file = layout.container_exit_file(config.container.id.as_str());
        if let Some(parent) = exit_file.parent() {
            std::fs::create_dir_all(parent).expect("create exit-file dir");
        }
        boxlite_shared::layout::ExitRecord { exit_code }
            .write(&exit_file)
            .expect("write exit record");

        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("add box to manager");

        (child, id, pid)
    }

    /// Poll `get_info` until the predicate holds or the deadline passes.
    async fn wait_for_box<F>(runtime: &SharedRuntimeImpl, id: &str, done: F) -> Option<BoxInfo>
    where
        F: Fn(&Option<BoxInfo>) -> bool,
    {
        for _ in 0..40 {
            let info = runtime.get_info(id).await.expect("query box");
            if done(&info) {
                return info;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        runtime.get_info(id).await.expect("query box")
    }

    /// The watcher records `Stopped` + the guest's exit code the moment the shim
    /// dies — the exit-arm of `BoxWatcher`, the single writer of the transition.
    #[tokio::test]
    async fn box_watcher_records_stopped_with_exit_code_when_the_shim_dies() {
        let temp_dir = TempDir::new_in("/tmp").expect("create temp dir");
        let runtime = RuntimeImpl::new(BoxliteOptions {
            home_dir: temp_dir.path().to_path_buf(),
            image_registries: vec![],
        })
        .expect("create runtime");

        let (child, id, pid) = running_box_with_standin(&runtime, false, 7);

        // Handing out a handle arms the watcher (adopt path, health = None).
        let litebox = runtime
            .get(id.as_str())
            .await
            .expect("get box")
            .expect("box exists");

        // The shim dies: the watcher's `wait_for_exit` fires and records the exit.
        assert!(crate::util::kill_process(pid), "kill the stand-in shim");

        let info = wait_for_box(&runtime, id.as_str(), |i| {
            i.as_ref().is_some_and(|i| i.status != BoxStatus::Running)
        })
        .await
        .expect("box still present");

        assert_eq!(
            info.status,
            BoxStatus::Stopped,
            "the watcher must stop the box when its shim dies"
        );
        assert_eq!(
            info.exit_code,
            Some(7),
            "and deliver the exit code the guest recorded, not invent one"
        );

        drop((litebox, child));
    }

    /// An `auto_remove` box is cleaned up by the watcher after its shim dies —
    /// the "other death" tail that used to depend on someone calling `stop()`.
    #[tokio::test]
    async fn box_watcher_auto_removes_the_box_after_its_shim_dies() {
        let temp_dir = TempDir::new_in("/tmp").expect("create temp dir");
        let runtime = RuntimeImpl::new(BoxliteOptions {
            home_dir: temp_dir.path().to_path_buf(),
            image_registries: vec![],
        })
        .expect("create runtime");

        let (child, id, pid) = running_box_with_standin(&runtime, true, 0);

        let litebox = runtime
            .get(id.as_str())
            .await
            .expect("get box")
            .expect("box exists");

        assert!(crate::util::kill_process(pid), "kill the stand-in shim");

        let gone = wait_for_box(&runtime, id.as_str(), |i| i.is_none()).await;
        assert!(
            gone.is_none(),
            "an auto_remove box must be gone after its shim dies, found {gone:?}"
        );

        drop((litebox, child));
    }
}
