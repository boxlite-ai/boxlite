//! Filesystem ownership and permission utilities.

use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use nix::dir::{Dir, OwningIter};
use nix::fcntl::{openat, AtFlags, OFlag};
use nix::libc;
use nix::sys::stat::{fstat, fstatat, Mode};
use nix::unistd::{close, fchown, fchownat, Gid, Uid};

const WARNING_SAMPLE_LIMIT: usize = 8;
const OWNERSHIP_SAMPLE_LIMIT: usize = 5;
const MAX_CONSECUTIVE_READ_ERRORS: usize = 3;

/// Fixes filesystem ownership to match current process uid:gid.
pub struct OwnershipFixer;

impl OwnershipFixer {
    /// Fix ownership of all files/directories to current uid:gid if needed.
    ///
    /// Checks ownership first and skips if already correct.
    pub fn fix_if_needed(path: &Path) -> BoxliteResult<()> {
        let current_uid = unsafe { libc::getuid() };
        let current_gid = unsafe { libc::getgid() };
        Self::fix_for_owner(path, current_uid, current_gid)
    }

    fn fix_for_owner(path: &Path, current_uid: u32, current_gid: u32) -> BoxliteResult<()> {
        let mut root = OwnershipRoot::open(path)?;

        // Check if ownership fix is needed by sampling root and subdirectories
        if root.ownership_matches(current_uid, current_gid) {
            tracing::debug!(
                "Ownership of {} already matches {}:{}",
                path.display(),
                current_uid,
                current_gid
            );
            return Ok(());
        }

        tracing::info!(
            "Fixing ownership of {} to {}:{}",
            path.display(),
            current_uid,
            current_gid
        );

        let start = std::time::Instant::now();
        let report = RecursiveChowner::new(current_uid, current_gid).chown(root);
        let duration = start.elapsed();

        if report.has_warnings() {
            tracing::warn!(
                "Ownership repair of {} to {}:{} completed with warnings in {:?}: \
                 visited={}, changed={}, failures={}, cycles={}, samples={:?}",
                path.display(),
                current_uid,
                current_gid,
                duration,
                report.visited,
                report.changed,
                report.failures,
                report.cycles,
                report.warning_samples
            );
        } else {
            tracing::info!(
                "Fixed ownership of {} to {}:{} in {:?} (visited={}, changed={})",
                path.display(),
                current_uid,
                current_gid,
                duration,
                report.visited,
                report.changed
            );
        }

        Ok(())
    }
}

struct OwnershipRoot {
    directory: Dir,
    path: PathBuf,
    stat: libc::stat,
    #[cfg(test)]
    test_sampling_failure: Option<TestSamplingFailure>,
}

impl OwnershipRoot {
    fn open(path: &Path) -> BoxliteResult<Self> {
        let directory = Self::open_without_symlinks(path)
            .map_err(|error| Self::root_error("open", path, error))?;
        let stat =
            fstat(directory.as_raw_fd()).map_err(|error| Self::root_error("stat", path, error))?;

        Ok(Self {
            directory,
            path: path.to_path_buf(),
            stat,
            #[cfg(test)]
            test_sampling_failure: None,
        })
    }

    /// Open each component relative to an already-open parent so no pathname
    /// spelling can move a symlink out of `O_NOFOLLOW`'s final-component check.
    fn open_without_symlinks(path: &Path) -> nix::Result<Dir> {
        let directory_flags =
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        if path.as_os_str().is_empty() {
            return Dir::open(path, directory_flags, Mode::empty());
        }

        let base = if path.is_absolute() {
            std::ffi::OsStr::new("/")
        } else {
            std::ffi::OsStr::new(".")
        };
        let mut parent = Self::open_path_component(None, base)?;
        for component in path.components() {
            let name = match component {
                Component::RootDir | Component::CurDir => continue,
                Component::ParentDir => std::ffi::OsStr::new(".."),
                Component::Normal(name) => name,
                Component::Prefix(_) => unreachable!("Unix paths have no prefixes"),
            };
            parent = Self::open_path_component(Some(parent.as_raw_fd()), name)?;
        }

        Dir::openat(
            Some(parent.as_raw_fd()),
            Path::new("."),
            directory_flags,
            Mode::empty(),
        )
    }

    fn open_path_component(parent_fd: Option<i32>, name: &std::ffi::OsStr) -> nix::Result<OwnedFd> {
        let fd = openat(
            parent_fd,
            name,
            OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )?;
        // SAFETY: `openat` returned a new descriptor whose sole owner is this value.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    #[cfg(test)]
    fn with_test_sampling_failure(mut self, failure: TestSamplingFailure) -> Self {
        self.test_sampling_failure = Some(failure);
        self
    }

    /// Check if ownership of the root and a bounded sample of its entries matches.
    fn ownership_matches(&mut self, expected_uid: u32, expected_gid: u32) -> bool {
        if self.stat.st_uid != expected_uid || self.stat.st_gid != expected_gid {
            return false;
        }

        let root_fd = self.directory.as_raw_fd();
        let mut sampled = 0;
        #[cfg(test)]
        let mut test_sampling_failure = self.test_sampling_failure.take();
        let mut entries = self.directory.iter();
        loop {
            #[cfg(test)]
            let next_entry = if test_sampling_failure == Some(TestSamplingFailure::Read) {
                test_sampling_failure = None;
                Some(Err(nix::errno::Errno::EIO))
            } else {
                entries.next()
            };
            #[cfg(not(test))]
            let next_entry = entries.next();
            let Some(entry) = next_entry else {
                break;
            };
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => return false,
            };
            let name = entry.file_name();
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }

            sampled += 1;
            #[cfg(test)]
            let stat_result = if test_sampling_failure == Some(TestSamplingFailure::Stat) {
                test_sampling_failure = None;
                Err(nix::errno::Errno::EIO)
            } else {
                fstatat(Some(root_fd), name, AtFlags::AT_SYMLINK_NOFOLLOW)
            };
            #[cfg(not(test))]
            let stat_result = fstatat(Some(root_fd), name, AtFlags::AT_SYMLINK_NOFOLLOW);
            let stat = match stat_result {
                Ok(stat) => stat,
                Err(_) => return false,
            };
            if stat.st_uid != expected_uid || stat.st_gid != expected_gid {
                return false;
            }
            if sampled == OWNERSHIP_SAMPLE_LIMIT {
                break;
            }
        }

