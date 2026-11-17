//! Resume-event clock sync: once per host resume, correct the guest clock.
//!
//! The shim owns this because a detached Box outlives its creator: neither
//! the SDK process nor `boxlite serve` is guaranteed to be alive when the
//! host wakes up. The Linux wake source is logind's `PrepareForSleep(false)`
//! (the sleep/hibernate has finished). Without logind the subscription logs
//! why it stopped and stays off — there is no periodic fallback, per the
//! design boundary that nothing corrects the clock without a resume event.
//!
//! One correction per wake: connect with backoff inside a 5 s window, sample
//! the host UTC right before sending, and let a connected RPC's outcome end
//! the cycle. A failed correction is logged, never retried into a second
//! correction, and never reported as applied.

// The wake-subscription machinery below is Linux-only; on other platforms the
// module carries only the engine gate, so these imports stay gated with it.
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "linux")]
use boxlite::GuestSession;
use boxlite::vmm::VmmKind;
use boxlite_shared::BoxTransport;

/// Total window for one resume correction; the acceptance target allows 5 s.
#[cfg(target_os = "linux")]
pub(crate) const SYNC_WINDOW: Duration = Duration::from_secs(5);
/// Guest RPC budget once the channel is connected.
#[cfg(target_os = "linux")]
const RPC_TIMEOUT: Duration = Duration::from_secs(2);
/// Reconnect backoff inside the window: 100 ms doubling, capped at 500 ms.
#[cfg(target_os = "linux")]
const RETRY_START: Duration = Duration::from_millis(100);
#[cfg(target_os = "linux")]
const RETRY_CAP: Duration = Duration::from_millis(500);

/// Outcome of one resume correction cycle.
#[cfg(target_os = "linux")]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SyncOutcome {
    Corrected,
    GuestRejected(String),
    RpcTimedOut,
    ChannelUnavailable,
}

/// Start the wake-event watcher, unless the engine keeps its own mechanism.
///
/// Native only (design decision 2): libkrun ships a TIMESYNC datagram
/// receiver, and two mechanisms must not both set the guest clock.
pub(crate) fn spawn(engine: VmmKind, transport: BoxTransport) {
    if !enabled_for(engine) {
        tracing::info!(
            ?engine,
            "resume clock sync stays off; this engine keeps its own time mechanism"
        );
        return;
    }
    if let Err(error) = std::thread::Builder::new()
        .name("resume-clock-sync".into())
        .spawn(move || run_event_loop(transport))
    {
        tracing::warn!(%error, "could not start the resume-clock-sync thread");
    }
}

/// The engine gate: only the native VMM gets the shim's wake subscription.
fn enabled_for(engine: VmmKind) -> bool {
    engine == VmmKind::Native
}

#[cfg(target_os = "linux")]
fn run_event_loop(transport: BoxTransport) {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            tracing::warn!(%error, "resume clock sync could not start a runtime");
            return;
        }
    };
    runtime.block_on(logind_resume_loop(transport));
}

#[cfg(not(target_os = "linux"))]
fn run_event_loop(_transport: BoxTransport) {
    // Engine gating keeps this off macOS today: the native VMM is
    // x86_64/Linux only, and libkrun runs its own timesync, so no wake-event
    // source is wired here yet.
    tracing::info!("no wake-event source for resume clock sync on this platform");
}

