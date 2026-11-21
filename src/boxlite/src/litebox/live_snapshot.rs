//! Durable online snapshot transaction for the local libkrun container disk.

use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db::current_boot_id;
use crate::db::snapshot::SnapshotStore;
use crate::disk::constants::filenames::CONTAINER_DISK;
use crate::disk::qcow2::MAX_BACKING_CHAIN_DEPTH;
use crate::disk::{DiskInfo, Qcow2Helper, read_backing_file_path};
use crate::litebox::box_impl::BoxImpl;
use crate::litebox::local_snapshot::LIVE_SNAPSHOT_JOURNAL;
use crate::litebox::snapshot_mgr::{SnapshotInfo, SnapshotManager, validate_snapshot_name};
use crate::net::socket_path::BoxSockets;
use crate::util::{PidFileReader, PidRecord};
use crate::vmm::live_snapshot::{Command, FENCE_WINDOW, FileId, Phase, Request, monotonic_nanos};
use crate::vmm::vmm_socket::{self, ControlError, ControlOp, ControlReply, ControlRequest};

const CONTROL_TIMEOUT: Duration = Duration::from_secs(2);
const JOURNAL_VERSION: u32 = 1;
const MAX_JOURNAL_BYTES: u64 = 32 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
enum Decision {
    Pending,
    AbortReady,
    Commit,
}

#[derive(Clone, Serialize, Deserialize)]
struct Journal {
    version: u32,
    decision: Decision,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    finished: bool,
    boot_id: String,
    shim: PidRecord,
    info: SnapshotInfo,
    reservation: Option<FileId>,
    source: FileId,
    overlay: Option<FileId>,
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    record: Journal,
    checksum: String,
}

#[derive(Clone)]
struct Paths {
    home: PathBuf,
    disks: PathBuf,
    snapshots: PathBuf,
    active: PathBuf,
    reservation: PathBuf,
    target: PathBuf,
    saved: PathBuf,
    staged: PathBuf,
    journal: PathBuf,
}

impl Paths {
    fn new(home: &Path, name: &str, transaction: &str) -> BoxliteResult<Self> {
        validate_snapshot_name(name)?;
        if transaction.len() != 21
            || !transaction
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(storage("invalid snapshot transaction ID"));
        }
        if !home.is_absolute() {
            return Err(BoxliteError::InvalidState(
                "live snapshots require an absolute box directory".into(),
            ));
        }
        let disks = home.join("disks");
        let snapshots = home.join("snapshots");
        let target = snapshots.join(name);
        Ok(Self {
            home: home.to_path_buf(),
            active: disks.join(CONTAINER_DISK),
            saved: target.join(CONTAINER_DISK),
            reservation: snapshots.join(format!(".live-{transaction}")),
            staged: target.join(".overlay.qcow2"),
            journal: home.join(LIVE_SNAPSHOT_JOURNAL),
            disks,
            snapshots,
            target,
        })
    }

    fn qualify(&self, source: FileId) -> BoxliteResult<()> {
        self.check_directories(source)?;
        require_missing(&self.target)?;
        require_missing(&self.reservation)?;
        qualify_rename(&self.disks, &self.snapshots).map_err(|error| {
            BoxliteError::InvalidState(format!(
                "snapshot filesystem lacks exclusive rename: {error}"
            ))
        })
    }

    fn check_directories(&self, source: FileId) -> BoxliteResult<()> {
        for directory in [&self.home, &self.disks, &self.snapshots] {
            if dir_identity(directory)?.device != source.device {
                return Err(BoxliteError::InvalidState(
                    "live snapshots require one filesystem".into(),
                ));
            }
        }
        Ok(())
    }

    fn reserve(&self, journal: &mut Journal) -> BoxliteResult<()> {
        fs::create_dir(&self.reservation)?;
        journal.reservation = Some(dir_identity(&self.reservation)?);
        sync_dir(&self.snapshots)?;
        journal.save(self)?;
        rename_exclusive(&self.reservation, &self.target)?;
        sync_dir(&self.snapshots)?;
        Ok(())
    }
}

