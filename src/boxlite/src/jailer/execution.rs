//! Host execution control. A sandboxed Linux VM is a process tree, not the
//! outer bubblewrap PID recorded by pre_exec.

use std::path::Path;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::runtime::advanced_options::SecurityOptions;
use crate::runtime::id::BoxID;
use crate::util::{PidFileReader, PidRecord};

pub(crate) struct ExecutionControl {
    identity: PidRecord,
    #[cfg(target_os = "linux")]
    cgroup: Option<CgroupFreezer>,
}

impl ExecutionControl {
    pub(crate) fn new(
        box_id: &BoxID,
        pid_file: &Path,
        security: &SecurityOptions,
    ) -> BoxliteResult<Self> {
        let identity = PidFileReader::at(pid_file)
            .verified_shim()
            .ok_or_else(|| {
                BoxliteError::Stopped(format!("Box {box_id} has no verified live shim"))
            })?
            .identity();
        #[cfg(target_os = "linux")]
        let cgroup = if security.jailer_enabled {
            Some(CgroupFreezer::open(
                &super::cgroup::cgroup_path(box_id.as_str()),
                identity.pid,
            )?)
        } else {
            None
        };
        #[cfg(not(target_os = "linux"))]
        let _ = security;
        Ok(Self {
            identity,
            #[cfg(target_os = "linux")]
            cgroup,
        })
    }

    pub(crate) async fn pause(&self) -> BoxliteResult<()> {
        self.verify()?;
        #[cfg(target_os = "linux")]
        if let Some(cgroup) = &self.cgroup {
            cgroup.pause().await.map_err(|error| {
                BoxliteError::Engine(format!(
                    "Freeze sandbox for PID {}: {error}",
                    self.identity.pid
                ))
            })?;
            if let Err(error) = self.verify() {
                if let Err(thaw_error) = cgroup.resume() {
                    tracing::error!(%thaw_error, "Failed to release dead shim's frozen cgroup");
                }
                return Err(error);
            }
            return Ok(());
        }
        self.signal(libc::SIGSTOP)
    }

    pub(crate) fn resume(&self) -> BoxliteResult<ResumeRollback<'_>> {
        self.verify()?;
        let rollback = ResumeRollback(Some(self));
        #[cfg(target_os = "linux")]
        if let Some(cgroup) = &self.cgroup {
            cgroup.resume().map_err(|error| {
                BoxliteError::Engine(format!(
                    "Thaw sandbox for PID {}: {error}",
                    self.identity.pid
                ))
            })?;
        }
        // Also releases boxes paused by older versions with SIGSTOP.
        self.signal(libc::SIGCONT)?;
        Ok(rollback)
    }

    fn request_pause(&self) -> BoxliteResult<()> {
        self.verify()?;
        #[cfg(target_os = "linux")]
        if let Some(cgroup) = &self.cgroup {
            use std::os::unix::fs::FileExt;
            cgroup.control.write_all_at(b"1", 0).map_err(|error| {
                BoxliteError::Engine(format!("Refreeze interrupted resume: {error}"))
            })?;
            return Ok(());
        }
        self.signal(libc::SIGSTOP)
    }

    fn verify(&self) -> BoxliteResult<()> {
        if !crate::util::is_process_alive(self.identity.pid)
            || crate::util::process_start_time(self.identity.pid) != self.identity.start_time
        {
            return Err(BoxliteError::Stopped(format!(
                "Shim PID {} exited or changed identity",
                self.identity.pid
            )));
        }
        Ok(())
    }

    fn signal(&self, signal: i32) -> BoxliteResult<()> {
        self.verify()?;
        // SAFETY: the positive PID's lifecycle was checked immediately above.
        if unsafe { libc::kill(self.identity.pid as i32, signal) } != 0 {
            return Err(BoxliteError::Engine(format!(
                "Signal {signal} to shim PID {}: {}",
                self.identity.pid,
                std::io::Error::last_os_error()
            )));
        }
        Ok(())
    }
}

/// Keep the host stopped if the caller cancels resume while awaiting guest
/// thaw. A later pause/disk operation still waits for kernel freeze completion.
pub(crate) struct ResumeRollback<'a>(Option<&'a ExecutionControl>);

impl ResumeRollback<'_> {
    pub(crate) fn commit(mut self) {
        self.0 = None;
    }
}

impl Drop for ResumeRollback<'_> {
    fn drop(&mut self) {
        if let Some(execution) = self.0
            && let Err(error) = execution.request_pause()
        {
            tracing::error!(%error, "Failed to refreeze interrupted resume");
        }
    }
}

#[cfg(target_os = "linux")]
struct CgroupFreezer {
    control: std::fs::File,
    events: std::fs::File,
}