/// One clock correction per `PrepareForSleep(false)` (host finished sleeping).
#[cfg(target_os = "linux")]
async fn logind_resume_loop(transport: BoxTransport) {
    use futures_lite::StreamExt as _;

    let connection = match zbus::Connection::system().await {
        Ok(connection) => connection,
        Err(error) => {
            tracing::warn!(
                %error,
                "no system bus: resume clock sync stays off (no wake events, no periodic fallback)"
            );
            return;
        }
    };
    let logind = match zbus::Proxy::new(
        &connection,
        "org.freedesktop.login1",
        "/org/freedesktop/login1",
        "org.freedesktop.login1.Manager",
    )
    .await
    {
        Ok(proxy) => proxy,
        Err(error) => {
            tracing::warn!(%error, "no logind on the system bus: resume clock sync stays off");
            return;
        }
    };
    let mut sleeps = match logind.receive_signal("PrepareForSleep").await {
        Ok(signals) => signals,
        Err(error) => {
            tracing::warn!(%error, "cannot subscribe to PrepareForSleep: resume clock sync stays off");
            return;
        }
    };
    tracing::info!("Subscribed to logind PrepareForSleep; one clock correction per wake");

    while let Some(signal) = sleeps.next().await {
        // The payload is (starting: bool); `false` means the sleep finished.
        let starting = match signal.body().deserialize::<(bool,)>() {
            Ok((starting,)) => starting,
            Err(error) => {
                tracing::warn!(%error, "unreadable PrepareForSleep payload; ignoring the signal");
                continue;
            }
        };
        tracing::info!(starting, "PrepareForSleep received");
        if starting {
            continue;
        }
        tracing::info!("Host resumed from sleep; sending one clock correction");
        let outcome = sync_once(&transport, SYNC_WINDOW).await;
        tracing::info!(?outcome, "resume clock correction finished");
    }
}

/// Connect (with backoff inside the window), sample the host clock, and send
/// exactly one correction. A connected RPC's outcome ends the cycle: the next
/// wake event is the next chance, matching the one-shot boundary.
#[cfg(target_os = "linux")]
pub(crate) async fn sync_once(transport: &BoxTransport, window: Duration) -> SyncOutcome {
    let deadline = Instant::now() + window;
    let mut backoff = RETRY_START;
    loop {
        // The connector retries internally for far longer than the window,
        // so the connect itself is bounded by what remains of this resume.
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            tracing::warn!("guest channel did not come up inside the resume window");
            return SyncOutcome::ChannelUnavailable;
        }
        let session = GuestSession::new(transport.clone());
        match tokio::time::timeout(remaining, session.guest()).await {
            Ok(Ok(mut guest)) => {
                // Sample the host clock after connecting, so waiting for the
                // agent can never send a stale stamp; the RPC shares the
                // window with the connect but never outlives the resume.
                let budget = deadline
                    .saturating_duration_since(Instant::now())
                    .min(RPC_TIMEOUT);
                let (unix_sec, nanos) = host_utc_now();
                return match tokio::time::timeout(budget, guest.sync_clock(unix_sec, nanos)).await {
                    Ok(Ok(())) => SyncOutcome::Corrected,
                    Ok(Err(error)) => SyncOutcome::GuestRejected(error.to_string()),
                    Err(_) => SyncOutcome::RpcTimedOut,
                };
            }
            Ok(Err(error)) => {
                if Instant::now() + backoff >= deadline {
                    tracing::warn!(
                        %error,
                        "guest channel did not come up inside the resume window"
                    );
                    return SyncOutcome::ChannelUnavailable;
                }
                tracing::debug!(%error, "guest channel not ready; retrying resume clock sync");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(RETRY_CAP);
            }
            Err(_elapsed) => {
                tracing::warn!("guest channel did not come up inside the resume window");
                return SyncOutcome::ChannelUnavailable;
            }
        }
    }
}