impl Journal {
    fn save(&self, paths: &Paths) -> BoxliteResult<()> {
        let checksum = checksum(self)?;
        let mut temp = tempfile::NamedTempFile::new_in(&paths.home)?;
        serde_json::to_writer(
            &mut temp,
            &serde_json::json!({ "record": self, "checksum": checksum }),
        )?;
        temp.flush()?;
        temp.as_file().sync_all()?;
        temp.persist(&paths.journal).map_err(|error| error.error)?;
        sync_dir(&paths.home)?;
        Ok(())
    }

    fn load(home: &Path, box_id: &str) -> BoxliteResult<Option<(Self, Paths)>> {
        let path = home.join(LIVE_SNAPSHOT_JOURNAL);
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() > MAX_JOURNAL_BYTES {
            return Err(storage("invalid live snapshot journal file"));
        }
        let env: Envelope = serde_json::from_reader((&file).take(MAX_JOURNAL_BYTES))?;
        let record = env.record;
        let paths = Paths::new(home, &record.info.name, &record.info.id)?;
        if record.version != JOURNAL_VERSION
            || record.info.box_id != box_id
            || record.shim.start_time.is_none()
            || record.shim.pid < 2
            || record.boot_id.is_empty()
            || record.info.disk_info.as_path() != paths.saved
            || env.checksum != checksum(&record)?
            || (record.decision == Decision::Commit
                && (record.overlay.is_none() || record.reservation.is_none()))
        {
            return Err(storage(
                "live snapshot journal identity or checksum mismatch",
            ));
        }
        // A visible phase may be the result of a rename whose publisher died before fsync.
        file.sync_all()?;
        sync_dir(home)?;
        let opened = FileId {
            device: metadata.dev(),
            inode: metadata.ino(),
        };
        if FileId::at(&path)? != opened {
            return Err(storage("live snapshot journal changed during recovery"));
        }
        if record.finished {
            Self::remove_finished(&paths)?;
            return Ok(None);
        }
        paths.check_directories(record.source)?;
        Ok(Some((record, paths)))
    }

    fn peer_exited(&self) -> BoxliteResult<bool> {
        let boot = current_boot_id().ok_or_else(|| storage("can't verify host boot identity"))?;
        if boot != self.boot_id {
            return Ok(true);
        }
        match crate::util::process_start_time(self.shim.pid) {
            Some(start) => Ok(Some(start) != self.shim.start_time
                || !crate::util::is_process_alive(self.shim.pid)),
            None if !crate::util::is_process_alive(self.shim.pid) => Ok(true),
            None => Err(storage("can't verify the original snapshot shim exited")),
        }
    }

    fn prepare_abort(&mut self, paths: &Paths) -> BoxliteResult<()> {
        if self.decision == Decision::Commit {
            return Err(storage("can't abort a committed snapshot"));
        }
        let active = file_identity(&paths.active)?;
        let owns_target = self.owns_target(paths)?;
        if active != Some(self.source) {
            if !owns_target || file_identity(&paths.saved)? != Some(self.source) {
                return Err(storage("can't find the original live snapshot disk"));
            }
            if let Some(active) = active {
                if Some(active) != self.overlay || file_identity(&paths.staged)?.is_some() {
                    return Err(storage("unexpected image at the active disk path"));
                }
                rename_exclusive(&paths.active, &paths.staged)?;
            }
            rename_exclusive(&paths.saved, &paths.active)?;
        } else if owns_target && file_identity(&paths.saved)?.is_some() {
            return Err(storage("unexpected file at the reserved snapshot path"));
        }
        sync_dir(&paths.disks)?;
        if owns_target {
            sync_dir(&paths.target)?;
        }
        self.decision = Decision::AbortReady;
        self.save(paths)
    }

    fn confirm_commit(&self, paths: &Paths) -> BoxliteResult<FileId> {
        let overlay = self
            .overlay
            .ok_or_else(|| storage("committed snapshot lacks an overlay identity"))?;
        if !self.owns_target(paths)?
            || file_identity(&paths.saved)? != Some(self.source)
            || file_identity(&paths.active)? != Some(overlay)
            || file_identity(&paths.staged)?.is_some()
            || read_backing_file_path(&paths.active)?.as_deref() != paths.saved.to_str()
        {
            return Err(storage("committed snapshot files don't match the journal"));
        }
        Ok(overlay)
    }

