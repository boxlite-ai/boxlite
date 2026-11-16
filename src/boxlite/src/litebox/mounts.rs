//! Runtime directory delivery: the Box-side coordination of M6 hot mounts.
//!
//! One mount is a two-phase, three-step dance. Host registration (the
//! mount-control socket delivers the directory descriptor to the shim) comes
//! first, the guest bind second, the runtime record last. Every failure
//! unwinds the steps already taken, in reverse, so the visible state after a
//! failed add is exactly the state before it. Removal runs the guest detach
//! first — open descriptors keep working (`MNT_DETACH`) — and only then
//! retires the host registration and the record. Internal identities never
//! leave this module: callers address mounts by container path.

use std::future::Future;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Supplies the source descriptor for one mount transaction: either the
/// plain path open, or a caller-pinned descriptor that skips re-opening.
type OpenSource =
    Box<dyn FnOnce() -> Pin<Box<dyn Future<Output = BoxliteResult<std::fs::File>> + Send>> + Send>;

use serde::{Deserialize, Serialize};

use boxlite_shared::constants::mount_tags::AGGREGATE;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::vmm::controller::mount_control::{ControlMount, MountControlClient, MountResponse};

#[async_trait::async_trait]
impl GuestMounts for crate::portal::interfaces::container::ContainerInterface {
    async fn mount_aggregate(
        &mut self,
        container_id: &str,
        export_key: &str,
        device_tag: &str,
        destination: &Path,
        read_only: bool,
    ) -> BoxliteResult<()> {
        // The inherent method takes the destination as &str; the trait form
        // above takes &Path, so this resolves to the inherent one.
        let destination = destination.to_string_lossy().into_owned();
        ContainerInterface::mount_aggregate(
            self,
            container_id,
            export_key,
            device_tag,
            &destination,
            read_only,
        )
        .await
    }

    async fn detach(
        &mut self,
        container_id: &str,
        destination: &Path,
        export_key: &str,
    ) -> BoxliteResult<()> {
        let destination = destination.to_string_lossy().into_owned();
        ContainerInterface::detach(self, container_id, &destination, export_key).await
    }
}

use crate::portal::interfaces::container::ContainerInterface;

/// How long one guest mount or detach may take before the step counts as
/// failed and the completed steps unwind.
const GUEST_STEP_TIMEOUT: Duration = Duration::from_secs(30);

/// A runtime-mounted directory as the outside world sees it. Internal
/// identities stay internal: this type carries no mount id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MountInfo {
    /// Host directory the content comes from.
    pub source: PathBuf,
    /// Container path the content is visible at.
    pub target: PathBuf,
    /// The mode the delivery requested; content policy is the export's.
    pub read_only: bool,
    /// Where the mount is in its lifecycle.
    pub state: MountState,
}

/// Lifecycle of one runtime mount. `Detaching` is a convergence state: the
/// detach or the retirement did not complete and a retry finishes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MountState {
    /// Visible in the container at `target`.
    Mounted,
    /// Detach or retirement is incomplete; repeating the removal converges.
    Detaching,
}

/// A delivery request.
#[derive(Debug, Clone)]
pub struct MountRequest {
    /// Host directory to deliver. Must be a real directory; symlinks are
    /// refused at open.
    pub source: PathBuf,
    /// Absolute container path. The guest creates missing directories and
    /// refuses non-empty destinations.
    pub target: PathBuf,
    /// Guest bind mode. Content policy for read-only exports stays with the
    /// host backend regardless of this flag.
    pub read_only: bool,
}

/// The guest half of the dance, as the coordinator sees it. A seam for fault
/// injection: the real implementation wraps the gRPC container client.
// async_trait boxes the futures; the boxed Future is already must_use, so the
// macro's own #[must_use] would be a double annotation (clippy::double_must_use).
#[allow(clippy::double_must_use)]
#[async_trait::async_trait]
pub(crate) trait GuestMounts: Send + Sync + 'static {
    async fn mount_aggregate(
        &mut self,
        container_id: &str,
        export_key: &str,
        device_tag: &str,
        destination: &Path,
        read_only: bool,
    ) -> BoxliteResult<()>;

    async fn detach(
        &mut self,
        container_id: &str,
        destination: &Path,
        export_key: &str,
    ) -> BoxliteResult<()>;
}

