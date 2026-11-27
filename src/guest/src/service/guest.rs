//! Guest service implementation.
//!
//! Handles guest initialization and management (Init, Ping, Shutdown,
//! Quiesce, Thaw, SyncClock and ResizeFilesystem RPCs).

use crate::service::server::GuestServer;
use boxlite_shared::{
    guest_init_response, Guest as GuestService, GuestInitError, GuestInitRequest,
    GuestInitResponse, GuestInitSuccess, PingRequest, PingResponse, QuiesceRequest,
    QuiesceResponse, ResizeFilesystemRequest, ResizeFilesystemResponse, ShutdownRequest,
    ShutdownResponse, SyncClockRequest, SyncClockResponse, ThawRequest, ThawResponse,
};
use tonic::{Request, Response, Status};
use tracing::{debug, error, info, warn};

#[tonic::async_trait]
impl GuestService for GuestServer {
    /// Initialize guest environment.
    ///
    /// This must be called first after connection. It:
    /// 1. Mounts all volumes (virtiofs + block devices)
    /// 2. Configures network (if specified)
    ///
    /// Note: Rootfs setup is handled by Container.Init.
    async fn init(
        &self,
        request: Request<GuestInitRequest>,
    ) -> Result<Response<GuestInitResponse>, Status> {
        let req = request.into_inner();
        info!("Received guest init request");

        // Check if already initialized
        let mut init_state = self.init_state.lock().await;
        if init_state.initialized {
            error!("Guest already initialized (Init can only be called once)");
            return Ok(Response::new(GuestInitResponse {
                result: Some(guest_init_response::Result::Error(GuestInitError {
                    reason: "Guest already initialized (Init can only be called once)".to_string(),
                })),
            }));
        }

        // Step 1: Mount all volumes (virtiofs + block devices)
        // Empty mount_point = guest determines path from tag
        info!("Mounting {} volumes", req.volumes.len());
        let mounted = match crate::storage::mount_initial_volumes(&req.volumes) {
            Ok(mounted) => mounted,
            Err(e) => {
                error!("Failed to mount volumes: {}", e);
                return Ok(Response::new(GuestInitResponse {
                    result: Some(guest_init_response::Result::Error(GuestInitError {
                        reason: format!("Failed to mount volumes: {}", e),
                    })),
                }));
            }
        };

        // Step 2: Configure network (if specified)
        if let Some(network) = req.network {
            info!("Configuring network interface: {}", network.interface);
            if let Err(e) = crate::network::configure_network_from_config(
                &network.interface,
                network.ip.as_deref(),
                network.gateway.as_deref(),
            )
            .await
            {
                error!("Failed to configure network: {}", e);
                return Ok(Response::new(GuestInitResponse {
                    result: Some(guest_init_response::Result::Error(GuestInitError {
                        reason: format!("Failed to configure network: {}", e),
                    })),
                }));
            }
        }

        // Mark as initialized
        init_state.initialized = true;
        mounted.commit();

        info!("✅ Guest initialized successfully");
        Ok(Response::new(GuestInitResponse {
            result: Some(guest_init_response::Result::Success(GuestInitSuccess {})),
        }))
    }

    async fn ping(&self, _request: Request<PingRequest>) -> Result<Response<PingResponse>, Status> {
        debug!("Received ping request");
        Ok(Response::new(PingResponse {
            version: env!("CARGO_PKG_VERSION").to_string(),
            safe_managed_volume_sub_path: true,
            records_boot_mounts: crate::storage::attach::identifies_namespaces(),
        }))
    }

