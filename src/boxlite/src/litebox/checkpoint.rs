//! Pause and resume for checkpoint-enabled boxes.
//!
//! The VM's real state lives in the shim's snapshot owner. This module asks
//! it over the box's control socket and records only what the owner
//! answered: a cached `Running` may be stale when another host process
//! paused the box, so every operation that needs a running guest asks first.

use super::box_impl::BoxImpl;
use super::state::BoxStatus;
use crate::images::ContainerImageConfig;
use crate::portal::GuestSession;
use crate::util::{PidFileReader, ProcessIdentity};
use crate::vmm::checkpoint::{
    ControlClient, ControlReply, ControlRequest, FailureKind, Outcome, VmRunState,
};
use crate::vmm::controller::{ShimHandler, VmmHandler};
use boxlite_shared::RunningStateResponse;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{Duration, Instant};

pub(crate) mod archive;
mod export;
#[cfg(test)]
pub(crate) mod test_support;

/// How long `stop` waits for a checkpoint box's shim to be gone after
/// signalling it (SIGTERM, then SIGKILL after the handler's own grace).
const SHIM_EXIT_CONFIRM_TIMEOUT: Duration = Duration::from_secs(5);

/// Bound for the guest shutdown RPC that flushes disks before a running
/// checkpoint box stops, matching ordinary boxes.
const GUEST_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);

/// Bound for the guest running-state query around a pause or resume.
const GUEST_STATE_TIMEOUT: Duration = Duration::from_secs(10);

/// The running guest a checkpoint pause cut, recorded so a resume or a
/// reattach can tell it reconnected to that guest and not to a fresh boot of
/// the same container. An import carries it over; a cold start drops it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct GuestIdentity {
    /// The guest agent's per-start random ID.
    pub(crate) boot_id: String,
    pub(crate) container_id: String,
    /// The container init's PID inside the guest.
    pub(crate) init_pid: u32,
}

impl GuestIdentity {
    /// The identity of `container_id`'s guest in a running-state reply.
    pub(crate) fn from_running_state(
        state: &RunningStateResponse,
        container_id: &str,
    ) -> Result<Self, String> {
        if !state.initialized || state.boot_id.is_empty() {
            return Err("the guest agent is not initialized".into());
        }
        let container = state
            .containers
            .iter()
            .find(|container| container.container_id == container_id)
            .ok_or_else(|| format!("the guest has no container {container_id}"))?;
        if container.init_pid == 0 {
            return Err(format!("container {container_id} has no init process"));
        }
        Ok(Self {
            boot_id: state.boot_id.clone(),
            container_id: container_id.to_string(),
            init_pid: container.init_pid,
        })
    }
}

/// Storage an imported box runs from: the copies libkrun handed over at
/// import. Cold starts use these, never an image, the image cache or the
/// source box's files. Pinned for the box's life, unlike [`GuestIdentity`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RestoredStorage {
    /// Disks in guest order: the container rootfs (`/dev/vda`), then the
    /// read-only guest rootfs (`/dev/vdb`).
    pub(crate) disks: Vec<RestoredDisk>,
    /// The copy of the box's `shared/` tree, served as its `shared` share.
    pub(crate) shared_dir: PathBuf,
    /// The container's image config as the source box last booted it.
    pub(crate) container_image_config: ContainerImageConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct RestoredDisk {
    pub(crate) path: PathBuf,
    /// Always RAW: libkrun restores every disk as a raw copy.
    pub(crate) format: crate::vmm::DiskFormat,
    pub(crate) read_only: bool,
}

impl RestoredStorage {
    /// The container rootfs disk.
    pub(crate) fn container_disk(&self) -> BoxliteResult<&RestoredDisk> {
        self.disks
            .first()
            .ok_or_else(|| BoxliteError::Internal("restored storage has no container disk".into()))
    }

    /// The guest rootfs disk.
    pub(crate) fn guest_disk(&self) -> BoxliteResult<&RestoredDisk> {
        self.disks.get(1).ok_or_else(|| {
            BoxliteError::Internal("restored storage has no guest rootfs disk".into())
        })
    }
}

/// Options for [`LiteBox::pause`](super::LiteBox::pause).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PauseOptions {
    /// The caller stopped every host process that writes the box's external
    /// shared directories (volumes and mounts) and keeps them stopped until
    /// the box resumes or stops.
    ///
    /// Required when the box has such a directory. Pausing stops the guest,
    /// not the host: a writer left running would change a share under a
    /// paused guest and tear any checkpoint taken from it. Directories the
    /// box owns itself are coordinated by the runtime.
    pub host_writers_stopped: bool,
}

/// Ask the owner for its state; `Err` when it gave no answer, so the state
/// is unknown.
async fn query_state(control: &ControlClient) -> Result<ControlReply, String> {
    let reply = control
        .send(&ControlRequest::State)
        .await
        .map_err(|e| e.to_string())?;
    match &reply.error {
        None => Ok(reply),
        Some(failure) => Err(failure.message.clone()),
    }
}

/// The guest's running state, bounded so an unresponsive guest fails the
/// caller instead of holding it.
async fn guest_running_state(session: &GuestSession) -> BoxliteResult<RunningStateResponse> {
    tokio::time::timeout(GUEST_STATE_TIMEOUT, async {
        session.guest().await?.running_state().await
    })
    .await
    .map_err(|_| {
        BoxliteError::Engine(format!(
            "the guest did not report its state within {}s",
            GUEST_STATE_TIMEOUT.as_secs()
        ))
    })?
}

/// The owner's mutation count when it reports the guest running with no
/// pause, resume or export under way; `None` otherwise or when unknown.
///
/// Asks the owner, so a box paused by another host process is never mistaken
/// for a running one. Two equal counts mean the guest ran unpaused between
/// the two queries.
pub(crate) async fn running_since(control: &ControlClient) -> Option<u64> {
    let reply = query_state(control).await.ok()?;
    (reply.state == VmRunState::Running && reply.in_flight.is_none()).then_some(reply.mutations)
}

