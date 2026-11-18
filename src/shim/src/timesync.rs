//! Native clock alignment owned by the shim, including detached Boxes.
//!
//! Check host wall time every two seconds: a six-second gap catches suspend
//! or scheduling stalls, and sixty seconds since success catches normal drift.
//! Only the guest decides whether its clock needs a correction.

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
    runtime.block_on(sync_loop(transport));
}

#[cfg(not(target_os = "linux"))]
fn run(_transport: BoxTransport) {}

#[cfg(target_os = "linux")]
struct Schedule {
    previous_check: SystemTime,
    last_successful_push: Option<SystemTime>,
}

#[cfg(target_os = "linux")]
impl Schedule {
    fn check(&mut self, now: SystemTime) -> Option<&'static str> {
        // Save the check time before any RPC; a suspend during the RPC must
        // still be visible as a gap at the next check.
        let gap = now.duration_since(self.previous_check);
        self.previous_check = now;
        let Some(last_success) = self.last_successful_push else {
            return Some("no_successful_push");
        };
        let since_success = now.duration_since(last_success);
        if gap.is_err() || since_success.is_err() {
            Some("host_clock_rollback")
        } else if gap.is_ok_and(|elapsed| elapsed >= GAP_THRESHOLD) {
            Some("check_gap")
        } else if since_success.is_ok_and(|elapsed| elapsed >= UPDATE_INTERVAL) {
            Some("periodic")
        } else {
            None
        }
    }
}

#[cfg(target_os = "linux")]
async fn sync_loop(transport: BoxTransport) {
    let mut schedule = Schedule {
        previous_check: SystemTime::now(),
        last_successful_push: None,
    };
    let mut checks = tokio::time::interval(CHECK_INTERVAL);
    // The first tick is immediate; missed checks never become a burst of RPCs.
    checks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        checks.tick().await;
        if let Some(reason) = schedule.check(SystemTime::now())
            && let Ok(sampled_at) = sync_once(&transport, SYNC_TIMEOUT, reason).await
        {
            schedule.last_successful_push = Some(sampled_at);
        }
    }
}

/// Connect and send within one budget; sample UTC only after connecting.
#[cfg(target_os = "linux")]
async fn sync_once(
    transport: &BoxTransport,
    timeout: Duration,
    reason: &str,
) -> Result<SystemTime, String> {
    let started = Instant::now();
    let mut sampled_at = None;
    let result = tokio::time::timeout(timeout, async {
        let session = GuestSession::new(transport.clone());
        let mut guest = session.guest().await.map_err(|error| error.to_string())?;
        let now = SystemTime::now();
        sampled_at = Some(now);
        let utc = now
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
            .expect("delayed channel recovered");
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
        let at = |seconds| UNIX_EPOCH + Duration::from_secs(seconds);
        let mut schedule = Schedule {
            previous_check: at(100),
            last_successful_push: None,
        };
        assert_eq!(schedule.check(at(100)), Some("no_successful_push"));
        assert_eq!(schedule.check(at(102)), Some("no_successful_push"));
        schedule.last_successful_push = Some(at(102));
        assert_eq!(schedule.check(at(107)), None);
        assert_eq!(schedule.check(at(113)), Some("check_gap"));
        // A failed gap push leaves the success baseline, but isn't itself retried.
        assert_eq!(schedule.check(at(115)), None);
        schedule.previous_check = at(159);
        assert_eq!(schedule.check(at(161)), None);
        assert_eq!(schedule.check(at(162)), Some("periodic"));
        assert_eq!(schedule.check(at(164)), Some("periodic"));
        schedule.last_successful_push = Some(at(164));
        assert_eq!(schedule.check(at(166)), None);
        assert_eq!(schedule.check(at(90)), Some("host_clock_rollback"));
        schedule.last_successful_push = Some(at(90));
        assert_eq!(schedule.check(at(92)), None);
        // Even a successful RPC must not erase a suspend during that RPC.
        schedule.last_successful_push = Some(at(100));
        assert_eq!(schedule.check(at(100)), Some("check_gap"));
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
                0 => assert_eq!(result.expect("RPC succeeded"), sent_at),
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