    async fn shutdown(
        &self,
        _request: Request<ShutdownRequest>,
    ) -> Result<Response<ShutdownResponse>, Status> {
        info!("Received shutdown request - graceful shutdown starting");

        // Host owns this teardown — tell the reaper's init-exit action to
        // stand down (it would otherwise race us with its own VM power-off).
        self.shutting_down
            .store(true, std::sync::atomic::Ordering::SeqCst);

        // Close SSH before draining the execution registry. The SSH lock
        // serializes draining with admitted configuration and restore calls.
        // Best-effort: a stuck session must not strand containers or skip the
        // filesystem sync that COW disk consistency on restart depends on.
        // `shutting_down` is already set, so nothing else would finish the
        // teardown if this returned.
        let quiesce = self.ssh_manager.shutdown().await.inspect_err(|error| {
            error!(%error, "SSH sessions did not quiesce; continuing guest teardown");
        });

        // Step 1: Gracefully shutdown all running executions
        info!("Stopping running executions...");
        self.registry
            .shutdown_all(crate::service::exec::registry::SHUTDOWN_TIMEOUT_MS)
            .await;

        // Step 2: Gracefully shutdown all containers
        const CONTAINER_SHUTDOWN_TIMEOUT_MS: u64 = 2000;
        info!("Stopping containers...");
        let containers = self.containers.lock().await;
        for (container_id, container_arc) in containers.iter() {
            info!(container_id = %container_id, "Shutting down container");
            let container = container_arc.lock().await;
            if let Err(e) = container.shutdown(CONTAINER_SHUTDOWN_TIMEOUT_MS) {
                error!(container_id = %container_id, error = %e, "Failed to shutdown container");
            }
        }
        drop(containers);

        // Step 2b: write each init's exit record before answering the host.
        //
        // Killing init above gets it reaped and its exit slot filled. The
        // reaper's action writes this record too, but on its own task, with
        // nothing here to wait for it — so this RPC writes the record itself.
        // Both writers derive it from the same level-triggered slot, so the
        // bytes agree whichever runs first; what this write adds is ordering:
        // the record is on disk before the RPC returns and the host reads the
        // exit file (its `stop()` reports that code as the box's exit status —
        // docker leaves ExitCode 137 after a `docker stop`).
        let init_exits: Vec<_> = self.init_exits.lock().await.drain().collect();
        for (container_id, exit_slot) in init_exits {
            match tokio::time::timeout(
                std::time::Duration::from_millis(CONTAINER_SHUTDOWN_TIMEOUT_MS),
                exit_slot.get(),
            )
            .await
            {
                Ok(status) => {
                    let record = boxlite_shared::layout::ExitRecord {
                        exit_code: status.shell_code(),
                    };
                    let exit_file = self.layout.shared().container(&container_id).exit_file();
                    if let Err(e) = record.write(&exit_file) {
                        warn!(container_id = %container_id, error = %e, "failed to write exit file");
                    }
                }
                Err(_) => {
                    warn!(container_id = %container_id, "init exit not observed in time; no exit record written")
                }
            }
        }

        // Step 3: Sync all filesystems to ensure data is flushed to disk.
        // This is critical for COW disks to be in consistent state on restart.
        info!("Syncing filesystems...");
        unsafe {
            nix::libc::sync();
        }

        // Report the degraded quiesce only now that containers are stopped,
        // exit records are written and the filesystems are synced.
        if let Err(error) = quiesce {
            return Err(Status::deadline_exceeded(format!(
                "guest teardown completed but SSH sessions did not quiesce: {error}"
            )));
        }

        info!("Graceful shutdown complete");
        Ok(Response::new(ShutdownResponse {}))
    }

    /// Quiesce all writable filesystems (FIFREEZE ioctl).
    ///
    /// Atomically flushes dirty pages and blocks new writes on each filesystem.
    /// Follows QEMU guest-agent's `guest-fsfreeze-freeze` protocol.
    async fn quiesce(
        &self,
        _request: Request<QuiesceRequest>,
    ) -> Result<Response<QuiesceResponse>, Status> {
        info!("Received quiesce request — freezing filesystems");

        let frozen = crate::storage::fsfreeze::freeze_filesystems();
        let frozen_count = frozen.len() as u32;

        // Store frozen mount points for the subsequent Thaw call
        let mut stored = self.frozen_mounts.lock().await;
        *stored = frozen;

        Ok(Response::new(QuiesceResponse { frozen_count }))
    }

