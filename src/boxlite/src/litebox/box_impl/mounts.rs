//! Persistent host directory mounts of a box: admission, then the change.
//!
//! Every operation first requires the `native-vmm` experimental opt-in and
//! the native engine, so an unsupported box is refused before anything is
//! opened or registered. A change then runs against the lifecycle it is
//! admitted to: a stopped box only commits a declaration for its next start;
//! a running one records `Preparing` or `Detaching`, delivers through the shim
//! and the guest, and commits the confirmation. Queries read the store: they
//! take no lifecycle lock and touch neither the source directory, the shim nor
//! the guest. Nothing here starts or restarts the box.

use std::fs::File;
use std::future::Future;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use boxlite_shared::constants::{STANDARD_MOUNT_TARGETS, mount_tags::AGGREGATE, paths_overlap};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::{BoxImpl, BoxRun};
use crate::db::{BoxStore, Mounts};
use crate::experimental::ExperimentalFeature;
use crate::litebox::mounts::{
    MountInfo, MountProgress, MountRequest, MountState, normalize_target, target_key,
};
use crate::lock::OwnedLockGuard;
use crate::portal::interfaces::ContainerInterface;
use crate::runtime::id::BoxID;
use crate::runtime::types::BoxStatus;
use crate::vmm::VmmKind;
use crate::vmm::controller::mount_control::{MountControlClient, MountRequestId};

/// How long one guest mount or detach may take before its outcome is unknown.
const GUEST_STEP_TIMEOUT: Duration = Duration::from_secs(30);

/// The running VM a change acts on, with the store that tracks its progress.
struct Running {
    store: BoxStore,
    id: BoxID,
    /// The run every store write must still name.
    run: BoxRun,
    /// Where the shim takes mount control.
    control: PathBuf,
    guest: ContainerInterface,
    container_id: String,
    /// The box's lifecycle lock, held until the change ends: no start or stop
    /// can replace the VM under it. Only its drop matters.
    _lifecycle: OwnedLockGuard,
}

impl Running {
    /// Run `change` inside one write transaction. The write is refused unless
    /// the box still runs the admitted run.
    fn update<T>(&self, change: impl FnOnce(&mut Mounts) -> BoxliteResult<T>) -> BoxliteResult<T> {
        let run = self.run;
        self.store.update_mounts(self.id.as_str(), |mounts| {
            mounts.ensure_run(run.pid, run.started_at)?;
            change(mounts)
        })
    }