fn paused_error(op: &str) -> BoxliteError {
    BoxliteError::InvalidState(format!("Cannot {op}: the box is paused. Resume it first."))
}

fn failure_error(op: &str, kind: FailureKind, message: String) -> BoxliteError {
    let message = format!("{op}: {message}");
    match kind {
        FailureKind::Busy | FailureKind::Rejected => BoxliteError::InvalidState(message),
        FailureKind::Io => BoxliteError::Storage(message),
        FailureKind::Failed => BoxliteError::Engine(message),
    }
}

impl BoxImpl {
    pub(crate) fn checkpoint_enabled(&self) -> bool {
        self.config.options.advanced.checkpoint_enabled
    }

    pub(crate) fn checkpoint_control(&self) -> ControlClient {
        ControlClient::new(self.layout.control_socket_path())
    }

    /// Refuse a disk-only snapshot, clone or export: a checkpoint-enabled
    /// box's guest state belongs with its disks, and those operations would
    /// also SIGSTOP and freeze a VM the snapshot owner controls.
    pub(crate) fn refuse_for_checkpoint(&self, op: &str) -> BoxliteResult<()> {
        if self.checkpoint_enabled() {
            return Err(BoxliteError::Unsupported(format!(
                "{op} is not supported for a checkpoint-enabled box"
            )));
        }
        Ok(())
    }

    /// Whether the box shares directories that processes outside it can
    /// write: bind-mounted host paths, and managed volumes, which other boxes
    /// and the volume's own backend can write too.
    fn has_external_shares(&self) -> bool {
        let options = &self.config.options;
        !options.volumes.is_empty() || !options.mounts.is_empty()
    }

    fn require_checkpoint(&self, op: &str) -> BoxliteResult<()> {
        if !self.checkpoint_enabled() {
            return Err(BoxliteError::Unsupported(format!(
                "{op} needs a box created with advanced.checkpoint_enabled"
            )));
        }
        let status = self.state.read().status;
        if !status.is_active() {
            return Err(BoxliteError::InvalidState(format!(
                "Cannot {op} box {}: it is {status}",
                self.config.id
            )));
        }
        Ok(())
    }

    /// Stop the guest's vCPUs and devices at one consistent cut.
    ///
    /// Not SIGSTOP and no guest filesystem freeze. Concurrent pause/resume
    /// calls are serialized; another host process's in-flight operation makes
    /// this one fail without effect.
    pub(crate) async fn pause(
        &self,
        options: super::checkpoint::PauseOptions,
    ) -> BoxliteResult<()> {
        let _serial = self.checkpoint_ops.lock().await;
        self.require_checkpoint("pause")?;
        if self.has_external_shares() && !options.host_writers_stopped {
            return Err(BoxliteError::InvalidArgument(format!(
                "box {} shares host directories; stop every host writer of them, then pause \
                 with host_writers_stopped=true",
                self.config.id
            )));
        }
        // Record which guest this pause cuts, so a resume or an import can
        // tell it reconnected to the same one. Asked only of a guest the
        // owner reports running: a paused guest would never answer.
        let reply = query_state(&self.checkpoint_control())
            .await
            .map_err(|message| BoxliteError::Engine(format!("pause: {message}")))?;
        if reply.state != VmRunState::Running || reply.in_flight.is_some() {
            return Err(BoxliteError::InvalidState(format!(
                "Cannot pause box {}: its VM is {}{}",
                self.config.id,
                reply.state,
                reply
                    .in_flight
                    .map(|op| format!(" with a {op} in progress"))
                    .unwrap_or_default()
            )));
        }
        let identity = self.guest_identity().await?;
        self.record_guest_identity(Some(identity))?;
        // Every box also shares directories it owns: its `shared/` tree and
        // the VM-owned boot root. The host writes `shared/` only in the boot
        // pipeline, before the VM starts, and a paused box refuses that
        // pipeline until it resumes (`ensure_guest_running`). A writable
        // single-file volume is linked into `shared/`, but it is a volume, so
        // the caller vouched for it above. Every host writer is therefore
        // stopped, which libkrun needs declared before it exports shares.
        let outcome = {
            // Network and SSH changes must not land half-way through a pause.
            let _network = self.network_updates.lock().await;
            self.checkpoint_request(&ControlRequest::Pause {
                host_writers_stopped: true,
            })
            .await
        };
        self.settle("pause", outcome).await.map(drop)
    }

    /// Let a paused guest run again, then reconnect to it and check it is
    /// the guest the pause cut before anything uses it. A guest that is not
    /// is stopped.
    pub(crate) async fn resume(&self) -> BoxliteResult<()> {
        let _serial = self.checkpoint_ops.lock().await;
        self.require_checkpoint("resume")?;
        let outcome = {
            let _network = self.network_updates.lock().await;
            self.checkpoint_request(&ControlRequest::Resume).await
        };
        self.settle("resume", outcome).await?;
        let reconnected = async {
            let live = self.ensure_booted().await?;
            self.check_guest_identity(live.guest_session()).await
        };
        if let Err(error) = reconnected.await {
            tracing::error!(box_id = %self.config.id, %error, "Resumed guest failed its identity check; stopping it");
            let stopped = self.stop().await;
            return Err(BoxliteError::Engine(format!(
                "resume: {error}; {}",
                match stopped {
                    Ok(()) => "the VM was stopped".to_string(),
                    Err(e) => format!("stopping the VM also failed: {e}"),
                }
            )));
        }
        Ok(())
    }