/// One registered export, as the records see it.
#[derive(Debug, Clone)]
pub(crate) struct MountRecord {
    export: String,
    info: MountInfo,
}

/// Coordinates adds and removals across the host registration and the guest.
/// Records live in the shim: every client of this VM run sees the same set,
/// and a fresh handle recovers it from the control socket instead of losing
/// mounts another client added.
pub(crate) struct MountCoordinator {
    records: Mutex<Vec<MountRecord>>,
    next_export: AtomicU64,
    guest_timeout: Duration,
}

impl Default for MountCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl MountCoordinator {
    pub(crate) fn new() -> Self {
        Self {
            records: Mutex::new(Vec::new()),
            next_export: AtomicU64::new(1),
            guest_timeout: GUEST_STEP_TIMEOUT,
        }
    }

    /// A coordinator whose guest steps time out quickly, for injection tests.
    /// Same gate as the tests module: it is the only caller, and the module
    /// does not compile on every target this crate builds for.
    #[cfg(all(test, feature = "native", target_os = "linux", target_arch = "x86_64"))]
    pub(crate) fn with_guest_timeout(guest_timeout: Duration) -> Self {
        Self {
            guest_timeout,
            ..Self::new()
        }
    }

    /// Deliver `request.source` at `request.target` of the running container.
    ///
    /// Stages: open and register the host directory (descriptor + identity),
    /// then ask the guest to bind the aggregate export. A guest failure rolls
    /// the registration back before the error surfaces. The transaction runs
    /// in an owned task, so cancelling the caller cannot strand a registered
    /// export without cleanup; the caller sees the cancelled error after the
    /// unwinding finishes.
    pub(crate) async fn add(
        self: Arc<Self>,
        container_id: &str,
        control: MountControlClient,
        guest: impl GuestMounts + 'static,
        request: MountRequest,
    ) -> BoxliteResult<MountInfo> {
        if !request.source.is_absolute() {
            return Err(BoxliteError::InvalidArgument(format!(
                "source must be an absolute host path: {:?}",
                request.source
            )));
        }
        if !request.target.is_absolute() {
            return Err(BoxliteError::InvalidArgument(format!(
                "destination must be an absolute container path: {:?}",
                request.target
            )));
        }
        if self.get(&request.target).is_some() {
            return Err(BoxliteError::InvalidState(format!(
                "a mount already exists at {:?}",
                request.target
            )));
        }
        let info = MountInfo {
            source: request.source.clone(),
            target: request.target.clone(),
            read_only: request.read_only,
            state: MountState::Mounted,
        };
        let container_id = container_id.to_string();
        // The open closure owns a copy of the source path, not `request`,
        // so the transaction below can still own the whole request.
        let open_source = request.source.clone();
        let open: OpenSource = Box::new(move || {
            Box::pin(async move {
                tokio::task::spawn_blocking(move || {
                    let path = std::ffi::CString::new(open_source.as_os_str().as_bytes()).map_err(
                        |_| BoxliteError::InvalidArgument("source has a NUL byte".into()),
                    )?;
                    let flags =
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
                    // SAFETY: a NUL-free path open; a successful descriptor is owned.
                    let fd = unsafe { libc::open(path.as_ptr(), flags) };
                    if fd < 0 {
                        Err(BoxliteError::Storage(format!(
                            "open source {}: {}",
                            open_source.display(),
                            std::io::Error::last_os_error()
                        )))
                    } else {
                        // SAFETY: open returned a fresh owned descriptor.
                        Ok(unsafe { std::os::fd::FromRawFd::from_raw_fd(fd) })
                    }
                })
                .await
                .map_err(|error| BoxliteError::Internal(format!("source open task: {error}")))?
            })
        });
        // The receiver Arc stays with run_owned; the transaction captures a
        // clone so the coordinator outlives the caller's future.
        let coordinator = Arc::clone(&self);
        coordinator
            .run_owned(move || {
                Box::pin(async move {
                    // The transaction owns its guest interface exclusively.
                    let mut guest = guest;
                    self.add_admitted(&container_id, control, &mut guest, request, info, open)
                        .await
                })
            })
            .await
    }