/// Host UTC as the agent expects it: (seconds since the epoch, nanoseconds).
#[cfg(target_os = "linux")]
fn host_utc_now() -> (i64, i32) {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(now) => (now.as_secs() as i64, now.subsec_nanos() as i32),
        // A host clock before 1970 is broken; the agent rejects the stamp.
        Err(_) => (0, 0),
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use boxlite_shared::SyncClockRequest;
    use std::sync::{Arc, Mutex};

    /// A Guest server over the same Unix transport the shim uses, capturing
    /// the sampled stamp or reporting the supplied status.
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

    /// Serve a fake guest on `path` (binding it) and return the capture slot.
    async fn serve_fake(
        path: &std::path::Path,
        sync_status: Option<tonic::Status>,
    ) -> Arc<Mutex<Option<SyncClockRequest>>> {
        use boxlite_shared::generated::guest_server::GuestServer;

        let _ = std::fs::remove_file(path);
        let listener = tokio::net::UnixListener::bind(path).expect("bind the test socket");
        let received: Arc<Mutex<Option<SyncClockRequest>>> = Arc::new(Mutex::new(None));
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

    /// Short unique socket paths: AF_UNIX paths cap at SUN_LEN (108), and
    /// TMPDIR may point somewhere arbitrarily deep (e.g. nested nix-shell
    /// dirs), so the tests bind directly under `/tmp`.
    fn test_socket_path(name: &str) -> std::path::PathBuf {
        std::path::PathBuf::from("/tmp").join(format!(
            "boxlite-resume-{}-{}.sock",
            name,
            std::process::id()
        ))
    }

    fn unix_transport(path: &std::path::Path) -> BoxTransport {
        BoxTransport::Unix {
            socket_path: path.to_path_buf(),
        }
    }

    #[test]
    fn the_wake_subscription_starts_only_for_the_native_engine() {
        use boxlite::vmm::VmmKind;

        assert!(enabled_for(VmmKind::Native));
        assert!(!enabled_for(VmmKind::Libkrun));
        assert!(!enabled_for(VmmKind::Firecracker));
    }

    #[tokio::test]
    async fn corrects_the_clock_once_the_channel_comes_up() {
        let path = test_socket_path("corrects");
        let received = serve_fake(&path, None).await;

        let outcome = sync_once(&unix_transport(&path), SYNC_WINDOW).await;

        let _ = std::fs::remove_file(&path);
        assert_eq!(outcome, SyncOutcome::Corrected);
        let sent = received
            .lock()
            .expect("received lock")
            .expect("the sample reached the fake guest");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_secs() as i64;
        assert!(
            (sent.unix_sec - now).abs() <= 5,
            "stamp must be sampled right before sending: {} vs now {now}",
            sent.unix_sec
        );
    }

    #[tokio::test]
    async fn a_connected_guest_rejection_ends_the_cycle() {
        let path = test_socket_path("rejected");
        serve_fake(
            &path,
            Some(tonic::Status::permission_denied("no CAP_SYS_TIME")),
        )
        .await;

        let outcome = sync_once(&unix_transport(&path), SYNC_WINDOW).await;

        let _ = std::fs::remove_file(&path);

        match outcome {
            SyncOutcome::GuestRejected(message) => assert!(
                message.contains("PermissionDenied") && message.contains("no CAP_SYS_TIME"),
                "the guest rejection must reach the host verbatim: {message}"
            ),
            other => panic!("expected a guest rejection, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_agent_without_the_method_fails_the_cycle() {
        let path = test_socket_path("unimplemented");
        serve_fake(&path, Some(tonic::Status::unimplemented("old agent"))).await;

        let outcome = sync_once(&unix_transport(&path), SYNC_WINDOW).await;

        let _ = std::fs::remove_file(&path);

        match outcome {
            SyncOutcome::GuestRejected(message) => assert!(
                message.contains("Unimplemented"),
                "an agent without SyncClock must fail the cycle: {message}"
            ),
            other => panic!("expected an Unimplemented rejection, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_never_ready_channel_gives_up_inside_the_window() {
        let path = test_socket_path("absent");
        let _ = std::fs::remove_file(&path);

        let started = Instant::now();
        let outcome = sync_once(&unix_transport(&path), Duration::from_millis(300)).await;
        let elapsed = started.elapsed();

        assert_eq!(outcome, SyncOutcome::ChannelUnavailable);
        assert!(
            elapsed >= Duration::from_millis(300),
            "the retry loop must stay inside the window"
        );
    }
}