    /// Thaw previously quiesced filesystems (FITHAW ioctl).
    ///
    /// Unblocks writes on all filesystems frozen by the last Quiesce call.
    async fn thaw(&self, _request: Request<ThawRequest>) -> Result<Response<ThawResponse>, Status> {
        info!("Received thaw request — thawing filesystems");

        let mut stored = self.frozen_mounts.lock().await;
        let thawed_count = crate::storage::fsfreeze::thaw_filesystems(&stored);
        stored.clear();

        Ok(Response::new(ThawResponse { thawed_count }))
    }

    /// Correct CLOCK_REALTIME from host-sampled UTC when drift exceeds 100ms.
    ///
    /// Success means no adjustment was needed or the kernel accepted the
    /// setting. Validation, clock reads, and clock setting failures propagate
    /// to the host.
    async fn sync_clock(
        &self,
        request: Request<SyncClockRequest>,
    ) -> Result<Response<SyncClockResponse>, Status> {
        if !self.allow_clock_sync {
            return Err(Status::permission_denied("clock sync requires host vsock"));
        }
        let ts = match sync_clock_timespec(request.into_inner()) {
            Ok(ts) => ts,
            Err(reject) => return Err(Status::invalid_argument(reject.reason())),
        };
        let mut current = nix::libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: current is a valid writable timespec for clock_gettime.
        if unsafe { nix::libc::clock_gettime(nix::libc::CLOCK_REALTIME, &mut current) } != 0 {
            let error = std::io::Error::last_os_error();
            error!(%error, "clock_gettime(CLOCK_REALTIME) failed");
            return Err(Status::internal(format!(
                "clock_gettime(CLOCK_REALTIME) failed: {error}"
            )));
        }
        if !clock_correction_needed(&ts, &current) {
            return Ok(Response::new(SyncClockResponse {}));
        }
        if let Err(error) = set_system_clock(&ts) {
            error!(%error, "clock_settime(CLOCK_REALTIME) rejected the host time");
            return Err(clock_settime_status(&error));
        }
        info!(
            sec = ts.tv_sec,
            nsec = ts.tv_nsec,
            "Guest system clock set to host UTC"
        );
        Ok(Response::new(SyncClockResponse {}))
    }

    async fn resize_filesystem(
        &self,
        request: Request<ResizeFilesystemRequest>,
    ) -> Result<Response<ResizeFilesystemResponse>, Status> {
        use std::os::unix::fs::FileTypeExt;
        use std::path::Path;
        use std::time::Duration;

        let request = request.into_inner();
        if request.device != "/dev/vda"
            || request.minimum_bytes == 0
            || !request.minimum_bytes.is_multiple_of(512)
        {
            return Err(Status::invalid_argument(
                "resize requires /dev/vda and a positive sector-aligned capacity",
            ));
        }
        let initialized = self.init_state.lock().await.initialized;
        if !initialized || self.shutting_down.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(Status::failed_precondition(
                "guest must be initialized and running",
            ));
        }
        // Let resize2fs finish and be reaped even if the RPC is cancelled.
        tokio::spawn(async move {
            let device = Path::new("/dev/vda");
            let metadata = tokio::fs::symlink_metadata(device).await.map_err(|error| {
                Status::failed_precondition(format!("root disk unavailable: {error}"))
            })?;
            if !metadata.file_type().is_block_device() {
                return Err(Status::failed_precondition(
                    "root disk must be a block device",
                ));
            }
            wait_for_disk_capacity(
                Path::new("/sys/class/block/vda/size"),
                request.minimum_bytes,
                Duration::from_secs(10),
            )
            .await
            .map_err(|error| *error)?;
            info!(device = %device.display(), "Resizing ext4 to fill disk");
            let output = crate::service::exec::executor::GuestExecutor
                .run_command(
                    format!("{}/resize2fs", boxlite_shared::layout::BIN_DIR),
                    vec![request.device],
                )
                .await
                .map_err(|error| Status::internal(error.to_string()))?;
            if !output.status.success() {
                return Err(Status::internal(format!(
                    "resize2fs failed on {} (exit {}): {}",
                    device.display(),
                    output.status.shell_code(),
                    String::from_utf8_lossy(&output.stderr).trim()
                )));
            }
            info!(
                "Filesystem resize completed: {}",
                String::from_utf8_lossy(&output.stdout).trim()
            );
            Ok(Response::new(ResizeFilesystemResponse {}))
        })
        .await
        .map_err(|error| Status::internal(format!("resize task failed: {error}")))?
    }
}