    /// One blocking shim exchange, on the blocking pool.
    async fn control<T: Send + 'static>(
        &self,
        step: &'static str,
        request: impl FnOnce(&MountControlClient) -> io::Result<T> + Send + 'static,
    ) -> BoxliteResult<T> {
        let client = MountControlClient::new(&self.control);
        tokio::task::spawn_blocking(move || request(&client))
            .await
            .map_err(|error| BoxliteError::Internal(format!("{step} task: {error}")))?
            .map_err(|error| shim_error(step, error))
    }

    /// Retire the export at the shim. One that is already gone stays gone.
    async fn retire(&self, export: &str) -> BoxliteResult<()> {
        let export = export.to_owned();
        self.control("retire the export", move |client| client.remove(&export))
            .await
    }

    /// Have the guest bind the export at `target`. A refusal, see [`refusal`],
    /// means the guest refused before touching the container.
    async fn mount(&mut self, export: &str, target: &str, read_only: bool) -> BoxliteResult<()> {
        guest_step(
            "mount",
            target,
            self.guest
                .mount_aggregate(&self.container_id, export, AGGREGATE, target, read_only),
        )
        .await
    }

    /// Have the guest lazily detach the mount identity `export`.
    async fn detach(&mut self, export: &str, target: &str) -> BoxliteResult<()> {
        guest_step(
            "detach",
            target,
            self.guest.detach(&self.container_id, target, export),
        )
        .await
    }

    /// The export the shim registered for `request_id`, if any.
    async fn registered_export(&self, request_id: MountRequestId) -> BoxliteResult<Option<String>> {
        let record = self
            .control("find the registration", move |client| {
                client.find_registered(request_id)
            })
            .await?;
        Ok(record.map(|record| record.export))
    }

    /// Drop the reservation of a request that left nothing behind. A later
    /// request's entry at the target stays.
    fn release(&self, target: &str, request_id: MountRequestId) -> BoxliteResult<()> {
        self.update(|mounts| {
            if owns(mounts, target, request_id) {
                mounts.progress.remove(target);
            }
            Ok(())
        })
    }

    /// Commit the end of a removal: drop the declaration together with this
    /// request's entry. A later request's entry at the target stays.
    fn end(&self, target: &str, request_id: MountRequestId) -> BoxliteResult<()> {
        self.update(|mounts| {
            if owns(mounts, target, request_id) {
                mounts.forget(target);
                mounts.progress.remove(target);
            }
            Ok(())
        })
    }

    /// Report a refusal to detach this request's mount. The guest touched
    /// nothing, so its entry returns to `found`, the state the removal found.
    /// An outcome the guest did not report leaves the entry `Detaching` for a
    /// retry.
    fn refused(
        &self,
        target: &str,
        request_id: MountRequestId,
        found: MountState,
        error: BoxliteError,
    ) -> BoxliteError {
        if !refusal(&error) {
            return error;
        }
        let restored = self.update(|mounts| {
            if let Some(entry) = mounts
                .progress
                .get_mut(target)
                .filter(|entry| entry.request_id == request_id)
            {
                entry.state = found;
            }
            Ok(())
        });
        match restored {
            Err(stopped @ BoxliteError::Stopped(_)) => stopped,
            _ => error,
        }
    }

    /// End a failed change that left nothing behind: release its reservation
    /// and report why it failed.
    fn settle(self, target: &str, request_id: MountRequestId, error: BoxliteError) -> BoxliteError {
        match self.release(target, request_id) {
            Ok(()) => error,
            Err(release) => unconverged(error, release),
        }
    }

    /// Undo a failed add: bring its export to "no mount, no export", then
    /// release the entry. The entry leaves the store only once the cleanup is
    /// confirmed; otherwise it stays listed for a remove, and the original
    /// error is kept.
    async fn undo(
        mut self,
        target: &str,
        request_id: MountRequestId,
        export: &str,
        error: BoxliteError,
        detach: bool,
    ) -> BoxliteError {
        let cleanup = async {
            if detach {
                self.detach(export, target).await?;
            }
            self.retire(export).await
        }
        .await;
        match cleanup {
            Ok(()) => self.settle(target, request_id, error),
            Err(cleanup) => unconverged(error, cleanup),
        }
    }
}

/// One guest step under its deadline. An outcome the guest does not report in
/// time is unknown, the guest may have acted, so it is no refusal.
async fn guest_step<T>(
    step: &'static str,
    target: &str,
    call: impl Future<Output = BoxliteResult<T>>,
) -> BoxliteResult<T> {
    tokio::time::timeout(GUEST_STEP_TIMEOUT, call)
        .await
        .unwrap_or_else(|_| {
            Err(BoxliteError::Rpc(format!(
                "guest {step} of {target} did not finish within {GUEST_STEP_TIMEOUT:?}"
            )))
        })
}

/// Whether `target` still holds the entry of `request_id`.
fn owns(mounts: &Mounts, target: &str, request_id: MountRequestId) -> bool {
    mounts
        .progress
        .get(target)
        .is_some_and(|entry| entry.request_id == request_id)
}

/// The entry of `request_id` at `target` while it still takes its add.
/// Another request's entry, a removed one, or one a removal is detaching
/// means the mount is no longer the add's.
fn own_entry<'a>(
    mounts: &'a mut Mounts,
    target: &str,
    request_id: MountRequestId,
) -> Option<&'a mut MountProgress> {
    mounts
        .progress
        .get_mut(target)
        .filter(|entry| entry.request_id == request_id && entry.state == MountState::Preparing)
}

/// A request as the shim, the guest and the store take it: an absolute UTF-8
/// source, and the target as every plane records it.
#[derive(Clone)]
struct CheckedRequest {
    source: String,
    target: String,
    read_only: bool,
}