    fn owns_target(&self, paths: &Paths) -> BoxliteResult<bool> {
        Ok(self.reservation.is_some() && optional_dir_identity(&paths.target)? == self.reservation)
    }

    fn finish(&mut self, paths: &Paths) -> BoxliteResult<()> {
        if self.decision == Decision::AbortReady {
            if self.owns_target(paths)? {
                if let Some(staged) = file_identity(&paths.staged)? {
                    if self.overlay.is_some_and(|expected| expected != staged) {
                        return Err(storage("unexpected staged live snapshot image"));
                    }
                    fs::remove_file(&paths.staged)?;
                    sync_dir(&paths.target)?;
                }
                fs::remove_dir(&paths.target)?;
            }
            if let Some(reservation) = optional_dir_identity(&paths.reservation)? {
                if self
                    .reservation
                    .is_some_and(|expected| expected != reservation)
                {
                    return Err(storage("unexpected snapshot reservation directory"));
                }
                fs::remove_dir(&paths.reservation)?;
            }
            sync_dir(&paths.snapshots)?;
        }
        // A crash before the following unlink is durable may resurrect the marker.
        // Replay of a finished transaction must not touch disks changed since it settled.
        self.finished = true;
        self.save(paths)?;
        Self::remove_finished(paths)
    }

    fn remove_finished(paths: &Paths) -> BoxliteResult<()> {
        fs::remove_file(&paths.journal)?;
        sync_dir(&paths.home)?;
        Ok(())
    }
}

struct Shim {
    socket: PathBuf,
    identity: PidRecord,
}

impl Shim {
    fn for_box(home: &Path, box_id: &str, identity: PidRecord) -> Self {
        let socket = BoxSockets::new(box_id.to_owned(), home.join("sockets")).vmm_sock();
        Self { socket, identity }
    }

    async fn call(
        &self,
        transaction: &str,
        command: Command,
        timeout: Duration,
    ) -> BoxliteResult<(Phase, PidRecord)> {
        let request = ControlRequest {
            version: vmm_socket::VERSION,
            op: ControlOp::DiskSnapshot(Request {
                transaction: transaction.to_owned(),
                command,
            }),
        };
        let (response, peer) =
            vmm_socket::request_from_shim(&self.socket, &request, self.identity, timeout)
                .await
                .map_err(|error| match error.kind() {
                    io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused => {
                        BoxliteError::InvalidState(
                            "shim does not support live snapshots; stop the box first".into(),
                        )
                    }
                    _ => storage(error),
                })?;
        match response {
            Ok(ControlReply::DiskSnapshot(phase)) => Ok((phase, peer)),
            Err(ControlError::Unsupported(message)) => Err(BoxliteError::InvalidState(message)),
            Err(error) => Err(storage(error)),
            _ => Err(storage("unexpected live snapshot reply")),
        }
    }

    async fn expect(
        &self,
        journal: &Journal,
        command: Command,
        phase: Phase,
        until: u64,
    ) -> BoxliteResult<()> {
        let (reported, peer) = self
            .call(&journal.info.id, command, remaining(until)?)
            .await?;
        if reported != phase || peer != journal.shim {
            return Err(storage(format!(
                "snapshot worker reported {reported:?}, expected {phase:?}"
            )));
        }
        Ok(())
    }
}

