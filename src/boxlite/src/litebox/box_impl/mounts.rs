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
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use boxlite_shared::constants::mount_tags::AGGREGATE;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::{BoxImpl, BoxRun, LiveState};
use crate::db::{BoxStore, Mounts};
use crate::experimental::ExperimentalFeature;
use crate::litebox::mounts::{MountInfo, MountProgress, MountRequest, MountState, target_key};
use crate::lock::OwnedLockGuard;
use crate::portal::interfaces::ContainerInterface;
use crate::runtime::id::BoxID;
use crate::runtime::types::BoxStatus;
use crate::vmm::VmmKind;
use crate::vmm::controller::mount_control::{MountControlClient, MountRequestId};

/// How long one guest mount or detach may take before its outcome is unknown.
const GUEST_STEP_TIMEOUT: Duration = Duration::from_secs(30);

/// Whether the VM run a change was admitted to is still the live one. Export
/// identities restart with every run, so no request may outlive the run it names.
type RunCheck = Arc<dyn Fn() -> bool + Send + Sync>;

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
    is_current: RunCheck,
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
        ensure_current(self.is_current.as_ref())?;
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

    /// Have the guest bind the export at `target`. `Unsupported` means the
    /// guest refused before touching the container.
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

    /// Bring the mount of `export` at `target` to "no mount, no export": have
    /// the guest detach that identity when `detach`, then retire the export.
    async fn converge(&mut self, export: &str, target: &str, detach: bool) -> BoxliteResult<()> {
        if detach {
            ensure_current(self.is_current.as_ref())?;
            self.detach(export, target).await?;
        }
        self.retire(export).await
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

    /// End a failed change that left nothing behind: release its reservation
    /// and report why it failed.
    fn settle(self, target: &str, request_id: MountRequestId, error: BoxliteError) -> BoxliteError {
        match self.release(target, request_id) {
            Ok(()) => error,
            Err(stopped @ BoxliteError::Stopped(_)) => stopped,
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
        match self.converge(export, target, detach).await {
            Ok(()) => self.settle(target, request_id, error),
            Err(stopped @ BoxliteError::Stopped(_)) => stopped,
            Err(cleanup) => unconverged(error, cleanup),
        }
    }
}

/// One guest step under its deadline. An outcome the guest does not report in
/// time is unknown: the guest may have acted.
async fn guest_step<T>(
    step: &'static str,
    target: &str,
    call: impl Future<Output = BoxliteResult<T>>,
) -> BoxliteResult<T> {
    tokio::time::timeout(GUEST_STEP_TIMEOUT, call)
        .await
        .unwrap_or_else(|_| {
            Err(BoxliteError::InvalidState(format!(
                "guest {step} of {target} did not finish within {GUEST_STEP_TIMEOUT:?}"
            )))
        })
}

/// Whether the VM run a change was admitted to is still the live one.
fn ensure_current(is_current: &(dyn Fn() -> bool + Send + Sync)) -> BoxliteResult<()> {
    if is_current() {
        Ok(())
    } else {
        Err(BoxliteError::Stopped(
            "the box's VM run ended; use runtime.get() for its next run".into(),
        ))
    }
}

/// Whether `target` still holds the entry of `request_id`.
fn owns(mounts: &Mounts, target: &str, request_id: MountRequestId) -> bool {
    mounts
        .progress
        .get(target)
        .is_some_and(|entry| entry.request_id == request_id)
}

/// The entry of `request_id` at `target`, when it is still there. Another
/// request's entry, or none, means a removal took the mount meanwhile.
fn own_entry<'a>(
    mounts: &'a mut Mounts,
    target: &str,
    request_id: MountRequestId,
) -> Option<&'a mut MountProgress> {
    mounts
        .progress
        .get_mut(target)
        .filter(|entry| entry.request_id == request_id)
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
    Ok(CheckedRequest {
        source: source.to_owned(),
        target: target_key(&request.target)?,
        read_only: request.read_only,
    })
}

/// Open a directory without following a symbolic link in its final component.
fn open_source(source: &Path) -> BoxliteResult<File> {
    // A trailing slash or dot makes Linux follow the preceding component even
    // with O_NOFOLLOW. Strip that spelling while preserving `..` resolution.
    std::fs::OpenOptions::new()
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
        })
}

/// A target that already has a mount, on any plane.
fn occupied(target: &str) -> BoxliteError {
    BoxliteError::InvalidState(format!("a mount already exists at {target}"))
}