impl CheckedRequest {
    /// The request to keep as a declaration and as progress.
    fn request(&self) -> MountRequest {
        MountRequest {
            source: PathBuf::from(&self.source),
            target: PathBuf::from(&self.target),
            read_only: self.read_only,
        }
    }

    /// The request as callers see it in `state`.
    fn info(&self, state: MountState) -> MountInfo {
        MountInfo {
            source: PathBuf::from(&self.source),
            target: PathBuf::from(&self.target),
            read_only: self.read_only,
            state,
        }
    }
}

/// Validate a request. Invalid input stops here, before any descriptor, record
/// or declaration exists.
fn checked_request(request: &MountRequest) -> BoxliteResult<CheckedRequest> {
    if !request.source.is_absolute() {
        return Err(BoxliteError::InvalidArgument(format!(
            "source must be an absolute host path: {:?}",
            request.source
        )));
    }
    let source = request.source.to_str().ok_or_else(|| {
        BoxliteError::InvalidArgument(format!("source must be valid UTF-8: {:?}", request.source))
    })?;
    let target = target_key(&request.target)?;
    // The runtime mounts its own filesystems before any user mount applies,
    // so a directory there, above or below one would hide it.
    if let Some(root) = STANDARD_MOUNT_TARGETS
        .into_iter()
        .find(|root| paths_overlap(&target, root))
    {
        return Err(BoxliteError::InvalidArgument(format!(
            "mount target {target} is reserved for the container's own mount at {root}"
        )));
    }
    Ok(CheckedRequest {
        source: source.to_owned(),
        target,
        read_only: request.read_only,
    })
}

/// Open a directory without following a symbolic link in its final component,
/// and report where it really is.
fn open_source(source: &Path) -> BoxliteResult<(File, PathBuf)> {
    // A trailing slash or dot makes Linux follow the preceding component even
    // with O_NOFOLLOW. Strip that spelling while preserving `..` resolution.
    let directory = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(source.components().as_path())
        .map_err(|error| match error.raw_os_error() {
            Some(libc::ENOENT) => {
                BoxliteError::NotFound(format!("source {} does not exist", source.display()))
            }
            Some(libc::ENOTDIR | libc::ELOOP) => BoxliteError::InvalidArgument(format!(
                "source {} is not a directory",
                source.display()
            )),
            _ => BoxliteError::Storage(format!("open source {}: {error}", source.display())),
        })?;
    // The descriptor names the directory the kernel opened, whichever way the
    // path spells it.
    let root = std::fs::canonicalize(format!("/proc/self/fd/{}", directory.as_raw_fd())).map_err(
        |error| BoxliteError::Storage(format!("resolve source {}: {error}", source.display())),
    )?;
    Ok((directory, root))
}

/// Refuse a target that already has a mount on any plane, or one with a
/// mount below it: a directory applied last would cover that mount.
fn require_free(mounts: &Mounts, target: &str) -> BoxliteResult<()> {
    if mounts.occupied(target) {
        return Err(BoxliteError::InvalidState(format!(
            "a mount already exists at {target}"
        )));
    }
    if let Some(below) = mounts.below(target) {
        return Err(BoxliteError::InvalidState(format!(
            "a mount at {below} sits below {target} and would be covered"
        )));
    }
    Ok(())
}

/// A target that has no mount to remove.
fn missing(target: &str) -> BoxliteError {
    BoxliteError::NotFound(format!("no mount at {target}"))
}

/// Whether the guest refused a step before it touched the container. The guest
/// reports each such refusal with its own code; anything else, a deadline
/// included, leaves the outcome unknown.
fn refusal(error: &BoxliteError) -> bool {
    matches!(
        error,
        BoxliteError::InvalidState(_)
            | BoxliteError::InvalidArgument(_)
            | BoxliteError::Unsupported(_)
    )
}

