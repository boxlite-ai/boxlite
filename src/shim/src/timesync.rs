//! Native clock alignment owned by the shim, including detached Boxes.
//!
//! Compare wall time with suspend-aware elapsed time every two seconds.
//! A gap or clock step stays due until the guest accepts a fresh sample.

#[cfg(target_os = "linux")]
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "linux")]
use boxlite::GuestSession;
use boxlite::vmm::VmmKind;
use boxlite_shared::BoxTransport;

#[cfg(target_os = "linux")]
const CHECK_INTERVAL: Duration = Duration::from_secs(2);
#[cfg(target_os = "linux")]
const GAP_THRESHOLD: Duration = Duration::from_secs(6);
#[cfg(target_os = "linux")]
const CLOCK_STEP_THRESHOLD: Duration = Duration::from_millis(100);
#[cfg(target_os = "linux")]
const UPDATE_INTERVAL: Duration = Duration::from_secs(60);
#[cfg(target_os = "linux")]
const SYNC_TIMEOUT: Duration = Duration::from_secs(2);

/// Keep the worker in the shim so a detached creator can exit independently.
pub(crate) fn spawn(engine: VmmKind, transport: BoxTransport) {
    if !enabled_for(engine) {
        tracing::debug!(?engine, "shim clock sync stays off for this engine");
        return;
    }
    if let Err(error) = std::thread::Builder::new()
        .name("clock-sync".into())
        .spawn(move || run(transport))
    {
        tracing::warn!(%error, "could not start the clock-sync thread");
    }
}

fn enabled_for(engine: VmmKind) -> bool {
    cfg!(target_os = "linux") && engine == VmmKind::Native
}

#[cfg(target_os = "linux")]
fn run(transport: BoxTransport) {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            tracing::warn!(%error, "clock sync could not start a runtime");
            return;
        }
    };
    if let Err(error) = runtime.block_on(sync_loop(transport)) {
        tracing::warn!(%error, "clock sync could not read host boottime");
    }
}

#[cfg(not(target_os = "linux"))]
fn run(_transport: BoxTransport) {}

#[cfg(target_os = "linux")]
#[derive(Debug)]
struct HostTime {
    wall: SystemTime,
    boottime: Duration,
}

#[cfg(target_os = "linux")]
impl HostTime {
    fn now() -> std::io::Result<Self> {
        let mut time = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: time is a valid writable timespec for clock_gettime.
        if unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut time) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self {
            wall: SystemTime::now(),
            boottime: Duration::new(time.tv_sec as u64, time.tv_nsec as u32),
        })
    }
}

#[cfg(target_os = "linux")]
struct Schedule {
    previous_check: HostTime,
    last_successful_push: Option<Duration>,
    pending: Option<&'static str>,
}

#[cfg(target_os = "linux")]
impl Schedule {
    fn check(&mut self, now: HostTime) -> Option<&'static str> {
        // Record the check before the RPC so a suspend during it stays visible.
        let previous = std::mem::replace(&mut self.previous_check, now);
        if self.pending.is_some() {
            return self.pending;
        }
        let now = &self.previous_check;
        let elapsed = now.boottime.saturating_sub(previous.boottime);
        self.pending = match self.last_successful_push {
            None => Some("no_successful_push"),
            Some(_) if elapsed >= GAP_THRESHOLD => Some("check_gap"),
            Some(_)
                if now.wall.duration_since(previous.wall).map_or_else(
                    |_| true,
                    |wall_elapsed| elapsed.abs_diff(wall_elapsed) > CLOCK_STEP_THRESHOLD,
                ) =>
            {
                Some("host_clock_step")
            }
            Some(last) if now.boottime.saturating_sub(last) >= UPDATE_INTERVAL => Some("periodic"),
            Some(_) => None,
        };
        self.pending
    }

    fn pushed(&mut self, boottime: Duration) {
        self.last_successful_push = Some(boottime);
        self.pending = None;
    }
}

