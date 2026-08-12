//! Filesystem ownership and permission utilities.

use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use boxlite_shared::errors::BoxliteResult;
use nix::dir::{Dir, OwningIter};
use nix::fcntl::{openat, AtFlags, OFlag};
use nix::libc;
use nix::sys::stat::{fstat, fstatat, Mode};
use nix::unistd::{close, fchown, fchownat, Gid, Uid};

const WARNING_SAMPLE_LIMIT: usize = 8;

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
        // Check if ownership fix is needed by sampling root and subdirectories
        if Self::ownership_matches(path, current_uid, current_gid) {
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
        let report = RecursiveChowner::new(current_uid, current_gid).chown_path(path);
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

    /// Check if ownership of root and subdirectories matches expected uid:gid.
    fn ownership_matches(path: &Path, expected_uid: u32, expected_gid: u32) -> bool {
        use std::os::unix::fs::MetadataExt;

        // Check root directory
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.uid() != expected_uid || meta.gid() != expected_gid {
                return false;
            }
        } else {
            return false;
        }

        // Sample a few subdirectories/files
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.take(5).flatten() {
                if let Ok(meta) = entry.metadata() {
                    if meta.uid() != expected_uid || meta.gid() != expected_gid {
                        return false;
                    }
                }
            }
        }

        true
    }
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

    fn chown_path(mut self, path: &Path) -> ChownReport {
        // check if it is file, if it is just chown it and return
        let stat = match fstatat(None, path, AtFlags::AT_SYMLINK_NOFOLLOW) {
            Ok(stat) => stat,
            Err(error) => {
                self.report.record_failure("stat", path, error);
                return self.report;
            }
        };
        self.report.visited = 1;

        if stat.st_mode & libc::S_IFMT != libc::S_IFDIR {
            self.chown_operand(path);
            return self.report;
        }

        // now it is directory, we need to traverse it
        let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        let root = match Dir::open(path, flags, Mode::empty()) {
            Ok(root) => root,
            Err(error) => {
                self.report.record_failure("open directory", path, error);
                return self.report;
            }
        };
        let root_stat = match fstat(root.as_raw_fd()) {
            Ok(stat) => stat,
            Err(error) => {
                self.report.record_failure("stat directory", path, error);
                return self.report;
            }
        };

        // use stack to dfs traverse it. DirectoryFrame wrap an OwningIter, iterator for the directory
        // hint: if dir too deep, may cost too much fd. fix it in future.
        let mut stack = vec![DirectoryFrame::new(root, path.to_path_buf(), &root_stat)];
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
                Some(Ok(entry)) => entry,
                Some(Err(error)) => {
                    let frame = stack.pop().expect("non-empty directory stack");
                    self.report
                        .record_failure("read directory", &frame.path, error);
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
                    let _ = close(child_fd);
                    continue;
                }
            };

            let child_identity = DirectoryIdentity::from(&child_stat);
            if stack
                .iter()
                .any(|ancestor| ancestor.identity == child_identity)
            {
                let _ = close(child_fd);
                self.report.record_cycle(&path);
                continue;
            }

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
            stack.push(DirectoryFrame::new(child_dir, path, &child_stat));
        }

        self.report
    }

    fn chown_operand(&mut self, path: &Path) {
        match fchownat(
            None,
            path,
            Some(self.uid),
            Some(self.gid),
            AtFlags::AT_SYMLINK_NOFOLLOW,
        ) {
            Ok(()) => self.report.changed += 1,
            Err(error) => self.report.record_failure("chown", path, error),
        }
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
        match fchown(frame.entries.as_raw_fd(), Some(self.uid), Some(self.gid)) {
            Ok(()) => self.report.changed += 1,
            Err(error) => self
                .report
                .record_failure("chown directory", &frame.path, error),
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
#[derive(Default)]
struct TestFaults {
    descent_failure: Option<(PathBuf, TestDescentFailure)>,
    read_failure: Option<PathBuf>,
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
        if self.read_failure.as_deref() == Some(path) {
            self.read_failure = None;
            return true;
        }
        false
    }
}

struct DirectoryFrame {
    entries: OwningIter,
    path: PathBuf,
    identity: DirectoryIdentity,
}

impl DirectoryFrame {
    fn new(directory: Dir, path: PathBuf, stat: &libc::stat) -> Self {
        Self {
            entries: directory.into_iter(),
            path,
            identity: DirectoryIdentity::from(stat),
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
mod tests;