/// A failed shim exchange. Refusals keep their category; everything else is a
/// transport failure, whose outcome may be unknown.
fn shim_error(step: &str, error: io::Error) -> BoxliteError {
    let message = format!("{step}: {error}");
    match error.raw_os_error() {
        Some(libc::EBUSY) => BoxliteError::InvalidState(message),
        Some(libc::EINVAL) => BoxliteError::InvalidArgument(message),
        Some(libc::ENOSPC) => BoxliteError::ResourceExhausted(message),
        None => match error.kind() {
            io::ErrorKind::Unsupported => BoxliteError::Unsupported(message),
            io::ErrorKind::InvalidInput => BoxliteError::InvalidArgument(message),
            _ => BoxliteError::Storage(message),
        },
        _ => BoxliteError::Storage(message),
    }
}

/// The change's own error, plus what an unfinished cleanup leaves behind.
fn unconverged(error: BoxliteError, cleanup: BoxliteError) -> BoxliteError {
    match cleanup {
        stopped @ BoxliteError::Stopped(_) => stopped,
        cleanup => BoxliteError::InvalidState(format!(
            "{error}; removal is unconfirmed ({cleanup}), the record stays listed: retry remove"
        )),
    }
}

/// Run `work` against the store of box `id` on the blocking pool: the store
/// reads and writes SQLite, and its declarations name host paths.
async fn on_mount_store<T: Send + 'static>(
    store: &BoxStore,
    id: &str,
    work: impl FnOnce(&BoxStore, &str) -> BoxliteResult<T> + Send + 'static,
) -> BoxliteResult<T> {
    let (store, id) = (store.clone(), id.to_owned());
    tokio::task::spawn_blocking(move || work(&store, &id))
        .await
        .map_err(|error| BoxliteError::Internal(format!("mount store task: {error}")))?
}

/// Refuse a source that is, holds or lies inside the directory of another
/// mount on record. The next start delivers every declaration as its own
/// share, and refuses two shares whose roots overlap. The record at `target`
/// itself is left to the target's own check.
fn require_disjoint_source(
    mounts: &Mounts,
    target: &str,
    source: &str,
    root: &Path,
) -> BoxliteResult<()> {
    let on_record = mounts.declarations.iter().chain(
        mounts
            .progress
            .iter()
            .map(|(other, entry)| (other, &entry.request)),
    );
    for (other, request) in on_record {
        if other == target {
            continue;
        }
        // A source that cannot be resolved is named by the next start.
        let Ok(resolved) = request.source.canonicalize() else {
            continue;
        };
        if resolved.starts_with(root) || root.starts_with(&resolved) {
            return Err(BoxliteError::InvalidState(format!(
                "source {source} overlaps the directory mounted at {other}; a start could not \
                 deliver both"
            )));
        }
    }
    Ok(())
}

/// A directory cannot go below a file the box was created with: the file's
/// mount leaves no path to mount it at.
fn require_below_no_file(binds: &[(String, String)], target: &str) -> BoxliteResult<()> {
    for (source, guest) in binds {
        let file = std::fs::metadata(source).is_ok_and(|metadata| !metadata.is_dir());
        let below = |key: String| target.starts_with(format!("{key}/").as_str());
        if file && normalize_target(guest).is_some_and(below) {
            return Err(BoxliteError::InvalidState(format!(
                "a file the box was created with is mounted at {guest}; no directory can sit below it"
            )));
        }
    }
    Ok(())
}

impl BoxImpl {
    /// Admission shared by every mount operation: the `native-vmm`
    /// experimental opt-in and the native engine. Neither starts the box.
    fn require_runtime_mounts(&self) -> BoxliteResult<()> {
        self.runtime
            .experimental_features
            .require(ExperimentalFeature::NativeVmm)?;
        if self.config.engine_kind != VmmKind::Native {
            return Err(BoxliteError::Unsupported(format!(
                "runtime directory mounts need the native VMM; box {} runs {:?}",
                self.id(),
                self.config.engine_kind
            )));
        }
        Ok(())
    }