    /// Deliver an already-pinned descriptor. Source authorization belongs to
    /// the caller: the descriptor itself is registered, `request.source` only
    /// names it for queries.
    pub(crate) async fn add_pinned(
        self: Arc<Self>,
        container_id: &str,
        control: MountControlClient,
        guest: impl GuestMounts + 'static,
        request: MountRequest,
        source: std::fs::File,
    ) -> BoxliteResult<MountInfo> {
        if !request.target.is_absolute() {
            return Err(BoxliteError::InvalidArgument(format!(
                "destination must be an absolute container path: {:?}",
                request.target
            )));
        }
        if self.get(&request.target).is_some() {
            return Err(BoxliteError::InvalidState(format!(
                "a mount already exists at {:?}",
                request.target
            )));
        }
        let info = MountInfo {
            source: request.source.clone(),
            target: request.target.clone(),
            read_only: request.read_only,
            state: MountState::Mounted,
        };
        let container_id = container_id.to_string();
        let coordinator = Arc::clone(&self);
        coordinator
            .run_owned(move || {
                let open: OpenSource = Box::new(move || Box::pin(async move { Ok(source) }));
                Box::pin(async move {
                    let mut guest = guest;
                    self.add_admitted(&container_id, control, &mut guest, request, info, open)
                        .await
                })
            })
            .await
    }

    /// The admitted half of [`Self::add`]: reserve the target, open and
    /// register the source, then ask the guest to bind it. `open` supplies
    /// the directory descriptor — the plain path open, or a caller-pinned
    /// descriptor.
    async fn add_admitted(
        &self,
        container_id: &str,
        mut control: MountControlClient,
        guest: &mut dyn GuestMounts,
        request: MountRequest,
        info: MountInfo,
        open: OpenSource,
    ) -> BoxliteResult<MountInfo> {
        control.begin().map_err(|error| {
            BoxliteError::Internal(format!("transaction admission failed: {error}"))
        })?;
        // Stage 1a: obtain the source descriptor. The plain open refuses
        // files and symlinked sources before any descriptor leaves this
        // process; a pinned descriptor skips the re-open by contract.
        let file = open().await?;

        // Stage 1b: register behind an internal export name. The descriptor
        // moves into the registration; a failed register closes it. Server
        // rejection arrives as a normal `Error` response, not a transport
        // error, and must surface.
        let export = format!(
            "boxlite-m{}",
            self.next_export.fetch_add(1, Ordering::Relaxed)
        );
        let record_info = info.clone();
        let register_export = export.clone();
        let read_only = request.read_only;
        // The registration runs on a cloned handle, so `control` stays the
        // live connection for the record call and any rollback below.
        let mut register_control = control.try_clone().map_err(|error| {
            BoxliteError::Internal(format!("clone the control connection: {error}"))
        })?;
        let response = tokio::task::spawn_blocking(move || {
            register_control.register(register_export, file, read_only)
        })
        .await
        .map_err(|error| BoxliteError::Internal(format!("register task: {error}")))?
        .map_err(|error| BoxliteError::Storage(format!("register the directory: {error}")))?;
        match response {
            MountResponse::Registered { .. } => {}
            MountResponse::Error { code, message } => {
                return Err(BoxliteError::Storage(format!(
                    "register the directory failed with errno {code}: {message}"
                )));
            }
            _ => {
                return Err(BoxliteError::Internal(
                    "register answered an unexpected response".into(),
                ));
            }
        }
        // Stage 1c: the record becomes visible before the guest RPC, so a
        // cancelled or timed-out caller can still observe and converge it.
        // The shim is the authority: a fresh client recovers from it.
        control
            .record(ControlMount {
                export: export.clone(),
                info: record_info.clone(),
            })
            .map_err(|error| {
                BoxliteError::Storage(format!("record the mount with the shim: {error}"))
            })?;
        self.records.lock().unwrap().push(MountRecord {
            export: export.clone(),
            info: record_info,
        });
        // Stage 2: the guest binds the aggregate export at the target. Both
        // a guest error and a timeout roll the registration back.
        let guest_call = guest.mount_aggregate(
            container_id,
            &export,
            AGGREGATE,
            &request.target,
            request.read_only,
        );
        let guest_error = match tokio::time::timeout(self.guest_timeout, guest_call).await {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(error),
            Err(_) => Some(BoxliteError::InvalidState(format!(
                "guest mount of {:?} did not finish within {:?}",
                request.target, self.guest_timeout
            ))),
        };
        if let Some(error) = guest_error {
            // Roll the registration back: the mount never became visible.
            let rollback = self.retire(&mut control, &export).await;
            let forget = control.forget(export.clone());
            let dropped = export.clone();
            self.records
                .lock()
                .unwrap()
                .retain(|record| record.export != dropped);
            rollback?;
            forget.map_err(|error| {
                BoxliteError::Storage(format!("forget the shim record: {error}"))
            })?;
            return Err(error);
        }
        Ok(info)
    }