#[cfg(target_os = "linux")]
async fn sync_loop(transport: BoxTransport) -> std::io::Result<()> {
    let mut schedule = Schedule {
        previous_check: HostTime::now()?,
        last_successful_push: None,
        pending: None,
    };
    let mut checks = tokio::time::interval(CHECK_INTERVAL);
    // The first tick is immediate; missed checks never become a burst of RPCs.
    checks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        checks.tick().await;
        if let Some(reason) = schedule.check(HostTime::now()?)
            && let Ok(sampled_at) = sync_once(&transport, SYNC_TIMEOUT, reason).await
        {
            schedule.pushed(sampled_at.boottime);
        }
    }
}

/// Connect and send within one budget; sample UTC only after connecting.
#[cfg(target_os = "linux")]
async fn sync_once(
    transport: &BoxTransport,
    timeout: Duration,
    reason: &str,
) -> Result<HostTime, String> {
    let started = Instant::now();
    let mut sampled_at = None;
    let result = tokio::time::timeout(timeout, async {
        let session = GuestSession::new(transport.clone());
        let mut guest = session.guest().await.map_err(|error| error.to_string())?;
        let now = HostTime::now().map_err(|error| error.to_string())?;
        sampled_at = Some(now.wall);
        let utc = now
            .wall
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?;
        guest
            .sync_clock(utc.as_secs() as i64, utc.subsec_nanos() as i32)
            .await
            .map_err(|error| error.to_string())?;
        Ok(now)
    })
    .await
    .unwrap_or_else(|_| Err("guest clock synchronization timed out".into()));
    let elapsed_ms = started.elapsed().as_millis();
    match &result {
        Ok(_) => tracing::info!(
            reason,
            ?sampled_at,
            elapsed_ms,
            "guest clock synchronization succeeded"
        ),
        Err(error) => {
            tracing::warn!(reason, ?sampled_at, elapsed_ms, %error, "guest clock synchronization failed")
        }
    }
    result
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use boxlite_shared::SyncClockRequest;
    use std::sync::{Arc, Mutex};

    struct FakeGuest {
        sync_status: Option<tonic::Status>,
        received: Arc<Mutex<Option<SyncClockRequest>>>,
    }

    #[tonic::async_trait]
    impl boxlite_shared::Guest for FakeGuest {
        async fn init(
            &self,
            _: tonic::Request<boxlite_shared::GuestInitRequest>,
        ) -> Result<tonic::Response<boxlite_shared::GuestInitResponse>, tonic::Status> {
            Err(tonic::Status::unimplemented("test fake"))
        }

        async fn ping(
            &self,
            _: tonic::Request<boxlite_shared::PingRequest>,
        ) -> Result<tonic::Response<boxlite_shared::PingResponse>, tonic::Status> {
            Err(tonic::Status::unimplemented("test fake"))
        }

        async fn shutdown(
            &self,
            _: tonic::Request<boxlite_shared::ShutdownRequest>,
        ) -> Result<tonic::Response<boxlite_shared::ShutdownResponse>, tonic::Status> {
            Err(tonic::Status::unimplemented("test fake"))
        }

        async fn quiesce(
            &self,
            _: tonic::Request<boxlite_shared::QuiesceRequest>,
        ) -> Result<tonic::Response<boxlite_shared::QuiesceResponse>, tonic::Status> {
            Err(tonic::Status::unimplemented("test fake"))
        }

        async fn thaw(
            &self,
            _: tonic::Request<boxlite_shared::ThawRequest>,
        ) -> Result<tonic::Response<boxlite_shared::ThawResponse>, tonic::Status> {
            Err(tonic::Status::unimplemented("test fake"))
        }

        async fn sync_clock(
            &self,
            request: tonic::Request<SyncClockRequest>,
        ) -> Result<tonic::Response<boxlite_shared::SyncClockResponse>, tonic::Status> {
            *self.received.lock().expect("received lock") = Some(request.into_inner());
            match self.sync_status.clone() {
                Some(status) => Err(status),
                None => Ok(tonic::Response::new(boxlite_shared::SyncClockResponse {})),
            }
        }

        async fn memory_observation(
            &self,
            _: tonic::Request<boxlite_shared::MemoryObservationRequest>,
        ) -> Result<tonic::Response<boxlite_shared::MemoryObservationResponse>, tonic::Status>
        {
            Err(tonic::Status::unimplemented("memory observation"))
        }

        async fn resize_filesystem(
            &self,
            _: tonic::Request<boxlite_shared::ResizeFilesystemRequest>,
        ) -> Result<tonic::Response<boxlite_shared::ResizeFilesystemResponse>, tonic::Status>
        {
            Err(tonic::Status::unimplemented("test fake"))
        }
    }

    async fn serve_fake(
        path: &std::path::Path,
        sync_status: Option<tonic::Status>,
    ) -> Arc<Mutex<Option<SyncClockRequest>>> {
        use boxlite_shared::generated::guest_server::GuestServer;

        let listener = tokio::net::UnixListener::bind(path).expect("bind the test socket");
        let received = Arc::new(Mutex::new(None));
        let fake = FakeGuest {
            sync_status,
            received: Arc::clone(&received),
        };
        tokio::spawn(
            tonic::transport::Server::builder()
                .add_service(GuestServer::new(fake))
                .serve_with_incoming(tokio_stream::wrappers::UnixListenerStream::new(listener)),
        );
        received
    }

    fn unix_transport(path: &std::path::Path) -> BoxTransport {
        BoxTransport::Unix {
            socket_path: path.to_path_buf(),
        }
    }

    fn socket_dir() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("clock-")
            .tempdir_in("/tmp")
            .expect("short socket directory")
    }

    #[test]
    fn only_native_uses_the_shim_clock_worker() {
        assert!(enabled_for(VmmKind::Native));
        assert!(!enabled_for(VmmKind::Libkrun));
        assert!(!enabled_for(VmmKind::Firecracker));
    }

    #[tokio::test]
    async fn loop_pushes_at_startup_and_again_after_sixty_seconds() {
        let dir = socket_dir();
        let path = dir.path().join("guest.sock");
        let received = serve_fake(&path, None).await;
        let worker = tokio::spawn(sync_loop(unix_transport(&path)));
        let first = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Some(request) = received.lock().expect("capture lock").take() {
                    break request;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("startup push");
        let second = tokio::time::timeout(Duration::from_secs(65), async {
            loop {
                if let Some(request) = received.lock().expect("capture lock").take() {
                    break request;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("periodic push without a wake event");
        worker.abort();
        let delta = i128::from(second.unix_sec - first.unix_sec) * 1_000_000_000
            + i128::from(second.nanos - first.nanos);
        assert!(
            delta >= 60_000_000_000,
            "pushed before sixty seconds: {delta}ns"
        );
    }

    #[tokio::test]
    async fn delayed_connection_samples_after_the_listener_is_ready() {
        let dir = socket_dir();
        let path = dir.path().join("guest.sock");
        let transport = unix_transport(&path);
        let attempt =
            tokio::spawn(async move { sync_once(&transport, SYNC_TIMEOUT, "test").await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        let ready_at = SystemTime::now();
        let received = serve_fake(&path, None).await;
        let sampled_at = attempt
            .await
            .expect("attempt task")
            .expect("delayed channel recovered")
            .wall;
        assert!(
            sampled_at >= ready_at,
            "timestamp predates the available channel"
        );
        let sent = received
            .lock()
            .expect("capture lock")
            .expect("RPC reached guest");
        assert_eq!(
            sampled_at,
            UNIX_EPOCH + Duration::new(sent.unix_sec as u64, sent.nanos as u32)
        );
    }

    #[test]
    fn schedule_checks_thresholds_and_keeps_failures_due() {
        let after = Duration::from_secs;
        let at = |wall, boottime| HostTime {
            wall: UNIX_EPOCH + after(wall),
            boottime: after(boottime),
        };
        let mut schedule = Schedule {
            previous_check: at(100, 100),
            last_successful_push: None,
            pending: None,
        };
        assert_eq!(schedule.check(at(100, 100)), Some("no_successful_push"));
        assert_eq!(schedule.check(at(102, 102)), Some("no_successful_push"));
        schedule.pushed(after(102));
        assert_eq!(schedule.check(at(107, 107)), None);
        assert_eq!(schedule.check(at(113, 113)), Some("check_gap"));
        assert_eq!(schedule.check(at(115, 115)), Some("check_gap"));
        schedule.pushed(after(115));
        schedule.previous_check = at(172, 172);
        assert_eq!(schedule.check(at(174, 174)), None);
        assert_eq!(schedule.check(at(175, 175)), Some("periodic"));
        assert_eq!(schedule.check(at(177, 177)), Some("periodic"));
        schedule.pushed(after(177));
        assert_eq!(schedule.check(at(179, 179)), None);
        assert_eq!(schedule.check(at(180, 181)), Some("host_clock_step"));
        schedule.pushed(after(181));
        assert_eq!(schedule.check(at(182, 183)), None);
        // Even a successful RPC must not erase a suspend during that RPC.
        schedule.pushed(after(191));
        assert_eq!(schedule.check(at(190, 191)), Some("check_gap"));
    }

    #[tokio::test]
    async fn rpc_samples_current_time_and_propagates_rejections() {
        for (index, status) in [
            None,
            Some(tonic::Status::permission_denied("no CAP_SYS_TIME")),
            Some(tonic::Status::unimplemented("old agent")),
        ]
        .into_iter()
        .enumerate()
        {
            let dir = socket_dir();
            let path = dir.path().join("guest.sock");
            let received = serve_fake(&path, status).await;
            let before = SystemTime::now();
            let result = sync_once(&unix_transport(&path), SYNC_TIMEOUT, "test").await;
            let after = SystemTime::now();
            let sent = received
                .lock()
                .expect("capture lock")
                .expect("RPC reached guest");
            let sent_at = UNIX_EPOCH + Duration::new(sent.unix_sec as u64, sent.nanos as u32);
            assert!((before..=after).contains(&sent_at));
            match index {
                0 => assert_eq!(result.expect("RPC succeeded").wall, sent_at),
                1 => assert!(
                    result
                        .expect_err("guest rejected")
                        .contains("PermissionDenied")
                ),
                _ => assert!(
                    result
                        .expect_err("old agent rejected")
                        .contains("Unimplemented")
                ),
            }
        }
    }

    #[tokio::test]
    async fn stalled_connection_respects_the_attempt_budget() {
        let dir = socket_dir();
        let path = dir.path().join("guest.sock");
        let listener = tokio::net::UnixListener::bind(&path).expect("bind stalled socket");
        let peer = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.expect("accept");
            std::future::pending::<()>().await;
        });
        let started = Instant::now();
        let result = sync_once(&unix_transport(&path), Duration::from_millis(100), "test").await;
        peer.abort();
        assert!(
            result
                .expect_err("stalled peer times out")
                .contains("timed out")
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn rpc_runs_under_vmm_seccomp_without_a_system_bus() {
        const CHILD: &str = "BOXLITE_CLOCK_SECCOMP_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let output = std::process::Command::new(std::env::current_exe().expect("test binary"))
                .args([
                    "--exact",
                    "timesync::tests::rpc_runs_under_vmm_seccomp_without_a_system_bus",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .env(
                    "DBUS_SYSTEM_BUS_ADDRESS",
                    "unix:path=/nonexistent/clock-test-bus",
                )
                .output()
                .expect("run isolated seccomp test");
            assert!(
                output.status.success(),
                "child failed: {:?}\n{}\n{}",
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let dir = socket_dir();
        boxlite::jailer::seccomp::apply_vmm_filter("clock-sync-test").expect("install VMM filter");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime under filter");
        runtime.block_on(async {
            let path = dir.path().join("guest.sock");
            let received = serve_fake(&path, None).await;
            sync_once(&unix_transport(&path), SYNC_TIMEOUT, "test")
                .await
                .expect("RPC under filter");
            assert!(received.lock().expect("capture lock").is_some());
        });
    }
}