    /// Aggregate delivery needs a mount namespace the workload cannot modify.
    /// A stopped change follows the same admission: a declaration saved for a
    /// box that cannot deliver it could never take effect.
    fn require_aggregate_mounts(&self) -> BoxliteResult<()> {
        if self.config.options.advanced.permits_aggregate_mounts() {
            Ok(())
        } else {
            Err(BoxliteError::Unsupported(format!(
                "runtime directory mounts need a container without CAP_SYS_ADMIN; box {} keeps \
                 its configured capabilities",
                self.id()
            )))
        }
    }

    /// The host source and container target of every bind the box was created
    /// with.
    fn created_binds(&self) -> impl Iterator<Item = (&str, &str)> {
        let options = &self.config.options;
        options
            .volumes
            .iter()
            .filter(|volume| volume.managed_volume.is_none())
            .map(|volume| (volume.host_path.as_str(), volume.guest_path.as_str()))
            .chain(options.mounts.iter().map(|mount| {
                (
                    mount.source.as_deref().unwrap_or_default(),
                    mount.target.as_str(),
                )
            }))
    }

    /// Deliver a host directory into the container, or save it for the next
    /// start of a stopped box.
    pub(crate) async fn mount_add(&self, request: MountRequest) -> BoxliteResult<MountInfo> {
        self.require_runtime_mounts()?;
        self.require_aggregate_mounts()?;
        let request = checked_request(&request)?;
        // The host filesystem may sit on slow storage.
        let created: Vec<_> = self
            .created_binds()
            .map(|(source, guest)| (source.to_owned(), guest.to_owned()))
            .collect();
        let (target, source) = (request.target.clone(), request.source.clone());
        let (directory, root) = tokio::task::spawn_blocking(move || {
            require_below_no_file(&created, &target)?;
            open_source(Path::new(&source))
        })
        .await
        .map_err(|error| BoxliteError::Internal(format!("open source task: {error}")))??;
        self.mount_change(
            || self.add_while_stopped(&request, &root),
            |run| Self::add_while_running(run, request.clone(), directory, root.clone()),
        )
        .await
    }

    /// Remove the mount at `target`: a running box detaches it first, a
    /// stopped one only drops the declaration.
    pub(crate) async fn mount_remove(&self, target: &Path) -> BoxliteResult<()> {
        self.require_runtime_mounts()?;
        self.require_aggregate_mounts()?;
        let target = target_key(target)?;
        self.mount_change(
            || self.remove_while_stopped(&target),
            |run| Self::remove_while_running(run, target.clone()),
        )
        .await
    }

    /// Effective declarations and the current run's committed progress, from
    /// the store.
    pub(crate) async fn mount_list(&self) -> BoxliteResult<Vec<MountInfo>> {
        self.require_runtime_mounts()?;
        Ok(self.mounts().await?.visible())
    }

    /// The entry at `target`, or `None` when nothing is declared or in
    /// progress there.
    pub(crate) async fn mount_get(&self, target: &Path) -> BoxliteResult<Option<MountInfo>> {
        self.require_runtime_mounts()?;
        let target = target_key(target)?;
        Ok(self.mounts().await?.lookup(&target))
    }

    /// The declarations and progress from the store.
    async fn mounts(&self) -> BoxliteResult<Mounts> {
        on_mount_store(
            self.runtime.box_manager.store(),
            self.id().as_str(),
            |store, id| store.mounts(id),
        )
        .await
    }

    /// Run a change against the lifecycle it is admitted to. The lifecycle
    /// lock decides once: a stopped box commits under the admission, so a
    /// start cannot pass a write in flight, and a running one takes the change
    /// inside its VM run.
    async fn mount_change<T, S, F, R>(
        &self,
        stopped: S,
        running: impl FnOnce(Running) -> R,
    ) -> BoxliteResult<T>
    where
        S: FnOnce() -> F,
        F: Future<Output = BoxliteResult<T>>,
        R: Future<Output = BoxliteResult<T>> + Send + 'static,
        T: Send + 'static,
    {
        let admitted = self
            .with_operation(async move {
                let status = self.state.read().status;
                match status {
                    BoxStatus::Paused => Err(BoxliteError::InvalidState(format!(
                        "Box {} is paused; its mounts stay in place until it resumes or stops",
                        self.id()
                    ))),
                    BoxStatus::Running => Ok(None),
                    BoxStatus::Configured | BoxStatus::Stopped | BoxStatus::Failed => {
                        stopped().await.map(Some)
                    }
                    status => Err(BoxliteError::InvalidState(format!(
                        "Cannot change mounts of box {} while it is {status}",
                        self.id()
                    ))),
                }
            })
            .await?;
        match admitted {
            Some(result) => Ok(result),
            None => match self.running().await? {
                Some(run) => self.owned_mount(running(run)).await,
                // The box stopped while this handle looked at a running one.
                None => Err(BoxliteError::InvalidState(format!(
                    "the lifecycle of box {} changed while a mount change was admitted; retry",
                    self.id()
                ))),
            },
        }
    }