    /// Detach the mount at `target`, then retire its registration and record.
    /// A failure keeps the record in [`MountState::Detaching`]; repeating the
    /// removal converges, and queries report the real state. Like [`Self::add`],
    /// the transaction runs in an owned task so cancelling the caller cannot
    /// strand a half-detached mount.
    pub(crate) async fn remove(
        self: Arc<Self>,
        container_id: &str,
        control: MountControlClient,
        guest: impl GuestMounts + 'static,
        target: PathBuf,
    ) -> BoxliteResult<()> {
        if self.get(&target).is_none() {
            return Err(BoxliteError::NotFound(format!("no mount at {:?}", target)));
        }
        let container_id = container_id.to_string();
        let coordinator = Arc::clone(&self);
        coordinator
            .run_owned(move || {
                Box::pin(async move {
                    let mut guest = guest;
                    self.remove_admitted(&container_id, control, &mut guest, target)
                        .await
                })
            })
            .await
    }

    /// The admitted half of [`Self::remove`]: mark the record, ask the guest
    /// to lazily detach, retire the registration, then drop the record.
    async fn remove_admitted(
        &self,
        container_id: &str,
        mut control: MountControlClient,
        guest: &mut dyn GuestMounts,
        target: PathBuf,
    ) -> BoxliteResult<()> {
        control.begin().map_err(|error| {
            BoxliteError::Internal(format!("transaction admission failed: {error}"))
        })?;
        let record = {
            let mut records = self.records.lock().unwrap();
            let index = records
                .iter()
                .position(|record| record.info.target == target)
                .ok_or_else(|| BoxliteError::NotFound(format!("no mount at {:?}", target)))?;
            records[index].info.state = MountState::Detaching;
            records[index].clone()
        };
        // Stage 1: guest detach by export incarnation (lazy — open descriptors
        // stay valid). A retry reaches the same incarnation, so a response lost
        // after the guest finished is answered idempotently.
        let detach = tokio::time::timeout(
            self.guest_timeout,
            guest.detach(container_id, &target, &record.export),
        )
        .await;
        let mut guest_error = None;
        match detach {
            Ok(Ok(())) => {}
            Ok(Err(error)) => guest_error = Some(error),
            Err(_) => {
                guest_error = Some(BoxliteError::InvalidState(format!(
                    "guest detach of {:?} did not finish within {:?}",
                    target, self.guest_timeout
                )));
            }
        }
        // Stage 2: retire the registration. Run it even when the guest
        // already detached: the entry then goes away instead of lingering.
        let retire = self.retire(&mut control, &record.export).await;
        if let Some(error) = guest_error {
            let _ = retire;
            return Err(error);
        }
        retire?;
        control
            .forget(record.export.clone())
            .map_err(|error| BoxliteError::Storage(format!("forget the shim record: {error}")))?;
        // Stage 3: the record goes away with the mount, by its incarnation.
        let export = record.export;
        self.records
            .lock()
            .unwrap()
            .retain(|record| record.export != export);
        Ok(())
    }

