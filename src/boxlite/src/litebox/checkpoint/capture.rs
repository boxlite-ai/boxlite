//! Capture lifetime: an owner reservation survives cancellation of its caller.
use crate::BoxID;
use crate::vmm::checkpoint::{
    ControlClient,
    protocol::{DescriptorReply, DescriptorRequest},
};
use crate::vmm::controller::{ShimHandler, VmmHandler};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::sync::Arc;

pub(crate) async fn request(
    control: &ControlClient,
    request: DescriptorRequest,
    files: Vec<OwnedFd>,
) -> BoxliteResult<(DescriptorReply, Vec<OwnedFd>)> {
    let result = control
        .descriptors(request, files)
        .await
        .map_err(|e| BoxliteError::Engine(e.to_string()))?;
    if let Some(error) = &result.0.error {
        let message = format!("{:?}: {}", error.kind, error.message);
        return Err(match error.kind {
            crate::vmm::checkpoint::FailureKind::Busy
            | crate::vmm::checkpoint::FailureKind::Rejected => BoxliteError::InvalidState(message),
            crate::vmm::checkpoint::FailureKind::Io => BoxliteError::Storage(message),
            crate::vmm::checkpoint::FailureKind::Failed => BoxliteError::Engine(message),
        });
    }
    Ok(result)
}

pub(crate) struct Session {
    pub control: ControlClient,
    pub token: u64,
    peer: Option<UnixStream>,
    disk_only: bool,
}

impl Session {
    pub fn cancel(&self) {
        if let Some(peer) = &self.peer {
            let _ = peer.shutdown(std::net::Shutdown::Both);
        }
    }
    pub async fn begin(control: ControlClient, disk_only: bool) -> BoxliteResult<Self> {
        let (reply, _) = request(&control, DescriptorRequest::Capabilities, Vec::new()).await?;
        if reply.metadata["protocol"] != 2
            || reply.metadata["capabilities"].as_u64().unwrap_or(0) & 7 != 7
        {
            return Err(BoxliteError::Unsupported(
                "checkpoint capture needs an explicit restart with protocol generation 2".into(),
            ));
        }
        let (peer, owner) = UnixStream::pair().map_err(|e| BoxliteError::Engine(e.to_string()))?;
        let (reply, _) = request(
            &control,
            DescriptorRequest::Begin { disk_only },
            vec![owner.into()],
        )
        .await?;
        let token = reply.metadata["token"]
            .as_u64()
            .ok_or_else(|| BoxliteError::Engine("capture returned no token".into()))?;
        Ok(Self {
            control,
            token,
            peer: Some(peer),
            disk_only,
        })
    }

    pub async fn finish(mut self) -> BoxliteResult<()> {
        let (reply, _) = request(
            &self.control,
            DescriptorRequest::End {
                token: self.token,
                cancel: false,
            },
            Vec::new(),
        )
        .await?;
        let expected = if self.disk_only {
            crate::vmm::checkpoint::VmRunState::Running
        } else {
            crate::vmm::checkpoint::VmRunState::Paused
        };
        if reply.state != expected {
            return Err(BoxliteError::Engine(format!(
                "capture completion returned {}, expected {expected}",
                reply.state
            )));
        }
        self.peer.take();
        Ok(())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // Libkrun watches this separate, silent stream through publication.
        // Closing it invalidates the token and stops the owner, never resumes.
        self.peer.take();
    }
}

pub(crate) struct CancelOnDrop(pub tokio_util::sync::CancellationToken);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

/// Use the persisted lifecycle fingerprint, never a cached database PID alone.
fn recorded_process(
    reader: &crate::util::PidFileReader,
    expected: u32,
) -> BoxliteResult<Option<crate::util::PidRecord>> {
    use crate::util::ProcessIdentity;
    match reader.process_identity() {
        ProcessIdentity::Verified(pid) | ProcessIdentity::Legacy(pid) if pid == expected => {
            Ok(Some(reader.read()?))
        }
        ProcessIdentity::Absent => {
            // Missing/corrupt PID files do not prove a live writer exited.
            // A readable mismatched fingerprint does prove this PID belongs
            // to another lifecycle, which must never receive our signals.
            let replaced = reader.read().ok().is_some_and(|record| {
                record.pid == expected
                    && record.start_time.is_some_and(|start| {
                        crate::util::process_start_time(expected)
                            .is_some_and(|current| current != start)
                    })
            });
            if replaced || !crate::util::is_process_alive(expected) {
                Ok(None)
            } else {
                Err(BoxliteError::Engine(
                    "capture writer identity unavailable; retain attempt artifacts".into(),
                ))
            }
        }
        _ => Err(BoxliteError::InvalidState(
            "shim lifecycle changed during capture".into(),
        )),
    }
}