    /// The running VM of a change. It takes the box's lifecycle lock and holds
    /// it until the change ends, so no start or stop can replace the VM under it.
    async fn running(&self) -> BoxliteResult<Option<Running>> {
        if self.shutdown_token.is_cancelled() {
            return Err(BoxliteError::Stopped(
                "Mount cancelled during shutdown".into(),
            ));
        }
        let (pid, started_at, lock_id) = {
            let state = self.state.read();
            (state.pid, state.started_at, state.lock_id)
        };
        let lock_id = lock_id.ok_or_else(|| {
            BoxliteError::Internal(format!("box {} is missing lock_id", self.id()))
        })?;
        let lifecycle =
            OwnedLockGuard::new_async(self.runtime.lock_manager.retrieve(lock_id)?).await;
        // The lock was free between the admission and here, so another process
        // may have moved the lifecycle on.
        let current = self.runtime.box_manager.update_box(self.id())?;
        if current.pid != pid
            || current.started_at != started_at
            || current.status != BoxStatus::Running
        {
            return Ok(None);
        }
        let Some(pid) = pid else {
            return Ok(None);
        };
        // The guest mounts into the namespace of the container's init, so the
        // container runs first. The caller holds the lifecycle lock, so an
        // adopted VM is initialized under it.
        let live = self.existing_live_state_locked().await?;
        self.ensure_container_started(live).await?;
        let guest = live.guest_session.container().await?;
        Ok(Some(Running {
            store: self.runtime.box_manager.store().clone(),
            id: self.id().clone(),
            run: BoxRun { pid, started_at },
            control: self.layout.sockets().vmm_sock(),
            _lifecycle: lifecycle,
            guest,
            container_id: self.container_id().to_owned(),
        }))
    }

    /// Save the declaration for the next start. The source only has to be a
    /// directory now: every delivery opens it again.
    async fn add_while_stopped(
        &self,
        request: &CheckedRequest,
        root: &Path,
    ) -> BoxliteResult<MountInfo> {
        let (source, target, root) = (
            request.source.clone(),
            request.target.clone(),
            root.to_owned(),
        );
        let stored = request.request();
        // The overlap check reads the store before the transaction: two stopped
        // adds that pass it together are named by the next start.
        on_mount_store(
            self.runtime.box_manager.store(),
            self.id().as_str(),
            move |store, id| {
                require_disjoint_source(&store.mounts(id)?, &target, &source, &root)?;
                store.update_mounts(id, |mounts| {
                    require_free(mounts, &target)?;
                    mounts.declare(stored);
                    Ok(())
                })
            },
        )
        .await?;
        Ok(request.info(MountState::Configured))
    }

    /// Drop the declaration at `target`. The host source plays no part, so a
    /// declaration whose source is gone still goes.
    async fn remove_while_stopped(&self, target: &str) -> BoxliteResult<()> {
        let target = target.to_owned();
        on_mount_store(
            self.runtime.box_manager.store(),
            self.id().as_str(),
            move |store, id| {
                store.update_mounts(id, |mounts| {
                    if !mounts.declarations.contains_key(&target) {
                        return Err(missing(&target));
                    }
                    mounts.forget(&target);
                    Ok(())
                })
            },
        )
        .await
    }