#[cfg(target_os = "linux")]
impl CgroupFreezer {
    fn open(path: &Path, pid: u32) -> BoxliteResult<Self> {
        let open = || -> std::io::Result<Self> {
            let members = std::fs::read_to_string(path.join("cgroup.procs"))?;
            if !members.lines().any(|line| line.parse::<u32>() == Ok(pid)) {
                return Err(std::io::Error::other(
                    "shim is not a member of its sandbox cgroup",
                ));
            }
            Ok(Self {
                control: std::fs::OpenOptions::new()
                    .write(true)
                    .open(path.join("cgroup.freeze"))?,
                events: std::fs::File::open(path.join("cgroup.events"))?,
            })
        };
        open().map_err(|error| {
            BoxliteError::Unsupported(format!(
                "Cannot freeze sandbox at {}: {error}; a writable cgroup v2 freezer is required",
                path.display()
            ))
        })
    }

    async fn pause(&self) -> std::io::Result<()> {
        use std::io::{Read, Seek};
        use std::os::unix::fs::FileExt;
        use tokio::io::{Interest, unix::AsyncFd};

        // Register before requesting the freeze, so the completion cannot
        // race event registration. cgroup.events signals POLLPRI, not POLLIN.
        let events = AsyncFd::with_interest(self.events.try_clone()?, Interest::PRIORITY)?;
        let mut rollback = FreezeRollback(Some(self));
        self.control.write_all_at(b"1", 0)?;
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let mut contents = String::new();
                let mut file = events.get_ref();
                file.rewind()?;
                file.read_to_string(&mut contents)?;
                if contents.lines().any(|line| line == "frozen 1") {
                    return Ok::<_, std::io::Error>(());
                }
                let mut ready = events.ready(Interest::PRIORITY).await?;
                ready.clear_ready();
            }
        })
        .await
        .map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "sandbox did not reach frozen=1 within 5s",
            )
        })??;
        rollback.0 = None;
        Ok(())
    }

    fn resume(&self) -> std::io::Result<()> {
        use std::os::unix::fs::FileExt;
        self.control.write_all_at(b"0", 0)
    }
}

#[cfg(target_os = "linux")]
struct FreezeRollback<'a>(Option<&'a CgroupFreezer>);

#[cfg(target_os = "linux")]
impl Drop for FreezeRollback<'_> {
    fn drop(&mut self) {
        if let Some(freezer) = self.0
            && let Err(error) = freezer.resume()
        {
            tracing::error!(%error, "Failed to undo incomplete sandbox freeze");
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    fn cgroup_files(pid: u32) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("cgroup.procs"), format!("{pid}\n")).unwrap();
        std::fs::write(dir.path().join("cgroup.freeze"), "0").unwrap();
        std::fs::write(dir.path().join("cgroup.events"), "populated 1\nfrozen 0\n").unwrap();
        dir
    }

    #[test]
    fn pause_cgroup_rejects_nonmember_before_freezing() {
        let dir = cgroup_files(42);
        assert!(CgroupFreezer::open(dir.path(), 43).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("cgroup.freeze")).unwrap(),
            "0"
        );
    }

    #[tokio::test]
    async fn pause_cgroup_requires_completion_notifications() {
        let dir = cgroup_files(42);
        let freezer = CgroupFreezer::open(dir.path(), 42).unwrap();
        // Ordinary files cannot deliver the kernel's POLLPRI notification.
        // Refuse the pause rather than reporting success after a control write.
        assert!(freezer.pause().await.is_err());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("cgroup.freeze")).unwrap(),
            "0"
        );
    }

    #[test]
    fn pause_cgroup_rolls_back_an_unfinished_request() {
        let dir = cgroup_files(42);
        let freezer = CgroupFreezer::open(dir.path(), 42).unwrap();
        let rollback = FreezeRollback(Some(&freezer));
        std::fs::write(dir.path().join("cgroup.freeze"), "1").unwrap();
        drop(rollback);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("cgroup.freeze")).unwrap(),
            "0"
        );
    }

    #[test]
    fn pause_cgroup_interrupted_resume_requests_refreeze() {
        let identity = PidRecord::current();
        let dir = cgroup_files(identity.pid);
        let execution = ExecutionControl {
            identity,
            cgroup: Some(CgroupFreezer::open(dir.path(), identity.pid).unwrap()),
        };
        // The fake cgroup receives all freeze writes. SIGCONT to this already
        // running test process is harmless; no SIGSTOP is sent in cgroup mode.
        let resumed = execution.resume().unwrap();
        drop(resumed);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("cgroup.freeze")).unwrap(),
            "1"
        );
        execution.resume().unwrap().commit();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("cgroup.freeze")).unwrap(),
            "0"
        );
    }
}