        true
    }

    fn into_frame(self) -> DirectoryFrame {
        DirectoryFrame::new(self.directory, self.path, &self.stat)
    }

    fn root_error(operation: &str, path: &Path, error: nix::Error) -> BoxliteError {
        BoxliteError::Storage(format!(
            "Failed to {} ownership root {}: {}",
            operation,
            path.display(),
            error
        ))
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Eq, PartialEq)]
enum TestSamplingFailure {
    Read,
    Stat,
}

struct RecursiveChowner {
    uid: Uid,
    gid: Gid,
    report: ChownReport,
    #[cfg(test)]
    test_faults: TestFaults,
}

impl RecursiveChowner {
    fn new(uid: u32, gid: u32) -> Self {
        Self {
            uid: Uid::from_raw(uid),
            gid: Gid::from_raw(gid),
            report: ChownReport::default(),
            #[cfg(test)]
            test_faults: TestFaults::default(),
        }
    }

    #[cfg(test)]
    fn with_test_faults(mut self, test_faults: TestFaults) -> Self {
        self.test_faults = test_faults;
        self
    }

    fn chown(mut self, root: OwnershipRoot) -> ChownReport {
        self.report.visited = 1;
        let mut stack = vec![root.into_frame()];

        while !stack.is_empty() {
            #[cfg(test)]
            let inject_read_error = self
                .test_faults
                .should_fail_read(&stack.last().expect("non-empty directory stack").path);
            #[cfg(test)]
            let next_entry = if inject_read_error {
                Some(Err(nix::errno::Errno::EIO))
            } else {
                stack
                    .last_mut()
                    .expect("non-empty directory stack")
                    .entries
                    .next()
            };
            #[cfg(not(test))]
            let next_entry = stack
                .last_mut()
                .expect("non-empty directory stack")
                .entries
                .next();

            let entry = match next_entry {
                Some(Ok(entry)) => {
                    stack
                        .last_mut()
                        .expect("non-empty directory stack")
                        .consecutive_read_errors = 0;
                    entry
                }
                Some(Err(error)) => {
                    let (path, read_errors_exhausted) = {
                        let frame = stack.last_mut().expect("non-empty directory stack");
                        frame.consecutive_read_errors += 1;
                        (
                            frame.path.clone(),
                            frame.consecutive_read_errors >= MAX_CONSECUTIVE_READ_ERRORS,
                        )
                    };
                    self.report.record_failure("read directory", &path, error);
                    if read_errors_exhausted {
                        let frame = stack.pop().expect("non-empty directory stack");
                        self.chown_directory(frame);
                    }
                    continue;
                }
                None => {
                    let frame = stack.pop().expect("non-empty directory stack");
                    self.chown_directory(frame);
                    continue;
                }
            };

            let name = entry.file_name();
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }

            let parent = stack.last().expect("entry has a parent frame");
            let parent_fd = parent.entries.as_raw_fd();
            let path = parent
                .path
                .join(std::ffi::OsStr::from_bytes(name.to_bytes()));
            self.report.visited += 1;

            let stat = match fstatat(Some(parent_fd), name, AtFlags::AT_SYMLINK_NOFOLLOW) {
                Ok(stat) => stat,
                Err(error) => {
                    self.report.record_failure("stat", &path, error);
                    continue;
                }
            };

            if stat.st_mode & libc::S_IFMT != libc::S_IFDIR {
                self.chown_entry(parent_fd, name, &path);
                continue;
            }

            #[cfg(test)]
            let inject_open_error = self
                .test_faults
                .should_fail_descent(&path, TestDescentFailure::Open);
            #[cfg(test)]
            let child_open = if inject_open_error {
                Err(nix::errno::Errno::EMFILE)
            } else {
                openat(
                    Some(parent_fd),
                    name,
                    OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                    Mode::empty(),
                )
            };
            #[cfg(not(test))]
            let child_open = openat(
                Some(parent_fd),
                name,
                OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            );
            let child_fd = match child_open {
                Ok(fd) => fd,
                Err(error) => {
                    self.report.record_failure("open directory", &path, error);
                    self.chown_entry(parent_fd, name, &path);
                    continue;
                }
            };
            #[cfg(test)]
            let inject_stat_error = self
                .test_faults
                .should_fail_descent(&path, TestDescentFailure::Stat);
            #[cfg(test)]
            let child_stat_result = if inject_stat_error {
                Err(nix::errno::Errno::EIO)
            } else {
                fstat(child_fd)
            };
            #[cfg(not(test))]
            let child_stat_result = fstat(child_fd);
            let child_stat = match child_stat_result {
                Ok(stat) => stat,
                Err(error) => {
                    self.report.record_failure("stat directory", &path, error);
                    self.chown_fd(child_fd, &path);
                    let _ = close(child_fd);
                    continue;
                }
            };

            let child_identity = DirectoryIdentity::from(&child_stat);
            if stack
                .iter()
                .any(|ancestor| ancestor.identity == child_identity)
            {
                self.chown_fd(child_fd, &path);
                let _ = close(child_fd);
                self.report.record_cycle(&path);
                continue;
            }

            self.chown_fd(child_fd, &path);
            #[cfg(test)]
            let inject_stream_error = self
                .test_faults
                .should_fail_descent(&path, TestDescentFailure::Stream);
            #[cfg(test)]
            let child_stream = if inject_stream_error {
                let _ = close(child_fd);
                Err(nix::errno::Errno::EIO)
            } else {
                Dir::from_fd(child_fd)
            };
            #[cfg(not(test))]
            let child_stream = Dir::from_fd(child_fd);
            let child_dir = match child_stream {
                Ok(dir) => dir,
                Err(error) => {
                    self.report
                        .record_failure("open directory stream for", &path, error);
                    continue;
                }
            };
            stack.push(DirectoryFrame::new_after_chown(
                child_dir,
                path,
                &child_stat,
            ));
        }