    /// Keep a running change running after its caller gives up: a cancelled
    /// add could leave the guest holding a mount the store does not know
    /// about. The box's own shutdown still ends it.
    async fn owned_mount<T: Send + 'static>(
        &self,
        operation: impl Future<Output = BoxliteResult<T>> + Send + 'static,
    ) -> BoxliteResult<T> {
        let shutdown = self.shutdown_token.clone();
        let task = tokio::spawn(async move {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => Err(BoxliteError::Stopped(
                    "the box stopped during a mount operation".into(),
                )),
                result = operation => result,
            }
        });
        task.await.unwrap_or_else(|error| {
            Err(BoxliteError::Internal(format!(
                "mount operation failed: {error}"
            )))
        })
    }

    /// Deliver `directory` at the request's target in the admitted run.
    /// Succeeds only once the guest confirmed the mount and the declaration
    /// with its `Mounted` progress are committed.
    async fn add_while_running(
        mut run: Running,
        request: CheckedRequest,
        directory: File,
        root: PathBuf,
    ) -> BoxliteResult<MountInfo> {
        let target = request.target.clone();
        let stored = request.request();
        // The lifecycle lock is held, so every earlier add of this run has
        // committed its declaration.
        let (source, checked) = (request.source.clone(), target.clone());
        on_mount_store(&run.store, run.id.as_str(), move |store, id| {
            require_disjoint_source(&store.mounts(id)?, &checked, &source, &root)
        })
        .await?;
        let request_id: MountRequestId = uuid::Uuid::new_v4().into_bytes();
        // Reserve the target and publish `Preparing` before anything is registered.
        run.update(|mounts| {
            require_free(mounts, &target)?;
            mounts.progress.insert(
                target.clone(),
                MountProgress {
                    request: stored.clone(),
                    state: MountState::Preparing,
                    request_id,
                    export: None,
                    delivered_at_start: false,
                },
            );
            Ok(())
        })?;
        let registered = run
            .control("register the directory", {
                let (target, source) = (target.clone(), request.source.clone());
                move |client| {
                    client.register_with_request_id(
                        source,
                        target,
                        directory,
                        request.read_only,
                        Some(request_id),
                    )
                }
            })
            .await;
        let export = match registered {
            Ok(record) => record.export,
            // A transport failure can hide either a registration or a refusal.
            // Only this request's ID finds a registration whose reply was lost.
            Err(error @ (BoxliteError::Storage(_) | BoxliteError::Internal(_))) => {
                match run.registered_export(request_id).await {
                    Ok(Some(export)) => export,
                    // Nothing was registered, so nothing is mounted.
                    Ok(None) => return Err(run.settle(&target, request_id, error)),
                    // The shim cannot say: the entry stays listed for a remove.
                    Err(_) => return Err(error),
                }
            }
            // The run ended; the entry ends with it.
            Err(error @ BoxliteError::Stopped(_)) => return Err(error),
            // Refused, so nothing was registered: an invalid source or target,
            // a repeated request, or a full record list.
            Err(error) => return Err(run.settle(&target, request_id, error)),
        };

        if let Err(error) = run.mount(&export, &target, request.read_only).await {
            // A refusal means the guest refused before touching the container,
            // so nothing needs detaching. Any other outcome is unknown: the
            // guest may have mounted without reporting it.
            let detach = !refusal(&error);
            return Err(run.undo(&target, request_id, &export, error, detach).await);
        }
        let committed = run.update(|mounts| {
            let entry = own_entry(mounts, &target, request_id).ok_or_else(|| {
                BoxliteError::InvalidState(format!(
                    "the mount at {target} was removed while being added"
                ))
            })?;
            entry.state = MountState::Mounted;
            entry.export = Some(export.clone());
            mounts.declare(stored);
            Ok(())
        });
        match committed {
            Ok(()) => Ok(request.info(MountState::Mounted)),
            // The guest holds a mount that is not on record. Only undoing it
            // keeps the store truthful.
            Err(stopped @ BoxliteError::Stopped(_)) => Err(stopped),
            Err(error) => Err(run.undo(&target, request_id, &export, error, true).await),
        }
    }

    /// Remove this run's mount at `target`: detach its identity in the guest,
    /// retire its export, then commit the removal of the declaration.
    async fn remove_while_running(mut run: Running, target: String) -> BoxliteResult<()> {
        // Refuse what could not be detached, then publish `Detaching`, both
        // before anything changes in the guest.
        let (request_id, named, delivered, found) = run.update(|mounts| {
            // A mount below the target would leave the container with it.
            if let Some(below) = mounts.below(&target) {
                return Err(BoxliteError::InvalidState(format!(
                    "remove the mount at {below} first; one the box was created with needs a stop"
                )));
            }
            let entry = mounts.progress.get_mut(&target).ok_or_else(|| {
                if mounts.declarations.contains_key(&target) {
                    BoxliteError::InvalidState(format!(
                        "the mount at {target} has no committed identity in this VM run; stop the box before removing its declaration"
                    ))
                } else {
                    missing(&target)
                }
            })?;
            let delivered = entry.delivered_at_start;
            let found = entry.state;
            entry.state = MountState::Detaching;
            Ok((entry.request_id, entry.export.clone(), delivered, found))
        })?;
        let (key, exported) = match named {
            Some(export) => (export, true),
            None if delivered => (uuid::Uuid::from_bytes(request_id).to_string(), false),
            // An add whose export was never committed: its registration names it.
            None => match run.registered_export(request_id).await? {
                Some(export) => (export, true),
                // Nothing was registered, so nothing is mounted.
                None => return run.end(&target, request_id),
            },
        };
        if let Err(error) = run.detach(&key, &target).await {
            return Err(run.refused(&target, request_id, found, error));
        }
        if exported {
            run.retire(&key).await?;
        }
        run.end(&target, request_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::litebox::mounts::tests::Fixture;
    use crate::litebox::state::{BoxState, BoxStatus};
    use tonic::transport::Endpoint;

    const WORK: &str = "/work";

    /// A change on a running box whose shim and guest are never reached.
    async fn running(fx: &Fixture, state: &BoxState) -> Running {
        let endpoint = Endpoint::from_shared("http://127.0.0.1:1")
            .unwrap()
            .connect_lazy();
        Running {
            store: fx.runtime.box_manager.store().clone(),
            id: fx.id.clone(),
            run: BoxRun {
                pid: state.pid.expect("the fixture gives a running box a pid"),
                started_at: state.started_at,
            },
            control: PathBuf::new(),
            guest: ContainerInterface::new(endpoint),
            container_id: fx.config.container.id.to_string(),
            _lifecycle: OwnedLockGuard::new_async(
                fx.runtime
                    .lock_manager
                    .retrieve(state.lock_id.unwrap())
                    .unwrap(),
            )
            .await,
        }
    }

    #[tokio::test]
    async fn a_refused_removal_leaves_the_entry_as_it_found_it() {
        let fx = Fixture::new(BoxStatus::Running);
        let state = fx.runtime.box_manager.update_box(&fx.id).unwrap();
        let store = fx.runtime.box_manager.store().clone();
        // An add interrupted before its commit, then a committed mount.
        for (found, left) in [
            (MountState::Preparing, MountState::Preparing),
            (MountState::Mounted, MountState::Mounted),
        ] {
            let request_id: MountRequestId = [7; 16];
            store
                .update_mounts(fx.id.as_str(), |mounts| {
                    mounts.progress.insert(
                        WORK.into(),
                        MountProgress {
                            request: fx.request(),
                            state: found,
                            request_id,
                            export: None,
                            delivered_at_start: false,
                        },
                    );
                    Ok(())
                })
                .unwrap();
            let run = running(&fx, &state).await;
            let refused = run.refused(
                WORK,
                request_id,
                found,
                BoxliteError::InvalidState("detach descendant mounts first".into()),
            );
            drop(run);

            assert!(
                matches!(refused, BoxliteError::InvalidState(_)),
                "the caller still reports the refusal: {refused}"
            );
            assert_eq!(
                store.mounts(fx.id.as_str()).unwrap().progress[WORK].state,
                left,
                "an entry the removal found {found:?}"
            );
        }
    }
}