/// Why a host-supplied timestamp was rejected.
///
/// The host is the clock authority: the RPC arrives over the host control
/// socket with a stamp the host sampled, and a guest-side ahead bound could
/// only reject legitimate corrections after long host suspends. Validation
/// stays structural.
#[derive(Debug)]
enum SyncClockReject {
    NanosOutOfRange(i32),
    BeforeEpoch,
}

impl SyncClockReject {
    fn reason(&self) -> String {
        match self {
            Self::NanosOutOfRange(nanos) => {
                format!("nanos out of range 0-999999999: {nanos}")
            }
            Self::BeforeEpoch => "unix_sec must be after the Unix epoch".into(),
        }
    }
}

/// Validate a host-supplied UTC instant into a `timespec`.
///
/// Structural bounds only: the nanosecond part must be a valid subsecond
/// offset and the instant must sit after the epoch. The host is the clock
/// authority — the stamp is what the host sampled — and a guest-side bound
/// on how far ahead it may sit would reject legitimate corrections after
/// long host suspends, so any post-epoch instant is accepted.
fn sync_clock_timespec(request: SyncClockRequest) -> Result<nix::libc::timespec, SyncClockReject> {
    const NANOS_UPPER_BOUND: i32 = 999_999_999;

    let SyncClockRequest { unix_sec, nanos } = request;
    if !(0..=NANOS_UPPER_BOUND).contains(&nanos) {
        return Err(SyncClockReject::NanosOutOfRange(nanos));
    }
    if unix_sec <= 0 {
        return Err(SyncClockReject::BeforeEpoch);
    }
    Ok(nix::libc::timespec {
        tv_sec: unix_sec,
        tv_nsec: i64::from(nanos),
    })
}

fn clock_correction_needed(host: &nix::libc::timespec, guest: &nix::libc::timespec) -> bool {
    let delta = (i128::from(host.tv_sec) - i128::from(guest.tv_sec)) * 1_000_000_000
        + i128::from(host.tv_nsec)
        - i128::from(guest.tv_nsec);
    delta.abs() > 100_000_000
}