fn signal_process(
    reader: &crate::util::PidFileReader,
    record: crate::util::PidRecord,
    signal: i32,
) -> BoxliteResult<()> {
    if recorded_process(reader, record.pid)? != Some(record) {
        return Err(BoxliteError::Stopped(
            "capture shim identity is no longer current".into(),
        ));
    }
    // SAFETY: the persisted lifecycle was checked against the OS immediately above.
    if unsafe { libc::kill(record.pid as i32, signal) } != 0 {
        return Err(BoxliteError::Engine(
            std::io::Error::last_os_error().to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn stop_and_join_sync(
    reader: &crate::util::PidFileReader,
    pid: u32,
    id: BoxID,
) -> BoxliteResult<()> {
    let Some(record) = recorded_process(reader, pid)? else {
        // A lost/reused launcher says nothing about detached writers. Only a
        // known, empty owned cgroup can establish their exit at this point.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match crate::jailer::box_has_processes(&id) {
                Ok(Some(false)) => return Ok(()),
                Ok(Some(true)) if std::time::Instant::now() < deadline => {
                    crate::jailer::reap_box(&id);
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                result => {
                    return Err(BoxliteError::Engine(format!(
                        "launcher identity lost; writer exit unverified ({result:?}); retain attempt artifacts"
                    )));
                }
            }
        }
    };
    // Snapshot descendants before the launcher exits/reparents them. A kill
    // request alone is not a join, including when cgroups are unavailable.
    let mut system = sysinfo::System::new();
    system.refresh_processes();
    let mut processes = vec![record];
    let mut next = 0;
    while next < processes.len() {
        let parent = processes[next].pid;
        for (pid, process) in system.processes() {
            let pid = pid.as_u32();
            if process.parent().is_some_and(|pid| pid.as_u32() == parent)
                && !processes.iter().any(|record| record.pid == pid)
            {
                processes.push(crate::util::PidRecord {
                    pid,
                    start_time: crate::util::process_start_time(pid),
                });
            }
        }
        next += 1;
    }
    let mut handler = ShimHandler::from_pid(pid, id.clone());
    handler.stop()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while processes.iter().any(|record| {
        crate::util::is_process_alive(record.pid)
            && record
                .start_time
                .is_none_or(|start| crate::util::process_start_time(record.pid) == Some(start))
    }) || crate::jailer::box_has_processes(&id)
        .map_err(|error| {
            BoxliteError::Engine(format!(
                "sandbox exit uncertain; retain attempt artifacts: {error}"
            ))
        })?
        .unwrap_or(false)
    {
        if std::time::Instant::now() >= deadline {
            return Err(BoxliteError::Engine(
                "capture shim still alive; retain attempt artifacts".into(),
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    Ok(())
}

pub(crate) async fn stop_and_join(
    pid: u32,
    id: BoxID,
    reader: crate::util::PidFileReader,
) -> BoxliteResult<()> {
    tokio::task::spawn_blocking(move || stop_and_join_sync(&reader, pid, id))
        .await
        .map_err(|e| BoxliteError::Engine(e.to_string()))?
}

/// Frozen copy plus its private staging directory, consumed after resume.
pub(crate) struct DiskCapture {
    pub directory: Arc<tempfile::TempDir>,
    pub path: std::path::PathBuf,
}

impl super::BoxImpl {
    pub(crate) async fn capture_disk(
        &self,
        reservation: &crate::litebox::operation::Reservation,
    ) -> BoxliteResult<DiskCapture> {
        let reservation = reservation.duplicate()?;
        let state = self.state.read().clone();
        let running = state.status == crate::BoxStatus::Running;
        let owner = running && self.uses_checkpoint_owner();
        let control = self.checkpoint_control();
        let source = self.config.box_home.join("disks/disk.qcow2");
        let temporary_root = self.runtime.layout.temp_dir();
        let guest = running.then(|| crate::portal::GuestSession::new(self.config.transport()));
        let pid = state.pid;
        if running && pid.is_none() {
            return Err(BoxliteError::InvalidState(
                "running box has no verified shim PID".into(),
            ));
        }
        let reader = crate::util::PidFileReader::at(self.layout.pid_file_path());
        let process = if let Some(pid) = pid.filter(|_| running) {
            Some(recorded_process(&reader, pid)?.ok_or_else(|| {
                BoxliteError::InvalidState("running capture has no matching shim lifecycle".into())
            })?)
        } else {
            None
        };
        let id = self.config.id.clone();
        let cancel = self.shutdown_token.child_token();
        let canceller = CancelOnDrop(cancel.clone());
        let task = tokio::spawn(async move {
            let _reservation = reservation;
            let session = if owner {
                Some(Session::begin(control, true).await?)
            } else {
                None
            };
            let directory = match tempfile::tempdir_in(temporary_root) {
                Ok(directory) => Arc::new(directory),
                Err(error) => {
                    if let Some(session) = session {
                        session.finish().await?;
                    }
                    return Err(BoxliteError::Storage(error.to_string()));
                }
            };
            let destination = directory.path().join("disk.qcow2");
            if let Some(guest) = &guest
                && !owner
            {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                    guest.guest().await?.quiesce().await
                })
                .await;
                let pid =
                    pid.ok_or_else(|| BoxliteError::Engine("running box has no PID".into()))?;
                if cancel.is_cancelled() {
                    stop_and_join(pid, id, reader.clone()).await?;
                    return Err(BoxliteError::Stopped(
                        "capture cancelled during quiesce".into(),
                    ));
                }
                if let Err(error) =
                    signal_process(&reader, process.expect("running lifecycle"), libc::SIGSTOP)
                {
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                        guest.guest().await?.thaw().await
                    })
                    .await;
                    return Err(BoxliteError::Engine(error.to_string()));
                }
            }
            let worker_cancel = cancel.clone();
            let worker_directory = directory.clone();
            let worker_path = destination.clone();
            let mut worker = tokio::task::spawn_blocking(move || {
                let _directory = worker_directory;
                crate::disk::Qcow2Helper::flatten_cancellable(&source, &worker_path, &|| {
                    worker_cancel.is_cancelled()
                })
            });
            let result = tokio::select! {
                biased;
                () = cancel.cancelled() => {
                    drop(session);
                    let stopped = if let Some(pid) = pid { stop_and_join(pid, id, reader.clone()).await } else { Ok(()) };
                    let _ = worker.await;
                    stopped?;
                    return Err(BoxliteError::Stopped("disk capture cancelled; VM stopped".into()));
                }
                result = &mut worker => result.unwrap_or_else(|e|Err(BoxliteError::Engine(e.to_string()))),
            };
            if cancel.is_cancelled() {
                drop(session);
                if let Some(pid) = pid {
                    stop_and_join(pid, id, reader.clone()).await?;
                }
                return Err(BoxliteError::Stopped(
                    "disk capture cancelled; VM stopped".into(),
                ));
            }
            if let Some(session) = session {
                if let Err(error) = session.finish().await {
                    if let Some(pid) = pid {
                        stop_and_join(pid, id, reader.clone()).await?;
                    }
                    return Err(error);
                }
            } else if running {
                if let Some(pid) = pid
                    && signal_process(&reader, process.expect("running lifecycle"), libc::SIGCONT)
                        .is_err()
                {
                    stop_and_join(pid, id, reader.clone()).await?;
                    return Err(BoxliteError::Engine(
                        "could not resume captured shim".into(),
                    ));
                }
                if let Some(guest) = guest {
                    let thaw = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                        guest.guest().await?.thaw().await
                    })
                    .await
                    .map_err(|_| BoxliteError::Engine("guest thaw timed out".into()))
                    .and_then(|result| result);
                    if let Err(error) = thaw {
                        if let Some(pid) = pid {
                            stop_and_join(pid, id, reader.clone()).await?;
                        }
                        return Err(error);
                    }
                }
            }
            result?;
            Ok(DiskCapture {
                directory,
                path: destination,
            })
        });
        let result = task
            .await
            .map_err(|e| BoxliteError::Engine(e.to_string()))?;
        drop(canceller);
        result
    }
}
#[cfg(test)]
mod lifecycle_regression {
    use super::*;
    #[tokio::test]
    async fn checkpoint_capture_stop_does_not_signal_a_reused_pid() {
        let directory = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let pid = child.id();
        let start = crate::util::process_start_time(pid).unwrap();
        let path = directory.path().join("shim.pid");
        std::fs::write(&path, format!("{pid}\n{}\n", start + 1)).unwrap();
        let reader = crate::util::PidFileReader::at(path);
        assert_eq!(
            reader.process_identity(),
            crate::util::ProcessIdentity::Absent
        );
        let result = stop_and_join(pid, crate::runtime::id::BoxIDMint::mint(), reader).await;
        let survived = crate::util::is_process_alive(pid);
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            survived,
            "capture stop signalled a process with a mismatched fingerprint: {result:?}"
        );
    }
}