        self.report
    }

    fn chown_entry(&mut self, parent_fd: i32, name: &std::ffi::CStr, path: &Path) {
        match fchownat(
            Some(parent_fd),
            name,
            Some(self.uid),
            Some(self.gid),
            AtFlags::AT_SYMLINK_NOFOLLOW,
        ) {
            Ok(()) => self.report.changed += 1,
            Err(error) => self.report.record_failure("chown", path, error),
        }
    }

    fn chown_directory(&mut self, frame: DirectoryFrame) {
        if frame.is_chown_pending {
            self.chown_fd(frame.entries.as_raw_fd(), &frame.path);
        }
    }

    fn chown_fd(&mut self, fd: i32, path: &Path) {
        match fchown(fd, Some(self.uid), Some(self.gid)) {
            Ok(()) => {
                self.report.changed += 1;
            }
            Err(error) => {
                self.report.record_failure("chown directory", path, error);
            }
        }
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Eq, PartialEq)]
enum TestDescentFailure {
    Open,
    Stat,
    Stream,
}

#[cfg(test)]
struct TestReadFault {
    path: PathBuf,
    schedule: std::collections::VecDeque<bool>,
    repeat_error: bool,
}

#[cfg(test)]
#[derive(Default)]
struct TestFaults {
    descent_failure: Option<(PathBuf, TestDescentFailure)>,
    read_fault: Option<TestReadFault>,
}

#[cfg(test)]
impl TestFaults {
    fn should_fail_descent(&mut self, path: &Path, stage: TestDescentFailure) -> bool {
        let should_fail =
            self.descent_failure
                .as_ref()
                .is_some_and(|(failure_path, failure_stage)| {
                    failure_path == path && *failure_stage == stage
                });
        if should_fail {
            self.descent_failure = None;
        }
        should_fail
    }

    fn should_fail_read(&mut self, path: &Path) -> bool {
        let Some(read_fault) = self.read_fault.as_mut() else {
            return false;
        };
        if read_fault.path != path {
            return false;
        }
        read_fault
            .schedule
            .pop_front()
            .unwrap_or(read_fault.repeat_error)
    }
}

struct DirectoryFrame {
    entries: OwningIter,
    path: PathBuf,
    identity: DirectoryIdentity,
    consecutive_read_errors: usize,
    is_chown_pending: bool,
}

impl DirectoryFrame {
    fn new(directory: Dir, path: PathBuf, stat: &libc::stat) -> Self {
        Self::with_chown_state(directory, path, stat, true)
    }

    fn new_after_chown(directory: Dir, path: PathBuf, stat: &libc::stat) -> Self {
        Self::with_chown_state(directory, path, stat, false)
    }

