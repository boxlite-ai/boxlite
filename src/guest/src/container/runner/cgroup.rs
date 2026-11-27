//! Guest-local cgroup v2 placement, limits and teardown.

use super::super::spec::CgroupLimits;
use nix::libc;
use nix::unistd::Pid;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const ROOT: &str = "/sys/fs/cgroup";

pub(super) struct Cgroup {
    pub fd: File,
    path: PathBuf,
}

impl Cgroup {
    pub(super) fn create(id: &str, limits: Option<CgroupLimits>) -> io::Result<Option<Self>> {
        let root = Path::new(ROOT);
        let controllers = match fs::read_to_string(root.join("cgroup.controllers")) {
            Ok(controllers) => controllers,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        // Child cgroups need the controller files even when limits are left
        // at their defaults. Delegate all available guest controllers so
        // privileged nested runtimes can use them too.
        let enabled = controllers
            .split_ascii_whitespace()
            .map(|controller| format!("+{controller}"))
            .collect::<Vec<_>>()
            .join(" ");
        if !enabled.is_empty() {
            fs::write(root.join("cgroup.subtree_control"), enabled)?;
        }
        let path = root.join(format!("boxlite:{id}"));
        fs::create_dir(&path)?;
        let fd = match File::open(&path) {
            Ok(fd) => fd,
            Err(e) => {
                let _ = fs::remove_dir(&path);
                return Err(e);
            }
        };
        let group = Self { fd, path };
        if let Some(limits) = limits {
            group.apply_limits(limits)?;
        }
        Ok(Some(group))
    }

    fn apply_limits(&self, limits: CgroupLimits) -> io::Result<()> {
        let requested = [
            (
                "cpu.max",
                (limits.cpu_quota_us > 0).then(|| {
                    format!(
                        "{} {}",
                        limits.cpu_quota_us,
                        if limits.cpu_period_us == 0 {
                            100_000
                        } else {
                            limits.cpu_period_us
                        }
                    )
                }),
            ),
            (
                "memory.max",
                (limits.memory_limit_bytes > 0).then(|| limits.memory_limit_bytes.to_string()),
            ),
            (
                "pids.max",
                (limits.pids_limit > 0).then(|| limits.pids_limit.to_string()),
            ),
        ];
        for (file, value) in requested {
            if let Some(value) = value {
                fs::write(self.path.join(file), value)?;
            }
        }
        Ok(())
    }

    /// Open the subtree in the caller's mount namespace for a bind mount.
    /// The placement fd belongs to the zygote's mount namespace.
    pub(super) fn open_for_mount(&self) -> io::Result<File> {
        File::open(&self.path)
    }

    pub(super) fn place(&self, pid: Pid) -> io::Result<()> {
        fs::write(self.path.join("cgroup.procs"), pid.to_string())
    }

    pub(super) fn kill(&self) -> io::Result<()> {
        let kill_path = self.path.join("cgroup.kill");
        // Do not request O_CREAT: older kernels lack this control file.
        match OpenOptions::new()
            .write(true)
            .open(&kill_path)
            .and_then(|mut file| file.write_all(b"1"))
        {
            Ok(()) => Ok(()),
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(libc::ENOENT | libc::ENOSYS | libc::EOPNOTSUPP)
                ) =>
            {
                kill_members(&self.path)
            }
            Err(error) => Err(error),
        }
    }
}

// Pin each task through its proc directory before sending the signal so a stale
// cgroup.procs snapshot cannot signal a newly reused PID outside the container.
fn kill_members(path: &Path) -> io::Result<()> {
    for member in fs::read_to_string(path.join("cgroup.procs"))?.lines() {
        if let Ok(pid) = member.parse::<i32>() {
            if let Ok(identity) = super::process::Identity::open(Pid::from_raw(pid), None) {
                // Recheck membership after acquiring the process identity.
                if fs::read_to_string(path.join("cgroup.procs"))?
                    .lines()
                    .any(|p| p == member)
                {
                    identity.signal(nix::sys::signal::Signal::SIGKILL)?;
                }
            }
        }
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            kill_members(&entry.path())?;
        }
    }
    Ok(())
}

fn remove_tree(path: &Path) -> io::Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            remove_tree(&entry.path())?;
        }
    }
    fs::remove_dir(path)
}

impl Drop for Cgroup {
    fn drop(&mut self) {
        for _ in 0..50 {
            match remove_tree(&self.path) {
                Ok(()) => return,
                Err(e) if e.kind() == io::ErrorKind::NotFound => return,
                Err(e) if e.raw_os_error() == Some(libc::EBUSY) => {
                    std::thread::sleep(std::time::Duration::from_millis(2))
                }
                Err(e) => {
                    eprintln!("[zygote] remove {}: {e}", self.path.display());
                    return;
                }
            }
        }
        eprintln!("[zygote] cgroup still busy: {}", self.path.display());
    }
}