    /// Retire one export registration; a transport failure stays an error so
    /// the caller can retry, instead of silently leaking the export. Runs on
    /// a cloned handle, so the caller keeps the connection for follow-ups.
    async fn retire(&self, control: &mut MountControlClient, export: &str) -> BoxliteResult<()> {
        let export = export.to_string();
        let mut cloned = control.try_clone().map_err(|error| {
            BoxliteError::Internal(format!("clone the control connection: {error}"))
        })?;
        let result = tokio::task::spawn_blocking(move || cloned.remove(&export))
            .await
            .map_err(|error| BoxliteError::Internal(format!("retire task: {error}")))?
            .map_err(|error| BoxliteError::Storage(format!("retire the export: {error}")))?;
        match result {
            MountResponse::Removed
            | MountResponse::Error {
                code: libc::ENOENT, ..
            } => Ok(()),
            MountResponse::Error { code, message } => Err(BoxliteError::Storage(format!(
                "retire answered errno {code}: {message}"
            ))),
            _ => Err(BoxliteError::Internal(
                "retire answered an unexpected response".into(),
            )),
        }
    }

    /// Recover every mount record the shim still holds for this VM run. A
    /// fresh client handle therefore sees mounts another client added.
    pub(crate) async fn recover(&self, control: &mut MountControlClient) -> BoxliteResult<()> {
        let mut cloned = control.try_clone().map_err(|error| {
            BoxliteError::Internal(format!("clone the control connection: {error}"))
        })?;
        let mounts = tokio::task::spawn_blocking(move || cloned.list())
            .await
            .map_err(|error| BoxliteError::Internal(format!("recovery task: {error}")))?
            .map_err(|error| BoxliteError::Storage(format!("list shim mounts: {error}")))?;
        let mut records = self.records.lock().unwrap();
        for mount in mounts {
            if records.iter().any(|record| record.export == mount.export) {
                continue;
            }
            let highest = self.next_export.load(Ordering::Relaxed).max(
                mount
                    .export
                    .trim_start_matches("boxlite-m")
                    .parse()
                    .unwrap_or(0)
                    + 1,
            );
            self.next_export.store(highest, Ordering::Relaxed);
            records.push(MountRecord {
                export: mount.export,
                info: mount.info,
            });
        }
        Ok(())
    }

    /// Every runtime mount of this VM run.
    pub(crate) fn list(&self) -> Vec<MountInfo> {
        self.records
            .lock()
            .unwrap()
            .iter()
            .map(|record| record.info.clone())
            .collect()
    }

    /// The mount at `target`, if any.
    pub(crate) fn get(&self, target: &Path) -> Option<MountInfo> {
        self.list().into_iter().find(|info| info.target == *target)
    }

    /// Run one mount transaction so a cancelled caller cannot strand a
    /// half-registered export: the transaction future moves into a tokio
    /// task that owns the coordinator Arc and all transaction state, and
    /// the caller awaits that task's completion. Cancellation of the
    /// caller's future therefore cannot skip cleanup; only runtime drop
    /// (which joins first) can end the task.
    async fn run_owned<T>(
        self: Arc<Self>,
        transaction: impl FnOnce() -> Pin<Box<dyn Future<Output = BoxliteResult<T>> + Send>>
        + Send
        + 'static,
    ) -> BoxliteResult<T>
    where
        T: Send + 'static,
    {
        let task = tokio::spawn(async move { transaction().await });
        match task.await {
            Ok(result) => result,
            Err(error) if error.is_cancelled() => Err(BoxliteError::Internal(
                "mount transaction was cancelled".into(),
            )),
            Err(error) => Err(BoxliteError::Internal(format!(
                "mount transaction failed: {error}"
            ))),
        }
    }
}

/// Runtime mount operations on a Box. Reached via `LiteBox::mounts`.
pub struct MountsHandle {
    backend: Arc<dyn crate::runtime::backend::BoxBackend>,
}

impl MountsHandle {
    pub(crate) fn new(backend: Arc<dyn crate::runtime::backend::BoxBackend>) -> Self {
        Self { backend }
    }

    /// Deliver a host directory into the running container. Fails when the
    /// box is not running a native VM, when the source is not a readable
    /// directory, or when the guest refuses the destination.
    pub async fn add(&self, request: MountRequest) -> BoxliteResult<MountInfo> {
        self.backend.mounts_add(request).await
    }