    /// Ask the running guest who it is, over this lifecycle's session or a
    /// new lazy one on the box's socket. Never boots or reattaches anything.
    async fn guest_identity(&self) -> BoxliteResult<GuestIdentity> {
        let session = match self.live_state_if_booted() {
            Some(live) => live.guest_session().clone(),
            None => GuestSession::new(self.config.transport()),
        };
        let state = guest_running_state(&session).await?;
        GuestIdentity::from_running_state(&state, self.container_id())
            .map_err(|why| BoxliteError::InvalidState(format!("Cannot pause: {why}")))
    }

    /// Persist the identity a pause recorded, or forget it on a cold start.
    pub(crate) fn record_guest_identity(
        &self,
        identity: Option<GuestIdentity>,
    ) -> BoxliteResult<()> {
        let snapshot = {
            let mut state = self.state.write();
            state.checkpoint_guest = identity;
            state.clone()
        };
        self.runtime
            .box_manager
            .save_box(&self.config.id, &snapshot)
    }

    /// Fail unless `session` reaches the guest a checkpoint pause recorded:
    /// same agent boot, same container, same init process. A box with no
    /// record (never paused since its cold start) passes. The record is read
    /// from the database: another process may have taken the pause.
    pub(crate) async fn check_guest_identity(&self, session: &GuestSession) -> BoxliteResult<()> {
        let persisted = self.runtime.box_manager.update_box(&self.config.id)?;
        let Some(expected) = persisted.checkpoint_guest else {
            return Ok(());
        };
        let state = guest_running_state(session).await?;
        let found = GuestIdentity::from_running_state(&state, &expected.container_id)
            .map_err(|why| BoxliteError::Engine(format!("guest identity check: {why}")))?;
        if found != expected {
            return Err(BoxliteError::Engine(format!(
                "box {} reached a different guest than the one paused (expected {expected:?}, found {found:?})",
                self.config.id
            )));
        }
        Ok(())
    }

    async fn checkpoint_request(&self, request: &ControlRequest) -> Outcome {
        Outcome::from_result(self.checkpoint_control().send(request).await)
    }

    /// Turn a control outcome into the caller's result, recording only what
    /// the owner reported. An uncertain outcome stops the VM: neither the
    /// guest's state nor a half-written export can be trusted, and the
    /// request is never repeated.
    async fn settle(&self, op: &str, outcome: Outcome) -> BoxliteResult<VmRunState> {
        match outcome {
            Outcome::Done(state) => {
                self.record_checkpoint_state(state);
                Ok(state)
            }
            Outcome::Refused { state, failure } => {
                self.record_checkpoint_state(state);
                Err(failure_error(op, failure.kind, failure.message))
            }
            Outcome::Unavailable(message) => Err(BoxliteError::Engine(format!("{op}: {message}"))),
            Outcome::Uncertain(message) => {
                tracing::error!(
                    box_id = %self.config.id,
                    op,
                    error = %message,
                    "Checkpoint control outcome unknown; stopping the VM"
                );
                let stopped = self.stop().await;
                Err(BoxliteError::Engine(format!(
                    "{op}: outcome unknown ({message}); {}",
                    match stopped {
                        Ok(()) => "the VM was stopped".to_string(),
                        Err(e) => format!("stopping the VM also failed: {e}"),
                    }
                )))
            }
        }
    }

    /// Record a running/paused state the owner reported. Terminal states are
    /// left to the watcher and `stop`, which see the shim end.
    fn record_checkpoint_state(&self, state: VmRunState) {
        let status = match state {
            VmRunState::Running => BoxStatus::Running,
            VmRunState::Paused => BoxStatus::Paused,
            _ => return,
        };
        let snapshot = {
            let mut current = self.state.write();
            if current.status == status || !current.status.is_active() {
                return;
            }
            current.force_status(status);
            current.clone()
        };
        if snapshot.lock_id.is_some()
            && let Err(e) = self
                .runtime
                .box_manager
                .save_box(&self.config.id, &snapshot)
        {
            tracing::error!(box_id = %self.config.id, error = %e, "Failed to persist checkpoint state");
        }
    }

    /// Refuse to use a checkpoint box's guest unless its owner says it runs.
    ///
    /// Called from the boot funnel, so exec, attach, copies, metrics, SSH,
    /// network control and implicit start all follow the owner, not a cached
    /// status: a box paused or resumed by another host process is seen as it
    /// is. Asking never resumes anything. When the owner gives no answer the
    /// guest's state is unknown, so the box is not used and not rebooted.
    pub(crate) async fn ensure_guest_running(&self) -> BoxliteResult<()> {
        if !self.checkpoint_enabled() {
            return Ok(());
        }
        // A cached stopped status can predate a VM started by another
        // process. A live shim's owner, not the cache, decides, so the cold
        // pipeline never runs over it.
        if !self.state.read().status.is_active() {
            return self.adopt_live_checkpoint_vm().await;
        }
        let reply = query_state(&self.checkpoint_control())
            .await
            .map_err(|message| {
                BoxliteError::Engine(format!(
                    "Cannot confirm that box {}'s VM is running: {message}",
                    self.config.id
                ))
            })?;
        if let Some(operation) = reply.in_flight {
            return Err(BoxliteError::InvalidState(format!(
                "Cannot use the box: a {operation} is in progress"
            )));
        }
        match reply.state {
            VmRunState::Running => {
                self.record_checkpoint_state(VmRunState::Running);
                Ok(())
            }
            VmRunState::Paused => {
                self.record_checkpoint_state(VmRunState::Paused);
                Err(paused_error("use the box"))
            }
            state => Err(BoxliteError::InvalidState(format!(
                "Cannot use the box: its VM is {state}"
            ))),
        }
    }

