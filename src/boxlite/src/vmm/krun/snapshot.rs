use std::ffi::{CString, c_void};
use std::io;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::ptr::{self, NonNull};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::disk::constants::filenames::CONTAINER_DISK;
use crate::litebox::snapshot_mgr::validate_snapshot_name;
use crate::net::socket_path::BoxSockets;
use crate::vmm::live_snapshot::{Command, FENCE_WINDOW, FileId, Phase, Request, monotonic_nanos};
use crate::vmm::vmm_socket::{self, ControlError, ControlOp, ControlReply, ControlResponse};
use crate::vmm::{DiskFormat, InstanceSpec, VmmInstance, VmmKind};

impl From<FileId> for libkrun_sys::DiskFileIdentity {
    fn from(value: FileId) -> Self {
        Self {
            device: value.device,
            inode: value.inode,
        }
    }
}

pub(crate) fn container_block_id(config: &InstanceSpec) -> Option<&str> {
    config.block_devices.devices().iter().find_map(|disk| {
        (disk.format == DiskFormat::Qcow2
            && !disk.read_only
            && disk
                .disk_path
                .file_name()
                .is_some_and(|name| name == CONTAINER_DISK))
        .then_some(disk.block_id.as_str())
    })
}

pub(crate) struct SnapshotHandle(NonNull<c_void>);

// SAFETY: the opaque handle retains an Arc, and libkrun serializes mutations in its disk control.
unsafe impl Send for SnapshotHandle {}

impl SnapshotHandle {
    pub(crate) fn enable(context: u32, block: &str) -> BoxliteResult<Self> {
        let block = CString::new(block).map_err(|error| BoxliteError::Config(error.to_string()))?;
        let mut handle = ptr::null();
        // SAFETY: the live configuration context owns the named block device.
        let status =
            unsafe { libkrun_sys::krun_enable_disk_snapshot(context, block.as_ptr(), &mut handle) };
        super::check_status("krun_enable_disk_snapshot", status)?;
        NonNull::new(handle.cast_mut()).map(Self).ok_or_else(|| {
            BoxliteError::Engine("libkrun returned an empty disk snapshot handle".into())
        })
    }

    fn request(&self, request: &Request, snapshots: &Path) -> Result<Phase, ControlError> {
        let mut source = FileId::default();
        let mut overlay = FileId::default();
        let mut backing = None;
        let operation = match &request.command {
            Command::Status => 0,
            Command::Fence {
                source: expected, ..
            } => {
                source = *expected;
                1
            }
            Command::Install {
                source: expected,
                overlay: candidate,
                snapshot,
            } => {
                validate_snapshot_name(snapshot)
                    .map_err(|error| ControlError::InvalidInput(error.to_string()))?;
                let path = snapshots.join(snapshot).join(CONTAINER_DISK);
                backing = Some(
                    CString::new(path.as_os_str().as_encoded_bytes())
                        .map_err(|error| ControlError::InvalidInput(error.to_string()))?,
                );
                source = *expected;
                overlay = *candidate;
                2
            }
            Command::Release { overlay: candidate } => {
                overlay = *candidate;
                3
            }
            Command::Abort { source: expected } => {
                source = *expected;
                4
            }
        };
        let transaction = CString::new(request.transaction.as_str())
            .map_err(|error| ControlError::InvalidInput(error.to_string()))?;
        let command = libkrun_sys::DiskSnapshotCommand {
            operation,
            transaction: transaction.as_ptr(),
            backing_path: backing.as_ref().map_or(ptr::null(), |value| value.as_ptr()),
            source: source.into(),
            overlay: overlay.into(),
        };
        // SAFETY: this handle and all pointers in command remain valid for the synchronous call.
        match unsafe { libkrun_sys::krun_disk_snapshot(self.0.as_ptr(), &command) } {
            0 => Ok(Phase::Absent),
            1 => Ok(Phase::Fenced),
            2 => Ok(Phase::Installed),
            3 => Ok(Phase::Committed),
            4 => Ok(Phase::Aborted),
            status if status == -libc::ENODEV => Err(ControlError::Unsupported(
                "writable QCOW2 switch unavailable for this disk".into(),
            )),
            status => Err(ControlError::Failed(
                io::Error::from_raw_os_error(-status).to_string(),
            )),
        }
    }
}

impl Drop for SnapshotHandle {
    fn drop(&mut self) {
        // SAFETY: this is the reference returned to the caller by enable.
        unsafe { libkrun_sys::krun_free_disk_snapshot(self.0.as_ptr()) };
    }
}

/// Host-only listener bound before seccomp and attached to the configured libkrun context.
#[doc(hidden)]
pub struct SnapshotListener {
    listener: UnixListener,
    snapshots: PathBuf,
}