    fn with_chown_state(
        directory: Dir,
        path: PathBuf,
        stat: &libc::stat,
        is_chown_pending: bool,
    ) -> Self {
        Self {
            entries: directory.into_iter(),
            path,
            identity: DirectoryIdentity::from(stat),
            consecutive_read_errors: 0,
            is_chown_pending,
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct DirectoryIdentity {
    device: libc::dev_t,
    inode: libc::ino_t,
}

impl From<&libc::stat> for DirectoryIdentity {
    fn from(stat: &libc::stat) -> Self {
        Self {
            device: stat.st_dev,
            inode: stat.st_ino,
        }
    }
}

#[derive(Debug, Default)]
struct ChownReport {
    visited: usize,
    changed: usize,
    failures: usize,
    cycles: usize,
    warning_samples: Vec<String>,
}

impl ChownReport {
    fn has_warnings(&self) -> bool {
        self.failures != 0 || self.cycles != 0
    }

    fn record_failure(&mut self, operation: &str, path: &Path, error: nix::Error) {
        self.failures += 1;
        self.record_sample(format!(
            "{} {}: {}",
            operation,
            path.to_string_lossy(),
            error
        ));
    }

    fn record_cycle(&mut self, path: &Path) {
        self.cycles += 1;
        self.record_sample(format!(
            "skipped directory cycle at {}",
            path.to_string_lossy()
        ));
    }

    fn record_sample(&mut self, sample: String) {
        if self.warning_samples.len() < WARNING_SAMPLE_LIMIT {
            self.warning_samples.push(sample);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nix::mount::{mount, umount2, MntFlags, MsFlags};
    use nix::unistd::{chown, mkfifo, Gid, Uid};
    use std::ffi::OsString;
    use std::fs::{self, File, Permissions};
    use std::io::{self, Write};
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    use std::os::unix::net::UnixListener;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct CapturedLogs(Arc<Mutex<Vec<u8>>>);

    struct CapturedWriter(Arc<Mutex<Vec<u8>>>);

    impl CapturedLogs {
        fn contents(&self) -> String {
            String::from_utf8(self.0.lock().expect("lock captured logs").clone())
                .expect("tracing output is UTF-8")
        }
    }

    impl<'writer> tracing_subscriber::fmt::MakeWriter<'writer> for CapturedLogs {
        type Writer = CapturedWriter;

        fn make_writer(&'writer self) -> Self::Writer {
            CapturedWriter(Arc::clone(&self.0))
        }
    }

    impl Write for CapturedWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.0.lock().expect("lock captured logs").write(buffer)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct PathGuard(Option<std::ffi::OsString>);

    impl PathGuard {
        fn clear() -> Self {
            let original = std::env::var_os("PATH");
            std::env::set_var("PATH", "");
            Self(original)
        }
    }

    impl Drop for PathGuard {
        fn drop(&mut self) {
            if let Some(path) = self.0.take() {
                std::env::set_var("PATH", path);
            } else {
                std::env::remove_var("PATH");
            }
        }
    }

    struct MountGuard(PathBuf);

    impl Drop for MountGuard {
        fn drop(&mut self) {
            umount2(&self.0, MntFlags::MNT_DETACH).expect("unmount test bind mount");
        }
    }

    fn current_owner() -> (u32, u32) {
        (unsafe { libc::getuid() }, unsafe { libc::getgid() })
    }

    fn with_trailing_slashes(path: &Path, slash_count: usize) -> PathBuf {
        assert!(slash_count > 0);
        let mut bytes = path.as_os_str().as_bytes().to_vec();
        bytes.resize(bytes.len() + slash_count, b'/');
        PathBuf::from(OsString::from_vec(bytes))
    }

    fn chown_path_for_current_process(path: &Path) -> BoxliteResult<ChownReport> {
        let (uid, gid) = current_owner();
        let root = OwnershipRoot::open(path)?;
        Ok(RecursiveChowner::new(uid, gid).chown(root))
    }

    fn chown_path_with_test_faults(path: &Path, test_faults: TestFaults) -> ChownReport {
        let (uid, gid) = current_owner();
        let root = OwnershipRoot::open(path).expect("open ownership root");
        RecursiveChowner::new(uid, gid)
            .with_test_faults(test_faults)
            .chown(root)
    }

    fn descent_failure_report(stage: TestDescentFailure) -> ChownReport {
        let temp = tempfile::tempdir().expect("create temporary directory");
        let child = temp.path().join("child");
        fs::create_dir(&child).expect("create child directory");
        let test_faults = TestFaults {
            descent_failure: Some((child, stage)),
            read_fault: None,
        };
        chown_path_with_test_faults(temp.path(), test_faults)
    }

    fn ownership_sample_with_failure(failure: TestSamplingFailure) -> bool {
        let temp = tempfile::tempdir().expect("create temporary directory");
        File::create(temp.path().join("sampled")).expect("create sampled entry");
        let (uid, gid) = current_owner();
        let mut root = OwnershipRoot::open(temp.path())
            .expect("open ownership root")
            .with_test_sampling_failure(failure);
        root.ownership_matches(uid, gid)
    }

    fn read_fault(path: &Path, schedule: &[bool], repeat_error: bool) -> TestFaults {
        TestFaults {
            descent_failure: None,
            read_fault: Some(TestReadFault {
                path: path.to_path_buf(),
                schedule: schedule.iter().copied().collect(),
                repeat_error,
            }),
        }
    }

    fn set_mode(path: &Path, mode: u32) {
        fs::set_permissions(path, Permissions::from_mode(mode)).expect("set fixture mode");
    }

    fn set_distinct_owner(path: &Path) {
        let (uid, gid) = current_owner();
        let different_uid = if uid == 0 { 1 } else { 0 };
        let different_gid = if gid == 0 { 1 } else { 0 };
        chown(
            path,
            Some(Uid::from_raw(different_uid)),
            Some(Gid::from_raw(different_gid)),
        )
        .expect("privileged ownership test requires a mapped alternate uid/gid");
    }

    #[test]
    #[ignore = "mutates process PATH; run serially"]
    fn privileged_fix_does_not_depend_on_path() {
        let temp = tempfile::tempdir().expect("create temporary directory");
        let (uid, gid) = current_owner();
        let mismatched_gid = if gid == u32::MAX { gid - 1 } else { gid + 1 };

        let _path = PathGuard::clear();
        OwnershipFixer::fix_for_owner(temp.path(), uid, mismatched_gid)
            .expect("ownership repair must not depend on a PATH chown binary");
    }

    #[test]
    fn walks_non_utf8_and_deep_directory_names_without_recursion() {
        let temp = tempfile::tempdir().expect("create temporary directory");
        let non_utf8 = OsString::from_vec(vec![b'n', b'a', b'm', b'e', 0xff]);
        File::create(temp.path().join(non_utf8)).expect("create non-UTF-8 file");

        let mut deepest = temp.path().to_path_buf();
        for _ in 0..256 {
            deepest.push("d");
            fs::create_dir(&deepest).expect("create deep directory");
        }
        File::create(deepest.join("leaf")).expect("create deep leaf");

        let report = chown_path_for_current_process(temp.path()).expect("walk deep tree");

        assert_eq!(report.failures, 0);
        assert_eq!(report.cycles, 0);
        assert_eq!(report.visited, 259);
        assert_eq!(report.changed, report.visited);
    }

    #[test]
    fn sample_read_error_cannot_certify_matching_ownership() {
        assert!(!ownership_sample_with_failure(TestSamplingFailure::Read));
    }

    #[test]
    fn sample_stat_error_cannot_certify_matching_ownership() {
        assert!(!ownership_sample_with_failure(TestSamplingFailure::Stat));
    }

    #[test]
    fn directory_open_failure_still_chowns_inode() {
        let report = descent_failure_report(TestDescentFailure::Open);

        assert_eq!(report.visited, 2);
        assert_eq!(report.failures, 1);
        assert_eq!(report.changed, 2, "root and unopened child must be changed");
    }

    #[test]
    fn directory_stat_failure_still_chowns_inode() {
        let report = descent_failure_report(TestDescentFailure::Stat);

        assert_eq!(report.visited, 2);
        assert_eq!(report.failures, 1);
        assert_eq!(report.changed, 2, "root and opened child must be changed");
    }

    #[test]
    fn directory_stream_failure_still_chowns_inode() {
        let report = descent_failure_report(TestDescentFailure::Stream);

        assert_eq!(report.visited, 2);
        assert_eq!(report.failures, 1);
        assert_eq!(report.changed, 2, "root and opened child must be changed");
    }

    #[test]
    fn transient_directory_read_error_keeps_remaining_siblings() {
        let temp = tempfile::tempdir().expect("create temporary directory");
        File::create(temp.path().join("first")).expect("create first sibling");
        File::create(temp.path().join("second")).expect("create second sibling");
        let report =
            chown_path_with_test_faults(temp.path(), read_fault(temp.path(), &[true], false));

        assert_eq!(report.failures, 1);
        assert_eq!(report.visited, 3, "both siblings must be visited");
        assert_eq!(report.changed, 3, "root and both siblings must be changed");
    }

    #[test]
    fn persistent_directory_read_errors_are_bounded() {
        let temp = tempfile::tempdir().expect("create temporary directory");
        File::create(temp.path().join("unreachable")).expect("create sibling");
        let report = chown_path_with_test_faults(temp.path(), read_fault(temp.path(), &[], true));

        assert_eq!(
            report.failures, 3,
            "persistent reads stop after the retry cap"
        );
        assert_eq!(report.visited, 1, "persistent errors terminate the frame");
        assert_eq!(
            report.changed, 1,
            "the unreadable directory is still changed"
        );
    }

    #[test]
    fn successful_directory_reads_reset_the_error_budget() {
        let temp = tempfile::tempdir().expect("create temporary directory");
        File::create(temp.path().join("sibling")).expect("create sibling");
        let report = chown_path_with_test_faults(
            temp.path(),
            read_fault(temp.path(), &[true, false, true, false, true, false], false),
        );

        assert_eq!(report.failures, 3);
        assert_eq!(
            report.visited, 2,
            "successful reads reset consecutive errors"
        );
        assert_eq!(report.changed, 2, "root and sibling must be changed");
    }

    #[test]
    fn does_not_follow_external_or_dangling_symlinks() {
        let root = tempfile::tempdir().expect("create root directory");
        let outside = tempfile::tempdir().expect("create outside directory");
        let outside_file = outside.path().join("target");
        File::create(&outside_file).expect("create outside file");
        set_mode(&outside_file, 0o4755);

        symlink(&outside_file, root.path().join("external")).expect("create outside symlink");
        symlink("missing", root.path().join("dangling")).expect("create dangling symlink");

        let report = chown_path_for_current_process(root.path()).expect("walk symlinks");

        assert_eq!(report.failures, 0);
        assert_eq!(report.visited, 3);
        assert_ne!(
            fs::metadata(&outside_file)
                .expect("stat outside file")
                .mode()
                & 0o4000,
            0,
            "following the symlink would clear the target's setuid bit"
        );
    }

    #[test]
    fn handles_hardlinks_fifo_and_unix_socket() {
        let target_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target");
        let temp = tempfile::Builder::new()
            .prefix("boxlite-perms-")
            .tempdir_in(target_dir)
            .expect("create temporary directory");
        let original = temp.path().join("original");
        let hardlink = temp.path().join("hardlink");
        File::create(&original).expect("create hardlink source");
        fs::hard_link(&original, &hardlink).expect("create hardlink");
        mkfifo(&temp.path().join("fifo"), Mode::S_IRUSR | Mode::S_IWUSR).expect("create FIFO");
        let socket = match UnixListener::bind(temp.path().join("socket")) {
            Ok(socket) => Some(socket),
            Err(error) if error.raw_os_error() == Some(libc::EPERM) => {
                eprintln!("skipping Unix socket fixture: sandbox denies bind(2)");
                None
            }
            Err(error) => panic!("create Unix socket: {error}"),
        };

        let report = chown_path_for_current_process(temp.path()).expect("walk special files");

        assert_eq!(report.failures, 0);
        assert_eq!(report.visited, if socket.is_some() { 5 } else { 4 });
        assert_eq!(fs::metadata(original).expect("stat hardlink").nlink(), 2);
        drop(socket);
    }

    #[test]
    fn continues_after_entry_failures_and_bounds_warning_samples() {
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("skipping permission-denied fixture as root");
            return;
        }

        let temp = tempfile::tempdir().expect("create temporary directory");
        let sibling = temp.path().join("sibling");
        File::create(&sibling).expect("create successful sibling");
        let blocked: Vec<_> = (0..10)
            .map(|index| {
                let path = temp.path().join(format!("blocked-{index}"));
                fs::create_dir(&path).expect("create blocked directory");
                set_mode(&path, 0);
                path
            })
            .collect();

        let report =
            chown_path_for_current_process(temp.path()).expect("entry failures are non-fatal");

        for path in &blocked {
            set_mode(path, 0o700);
        }
        assert_eq!(report.failures, blocked.len());
        assert_eq!(report.warning_samples.len(), WARNING_SAMPLE_LIMIT);
        assert_eq!(
            report.changed,
            blocked.len() + 2,
            "root, sibling, and unopened directory inodes are changed"
        );
        assert!(sibling.exists());
    }

    #[test]
    fn rejects_missing_or_symlinked_root() {
        let temp = tempfile::tempdir().expect("create temporary directory");
        let missing = temp.path().join("missing");
        let missing_error =
            chown_path_for_current_process(&missing).expect_err("missing root must be fatal");
        assert!(missing_error
            .to_string()
            .contains("Failed to open ownership root"));

        let target = temp.path().join("target");
        fs::create_dir(&target).expect("create symlink target");
        let link = temp.path().join("link");
        symlink(&target, &link).expect("create root symlink");
        let link_error =
            chown_path_for_current_process(&link).expect_err("symlink root must be fatal");
        assert!(link_error
            .to_string()
            .contains("Failed to open ownership root"));
    }

    #[test]
    fn public_entry_rejects_symlinked_root_even_when_target_owner_matches() {
        let temp = tempfile::tempdir().expect("create temporary directory");
        let target = temp.path().join("target");
        fs::create_dir(&target).expect("create symlink target");
        let link = temp.path().join("link");
        symlink(&target, &link).expect("create root symlink");

        let error = OwnershipFixer::fix_if_needed(&link)
            .expect_err("public ownership repair must reject a symlinked root");
        assert!(error.to_string().contains("Failed to open ownership root"));
    }

    #[test]
    fn public_entry_rejects_symlinked_root_with_trailing_slash() {
        let temp = tempfile::tempdir().expect("create temporary directory");
        let target = temp.path().join("target");
        fs::create_dir(&target).expect("create symlink target");
        let link = temp.path().join("link");
        symlink(&target, &link).expect("create root symlink");
        let link_with_trailing_slash = PathBuf::from(format!("{}/", link.display()));

        let error = OwnershipFixer::fix_if_needed(&link_with_trailing_slash)
            .expect_err("public ownership repair must reject a trailing-slash symlink root");
        assert!(error.to_string().contains("Failed to open ownership root"));
    }

    #[test]
    fn public_entry_rejects_symlinked_root_with_self_directory_suffix() {
        let temp = tempfile::tempdir().expect("create temporary directory");
        let target = temp.path().join("target");
        fs::create_dir(&target).expect("create symlink target");
        let link = temp.path().join("link");
        symlink(&target, &link).expect("create root symlink");

        let error = OwnershipFixer::fix_if_needed(&link.join("."))
            .expect_err("public ownership repair must reject a symlink root written as link/.");
        assert!(error.to_string().contains("Failed to open ownership root"));
    }

    #[test]
    fn public_entry_rejects_symlinked_root_with_self_directory_and_trailing_slash() {
        let temp = tempfile::tempdir().expect("create temporary directory");
        let target = temp.path().join("target");
        fs::create_dir(&target).expect("create symlink target");
        let link = temp.path().join("link");
        symlink(&target, &link).expect("create root symlink");
        let path = with_trailing_slashes(&link.join("."), 1);

        let error = OwnershipFixer::fix_if_needed(&path)
            .expect_err("public ownership repair must reject a symlink root written as link/./");
        assert!(error.to_string().contains("Failed to open ownership root"));
    }

    #[test]
    fn public_entry_rejects_symlinked_intermediate_directory() {
        let temp = tempfile::tempdir().expect("create temporary directory");
        let target = temp.path().join("target");
        let child = target.join("child");
        fs::create_dir_all(&child).expect("create symlink target child");
        let link = temp.path().join("link");
        symlink(&target, &link).expect("create intermediate symlink");

        let error = OwnershipFixer::fix_if_needed(&link.join("child"))
            .expect_err("public ownership repair must reject an intermediate symlink");
        assert!(error.to_string().contains("Failed to open ownership root"));
    }

    #[test]
    fn public_entry_rejects_symlink_before_parent_directory_component() {
        let temp = tempfile::tempdir().expect("create temporary directory");
        let target = temp.path().join("target");
        fs::create_dir_all(target.join("child")).expect("create symlink target child");
        let link = temp.path().join("link");
        symlink(&target, &link).expect("create intermediate symlink");
        let path = link.join("child").join("..");

        let error = OwnershipFixer::fix_if_needed(&path)
            .expect_err("public ownership repair must reject a symlink before child/..");
        assert!(error.to_string().contains("Failed to open ownership root"));
    }

    #[test]
    fn public_entry_rejects_symlink_chain_with_multiple_trailing_slashes() {
        let temp = tempfile::tempdir().expect("create temporary directory");
        let target = temp.path().join("target");
        fs::create_dir(&target).expect("create symlink target");
        let first_link = temp.path().join("first-link");
        symlink(&target, &first_link).expect("create first root symlink");
        let second_link = temp.path().join("second-link");
        symlink(&first_link, &second_link).expect("create second root symlink");
        let path = with_trailing_slashes(&second_link, 2);

        let error = OwnershipFixer::fix_if_needed(&path)
            .expect_err("public ownership repair must reject a trailing-slash symlink chain");
        assert!(error.to_string().contains("Failed to open ownership root"));
    }

    #[test]
    fn public_entry_accepts_directory_roots_with_trailing_slashes() {
        let temp = tempfile::tempdir().expect("create temporary directory");
        let non_utf8_name = OsString::from_vec(vec![b'r', b'o', b'o', b't', 0xff]);
        let non_utf8_directory = temp.path().join(non_utf8_name);
        fs::create_dir(&non_utf8_directory).expect("create non-UTF-8 directory");

        for directory in [temp.path(), non_utf8_directory.as_path()] {
            for slash_count in [1, 2] {
                let path = with_trailing_slashes(directory, slash_count);
                OwnershipFixer::fix_if_needed(&path)
                    .expect("directory roots with trailing slashes remain valid");
            }
        }
    }

    #[test]
    fn public_entry_accepts_real_directory_dot_and_parent_components() {
        let temp = tempfile::tempdir().expect("create temporary directory");
        let root = temp.path().join("root");
        let child = root.join("child");
        fs::create_dir_all(&child).expect("create real directory components");
        let repeated_dot = with_trailing_slashes(&root.join(".").join("."), 2);
        let parent = child.join("..");

        for path in [repeated_dot, parent] {
            OwnershipFixer::fix_if_needed(&path)
                .expect("real dot and parent directory components remain valid");
        }
    }

    #[test]
    fn ownership_root_open_allows_search_only_intermediate_directory() {
        let temp = tempfile::tempdir().expect("create temporary directory");
        let intermediate = temp.path().join("search-only");
        let root = intermediate.join("root");
        fs::create_dir_all(&root).expect("create root below intermediate directory");
        set_mode(&intermediate, 0o111);

        let result = OwnershipRoot::open(&root);

        set_mode(&intermediate, 0o700);
        result.expect("opening a root only requires search access to its ancestors");
    }

    #[test]
    fn public_entry_preserves_relative_and_empty_path_behavior() {
        let relative = tempfile::Builder::new()
            .prefix("boxlite-relative-perms-")
            .tempdir_in(".")
            .expect("create relative temporary directory");
        let relative_path = Path::new(
            relative
                .path()
                .file_name()
                .expect("relative fixture has a final component"),
        );
        assert!(!relative_path.is_absolute());
        OwnershipFixer::fix_if_needed(relative_path).expect("relative directory remains valid");

        let empty_error = OwnershipFixer::fix_if_needed(Path::new(""))
            .expect_err("empty ownership root remains invalid");
        assert!(empty_error
            .to_string()
            .contains("Failed to open ownership root"));
    }

    #[test]
    fn ownership_root_open_preserves_filesystem_root_paths() {
        for path in [Path::new("/"), Path::new("////")] {
            let root = OwnershipRoot::open(path).expect("filesystem root path remains valid");
            assert_eq!(root.path, path);
        }
    }

    #[test]
    fn public_entry_rejects_missing_and_non_directory_roots_with_trailing_slashes() {
        let temp = tempfile::tempdir().expect("create temporary directory");
        let missing = with_trailing_slashes(&temp.path().join("missing"), 2);
        let missing_error = OwnershipFixer::fix_if_needed(&missing)
            .expect_err("missing root with trailing slashes must be fatal");
        assert!(missing_error
            .to_string()
            .contains("Failed to open ownership root"));

        let file = temp.path().join("file");
        File::create(&file).expect("create non-directory root");
        for path in [file.clone(), with_trailing_slashes(&file, 2)] {
            let file_error = OwnershipFixer::fix_if_needed(&path)
                .expect_err("non-directory ownership root must be fatal");
            assert!(file_error
                .to_string()
                .contains("Failed to open ownership root"));
        }
    }

    #[test]
    #[ignore = "requires root"]
    fn privileged_preserves_sampling_skip_behavior() {
        let temp = tempfile::tempdir().expect("create temporary directory");
        let sampled = temp.path().join("sampled");
        fs::create_dir(&sampled).expect("create sampled directory");
        let nested = sampled.join("nested");
        File::create(&nested).expect("create nested file");
        set_distinct_owner(&nested);
        let before = fs::symlink_metadata(&nested).expect("stat nested fixture");

        OwnershipFixer::fix_if_needed(temp.path()).expect("sampling skip succeeds");

        let after = fs::symlink_metadata(&nested).expect("stat nested file after skip");
        assert_eq!((after.uid(), after.gid()), (before.uid(), before.gid()));
    }

    #[test]
    #[ignore = "requires root"]
    fn privileged_blanket_fix_changes_the_whole_tree() {
        let temp = tempfile::tempdir().expect("create temporary directory");
        let directory = temp.path().join("directory");
        fs::create_dir(&directory).expect("create child directory");
        let file = directory.join("file");
        File::create(&file).expect("create child file");
        set_distinct_owner(&directory);
        set_distinct_owner(&file);

        OwnershipFixer::fix_if_needed(temp.path()).expect("blanket ownership fix");

        let expected = current_owner();
        for path in [temp.path(), directory.as_path(), file.as_path()] {
            let metadata = fs::symlink_metadata(path).expect("stat fixed path");
            assert_eq!((metadata.uid(), metadata.gid()), expected);
        }
    }

    #[test]
    #[ignore = "requires root"]
    fn privileged_continues_when_ownership_root_is_read_only() {
        let root = tempfile::tempdir().expect("create root directory");
        let source = tempfile::tempdir().expect("create read-only root source");
        mount(
            Option::<&str>::None,
            source.path(),
            Some("tmpfs"),
            MsFlags::empty(),
            Some("size=1m"),
        )
        .expect("mount private tmpfs fixture");
        let source_guard = MountGuard(source.path().to_path_buf());
        File::create(source.path().join("file")).expect("create root fixture file");

        mount(
            Some(source.path()),
            root.path(),
            Option::<&str>::None,
            MsFlags::MS_BIND,
            Option::<&str>::None,
        )
        .expect("bind root fixture");
        let root_guard = MountGuard(root.path().to_path_buf());
        let expected_owner = current_owner();
        let before = fs::symlink_metadata(root.path()).expect("stat root before repair");
        assert_eq!((before.uid(), before.gid()), expected_owner);
        mount(
            Option::<&Path>::None,
            root.path(),
            Option::<&str>::None,
            MsFlags::MS_BIND | MsFlags::MS_REMOUNT | MsFlags::MS_RDONLY,
            Option::<&str>::None,
        )
        .expect("remount root fixture read-only");
        let (uid, gid) = current_owner();
        let mismatched_gid = if gid == u32::MAX { gid - 1 } else { gid + 1 };

        let report = chown_path_for_current_process(root.path())
            .expect("read-only root chown failures are non-fatal");
        assert_eq!(report.visited, 2);
        assert_eq!(report.changed, 0);
        assert_eq!(report.failures, 2);
        assert!(report
            .warning_samples
            .iter()
            .any(|sample| sample.contains("chown directory") && sample.contains("EROFS")));

        let logs = CapturedLogs::default();
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_max_level(tracing::Level::WARN)
            .with_writer(logs.clone())
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            OwnershipFixer::fix_for_owner(root.path(), uid, mismatched_gid)
        })
        .expect("root chown failure remains non-fatal");

        let after = fs::symlink_metadata(root.path()).expect("stat root after repair");
        assert_eq!((after.uid(), after.gid()), (before.uid(), before.gid()));
        let logs = logs.contents();
        assert!(logs.contains("completed with warnings"), "logs: {logs}");
        assert!(logs.contains("chown directory"), "logs: {logs}");
        drop(root_guard);
        drop(source_guard);
    }

    #[test]
    #[ignore = "requires root"]
    fn privileged_continues_past_read_only_mount() {
        let root = tempfile::tempdir().expect("create root directory");
        let source = tempfile::tempdir().expect("create read-only mount source");
        mount(
            Option::<&str>::None,
            source.path(),
            Some("tmpfs"),
            MsFlags::empty(),
            Some("size=1m"),
        )
        .expect("mount private tmpfs fixture");
        let source_guard = MountGuard(source.path().to_path_buf());
        File::create(source.path().join("read-only-file")).expect("create read-only file");
        let mountpoint = root.path().join("read-only");
        fs::create_dir(&mountpoint).expect("create read-only mountpoint");
        mount(
            Some(source.path()),
            &mountpoint,
            Option::<&str>::None,
            MsFlags::MS_BIND,
            Option::<&str>::None,
        )
        .expect("bind read-only fixture");
        let mount_guard = MountGuard(mountpoint.clone());
        mount(
            Option::<&Path>::None,
            &mountpoint,
            Option::<&str>::None,
            MsFlags::MS_BIND | MsFlags::MS_REMOUNT | MsFlags::MS_RDONLY,
            Option::<&str>::None,
        )
        .expect("remount fixture read-only");
        File::create(root.path().join("sibling")).expect("create writable sibling");

        let report = chown_path_for_current_process(root.path())
            .expect("read-only entry failures are non-fatal");

        assert_eq!(report.visited, 4);
        assert_eq!(report.changed, 2, "root and writable sibling are changed");
        assert_eq!(report.failures, 2, "read-only directory and file fail");
        assert!(report
            .warning_samples
            .iter()
            .all(|sample| sample.contains("EROFS")));
        drop(mount_guard);
        drop(source_guard);
    }

    #[test]
    #[ignore = "requires root"]
    fn privileged_crosses_mounts_and_stops_ancestor_cycles() {
        let root = tempfile::tempdir().expect("create root directory");
        let source = tempfile::tempdir().expect("create mount source");
        File::create(source.path().join("mounted-file")).expect("create mounted file");
        let mountpoint = root.path().join("mounted");
        fs::create_dir(&mountpoint).expect("create mountpoint");
        mount(
            Some(source.path()),
            &mountpoint,
            Option::<&str>::None,
            MsFlags::MS_BIND,
            Option::<&str>::None,
        )
        .expect("bind child filesystem");
        let mounted_guard = MountGuard(mountpoint.clone());

        let crossed = chown_path_for_current_process(root.path()).expect("walk across mount");
        assert_eq!(crossed.failures, 0);
        assert_eq!(crossed.cycles, 0);
        assert_eq!(crossed.visited, 3);
        drop(mounted_guard);

        let cyclepoint = root.path().join("cycle");
        fs::create_dir(&cyclepoint).expect("create cycle mountpoint");
        mount(
            Some(root.path()),
            &cyclepoint,
            Option::<&str>::None,
            MsFlags::MS_BIND,
            Option::<&str>::None,
        )
        .expect("bind ancestor onto descendant");
        let cycle_guard = MountGuard(cyclepoint);

        let cycled = chown_path_for_current_process(root.path()).expect("stop mount cycle");
        assert_eq!(cycled.failures, 0);
        assert_eq!(cycled.cycles, 1);
        assert_eq!(cycled.warning_samples.len(), 1);

        drop(cycle_guard);
    }
}