#[cfg(test)]
mod uncertain_identity_regression {
    use super::*;
    #[tokio::test]
    async fn checkpoint_capture_missing_or_corrupt_pidfile_does_not_authorize_cleanup() {
        for contents in [None, Some("corrupt\n")] {
            let directory = tempfile::tempdir().unwrap();
            let mut child = std::process::Command::new("sleep")
                .arg("30")
                .spawn()
                .unwrap();
            let pid = child.id();
            let path = directory.path().join("shim.pid");
            if let Some(contents) = contents {
                std::fs::write(&path, contents).unwrap();
            }
            let reader = crate::util::PidFileReader::at(path);
            assert_eq!(
                reader.process_identity(),
                crate::util::ProcessIdentity::Absent
            );
            let result = stop_and_join(pid, crate::runtime::id::BoxIDMint::mint(), reader).await;
            let survived = crate::util::is_process_alive(pid);
            let _ = child.kill();
            let _ = child.wait();
            assert!(
                survived && result.is_err(),
                "uncertain writer may not be signalled or declared joined: survived={survived}, {result:?}"
            );
        }
    }
}

#[cfg(test)]
mod writer_join_regression {
    use super::*;
    #[tokio::test]
    async fn checkpoint_capture_requires_descendant_writer_exit_before_cleanup() {
        use std::io::BufRead;
        let directory = tempfile::tempdir().unwrap();
        let mut launcher = std::process::Command::new("sh")
            .args(["-c", "sleep 30 & echo $!; wait"])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        std::io::BufReader::new(launcher.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let writer: u32 = line.trim().parse().unwrap();
        let pid = launcher.id();
        let start = crate::util::process_start_time(pid).unwrap();
        let path = directory.path().join("shim.pid");
        std::fs::write(&path, format!("{pid}\n{start}\n")).unwrap();
        let reader = crate::util::PidFileReader::at(path);
        let result = stop_and_join(pid, crate::runtime::id::BoxIDMint::mint(), reader).await;
        // The launcher has exited but its detached writer did not. Keep files
        // and leases, and never turn a queued kill into a join acknowledgement.
        let writer_alive = crate::util::is_process_alive(writer);
        // SAFETY: this test started and still owns the known writer process.
        unsafe {
            libc::kill(writer as i32, libc::SIGKILL);
        }
        let _ = launcher.kill();
        let _ = launcher.wait();
        assert!(
            writer_alive && result.is_err(),
            "surviving writer authorized cleanup: {result:?}"
        );
    }
}

#[cfg(all(test, target_os = "linux"))]
mod lost_launcher_regression {
    use super::*;
    #[tokio::test]
    async fn checkpoint_capture_lost_launcher_without_tree_identity_retains_resources() {
        use std::io::BufRead;
        let directory = tempfile::tempdir().unwrap();
        let mut launcher = std::process::Command::new("sh")
            .args(["-c", "sleep 30 & echo $!"])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        std::io::BufReader::new(launcher.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let writer: u32 = line.trim().parse().unwrap();
        let pid = launcher.id();
        launcher.wait().unwrap();
        let path = directory.path().join("shim.pid");
        std::fs::write(&path, format!("{pid}\n1\n")).unwrap();
        let reader = crate::util::PidFileReader::at(path);
        let result = stop_and_join(pid, crate::runtime::id::BoxIDMint::mint(), reader).await;
        let writer_alive = crate::util::is_process_alive(writer);
        // SAFETY: this test retains its own still-live writer PID.
        unsafe {
            libc::kill(writer as i32, libc::SIGKILL);
        }
        assert!(
            writer_alive && result.is_err(),
            "lost launcher authorized writer cleanup: {result:?}"
        );
    }
}