pub(crate) async fn create(
    box_impl: &BoxImpl,
    name: &str,
    deadline: tokio::sync::oneshot::Sender<tokio::time::Instant>,
) -> BoxliteResult<SnapshotInfo> {
    let home = &box_impl.config.box_home;
    let runtime = &box_impl.runtime;
    let box_id = box_impl.id().as_str();
    let pid = box_impl.state.read().pid;
    let launcher = PidFileReader::at(home.join("shim.pid"))
        .verified_shim()
        .map(|shim| shim.identity())
        .filter(|identity| Some(identity.pid) == pid)
        .ok_or_else(|| {
            BoxliteError::InvalidState("could not verify the running box shim".into())
        })?;
    let transaction = nanoid::nanoid!();
    let (phase, peer) = Shim::for_box(home, box_id, launcher)
        .call(&transaction, Command::Status, CONTROL_TIMEOUT)
        .await?;
    if phase != Phase::Absent {
        return Err(storage(
            "snapshot transaction is already known to the worker",
        ));
    }
    let shim = Shim::for_box(home, box_id, peer);
    let paths = Paths::new(home, name, &transaction)?;
    let source = FileId::at(&paths.active)?;
    validate_chain(
        &paths,
        &runtime.layout.image_layout().disk_images_dir(),
        &runtime.snapshot_mgr,
        box_id,
    )?;
    paths.qualify(source)?;
    let boot_id = current_boot_id().ok_or_else(|| storage("can't verify host boot identity"))?;
    let mut journal = Journal {
        version: JOURNAL_VERSION,
        decision: Decision::Pending,
        finished: false,
        boot_id,
        shim: peer,
        info: SnapshotInfo {
            id: transaction,
            box_id: box_id.to_owned(),
            name: name.to_owned(),
            created_at: chrono::Utc::now().timestamp(),
            disk_info: DiskInfo {
                base_path: paths
                    .saved
                    .to_str()
                    .ok_or_else(|| storage("invalid snapshot path"))?
                    .to_owned(),
                container_disk_bytes: Qcow2Helper::qcow2_virtual_size(&paths.active)?,
                size_bytes: 0,
            },
        },
        reservation: None,
        source,
        overlay: None,
    };
    sync_dir(home)?;
    journal.save(&paths)?;
    paths.reserve(&mut journal)?;
    let until = monotonic_nanos().saturating_add(FENCE_WINDOW.as_nanos() as u64);
    let _ = deadline.send(tokio::time::Instant::now() + remaining(until)?);
    let database = runtime.layout.db_dir().join("boxlite.db");
    match create_fenced(&paths, &mut journal, &shim, &database, until).await {
        Ok(()) => Ok(journal.info),
        Err(error) => {
            if remaining(until).is_ok()
                && let Err(recovery) = recover(home, box_id, &database).await
            {
                tracing::warn!(%box_id, snapshot = %name, %recovery, "Live snapshot journal retained");
            }
            Err(error)
        }
    }
}