    /// Deliver an already-opened host directory descriptor into the running
    /// container. `request.source` still names the directory for queries; the
    /// descriptor is what gets registered, so a caller with its own source
    /// authorization (for example a REST server with an operator-approved
    /// root) can pin delivery to the descriptor it validated. The descriptor
    /// moves into the registration.
    #[doc(hidden)]
    pub async fn add_pinned(
        &self,
        request: MountRequest,
        source: std::fs::File,
    ) -> BoxliteResult<MountInfo> {
        self.backend.mounts_add_pinned(request, source).await
    }

    /// Lazily detach the mount at `target`. Open descriptors keep working;
    /// the destination stops resolving to the mount.
    pub async fn remove(&self, target: impl AsRef<Path>) -> BoxliteResult<()> {
        self.backend.mounts_remove(target.as_ref()).await
    }

    /// Every runtime mount of the current VM run.
    pub async fn list(&self) -> BoxliteResult<Vec<MountInfo>> {
        self.backend.mounts_list().await
    }

    /// The mount at `target`, if one is delivered there.
    pub async fn get(&self, target: impl AsRef<Path>) -> BoxliteResult<Option<MountInfo>> {
        self.backend.mounts_get(target.as_ref()).await
    }
}

#[cfg(all(test, feature = "native", target_os = "linux", target_arch = "x86_64"))]
mod tests {
    use super::*;
    use std::ffi::CString;
    use std::sync::Arc;

    use crate::vmm::controller::mount_control::{MountResponse, bind, serve};
    use boxlite_shared::constants::mount_tags::MOUNT_CONTROL_SOCKET;
    use boxlite_vmm::{AggregateFs, Share, insert_aggregate};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct BoxDir(PathBuf);

    impl BoxDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "boxlite-mounts-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for BoxDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A guest seam with programmable failures and a call log. Clones share
    /// the log, so a transaction that takes the seam by value still reports
    /// its calls back to the test.
    #[derive(Clone)]
    struct StubGuest {
        calls: Arc<Mutex<Vec<String>>>,
        fail_mount: bool,
        fail_detach: bool,
        hang_mount: bool,
    }

    impl StubGuest {
        fn healthy() -> Self {
            Self {
                calls: Arc::new(Mutex::new(Vec::new())),
                fail_mount: false,
                fail_detach: false,
                hang_mount: false,
            }
        }

        fn failing_mount() -> Self {
            Self {
                fail_mount: true,
                ..Self::healthy()
            }
        }

        fn failing_detach() -> Self {
            Self {
                fail_detach: true,
                ..Self::healthy()
            }
        }

        fn hanging_mount() -> Self {
            Self {
                hang_mount: true,
                ..Self::healthy()
            }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait::async_trait]
    impl GuestMounts for StubGuest {
        async fn mount_aggregate(
            &mut self,
            container_id: &str,
            export_key: &str,
            device_tag: &str,
            destination: &Path,
            read_only: bool,
        ) -> BoxliteResult<()> {
            self.calls.lock().unwrap().push(format!(
                "mount {container_id} {export_key} {device_tag} {} {read_only}",
                destination.display()
            ));
            if self.hang_mount {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            if self.fail_mount {
                return Err(BoxliteError::Storage("injected mount failure".into()));
            }
            Ok(())
        }

        async fn detach(
            &mut self,
            container_id: &str,
            destination: &Path,
            export_key: &str,
        ) -> BoxliteResult<()> {
            self.calls.lock().unwrap().push(format!(
                "detach {container_id} {} {export_key}",
                destination.display()
            ));
            if self.fail_detach {
                return Err(BoxliteError::Storage("injected detach failure".into()));
            }
            Ok(())
        }
    }

    /// Serves the control socket for `tag` against a real aggregate over a
    /// fresh share directory, and returns (box dir, the aggregate handle).
    fn spawn_control(tag: &str) -> (BoxDir, Arc<AggregateFs>) {
        let box_dir = BoxDir::new();
        let share = box_dir.0.join("share");
        std::fs::create_dir(&share).unwrap();
        let filesystem = Arc::new(
            AggregateFs::new(vec![Share {
                name: "seed".into(),
                path: share.clone(),
                read_only: false,
            }])
            .unwrap(),
        );
        insert_aggregate(tag, filesystem.clone());
        let listener = bind(&box_dir.0).unwrap();
        let owned_tag = tag.to_string();
        std::thread::spawn(move || serve(listener, owned_tag));
        (box_dir, filesystem)
    }