    /// Before a cold start: follow a live shim the cached status missed. No
    /// shim means the cold start may go ahead. A running VM is adopted (the
    /// caller then reattaches); anything else is refused without spawning a
    /// second shim or touching `shared/`.
    async fn adopt_live_checkpoint_vm(&self) -> BoxliteResult<()> {
        let pid = match PidFileReader::at(self.layout.pid_file_path()).process_identity() {
            ProcessIdentity::Verified(pid) | ProcessIdentity::Legacy(pid) => pid,
            ProcessIdentity::Absent => return Ok(()),
        };
        let live_elsewhere = |what: String| {
            BoxliteError::InvalidState(format!(
                "box {} has a live VM (shim pid {pid}) {what}",
                self.config.id
            ))
        };
        if self.live_state_if_booted().is_some() {
            return Err(BoxliteError::Stopped(format!(
                "this handle of box {} is spent and its VM was started elsewhere; call \
                 runtime.get() for a fresh one",
                self.config.id
            )));
        }
        let reply = query_state(&self.checkpoint_control())
            .await
            .map_err(|message| live_elsewhere(format!("whose state is unknown: {message}")))?;
        if let Some(operation) = reply.in_flight {
            return Err(live_elsewhere(format!("with a {operation} in progress")));
        }
        let status = match reply.state {
            VmRunState::Running => BoxStatus::Running,
            VmRunState::Paused => BoxStatus::Paused,
            state => return Err(live_elsewhere(format!("that is {state}"))),
        };
        let snapshot = {
            let mut state = self.state.write();
            state.adopt_recovered_shim(pid);
            state.force_status(status);
            state.clone()
        };
        self.runtime
            .box_manager
            .save_box(&self.config.id, &snapshot)?;
        match status {
            BoxStatus::Paused => Err(paused_error("use the box")),
            _ => Ok(()),
        }
    }