async fn create_fenced(
    paths: &Paths,
    journal: &mut Journal,
    shim: &Shim,
    database: &Path,
    until: u64,
) -> BoxliteResult<()> {
    shim.expect(
        journal,
        Command::Fence {
            source: journal.source,
            deadline: until,
        },
        Phase::Fenced,
        until,
    )
    .await?;
    let (updated, overlay) = disk_io({
        let paths = paths.clone();
        let mut journal = journal.clone();
        move || {
            let overlay = stage_and_pivot(&paths, &mut journal, until)?;
            Ok((journal, overlay))
        }
    })
    .await?;
    *journal = updated;
    shim.expect(
        journal,
        Command::Install {
            source: journal.source,
            overlay,
            snapshot: journal.info.name.clone(),
        },
        Phase::Installed,
        until,
    )
    .await?;
    journal.decision = Decision::Commit;
    disk_io({
        let paths = paths.clone();
        let journal = journal.clone();
        let database = database.to_path_buf();
        move || {
            remaining(until)?;
            journal.save(&paths)?;
            loop {
                remaining(until)?;
                if SnapshotStore::register_live(&database, &journal.info)? {
                    break Ok(());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    })
    .await?;
    shim.expect(
        journal,
        Command::Release { overlay },
        Phase::Committed,
        until,
    )
    .await?;
    disk_io({
        let paths = paths.clone();
        let mut journal = journal.clone();
        move || journal.finish(&paths)
    })
    .await
}

async fn disk_io<T: Send + 'static>(
    work: impl FnOnce() -> BoxliteResult<T> + Send + 'static,
) -> BoxliteResult<T> {
    tokio::task::spawn_blocking(work).await.map_err(storage)?
}

fn stage_and_pivot(paths: &Paths, journal: &mut Journal, until: u64) -> BoxliteResult<FileId> {
    remaining(until)?;
    if FileId::at(&paths.active)? != journal.source {
        return Err(storage("active disk changed after the worker fence"));
    }
    journal.info.disk_info.size_bytes = fs::metadata(&paths.active)?.len();
    Qcow2Helper::write_snapshot_overlay(
        &paths.staged,
        &paths.saved,
        journal.info.disk_info.container_disk_bytes,
    )?;
    File::open(&paths.staged)?.sync_all()?;
    let overlay = FileId::at(&paths.staged)?;
    journal.overlay = Some(overlay);
    journal.save(paths)?;
    sync_dir(&paths.target)?;
    remaining(until)?;
    rename_exclusive(&paths.active, &paths.saved)?;
    remaining(until)?;
    rename_exclusive(&paths.staged, &paths.active)?;
    sync_dir(&paths.disks)?;
    sync_dir(&paths.target)?;
    Ok(overlay)
}

/// Reconcile a pending journal under the box's disk and lifecycle admission.
pub(crate) async fn recover(home: &Path, box_id: &str, database: &Path) -> BoxliteResult<()> {
    let Some((mut journal, paths)) = Journal::load(home, box_id)? else {
        return Ok(());
    };
    if journal.peer_exited()? {
        return recover_exited(&mut journal, &paths, database);
    }
    let shim = Shim::for_box(home, box_id, journal.shim);
    let (phase, peer) = shim
        .call(&journal.info.id, Command::Status, CONTROL_TIMEOUT)
        .await?;
    if peer != journal.shim {
        return Err(storage("live snapshot recovery found a different shim"));
    }
    let until = monotonic_nanos().saturating_add(CONTROL_TIMEOUT.as_nanos() as u64);
    match journal.decision {
        Decision::Commit => {
            if !matches!(phase, Phase::Installed | Phase::Committed) {
                return Err(storage("surviving shim has no installed committed overlay"));
            }
            let overlay = journal.confirm_commit(&paths)?;
            register_once(database, &journal.info)?;
            shim.expect(
                &journal,
                Command::Release { overlay },
                Phase::Committed,
                until,
            )
            .await?;
        }
        Decision::Pending | Decision::AbortReady => {
            if phase == Phase::Committed {
                return Err(storage("surviving shim reports an unexpected commit"));
            }
            if phase == Phase::Absent && FileId::at(&paths.active)? != journal.source {
                return Err(storage(
                    "unfenced worker while snapshot disks are displaced",
                ));
            }
            journal.prepare_abort(&paths)?;
            if phase != Phase::Absent {
                shim.expect(
                    &journal,
                    Command::Abort {
                        source: journal.source,
                    },
                    Phase::Aborted,
                    until,
                )
                .await?;
            }
        }
    }
    journal.finish(&paths)
}

/// Startup may settle a journal only after it proves the original writer exited.
pub(crate) fn recover_if_exited(home: &Path, box_id: &str, database: &Path) -> BoxliteResult<()> {
    if let Some((mut journal, paths)) = Journal::load(home, box_id)?
        && journal.peer_exited()?
    {
        recover_exited(&mut journal, &paths, database)?;
    }
    Ok(())
}

fn recover_exited(journal: &mut Journal, paths: &Paths, database: &Path) -> BoxliteResult<()> {
    if journal.decision == Decision::Commit {
        journal.confirm_commit(paths)?;
        register_once(database, &journal.info)?;
    } else {
        journal.prepare_abort(paths)?;
    }
    journal.finish(paths)
}

fn register_once(database: &Path, info: &SnapshotInfo) -> BoxliteResult<()> {
    if !SnapshotStore::register_live(database, info)? {
        return Err(storage("snapshot registration is busy; retry recovery"));
    }
    Ok(())
}

fn validate_chain(
    paths: &Paths,
    images: &Path,
    snapshots: &SnapshotManager,
    box_id: &str,
) -> BoxliteResult<()> {
    let mut current = paths.active.clone();
    let mut seen = std::collections::HashSet::new();
    let images = images.canonicalize()?;
    let snapshots_dir = paths.snapshots.canonicalize()?;
    while let Some(backing) = read_backing_file_path(&current)? {
        let backing = PathBuf::from(backing);
        if !backing.is_absolute() {
            return Err(BoxliteError::InvalidState(
                "live snapshot backing paths must be absolute".into(),
            ));
        }
        FileId::at(&backing)?;
        let canonical = backing.canonicalize()?;
        if !seen.insert(canonical.clone()) {
            return Err(BoxliteError::InvalidState(
                "live snapshot backing chain contains a cycle".into(),
            ));
        }
        // The new overlay adds one hop to the backing walk used to build the next jail.
        if seen.len() >= MAX_BACKING_CHAIN_DEPTH {
            return Err(BoxliteError::InvalidState(
                "another overlay would put the backing chain beyond the jail's supported depth"
                    .into(),
            ));
        }
        if canonical.parent() == Some(images.as_path())
            && canonical.extension().is_some_and(|ext| ext == "ext4")
        {
            return Ok(());
        }
        let parent = canonical
            .parent()
            .ok_or_else(|| storage("backing disk has no parent"))?;
        let name = parent
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if parent.parent() != Some(snapshots_dir.as_path())
            || canonical
                .file_name()
                .is_none_or(|name| name != CONTAINER_DISK)
            || snapshots
                .get(box_id, name)?
                .and_then(|info| info.disk_info.as_path().canonicalize().ok())
                .as_ref()
                != Some(&canonical)
        {
            return Err(BoxliteError::InvalidState(
                "live snapshot backing may have another writer; stop the box before creating a snapshot".into(),
            ));
        }
        current = backing;
    }
    Ok(())
}

fn checksum(record: &Journal) -> BoxliteResult<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(record)?)))
}