/// Set the guest system clock. Returns the raw OS error for callers to map.
fn set_system_clock(ts: &nix::libc::timespec) -> Result<(), std::io::Error> {
    // SAFETY: clock_settime only reads the timespec; there are no other inputs.
    let rc = unsafe { nix::libc::clock_settime(nix::libc::CLOCK_REALTIME, ts) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Map a `clock_settime` failure to the RPC status the host should see.
fn clock_settime_status(error: &std::io::Error) -> Status {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => Status::permission_denied(format!(
            "the guest agent lacks permission to set the system clock: {error}"
        )),
        std::io::ErrorKind::InvalidInput => {
            Status::invalid_argument(format!("the kernel rejected the timestamp: {error}"))
        }
        _ => Status::internal(format!("clock_settime(CLOCK_REALTIME) failed: {error}")),
    }
}

async fn wait_for_disk_capacity(
    size_path: &std::path::Path,
    minimum_bytes: u64,
    timeout: std::time::Duration,
) -> Result<(), Box<Status>> {
    tokio::time::timeout(timeout, async {
        loop {
            let text = tokio::fs::read_to_string(size_path)
                .await
                .map_err(|error| Status::internal(format!("read root disk capacity: {error}")))?;
            let bytes = text
                .trim()
                .parse::<u64>()
                .ok()
                .and_then(|sectors| sectors.checked_mul(512))
                .ok_or_else(|| Status::internal("invalid root disk capacity"))?;
            if bytes >= minimum_bytes {
                return Ok::<(), Box<Status>>(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .map_err(|_| Status::deadline_exceeded("kernel has not observed the grown root disk"))?
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;
    use crate::layout::GuestLayout;
    use crate::reaper::ExitSlot;
    use crate::service::exec::exec_handle::ExitStatus;

    #[tokio::test]
    async fn resize_filesystem_rejects_other_devices_and_uninitialized_guests() {
        let root = tempfile::tempdir().unwrap();
        let server = GuestServer::new(GuestLayout::with_base(root.path()));
        for (device, minimum_bytes) in [
            ("/dev/vdb", 1024),
            ("/dev/../dev/vda", 1024),
            ("/tmp/disk", 1024),
            ("/dev/vda", 0),
            ("/dev/vda", 513),
        ] {
            let error = server
                .resize_filesystem(Request::new(ResizeFilesystemRequest {
                    device: device.into(),
                    minimum_bytes,
                }))
                .await
                .unwrap_err();
            assert_eq!(error.code(), tonic::Code::InvalidArgument);
        }
        let error = server
            .resize_filesystem(Request::new(ResizeFilesystemRequest {
                device: "/dev/vda".into(),
                minimum_bytes: 1024,
            }))
            .await
            .unwrap_err();
        assert_eq!(error.code(), tonic::Code::FailedPrecondition);
    }

    #[tokio::test]
    async fn resize_filesystem_waits_for_kernel_capacity_and_bounds_the_wait() {
        use std::time::Duration;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("size");
        tokio::fs::write(&path, "2\n").await.unwrap();
        let wait = wait_for_disk_capacity(&path, 2048, Duration::from_secs(1));
        tokio::pin!(wait);
        assert!(tokio::time::timeout(Duration::from_millis(30), &mut wait)
            .await
            .is_err());
        tokio::fs::write(&path, "4\n").await.unwrap();
        wait.await.unwrap();
        assert_eq!(
            wait_for_disk_capacity(&path, 4096, Duration::from_millis(20))
                .await
                .unwrap_err()
                .code(),
            tonic::Code::DeadlineExceeded
        );
        for invalid in ["garbage", "18446744073709551615"] {
            tokio::fs::write(&path, invalid).await.unwrap();
            assert_eq!(
                wait_for_disk_capacity(&path, 2048, Duration::from_secs(1))
                    .await
                    .unwrap_err()
                    .code(),
                tonic::Code::Internal
            );
        }
    }

    /// A quiesce that fails must not strand the rest of the teardown: the exit
    /// record still reaches disk, and the failure is reported afterwards.
    #[tokio::test]
    async fn shutdown_writes_exit_records_when_ssh_fails_to_quiesce() {
        crate::test_syscalls::deny(nix::libc::SYS_sync);
        let root = tempfile::tempdir().expect("tempdir");
        let server = GuestServer::new(GuestLayout::with_base(root.path()));
        let exit_file = server.layout.shared().container("c1").exit_file();
        std::fs::create_dir_all(exit_file.parent().expect("container root"))
            .expect("container dir");
        server
            .init_exits
            .lock()
            .await
            .insert("c1".to_string(), ExitSlot::settled(ExitStatus::Code(7)));

        let _cleanup = server.ssh_manager.pending_cleanup_for_test().await;
        let status = server
            .shutdown(Request::new(ShutdownRequest {}))
            .await
            .expect_err("a failed quiesce is reported to the host");

        assert_eq!(status.code(), tonic::Code::DeadlineExceeded);
        let written = boxlite_shared::layout::ExitRecord::read(&exit_file);
        assert_eq!(written.map(|record| record.exit_code), Some(7));
    }

    /// Structural bounds only: a bad subsecond part or a pre-epoch instant
    /// are rejected, while past instants, today's host time, and stamps far
    /// ahead (a long host suspend) are accepted unchanged.
    #[test]
    fn sync_clock_rejects_invalid_timestamps() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock is after the epoch")
            .as_secs() as i64;

        for (unix_sec, nanos) in [(1, -1), (1, 1_000_000_000)] {
            assert!(matches!(
                sync_clock_timespec(SyncClockRequest { unix_sec, nanos }),
                Err(SyncClockReject::NanosOutOfRange(_))
            ));
        }
        for unix_sec in [0, -5] {
            assert!(matches!(
                sync_clock_timespec(SyncClockRequest { unix_sec, nanos: 0 }),
                Err(SyncClockReject::BeforeEpoch)
            ));
        }
        // A host that slept longer than a day is still authoritative; the
        // stamp far ahead of the guest clock must be accepted.
        let long_suspend = sync_clock_timespec(SyncClockRequest {
            unix_sec: now + 90_000,
            nanos: 0,
        })
        .expect("a host stamp ahead by more than a day is accepted");
        assert_eq!(long_suspend.tv_sec, now + 90_000);

        let behind = sync_clock_timespec(SyncClockRequest {
            unix_sec: now - 100_000,
            nanos: 500,
        })
        .expect("a past host instant is accepted");
        assert_eq!(behind.tv_sec, now - 100_000);
        let fresh = sync_clock_timespec(SyncClockRequest {
            unix_sec: now,
            nanos: 0,
        })
        .expect("the host's current instant is accepted");
        assert_eq!((fresh.tv_sec, fresh.tv_nsec), (now, 0));
    }

    #[test]
    fn sync_clock_corrects_only_beyond_100ms_in_both_directions() {
        // Include a second boundary and timestamps near the i64 limit to
        // exercise subtraction without overflowing seconds or nanoseconds.
        for (seconds, nanos) in [(10, 500_000_000), (10, 950_000_000), (i64::MAX - 1, 0)] {
            let earlier = nix::libc::timespec {
                tv_sec: seconds,
                tv_nsec: nanos,
            };
            for delta in [0, 99_999_999, 100_000_000, 100_000_001] {
                let later = nix::libc::timespec {
                    tv_sec: seconds + (nanos + delta) / 1_000_000_000,
                    tv_nsec: (nanos + delta) % 1_000_000_000,
                };
                let expected = delta > 100_000_000;
                assert_eq!(clock_correction_needed(&later, &earlier), expected);
                assert_eq!(clock_correction_needed(&earlier, &later), expected);
            }
        }
    }

    #[tokio::test]
    async fn sync_clock_within_tolerance_succeeds_without_clock_permission() {
        crate::test_syscalls::deny(nix::libc::SYS_clock_settime);
        let root = tempfile::tempdir().expect("tempdir");
        let mut server = GuestServer::new(GuestLayout::with_base(root.path()));
        server.allow_clock_sync = true;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch");
        server
            .sync_clock(Request::new(SyncClockRequest {
                unix_sec: now.as_secs() as i64,
                nanos: now.subsec_nanos() as i32,
            }))
            .await
            .expect("a current timestamp needs no clock_settime permission");
    }

    #[tokio::test]
    async fn sync_clock_rejects_invalid_requests_before_setting_clock() {
        crate::test_syscalls::deny(nix::libc::SYS_clock_settime);
        let root = tempfile::tempdir().expect("tempdir");
        let mut server = GuestServer::new(GuestLayout::with_base(root.path()));
        server.allow_clock_sync = true;
        for (unix_sec, nanos) in [(1, -1), (1, 1_000_000_000), (0, 0), (-1, 0)] {
            let status = server
                .sync_clock(Request::new(SyncClockRequest { unix_sec, nanos }))
                .await
                .expect_err("invalid timestamps must fail before clock_settime");
            assert_eq!(status.code(), tonic::Code::InvalidArgument);
        }
    }

    /// A guest that cannot set the clock (here: seccomp EPERM, standing in
    /// for the non-root agent) must fail the RPC instead of reporting a
    /// correction it did not apply.
    #[tokio::test]
    async fn sync_clock_propagates_clock_settime_denial() {
        crate::test_syscalls::deny(nix::libc::SYS_clock_settime);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock is after the epoch")
            .as_secs() as i64;

        let root = tempfile::tempdir().expect("tempdir");
        let mut server = GuestServer::new(GuestLayout::with_base(root.path()));
        server.allow_clock_sync = true;
        let status = server
            .sync_clock(Request::new(SyncClockRequest {
                unix_sec: now + 90_000,
                nanos: 0,
            }))
            .await
            .expect_err("a denied clock_settime must fail the RPC");

        assert_eq!(status.code(), tonic::Code::PermissionDenied);
    }
}