    /// Stop a checkpoint box's VM and confirm its shim is gone.
    ///
    /// A running guest first gets the usual shutdown RPC so its disks flush.
    /// SIGTERM then makes the shim stop the owner without a guest RPC (bounded:
    /// the owner queues stop behind an in-flight export), and the handler
    /// follows with SIGKILL.
    pub(crate) async fn stop_checkpoint_vm(&self) -> BoxliteResult<()> {
        let running = running_since(&self.checkpoint_control()).await.is_some();
        if running && let Some(live) = self.live_state_if_booted() {
            let guest_shutdown = async {
                if let Ok(mut guest) = live.guest_session().guest().await {
                    let _ = guest.shutdown().await;
                }
            };
            if tokio::time::timeout(GUEST_SHUTDOWN_TIMEOUT, guest_shutdown)
                .await
                .is_err()
            {
                tracing::warn!(box_id = %self.config.id, "Guest shutdown timed out");
            }
        }

        let pid = match PidFileReader::at(self.layout.pid_file_path()).process_identity() {
            ProcessIdentity::Verified(pid) | ProcessIdentity::Legacy(pid) => pid,
            ProcessIdentity::Absent => return Ok(()),
        };
        match self.live_state_if_booted() {
            Some(live) => live.stop_handler()?,
            None => ShimHandler::from_pid(pid, self.config.id.clone()).stop()?,
        }

        let deadline = Instant::now() + SHIM_EXIT_CONFIRM_TIMEOUT;
        while crate::util::is_process_alive(pid) {
            if Instant::now() >= deadline {
                return Err(BoxliteError::Engine(format!(
                    "box {} shim (pid {pid}) is still alive after stop",
                    self.config.id
                )));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::litebox::checkpoint::test_support::{FakeGuest, image_for, layout_for, serve_guest};
    use crate::litebox::config::{BoxConfig, ContainerRuntimeConfig};
    use crate::runtime::id::{BoxID, BoxIDMint};
    use crate::runtime::options::{
        BoxOptions, BoxliteOptions, CloneOptions, ExportOptions, RootfsSpec, SnapshotOptions,
        VolumeSpec,
    };
    use crate::runtime::rt_impl::{RuntimeImpl, SharedRuntimeImpl};
    use crate::runtime::types::{BoxState, ContainerID};
    use crate::util::{PidFileWriter, PidRecord, ShimPidRecord, is_process_alive};
    use crate::vmm::VmmKind;
    use crate::vmm::checkpoint::fake::{self, FakeOwner};
    use crate::{BoxCommand, LiteBox};
    use chrono::Utc;
    use std::sync::Arc;
    use tempfile::TempDir;

    struct ChildGuard(std::process::Child);

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    /// A checkpoint-enabled box in `status`, its shim a stand-in process, its
    /// control socket served by `owner` (or left unbound) and its guest
    /// socket by a fake guest agent.
    struct Fixture {
        _home: TempDir,
        runtime: SharedRuntimeImpl,
        id: BoxID,
        pid: u32,
        _shim: ChildGuard,
        socket: std::path::PathBuf,
        guest: Arc<FakeGuest>,
        layout: crate::runtime::layout::BoxFilesystemLayout,
    }

    impl Fixture {
        fn new(status: BoxStatus, options: BoxOptions, owner: Option<Arc<FakeOwner>>) -> Self {
            Self::with_state(status, options, owner, |_| {})
        }

        fn with_state(
            status: BoxStatus,
            options: BoxOptions,
            owner: Option<Arc<FakeOwner>>,
            configure: impl FnOnce(&mut BoxState),
        ) -> Self {
            let home = TempDir::new_in("/tmp").expect("temp home");
            let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
                home_dir: home.path().to_path_buf(),
                image_registries: vec![],
                ..Default::default()
            })
            .expect("runtime");
            let shim = ChildGuard(
                std::process::Command::new("sleep")
                    .arg("300")
                    .spawn()
                    .expect("stand-in shim"),
            );
            let pid = shim.0.id();

            let id = BoxIDMint::mint();
            let mut options = options;
            options.advanced.checkpoint_enabled = true;
            options.rootfs = RootfsSpec::Image("alpine:latest".into());
            options.auto_delete = Some(0);
            let config = BoxConfig {
                id: id.clone(),
                name: None,
                created_at: Utc::now(),
                container: ContainerRuntimeConfig {
                    id: ContainerID::new(),
                },
                options,
                engine_kind: VmmKind::Libkrun,
                box_home: runtime.layout.boxes_dir().join(id.as_str()),
            };
            let mut state = BoxState::new();
            state.status = status;
            state.pid = Some(pid);
            state.set_lock_id(runtime.lock_manager.allocate().expect("lock"));
            configure(&mut state);

            let layout = runtime.layout.box_layout(id.as_str(), false).unwrap();
            std::fs::create_dir_all(layout.sockets_dir()).unwrap();
            layout.sockets().ensure().unwrap();
            let start_time = crate::util::process_start_time(pid).expect("start time");
            PidFileWriter::at(&layout.pid_file_path())
                .unwrap()
                .write_shim(&ShimPidRecord::with_runtime_port_control(PidRecord {
                    pid,
                    start_time: Some(start_time),
                }))
                .unwrap();
            let socket = layout.control_socket_path();
            if let Some(owner) = owner {
                fake::serve(&socket, &layout.prepare_checkpoint_dir().unwrap(), owner);
            }
            let guest = FakeGuest::new(config.container.id.as_str());
            serve_guest(&layout.socket_path(), guest.clone());
            runtime.box_manager.add_box(&config, &state).unwrap();
            Self {
                _home: home,
                runtime,
                id,
                pid,
                _shim: shim,
                socket,
                guest,
                layout,
            }
        }

        fn state(&self) -> BoxState {
            self.runtime.box_manager.update_box(&self.id).unwrap()
        }

        async fn litebox(&self) -> LiteBox {
            self.runtime
                .get(self.id.as_str())
                .await
                .unwrap()
                .expect("box exists")
        }

        async fn status(&self) -> BoxStatus {
            self.runtime
                .get_info(self.id.as_str())
                .await
                .unwrap()
                .expect("box exists")
                .status
        }

        fn persisted(&self) -> BoxStatus {
            self.runtime
                .box_manager
                .update_box(&self.id)
                .unwrap()
                .status
        }
    }

    // Resuming reattaches through the boot pipeline, which refuses
    // checkpoint options off Linux x86_64.
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_pause_and_resume_record_the_owner_state_and_paused_boxes_refuse_guest_use()
    {
        let owner = FakeOwner::new(VmRunState::Running);
        let fx = Fixture::new(
            BoxStatus::Running,
            BoxOptions::default(),
            Some(owner.clone()),
        );
        let litebox = fx.litebox().await;

        litebox.pause(PauseOptions::default()).await.unwrap();
        assert_eq!(fx.status().await, BoxStatus::Paused);
        assert_eq!(fx.persisted(), BoxStatus::Paused);

        let err = litebox
            .exec(BoxCommand::new("true"))
            .await
            .err()
            .expect("exec on a paused box");
        assert!(matches!(err, BoxliteError::InvalidState(_)), "{err}");
        // Explicit start must not resume or re-run anything either.
        assert!(matches!(
            litebox.start().await,
            Err(BoxliteError::InvalidState(_))
        ));

        litebox.resume().await.unwrap();
        assert_eq!(fx.persisted(), BoxStatus::Running);
        assert_eq!(owner.calls(), ["pause(true)", "resume"]);
        assert!(is_process_alive(fx.pid));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_pause_declares_the_runtime_owned_shares_so_an_export_can_succeed() {
        // Every box shares its own `shared/` tree and boot root, and libkrun
        // refuses to export shares whose host writers were not declared stopped.
        let owner = FakeOwner::new(VmRunState::Running).with_shares();
        let fx = Fixture::new(
            BoxStatus::Running,
            BoxOptions::default(),
            Some(owner.clone()),
        );
        fx.litebox()
            .await
            .pause(PauseOptions::default())
            .await
            .unwrap();
        let export = ControlClient::new(&fx.socket)
            .send(&ControlRequest::ExportRaw {
                name: "vm.img".into(),
            })
            .await;
        assert_eq!(
            Outcome::from_result(export),
            Outcome::Done(VmRunState::Paused)
        );
        assert_eq!(owner.calls()[0], "pause(true)");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_pause_with_host_volumes_needs_the_writer_assertion() {
        // Bind mounts and managed volumes alike: a managed volume can have
        // writers outside this box.
        for volume in [
            VolumeSpec::bind_mount("/srv/data", "/data"),
            VolumeSpec::managed_volume("my-data", "/data"),
        ] {
            let owner = FakeOwner::new(VmRunState::Running);
            let options = BoxOptions {
                volumes: vec![volume.clone()],
                ..Default::default()
            };
            let fx = Fixture::new(BoxStatus::Running, options, Some(owner.clone()));
            let litebox = fx.litebox().await;

            let err = litebox.pause(PauseOptions::default()).await.unwrap_err();
            assert!(
                matches!(err, BoxliteError::InvalidArgument(_)),
                "{volume:?}: {err}"
            );
            assert!(owner.calls().is_empty(), "nothing reached the owner");
            assert_eq!(fx.persisted(), BoxStatus::Running);

            litebox
                .pause(PauseOptions {
                    host_writers_stopped: true,
                })
                .await
                .unwrap();
            assert_eq!(owner.calls(), ["pause(true)"]);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_stale_paused_status_follows_an_owner_resumed_elsewhere_without_resuming() {
        // Another host process resumed the box; this one still caches Paused.
        let owner = FakeOwner::new(VmRunState::Running);
        let fx = Fixture::new(
            BoxStatus::Paused,
            BoxOptions::default(),
            Some(owner.clone()),
        );
        let bx = fx.litebox().await.local_backend("test").unwrap();

        bx.ensure_guest_running().await.unwrap();
        assert_eq!(fx.persisted(), BoxStatus::Running);
        assert!(owner.calls().is_empty(), "a state query never resumes");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_guest_use_fails_closed_when_the_owner_cannot_confirm_a_running_guest() {
        // No owner answers: the guest's state is unknown.
        for status in [BoxStatus::Running, BoxStatus::Paused] {
            let fx = Fixture::new(status, BoxOptions::default(), None);
            let bx = fx.litebox().await.local_backend("test").unwrap();
            let err = bx.ensure_guest_running().await.unwrap_err();
            assert!(matches!(err, BoxliteError::Engine(_)), "{status}: {err}");
            assert_eq!(fx.persisted(), status);
        }

        // The owner reports running, but a pause is under way.
        let owner = FakeOwner::new(VmRunState::Running);
        let fx = Fixture::new(
            BoxStatus::Running,
            BoxOptions::default(),
            Some(owner.clone()),
        );
        let (entered, release) = owner.hold();
        let pausing = {
            let client = ControlClient::new(&fx.socket);
            tokio::spawn(async move {
                client
                    .send(&ControlRequest::Pause {
                        host_writers_stopped: true,
                    })
                    .await
            })
        };
        tokio::task::spawn_blocking(move || entered.recv().unwrap())
            .await
            .unwrap();
        let bx = fx.litebox().await.local_backend("test").unwrap();
        let err = bx.ensure_guest_running().await.unwrap_err();
        assert!(matches!(err, BoxliteError::InvalidState(_)), "{err}");
        release.send(()).unwrap();
        pausing.await.unwrap().unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_stale_running_status_follows_the_owner_instead_of_reattaching() {
        // Another host process paused the box; this one still caches Running.
        let owner = FakeOwner::new(VmRunState::Paused);
        let fx = Fixture::new(
            BoxStatus::Running,
            BoxOptions::default(),
            Some(owner.clone()),
        );
        let litebox = fx.litebox().await;

        let err = litebox
            .exec(BoxCommand::new("true"))
            .await
            .err()
            .expect("exec on a box paused elsewhere");
        assert!(err.to_string().contains("paused"), "{err}");
        assert_eq!(fx.persisted(), BoxStatus::Paused);
        assert!(owner.calls().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_stop_while_paused_ends_the_shim_without_a_guest_rpc() {
        let owner = FakeOwner::new(VmRunState::Paused);
        let fx = Fixture::new(BoxStatus::Paused, BoxOptions::default(), Some(owner));
        let litebox = fx.litebox().await;

        let started = Instant::now();
        litebox.stop().await.unwrap();
        // A guest RPC against the paused guest would have waited out its 10s.
        assert!(
            started.elapsed() < Duration::from_secs(8),
            "{:?}",
            started.elapsed()
        );
        assert!(!is_process_alive(fx.pid), "the shim must be gone");
        assert_eq!(fx.persisted(), BoxStatus::Stopped);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_uncertain_control_stops_the_vm_and_busy_does_not() {
        // Busy: another caller's export holds the owner; this resume is a
        // certain no-op and the VM keeps running.
        let owner = FakeOwner::new(VmRunState::Paused);
        let fx = Fixture::new(
            BoxStatus::Paused,
            BoxOptions::default(),
            Some(owner.clone()),
        );
        let (entered, release) = owner.hold();
        let exporter = {
            let client = ControlClient::new(&fx.socket);
            tokio::spawn(async move {
                client
                    .send(&ControlRequest::ExportRaw {
                        name: "vm.img".into(),
                    })
                    .await
            })
        };
        tokio::task::spawn_blocking(move || entered.recv().unwrap())
            .await
            .unwrap();
        let err = fx.litebox().await.resume().await.unwrap_err();
        assert!(matches!(err, BoxliteError::InvalidState(_)), "{err}");
        assert!(is_process_alive(fx.pid), "Busy must not stop the VM");
        assert_eq!(fx.persisted(), BoxStatus::Paused);
        release.send(()).unwrap();
        exporter.await.unwrap().unwrap();

        // Uncertain: the peer takes the request and hangs up without a reply.
        let fx = Fixture::new(BoxStatus::Running, BoxOptions::default(), None);
        let listener = std::os::unix::net::UnixListener::bind(&fx.socket).unwrap();
        let peer = std::thread::spawn(move || {
            // The pause's opening state query is answered; every later
            // request is read and dropped, including the stop path's query.
            for (i, stream) in listener.incoming().take(3).enumerate() {
                let stream = stream.unwrap();
                let mut reader = std::io::BufReader::new(&stream);
                let _: ControlRequest =
                    crate::vmm::checkpoint::protocol::read_line(&mut reader).unwrap();
                if i == 0 {
                    let reply = ControlReply {
                        state: VmRunState::Running,
                        in_flight: None,
                        mutations: 0,
                        error: None,
                        share: None,
                    };
                    crate::vmm::checkpoint::protocol::write_line(&mut &stream, &reply).unwrap();
                }
            }
        });
        let err = fx
            .litebox()
            .await
            .pause(PauseOptions::default())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("outcome unknown"), "{err}");
        assert!(!is_process_alive(fx.pid), "an uncertain pause stops the VM");
        assert_eq!(fx.persisted(), BoxStatus::Stopped);
        peer.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_boxes_refuse_disk_snapshot_clone_and_export() {
        let fx = Fixture::new(BoxStatus::Stopped, BoxOptions::default(), None);
        let litebox = fx.litebox().await;
        let unsupported = |result: BoxliteResult<()>| {
            assert!(
                matches!(result, Err(BoxliteError::Unsupported(_))),
                "{result:?}"
            );
        };
        unsupported(
            litebox
                .snapshots()
                .create(SnapshotOptions::default(), "snap")
                .await
                .map(drop),
        );
        unsupported(litebox.snapshots().restore("snap").await);
        unsupported(
            litebox
                .clone_box(CloneOptions::default(), None)
                .await
                .map(drop),
        );
        unsupported(
            litebox
                .export(ExportOptions::default(), fx._home.path())
                .await
                .map(drop),
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_health_probe_runs_only_while_the_owner_reports_running() {
        let owner = FakeOwner::new(VmRunState::Running);
        let fx = Fixture::new(
            BoxStatus::Running,
            BoxOptions::default(),
            Some(owner.clone()),
        );
        let control = ControlClient::new(&fx.socket);
        assert!(running_since(&control).await.is_some());
        owner.set(VmRunState::Paused);
        assert!(running_since(&control).await.is_none());
        owner.set(VmRunState::Starting);
        assert!(running_since(&control).await.is_none());
        let gone = ControlClient::new(fx._home.path().join("none.sock"));
        assert!(running_since(&gone).await.is_none());
    }

    /// The storage an imported box runs from, so an export reads the boot
    /// config it recorded instead of an image.
    fn restored(state: &mut BoxState) {
        state.restored_storage = Some(RestoredStorage {
            disks: Vec::new(),
            shared_dir: std::path::PathBuf::from("/nonexistent/shared"),
            container_image_config: ContainerImageConfig::default(),
        });
    }

    /// A box with one volume, paused through the API, whose owner exports
    /// `image`.
    async fn paused_for_export(image: Option<Vec<u8>>) -> (Fixture, Arc<FakeOwner>, LiteBox) {
        let options = BoxOptions {
            volumes: vec![VolumeSpec::bind_mount("/srv/source-host-data", "/data")],
            ..Default::default()
        };
        let owner = FakeOwner::new(VmRunState::Running).with_shares();
        *owner.export_image.lock().unwrap() =
            image.or_else(|| Some(image_for(&layout_for(&options))));
        let fx = Fixture::with_state(BoxStatus::Running, options, Some(owner.clone()), restored);
        let litebox = fx.litebox().await;
        litebox
            .pause(PauseOptions {
                host_writers_stopped: true,
            })
            .await
            .unwrap();
        (fx, owner, litebox)
    }

    fn entries(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .map(|read| read.map(|entry| entry.unwrap().path()).collect())
            .unwrap_or_default();
        entries.sort();
        entries
    }

    // Resuming reattaches through the boot pipeline, which refuses
    // checkpoint options off Linux x86_64.
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_pause_records_the_guest_and_resume_refuses_another_one() {
        let owner = FakeOwner::new(VmRunState::Running);
        let fx = Fixture::new(BoxStatus::Running, BoxOptions::default(), Some(owner));
        let litebox = fx.litebox().await;
        litebox.pause(PauseOptions::default()).await.unwrap();
        assert_eq!(fx.state().checkpoint_guest, Some(fx.guest.identity()));

        // The same container ID behind a fresh agent boot is not the guest
        // the pause cut.
        *fx.guest.boot_id.lock().unwrap() = "boot-2".into();
        let error = litebox.resume().await.unwrap_err();
        assert!(error.to_string().contains("different guest"), "{error}");
        assert!(!is_process_alive(fx.pid), "the VM must be stopped");
        assert_eq!(fx.persisted(), BoxStatus::Stopped);
        assert!(!fx.guest.called("Container.Start"));
    }

    // Resuming reattaches through the boot pipeline, which refuses
    // checkpoint options off Linux x86_64.
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_reattach_checks_the_guest_the_pause_cut() {
        // Another process paused and resumed this box; this one reattaches.
        let owner = FakeOwner::new(VmRunState::Running);
        let fx = Fixture::with_state(
            BoxStatus::Running,
            BoxOptions::default(),
            Some(owner),
            |state| {
                state.checkpoint_guest = Some(GuestIdentity {
                    boot_id: "an-earlier-boot".into(),
                    container_id: String::new(),
                    init_pid: 1,
                })
            },
        );
        let bx = fx.litebox().await.local_backend("test").unwrap();
        let error = bx.ensure_booted().await.err().expect("another guest");
        assert!(error.to_string().contains("guest"), "{error}");
        assert!(!is_process_alive(fx.pid), "the VM must be stopped");
        assert!(!fx.guest.called("Container.Start"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_export_publishes_one_file_and_keeps_the_box_paused() {
        let (fx, owner, litebox) = paused_for_export(None).await;
        let out = fx._home.path().join("out");
        std::fs::create_dir(&out).unwrap();
        let dest = out.join("box.ckpt");
        litebox.export_checkpoint(&dest).await.unwrap();

        let (manifest, _) = archive::read(&dest, &fx._home.path().join("staged")).unwrap();
        assert_eq!(manifest.guest, fx.guest.identity());
        assert_eq!(manifest.source_box_id, fx.id.as_str());
        manifest.layout.check_for(&manifest.boot.options).unwrap();
        // The volume's contents travel; its source host path does not.
        assert_eq!(manifest.boot.options.volumes[0].guest_path, "/data");
        assert!(manifest.boot.options.volumes[0].host_path.is_empty());
        assert!(
            !String::from_utf8_lossy(&std::fs::read(&dest).unwrap()).contains("source-host-data")
        );
        assert_eq!(
            entries(&out),
            std::slice::from_ref(&dest),
            "no temporary left"
        );
        assert!(
            entries(&fx.layout.checkpoint_dir()).is_empty(),
            "raw image removed"
        );
        assert_eq!(fx.persisted(), BoxStatus::Paused);
        assert_eq!(fx.status().await, BoxStatus::Paused);
        assert_eq!(
            crate::vmm::checkpoint::CheckpointOwner::state(&*owner),
            VmRunState::Paused
        );
        let calls = owner.calls();
        assert_eq!(calls.len(), 2, "{calls:?}");
        assert!(calls[1].starts_with("export("), "{calls:?}");
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_export_failures_keep_the_box_paused_and_leave_no_file() {
        // The owner's export fails: still paused, nothing published.
        let (fx, owner, litebox) = paused_for_export(None).await;
        *owner.export_error.lock().unwrap() = Some(crate::vmm::checkpoint::OwnerError::new(
            FailureKind::Io,
            "disk full",
        ));
        let dest = fx._home.path().join("box.ckpt");
        let error = litebox.export_checkpoint(&dest).await.unwrap_err();
        assert!(matches!(error, BoxliteError::Storage(_)), "{error}");
        assert!(!dest.exists());
        assert_eq!(fx.persisted(), BoxStatus::Paused);
        assert!(is_process_alive(fx.pid));

        // The raw image does not show the box's devices: refused on the
        // host, still paused, nothing left behind.
        let mut wrong = layout_for(&BoxOptions {
            volumes: vec![VolumeSpec::bind_mount("/srv/source-host-data", "/data")],
            ..Default::default()
        });
        wrong.disks.pop();
        let (fx, _, litebox) = paused_for_export(Some(image_for(&wrong))).await;
        let dest = fx._home.path().join("box.ckpt");
        let error = litebox.export_checkpoint(&dest).await.unwrap_err();
        assert!(error.to_string().contains("disks"), "{error}");
        assert!(!dest.exists());
        assert!(entries(&fx.layout.checkpoint_dir()).is_empty());
        assert_eq!(fx.persisted(), BoxStatus::Paused);
        assert!(is_process_alive(fx.pid));

        // An existing destination is never touched.
        std::fs::write(&dest, b"mine").unwrap();
        let error = litebox.export_checkpoint(&dest).await.unwrap_err();
        assert!(matches!(error, BoxliteError::InvalidArgument(_)), "{error}");
        assert_eq!(std::fs::read(&dest).unwrap(), b"mine");

        // A box that runs (here: resumed by another process) is not exported.
        let owner = FakeOwner::new(VmRunState::Running);
        let fx = Fixture::with_state(
            BoxStatus::Paused,
            BoxOptions::default(),
            Some(owner.clone()),
            |state| {
                restored(state);
                state.checkpoint_guest = Some(GuestIdentity {
                    boot_id: "boot-1".into(),
                    container_id: String::new(),
                    init_pid: 1,
                });
            },
        );
        let dest = fx._home.path().join("box.ckpt");
        let error = fx
            .litebox()
            .await
            .export_checkpoint(&dest)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("pause it first"), "{error}");
        assert!(owner.calls().is_empty());
        assert!(!dest.exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_export_with_an_unknown_outcome_stops_the_vm_and_is_not_repeated() {
        let fx = Fixture::with_state(BoxStatus::Paused, BoxOptions::default(), None, |state| {
            restored(state);
            state.checkpoint_guest = Some(GuestIdentity {
                boot_id: "boot-1".into(),
                container_id: String::new(),
                init_pid: 1,
            });
        });
        let listener = std::os::unix::net::UnixListener::bind(&fx.socket).unwrap();
        let exports = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let peer = {
            let exports = exports.clone();
            std::thread::spawn(move || {
                // Answer the opening state query; drop the export and the
                // stop path's query unanswered.
                for (i, stream) in listener.incoming().take(3).enumerate() {
                    let stream = stream.unwrap();
                    let mut reader = std::io::BufReader::new(&stream);
                    let request: ControlRequest =
                        crate::vmm::checkpoint::protocol::read_line(&mut reader).unwrap();
                    if matches!(request, ControlRequest::ExportRaw { .. }) {
                        exports.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                    if i == 0 {
                        let reply = ControlReply {
                            state: VmRunState::Paused,
                            in_flight: None,
                            mutations: 1,
                            error: None,
                            share: None,
                        };
                        crate::vmm::checkpoint::protocol::write_line(&mut &stream, &reply).unwrap();
                    }
                }
            })
        };
        let dest = fx._home.path().join("box.ckpt");
        let error = fx
            .litebox()
            .await
            .export_checkpoint(&dest)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("outcome unknown"), "{error}");
        assert!(
            !is_process_alive(fx.pid),
            "an uncertain export stops the VM"
        );
        assert_eq!(fx.persisted(), BoxStatus::Stopped);
        assert!(!dest.exists());
        assert!(entries(&fx.layout.checkpoint_dir()).is_empty());
        peer.join().unwrap();
        assert_eq!(exports.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_stale_stopped_status_never_cold_boots_over_a_live_vm() {
        // Another process started this box and paused it; this one still
        // caches Stopped. The cold pipeline would prepare the box layout
        // (disks/, logs/) and spawn a second shim.
        let owner = FakeOwner::new(VmRunState::Paused);
        let fx = Fixture::new(
            BoxStatus::Stopped,
            BoxOptions::default(),
            Some(owner.clone()),
        );
        let litebox = fx.litebox().await;
        let error = litebox.start().await.unwrap_err();
        assert!(error.to_string().contains("paused"), "{error}");
        assert_eq!(fx.persisted(), BoxStatus::Paused);
        assert!(!fx.layout.disks_dir().exists(), "the cold pipeline ran");
        assert!(owner.calls().is_empty());
        assert!(fx.guest.calls().is_empty(), "no guest RPC either");

        // Running elsewhere: adopted, so the caller reattaches.
        let owner = FakeOwner::new(VmRunState::Running);
        let fx = Fixture::new(BoxStatus::Stopped, BoxOptions::default(), Some(owner));
        let bx = fx.litebox().await.local_backend("test").unwrap();
        bx.ensure_guest_running().await.unwrap();
        let state = fx.state();
        assert_eq!(
            (state.status, state.pid),
            (BoxStatus::Running, Some(fx.pid))
        );
        assert!(!fx.layout.disks_dir().exists());

        // A live shim whose owner does not answer: refused, nothing booted.
        let fx = Fixture::new(BoxStatus::Stopped, BoxOptions::default(), None);
        let bx = fx.litebox().await.local_backend("test").unwrap();
        let error = bx.ensure_guest_running().await.unwrap_err();
        assert!(error.to_string().contains("live VM"), "{error}");
        assert_eq!(fx.persisted(), BoxStatus::Stopped);
        assert!(!fx.layout.disks_dir().exists());
    }
}