/// A target that has no mount to remove.
fn missing(target: &str) -> BoxliteError {
    BoxliteError::NotFound(format!("no mount at {target}"))
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

    /// Deliver a host directory into the container, or save it for the next
    /// start of a stopped box.
    pub(crate) async fn mount_add(&self, request: MountRequest) -> BoxliteResult<MountInfo> {
        self.require_runtime_mounts()?;
        self.require_aggregate_mounts()?;
        let request = checked_request(&request)?;
        let directory = open_source(Path::new(&request.source))?;
        self.mount_change(
            |admission| Self::add_while_stopped(self, &request, admission),
            |run| {
                let request = request.clone();
                self.owned_mount(Self::add_while_running(run, request, directory))
            },
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
            |admission| Self::remove_while_stopped(self, &target, admission),
            |run| {
                let target = target.clone();
                self.owned_mount(Self::remove_while_running(run, target))
            },
        )
        .await
    }

    /// Effective declarations and the current run's committed progress, from
    /// the store.
    pub(crate) async fn mount_list(&self) -> BoxliteResult<Vec<MountInfo>> {
        self.require_runtime_mounts()?;
        Ok(self.mounts()?.visible())
    }

    /// The entry at `target`, or `None` when nothing is declared or in
    /// progress there.
    pub(crate) async fn mount_get(&self, target: &Path) -> BoxliteResult<Option<MountInfo>> {
        self.require_runtime_mounts()?;
        let target = target_key(target)?;
        Ok(self.mounts()?.lookup(&target))
    }

    fn mounts(&self) -> BoxliteResult<Mounts> {
        self.runtime.box_manager.store().mounts(self.id().as_str())
    }

    /// Run a change against the lifecycle it is admitted to. The lifecycle
    /// lock decides once: a stopped box commits under the admission, so a
    /// start cannot pass a write in flight, and a running one takes the change
    /// inside its VM run.
    async fn mount_change<T, R>(
        &self,
        stopped: impl FnOnce(OwnedLockGuard) -> BoxliteResult<T>,
        running: impl FnOnce(Running) -> R,
    ) -> BoxliteResult<T>
    where
        R: Future<Output = BoxliteResult<T>>,
    {
        let admission = self.admit_operation().await?;
        let is_stopped = {
            let state = self.state.read();
            match state.status {
                BoxStatus::Paused => {
                    return Err(BoxliteError::InvalidState(format!(
                        "Box {} is paused; its mounts stay in place until it resumes or stops",
                        self.id()
                    )));
                }
                BoxStatus::Running => false,
                BoxStatus::Configured | BoxStatus::Stopped | BoxStatus::Failed => true,
                status => {
                    return Err(BoxliteError::InvalidState(format!(
                        "Cannot change mounts of box {} while it is {status}",
                        self.id()
                    )));
                }
            }
        };
        if is_stopped {
            return stopped(admission);
        }
        drop(admission);
        match self.running().await? {
            Some(run) => running(run).await,
            // The box stopped while this handle looked at a running one.
            None => Err(BoxliteError::InvalidState(format!(
                "the lifecycle of box {} changed while a mount change was admitted; retry",
                self.id()
            ))),
        }
    }

    /// The running VM of a change. The admission refreshed the handle with
    /// the persisted lifecycle, so the run it holds is the live one.
    async fn running(&self) -> BoxliteResult<Option<Running>> {
        if self.shutdown_token.is_cancelled() {
            return Err(BoxliteError::Stopped(
                "Mount cancelled during shutdown".into(),
            ));
        }
        let (pid, started_at) = {
            let state = self.state.read();
            (state.pid, state.started_at)
        };
        let Some(pid) = pid else {
            return Ok(None);
        };
        // The guest mounts into the namespace of the container's init, so the
        // container runs first.
        let live = self.mount_live().await?;
        self.ensure_container_started(live).await?;
        let guest = live.guest_session.container().await?;
        let state = Arc::clone(&self.state);
        Ok(Some(Running {
            store: self.runtime.box_manager.store().clone(),
            id: self.id().clone(),
            run: BoxRun { pid, started_at },
            control: self.layout.sockets().vmm_sock(),
            guest,
            container_id: self.container_id().to_owned(),
            is_current: Arc::new(move || {
                let state = state.read();
                state.status.is_active() && state.pid == Some(pid) && state.started_at == started_at
            }),
        }))
    }

    async fn mount_live(&self) -> BoxliteResult<&LiveState> {
        // An adopted VM needs exclusive admission for initialization. Once
        // initialized, concurrent changes share the handle.
        if !self.shutdown_token.is_cancelled()
            && self.state.read().status == BoxStatus::Running
            && let Some(live) = self.live.get()
        {
            return Ok(live);
        }
        self.existing_live_state().await
    }

    /// Save the declaration for the next start. The source only has to be a
    /// directory now: every delivery opens it again. The admission stays with
    /// the write, so it lands as admitted whatever the caller does meanwhile.
    fn add_while_stopped(
        &self,
        request: &CheckedRequest,
        admission: OwnedLockGuard,
    ) -> BoxliteResult<MountInfo> {
        let _admission = admission;
        self.runtime
            .box_manager
            .store()
            .update_mounts(self.id().as_str(), |mounts| {
                if mounts.occupied(&request.target) {
                    return Err(occupied(&request.target));
                }
                mounts.declare(request.request());
                Ok(())
            })?;
        Ok(request.info(MountState::Configured))
    }

    /// Drop the declaration at `target`. The host source plays no part, so a
    /// declaration whose source is gone still goes.
    fn remove_while_stopped(&self, target: &str, admission: OwnedLockGuard) -> BoxliteResult<()> {
        let _admission = admission;
        self.runtime
            .box_manager
            .store()
            .update_mounts(self.id().as_str(), |mounts| {
                if !mounts.declarations.contains_key(target) {
                    return Err(missing(target));
                }
                mounts.forget(target);
                Ok(())
            })
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
    ) -> BoxliteResult<MountInfo> {
        let target = request.target.clone();
        let stored = request.request();
        let request_id: MountRequestId = uuid::Uuid::new_v4().into_bytes();
        // Reserve the target and publish `Preparing` before anything is registered.
        run.update(|mounts| {
            if mounts.occupied(&target) {
                return Err(occupied(&target));
            }
            mounts.progress.insert(
                target.clone(),
                MountProgress {
                    request: stored.clone(),
                    state: MountState::Preparing,
                    request_id,
                    export: None,
                },
            );
            Ok(())
        })?;
        let registered = run
            .control("register the directory", {
                let target = target.clone();
                move |client| {
                    client.register_with_request_id(
                        request.source,
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
                match run
                    .control("find the registration", move |client| {
                        client.find_registered(request_id)
                    })
                    .await
                {
                    Ok(Some(record)) => record.export,
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

        ensure_current(run.is_current.as_ref())?;
        if let Err(error) = run.mount(&export, &target, request.read_only).await {
            // `Unsupported` means the guest refused before touching the
            // container, so nothing needs detaching. Any other outcome is
            // unknown: the guest may have mounted without reporting it.
            let detach = !matches!(error, BoxliteError::Unsupported(_));
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
            mounts.declare(stored.clone());
            Ok(())
        });
        match committed {
            Ok(()) => Ok(MountInfo {
                source: stored.source,
                target: stored.target,
                read_only: stored.read_only,
                state: MountState::Mounted,
            }),
            // The guest holds a mount that is not on record. Only undoing it
            // keeps the store truthful.
            Err(stopped @ BoxliteError::Stopped(_)) => Err(stopped),
            Err(error) => Err(run.undo(&target, request_id, &export, error, true).await),
        }
    }

    /// Remove this run's mount at `target`: detach its identity in the guest,
    /// retire its export, then commit the removal of the declaration.
    async fn remove_while_running(mut run: Running, target: String) -> BoxliteResult<()> {
        // Publish `Detaching` before anything changes in the guest.
        let (request_id, named, delivered) = run.update(|mounts| {
            let entry = mounts.progress.get_mut(&target).ok_or_else(|| {
                if mounts.declarations.contains_key(&target) {
                    BoxliteError::InvalidState(format!(
                        "the mount at {target} has no committed identity in this VM run; stop the box before removing its declaration"
                    ))
                } else {
                    missing(&target)
                }
            })?;
            // A directory the start delivered has no shim export: the guest
            // recorded it under the request ID.
            let delivered = entry.export.is_none() && entry.state != MountState::Preparing;
            entry.state = MountState::Detaching;
            Ok((entry.request_id, entry.export.clone(), delivered))
        })?;
        let (key, exported) = match named {
            Some(export) => (export, true),
            None if delivered => (uuid::Uuid::from_bytes(request_id).to_string(), false),
            // An add whose export was never committed: its registration names it.
            None => {
                match run
                    .control("find the registration", move |client| {
                        client.find_registered(request_id)
                    })
                    .await?
                {
                    Some(record) => (record.export, true),
                    // Nothing was registered, so nothing is mounted.
                    None => return run.end(&target, request_id),
                }
            }
        };
        ensure_current(run.is_current.as_ref())?;
        run.detach(&key, &target).await?;
        if exported {
            run.retire(&key).await?;
        }
        run.end(&target, request_id)
    }
}