    /// Whether the export name is still free on the control socket.
    async fn name_is_free(box_dir: &BoxDir, export: &str, share: &Path) -> bool {
        let mut client = MountControlClient::connect(&box_dir.0).unwrap();
        let handle = File::open(share).unwrap();
        matches!(
            client.register(export.to_string(), handle, false).unwrap(),
            MountResponse::Registered { .. }
        )
    }

    use std::fs::File;

    async fn coordinator_add(
        coordinator: &Arc<MountCoordinator>,
        box_dir: &BoxDir,
        guest: &StubGuest,
        source: &Path,
        target: &str,
        read_only: bool,
    ) -> BoxliteResult<MountInfo> {
        let control = MountControlClient::connect(&box_dir.0).unwrap();
        coordinator
            .clone()
            .add(
                "main",
                control,
                guest.clone(),
                MountRequest {
                    source: source.to_path_buf(),
                    target: PathBuf::from(target),
                    read_only,
                },
            )
            .await
    }

    #[tokio::test]
    async fn add_records_the_mount_and_reaches_guest_and_control() {
        let tag = "ctl-coord-add";
        let (box_dir, filesystem) = spawn_control(tag);
        let coordinator = Arc::new(MountCoordinator::new());
        let guest = StubGuest::healthy();

        let info = coordinator_add(
            &coordinator,
            &box_dir,
            &guest,
            &box_dir.0.join("share"),
            "/workspace",
            true,
        )
        .await
        .unwrap();

        assert_eq!(info.state, MountState::Mounted);
        assert!(info.read_only);
        assert_eq!(info.target, PathBuf::from("/workspace"));
        assert!(
            guest
                .calls()
                .iter()
                .any(|call| { call.starts_with("mount main boxlite-m1 boxlite /workspace true") }),
            "guest calls: {:?}",
            guest.calls()
        );
        assert_eq!(coordinator.list().len(), 1);
        assert_eq!(
            coordinator.get(Path::new("/workspace")).unwrap().target,
            PathBuf::from("/workspace")
        );
        let _ = filesystem; // the aggregate stays registered for the server
        let _ = tag;
    }

    #[tokio::test]
    async fn guest_failure_rolls_the_registration_back() {
        let tag = "ctl-coord-rollback";
        let (box_dir, _filesystem) = spawn_control(tag);
        let coordinator = Arc::new(MountCoordinator::new());
        let guest = StubGuest::failing_mount();

        let error = coordinator_add(
            &coordinator,
            &box_dir,
            &guest,
            &box_dir.0.join("share"),
            "/workspace",
            false,
        )
        .await
        .unwrap_err();

        assert!(
            error.to_string().contains("injected"),
            "surfaces the guest error: {error}"
        );
        assert!(coordinator.list().is_empty());
        // The registration rolled back: the first export name is free again.
        assert!(
            name_is_free(&box_dir, "boxlite-m1", &box_dir.0.join("share")).await,
            "rollback must release the export name"
        );
    }

    #[tokio::test]
    async fn registration_failure_keeps_the_guest_uninvolved() {
        let tag = "ctl-coord-dup";
        let (box_dir, _filesystem) = spawn_control(tag);
        let coordinator = Arc::new(MountCoordinator::new());
        let guest = StubGuest::healthy();

        // Pre-register the first export name the coordinator would pick.
        let mut client = MountControlClient::connect(&box_dir.0).unwrap();
        let handle = File::open(box_dir.0.join("share")).unwrap();
        client.register("boxlite-m1".into(), handle, false).unwrap();

        let error = coordinator_add(
            &coordinator,
            &box_dir,
            &guest,
            &box_dir.0.join("share"),
            "/workspace",
            false,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("register"), "{error}");
        assert!(
            guest.calls().is_empty(),
            "the guest must not see a failed registration: {:?}",
            guest.calls()
        );
    }