impl SnapshotListener {
    pub fn bind(config: &InstanceSpec) -> BoxliteResult<Option<Self>> {
        if config.engine != VmmKind::Libkrun || container_block_id(config).is_none() {
            return Ok(None);
        }
        let home = config
            .exit_file
            .parent()
            .ok_or_else(|| BoxliteError::Engine("snapshot control needs a box directory".into()))?;
        let path = BoxSockets::new(config.box_id.clone(), home.join("sockets")).vmm_sock();
        let listener = vmm_socket::bind_owner(&path)?;
        Ok(Some(Self {
            listener,
            snapshots: home.join("snapshots"),
        }))
    }

    pub fn serve(self, instance: &mut VmmInstance) -> BoxliteResult<()> {
        let handle = instance.take_disk_snapshot().ok_or_else(|| {
            BoxliteError::Engine("snapshot control missing from the libkrun context".into())
        })?;
        let watchdog = FenceWatchdog::spawn()?;
        vmm_socket::serve_bound(self.listener, move |op| {
            let ControlOp::DiskSnapshot(request) = op else {
                return Err(ControlError::Unsupported(
                    "only disk snapshot control is available".into(),
                ));
            };
            serve_request(&handle, &watchdog, &self.snapshots, request)
        })?;
        Ok(())
    }
}

fn serve_request(
    handle: &SnapshotHandle,
    watchdog: &FenceWatchdog,
    snapshots: &Path,
    request: Request,
) -> ControlResponse {
    if let Command::Fence { deadline, .. } = request.command {
        watchdog.arm(&request.transaction, deadline)?;
    }
    watchdog.check_deadline(&request.transaction)?;
    let result = handle.request(&request, snapshots);
    watchdog.check_deadline(&request.transaction)?;
    if matches!(result, Ok(Phase::Committed | Phase::Aborted))
        || (matches!(request.command, Command::Fence { .. }) && result.is_err())
    {
        watchdog.disarm(&request.transaction)?;
    }
    result.map(ControlReply::DiskSnapshot)
}

#[derive(Default)]
struct FenceWatchdog {
    armed: Mutex<Option<(String, u64)>>,
    changed: Condvar,
}

impl FenceWatchdog {
    fn spawn() -> io::Result<Arc<Self>> {
        let watchdog = Arc::new(Self::default());
        let worker = watchdog.clone();
        std::thread::Builder::new()
            .name("disk-snapshot-watchdog".into())
            .spawn(move || worker.watch())?;
        Ok(watchdog)
    }

    fn arm(&self, transaction: &str, deadline: u64) -> Result<(), ControlError> {
        let now = monotonic_nanos();
        if deadline <= now || deadline - now > FENCE_WINDOW.as_nanos() as u64 {
            return Err(ControlError::InvalidInput(
                "invalid disk snapshot deadline".into(),
            ));
        }
        let mut armed = self.armed.lock().unwrap();
        if let Some((current, expires)) = armed.as_ref() {
            if current != transaction || *expires != deadline {
                return Err(ControlError::Failed(
                    "another disk snapshot is fenced".into(),
                ));
            }
        } else {
            *armed = Some((transaction.to_owned(), deadline));
            self.changed.notify_one();
        }
        Ok(())
    }

    fn disarm(&self, transaction: &str) -> Result<(), ControlError> {
        let mut armed = self.armed.lock().unwrap();
        if let Some((current, deadline)) = armed.as_ref()
            && current == transaction
        {
            if monotonic_nanos() >= *deadline {
                return Err(ControlError::Failed(
                    "disk snapshot deadline expired".into(),
                ));
            }
            *armed = None;
            self.changed.notify_one();
        }
        Ok(())
    }

    fn check_deadline(&self, transaction: &str) -> Result<(), ControlError> {
        if let Some((current, deadline)) = self.armed.lock().unwrap().as_ref()
            && current == transaction
            && monotonic_nanos() >= *deadline
        {
            return Err(ControlError::Failed(
                "disk snapshot deadline expired".into(),
            ));
        }
        Ok(())
    }

    fn watch(&self) -> ! {
        let mut armed = self.armed.lock().unwrap();
        loop {
            if let Some((_, deadline)) = armed.as_ref() {
                let remaining = deadline.saturating_sub(monotonic_nanos());
                if remaining == 0 {
                    // SAFETY: abort immediately, independently of a worker blocked in the kernel.
                    unsafe { libc::_exit(1) };
                }
                (armed, _) = self
                    .changed
                    .wait_timeout(armed, Duration::from_nanos(remaining))
                    .unwrap();
            } else {
                armed = self.changed.wait(armed).unwrap();
            }
        }
    }
}