fn remaining(until: u64) -> BoxliteResult<Duration> {
    let remaining = until.saturating_sub(monotonic_nanos());
    if remaining == 0 {
        return Err(storage("live snapshot deadline expired"));
    }
    Ok(Duration::from_nanos(remaining))
}

fn file_identity(path: &Path) -> io::Result<Option<FileId>> {
    optional(FileId::at(path))
}

fn dir_identity(path: &Path) -> io::Result<FileId> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a snapshot directory",
        ));
    }
    Ok(FileId {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

fn optional_dir_identity(path: &Path) -> io::Result<Option<FileId>> {
    optional(dir_identity(path))
}

fn optional<T>(value: io::Result<T>) -> io::Result<Option<T>> {
    match value {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn require_missing(path: &Path) -> BoxliteResult<()> {
    if optional(fs::symlink_metadata(path))?.is_some() {
        return Err(BoxliteError::AlreadyExists(format!(
            "snapshot destination {} exists",
            path.display()
        )));
    }
    Ok(())
}

fn sync_dir(dir: &Path) -> io::Result<()> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(dir)?
        .sync_all()
}

fn qualify_rename(disks: &Path, snapshots: &Path) -> io::Result<()> {
    let source_scratch = tempfile::tempdir_in(disks)?;
    let target_scratch = tempfile::tempdir_in(snapshots)?;
    let source = source_scratch.path().join("source");
    let target = target_scratch.path().join("target");
    fs::create_dir(&source)?;
    fs::create_dir(&target)?;
    let source_id = dir_identity(&source)?;
    let target_id = dir_identity(&target)?;
    if !rename_exclusive(&source, &target)
        .is_err_and(|error| error.kind() == io::ErrorKind::AlreadyExists)
        || dir_identity(&source)? != source_id
        || dir_identity(&target)? != target_id
    {
        return Err(io::Error::other(
            "exclusive rename replaced an occupied destination",
        ));
    }
    fs::remove_dir(&target)?;
    rename_exclusive(&source, &target)?;
    if dir_identity(&target)? != source_id {
        return Err(io::Error::other(
            "exclusive rename didn't preserve directory identity",
        ));
    }
    // The switch and rollback both move files between these directories.
    rename_exclusive(&target, &source)?;
    Ok(())
}

fn rename_exclusive(from: &Path, to: &Path) -> io::Result<()> {
    let from = CString::new(from.as_os_str().as_bytes())?;
    let to = CString::new(to.as_os_str().as_bytes())?;
    // SAFETY: both C paths stay valid for the syscall.
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    // SAFETY: both C paths stay valid for the syscall.
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn storage(error: impl std::fmt::Display) -> BoxliteError {
    BoxliteError::Storage(format!("live disk snapshot: {error}"))
}

#[cfg(test)]
#[path = "tests/live_snapshot.rs"]
mod tests;