    #[tokio::test]
    async fn source_open_failures_precede_everything() {
        let tag = "ctl-coord-open";
        let (box_dir, _filesystem) = spawn_control(tag);
        let coordinator = Arc::new(MountCoordinator::new());
        let guest = StubGuest::healthy();

        let regular = File::create(box_dir.0.join("regular")).unwrap();
        drop(regular);
        let error = coordinator_add(
            &coordinator,
            &box_dir,
            &guest,
            &box_dir.0.join("regular"),
            "/workspace",
            false,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("open source"), "{error}");
        assert!(guest.calls().is_empty());

        let error = coordinator_add(
            &coordinator,
            &box_dir,
            &guest,
            Path::new("relative/source"),
            "/workspace",
            false,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("absolute"), "{error}");
        assert!(guest.calls().is_empty());
    }

    #[tokio::test]
    async fn remove_detaches_retires_and_converges() {
        let tag = "ctl-coord-remove";
        let (box_dir, _filesystem) = spawn_control(tag);
        let coordinator = Arc::new(MountCoordinator::new());
        let guest = StubGuest::healthy();
        coordinator_add(
            &coordinator,
            &box_dir,
            &guest,
            &box_dir.0.join("share"),
            "/workspace",
            false,
        )
        .await
        .unwrap();

        coordinator
            .clone()
            .remove(
                "main",
                MountControlClient::connect(&box_dir.0).unwrap(),
                guest.clone(),
                PathBuf::from("/workspace"),
            )
            .await
            .unwrap();
        assert!(coordinator.get(Path::new("/workspace")).is_none());
        assert!(
            guest
                .calls()
                .iter()
                .any(|call| call.starts_with("detach main /workspace"))
        );
        // The registration retired: the internal name is free again.
        assert!(
            name_is_free(&box_dir, "boxlite-m1", &box_dir.0.join("share")).await,
            "removal must release the export name"
        );

        // Detaching an absent target is a clean NotFound.
        let error = coordinator
            .clone()
            .remove(
                "main",
                MountControlClient::connect(&box_dir.0).unwrap(),
                guest.clone(),
                PathBuf::from("/absent"),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("no mount"), "{error}");
    }

    #[tokio::test]
    async fn detach_failure_lands_in_detaching_and_a_retry_converges() {
        let tag = "ctl-coord-converge";
        let (box_dir, _filesystem) = spawn_control(tag);
        let coordinator = Arc::new(MountCoordinator::new());
        let healthy = StubGuest::healthy();
        coordinator_add(
            &coordinator,
            &box_dir,
            &healthy,
            &box_dir.0.join("share"),
            "/workspace",
            false,
        )
        .await
        .unwrap();

        let failing = StubGuest::failing_detach();
        let error = coordinator
            .clone()
            .remove(
                "main",
                MountControlClient::connect(&box_dir.0).unwrap(),
                failing.clone(),
                PathBuf::from("/workspace"),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("injected"), "{error}");
        assert_eq!(
            coordinator.get(Path::new("/workspace")).unwrap().state,
            MountState::Detaching,
            "queries report the real, unfinished state"
        );

        // A healthy retry converges: the record drops.
        coordinator
            .clone()
            .remove(
                "main",
                MountControlClient::connect(&box_dir.0).unwrap(),
                healthy.clone(),
                PathBuf::from("/workspace"),
            )
            .await
            .unwrap();
        assert!(coordinator.get(Path::new("/workspace")).is_none());
    }

    #[tokio::test]
    async fn a_hanging_guest_times_out_and_rolls_back() {
        let tag = "ctl-coord-timeout";
        let (box_dir, _filesystem) = spawn_control(tag);
        let coordinator = Arc::new(MountCoordinator::with_guest_timeout(Duration::from_millis(
            80,
        )));
        let guest = StubGuest::hanging_mount();

        let error = coordinator_add(
            &coordinator,
            &box_dir,
            &guest,
            &box_dir.0.join("share"),
            "/workspace",
            false,
        )
        .await
        .unwrap_err();
        assert!(
            error.to_string().contains("did not finish within"),
            "{error}"
        );
        assert!(coordinator.list().is_empty());
        assert!(
            name_is_free(&box_dir, "boxlite-m1", &box_dir.0.join("share")).await,
            "the timeout rolls the registration back"
        );
    }

    // The socket name import stays honest with the server the tests spawn.
    const _: &str = MOUNT_CONTROL_SOCKET;
    const _: fn(CString) = |_| {};
    const _: &str = "seed";
}
