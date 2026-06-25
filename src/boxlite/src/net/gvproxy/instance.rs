//! GvproxyInstance - High-level wrapper for gvproxy lifecycle management
//!
//! This module provides a safe, RAII-style wrapper around gvproxy instances.
//! Instances are automatically cleaned up when dropped.

use std::path::{Path, PathBuf};
use std::sync::Weak;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::ffi;
use super::logging;
use super::stats::NetworkStats;

/// Safe wrapper for gvproxy library with automatic resource management
///
/// This struct manages the lifecycle of a gvproxy (gvisor-tap-vsock) instance
/// and automatically sets up logging integration on first use.
///
/// ## Logging
///
/// On the first call to `GvproxyInstance::new()`, a logging callback is registered
/// with the Go side via `gvproxy_set_log_callback`. This causes all Go `slog` logs
/// to be forwarded to Rust's `tracing` with the target `"gvproxy"`.
///
/// The callback is registered using `std::sync::Once` to ensure it happens exactly once,
/// regardless of how many instances are created.
///
/// ## Resource Management
///
/// The instance automatically calls `gvproxy_destroy` when dropped, ensuring
/// proper cleanup of Go resources and Unix sockets.
///
/// ## Thread Safety
///
/// `GvproxyInstance` is `Send`, allowing it to be transferred between threads.
/// The underlying CGO layer handles synchronization internally.
///
/// ## Example
///
/// `GvproxyInstance` is created internally by BoxLite's gvproxy backend during
/// box startup. Once initialized, the instance exposes its socket path via
/// [`GvproxyInstance::socket_path`] and automatically destroys the underlying
/// gvproxy handle on drop.
#[derive(Debug)]
pub struct GvproxyInstance {
    id: i64,
    socket_path: PathBuf,
}

impl GvproxyInstance {
    /// Create a new gvproxy instance with the given socket path and port mappings
    ///
    /// This automatically initializes the logging bridge on first use.
    ///
    /// # Arguments
    ///
    /// * `socket_path` - Caller-provided Unix socket path (must be unique per box)
    /// * `port_mappings` - List of (host_port, guest_port) tuples for port forwarding
    pub(crate) fn new(
        socket_path: PathBuf,
        port_mappings: &[(u16, u16)],
        allow_net: Vec<String>,
        secrets: Vec<super::config::GvproxySecretConfig>,
        ca_cert_pem: Option<&str>,
        ca_key_pem: Option<&str>,
    ) -> BoxliteResult<Self> {
        // Initialize logging callback (one-time setup)
        logging::init_logging();

        let mut config =
            super::config::GvproxyConfig::new(socket_path.clone(), port_mappings.to_vec())
                .with_allow_net(allow_net)
                .with_secrets(secrets);

        if let (Some(cert), Some(key)) = (ca_cert_pem, ca_key_pem) {
            config = config.with_ca(cert.to_string(), key.to_string());
        }

        let id = ffi::create_instance(&config)?;

        tracing::info!(id, ?socket_path, "Created GvproxyInstance");

        Ok(Self { id, socket_path })
    }

    /// Unix socket path for the network tap interface.
    ///
    /// This is the caller-provided path passed at creation — no FFI call needed.
    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    /// Create a GvproxyInstance from a NetworkBackendConfig and return the endpoint.
    ///
    /// This is the primary constructor — takes the full network config, creates the
    /// gvproxy instance, and returns the platform-specific endpoint for the VM.
    pub fn from_config(
        config: &super::super::NetworkBackendConfig,
    ) -> BoxliteResult<(Self, super::super::NetworkBackendEndpoint)> {
        let secrets = config.secrets.iter().map(Into::into).collect();
        let instance = Self::new(
            config.socket_path.clone(),
            &config.port_mappings,
            config.allow_net.clone(),
            secrets,
            config.ca_cert_pem.as_deref(),
            config.ca_key_pem.as_deref(),
        )?;

        let connection_type = if cfg!(target_os = "macos") {
            super::super::ConnectionType::UnixDgram
        } else {
            super::super::ConnectionType::UnixStream
        };

        use crate::net::constants::GUEST_MAC;
        let endpoint = super::super::NetworkBackendEndpoint::UnixSocket {
            path: config.socket_path.clone(),
            connection_type,
            mac_address: GUEST_MAC,
        };

        Ok((instance, endpoint))
    }

    /// Get network statistics from this gvproxy instance
    ///
    /// Returns current network counters including bandwidth, TCP metrics,
    /// and critical debugging counters like forward_max_inflight_drop.
    ///
    /// # Returns
    ///
    /// NetworkStats struct or an error if:
    /// - Instance not found (already destroyed)
    /// - VirtualNetwork not initialized yet (too early)
    /// - JSON parsing failed
    ///
    /// Call this on an existing gvproxy instance to inspect bandwidth counters
    /// and debugging metrics such as `forward_max_inflight_drop`.
    pub fn get_stats(&self) -> BoxliteResult<NetworkStats> {
        // Get JSON from FFI layer
        let json_str = ffi::get_stats_json(self.id)?;

        tracing::debug!("Received stats JSON: {}", json_str);

        // Parse JSON into NetworkStats
        NetworkStats::from_json_str(&json_str).map_err(|e| {
            BoxliteError::Network(format!(
                "Failed to parse stats JSON from gvproxy: {} (JSON: {})",
                e, json_str
            ))
        })
    }

    /// Get the gvproxy version string
    ///
    /// Returns the version of the gvproxy-bridge library.
    ///
    /// # Returns
    ///
    /// Version string or an error
    ///
    /// # Example
    ///
    /// ```no_run
    /// use boxlite::net::gvproxy::GvproxyInstance;
    ///
    /// let version = GvproxyInstance::version()?;
    /// println!("gvproxy version: {}", version);
    /// # Ok::<(), boxlite_shared::errors::BoxliteError>(())
    /// ```
    pub fn version() -> BoxliteResult<String> {
        ffi::get_version()
    }

    /// Get the instance ID
    ///
    /// This is the internal handle used by the CGO layer.
    pub fn id(&self) -> i64 {
        self.id
    }
}

impl Drop for GvproxyInstance {
    fn drop(&mut self) {
        tracing::debug!(id = self.id, "Dropping GvproxyInstance");

        match ffi::destroy_instance(self.id) {
            Ok(()) => tracing::debug!(id = self.id, "Successfully destroyed gvproxy instance"),
            Err(e) => tracing::error!(
                id = self.id,
                error = %e,
                "Failed to destroy gvproxy instance"
            ),
        }
    }
}

// The CGO layer handles synchronization internally, so it's safe to send between threads
unsafe impl Send for GvproxyInstance {}

/// Starts a background task to periodically log network statistics
///
/// This function spawns a tokio task that logs network stats every 30 seconds.
/// The task holds a weak reference to the instance and will automatically exit
/// when the instance is dropped.
///
/// # Arguments
///
/// * `instance` - Weak reference to the GvproxyInstance to monitor
///
/// # Design
///
/// - Uses Weak<GvproxyInstance> to avoid keeping instance alive
/// - Logs at INFO level every 30 seconds
/// - Automatically exits when instance is dropped (weak ref upgrade fails)
/// - Highlights critical metrics like forward_max_inflight_drop
pub(super) fn start_stats_logging(instance: Weak<GvproxyInstance>) {
    tokio::spawn(async move {
        // Wait 30 seconds before first log to let instance stabilize
        tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;

        loop {
            // Try to upgrade weak reference
            let Some(instance) = instance.upgrade() else {
                tracing::debug!("Stats logging task exiting (instance dropped)");
                break;
            };

            // Get stats and log
            match instance.get_stats() {
                Ok(stats) => {
                    tracing::info!(
                        bytes_sent = stats.bytes_sent,
                        bytes_received = stats.bytes_received,
                        tcp_established = stats.tcp.current_established,
                        tcp_failed = stats.tcp.failed_connection_attempts,
                        tcp_retransmits = stats.tcp.retransmits,
                        tcp_timeouts = stats.tcp.timeouts,
                        "Network statistics"
                    );

                    // Highlight critical drop counter
                    if stats.tcp.forward_max_inflight_drop > 0 {
                        tracing::warn!(
                            drops = stats.tcp.forward_max_inflight_drop,
                            "TCP connections dropped due to maxInFlight limit"
                        );
                    }
                }
                Err(e) => {
                    tracing::debug!(error = %e, "Failed to get stats (instance may be shutting down)");
                }
            }

            // Drop the Arc before sleeping to avoid holding ref
            drop(instance);

            // Sleep 30 seconds before next log
            tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;
        }
    });

    tracing::debug!("Started background stats logging task");
}

/// Interval between successive `gvproxy_poll_runtime_error` calls. 250ms is
/// the design budget: tight enough that an operator chasing a silent failure
/// sees the event in their tracing stream within a quarter-second of it
/// happening; loose enough that on the steady-state common case (empty
/// queue → NULL return) we burn negligible CPU per gvproxy instance.
///
/// Coupled with the Go-side `runtimeErrQueueSize = 16` and the documented
/// "typical runtime failure cadence < 1 per minute" — at 250ms we'd need
/// the producer to push >64 events/sec for the queue to overflow before a
/// poll drains it, which is well outside any realistic VM-transport
/// failure rate.
const RUNTIME_ERROR_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

/// Starts a background task that polls the gvproxy ErrSink for runtime
/// errors and routes each one into `tracing::warn!` with the target
/// `gvproxy.runtime_error`.
///
/// This is the **consumer** half of the ErrSink framework introduced in
/// #634. The five silent-failure sites in `gvproxy-bridge` (Accept loops
/// on both transports, both protocol pumps, and OverrideTCPHandler) now
/// feed `sink.Runtime(...)`; without a Rust-side reader, those events
/// would accumulate in the bounded queue and eventually drop. This task
/// is what makes the framework externally observable.
///
/// # Design
///
/// - Uses `Weak<GvproxyInstance>` like `start_stats_logging` — drops out
///   automatically when the instance is destroyed, no explicit cancel.
/// - Polls at 250ms intervals (see [`RUNTIME_ERROR_POLL_INTERVAL`]).
/// - Each non-empty poll drains the queue completely in a tight loop so
///   bursty failures (e.g. a 10-event RST storm during VM shutdown) reach
///   the operator within one poll cycle instead of one event per cycle.
/// - Decode failures bubble through `poll_runtime_error` as `Err` — we
///   log them but do NOT exit the loop (a single malformed event must
///   not blind us to subsequent good events).
///
/// # Tracing
///
/// Every event is `warn!` at target `gvproxy.runtime_error` with fields
/// `instance_id` and `event` (the rendered `[ts] source: cause` string).
/// Operators can grep `gvproxy.runtime_error` to find every silent-failure
/// path covered by #634 firing in production.
pub(super) fn start_runtime_error_polling(instance: Weak<GvproxyInstance>) {
    tokio::spawn(async move {
        loop {
            let Some(instance) = instance.upgrade() else {
                tracing::debug!("Runtime error polling task exiting (instance dropped)");
                break;
            };

            let id = instance.id();
            // Drop the Arc before draining so we don't pin the instance.
            drop(instance);

            poll_and_route_once(id);
            tokio::time::sleep(RUNTIME_ERROR_POLL_INTERVAL).await;
        }
    });

    tracing::debug!("Started background runtime-error polling task");
}

/// Drains every queued runtime error from the given instance via
/// `ffi::poll_runtime_error` and routes each one into a `tracing::warn!`
/// at target `gvproxy.runtime_error`. Returns the number of events
/// drained so tests can assert without scraping tracing output.
///
/// Extracted from `start_runtime_error_polling` so it can be unit-tested
/// without a real `tokio::spawn` loop / `Weak<GvproxyInstance>` setup.
/// Production calls this once per ~250ms tick; tests call it directly
/// after injecting events via `libgvproxy_sys::gvproxy_test_inject_runtime_error`.
pub(super) fn poll_and_route_once(id: i64) -> usize {
    let mut count = 0;
    loop {
        match ffi::poll_runtime_error(id) {
            Ok(Some(event)) => {
                tracing::warn!(
                    target: "gvproxy.runtime_error",
                    instance_id = id,
                    event = %event,
                    "gvproxy goroutine reported a runtime error",
                );
                count += 1;
            }
            Ok(None) => break,
            Err(e) => {
                // Don't kill the loop on a single decode failure — log
                // and continue. The bounded Go-side queue means any
                // leftover bad event drops naturally.
                tracing::error!(
                    target: "gvproxy.runtime_error",
                    instance_id = id,
                    error = %e,
                    "poll_runtime_error decode failed; continuing"
                );
                break;
            }
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;
    use std::sync::{Arc, Mutex};

    /// Inject a synthetic runtime error into a test-fixture gvproxy
    /// instance via the test-only FFI exports. Used by the polling
    /// tests below to validate the consumer side without needing a real
    /// VM transport + virtualnetwork setup.
    fn inject_runtime_error(id: i64, source: &str, message: &str) {
        let c_source = CString::new(source).unwrap();
        let c_message = CString::new(message).unwrap();
        unsafe {
            libgvproxy_sys::gvproxy_test_inject_runtime_error(
                id,
                c_source.as_ptr(),
                c_message.as_ptr(),
            );
        }
    }

    /// Create a test-fixture gvproxy instance + cleanup guard. The
    /// fixture has no socket / no goroutines / no virtual network — it
    /// exists only so its `errSink` can be driven by inject + polled by
    /// the consumer under test.
    struct PollingFixture {
        id: i64,
    }

    impl PollingFixture {
        fn new() -> Self {
            let id = unsafe { libgvproxy_sys::gvproxy_test_create_for_polling() };
            assert!(id > 0, "test-fixture creation must return a positive id");
            Self { id }
        }
    }

    impl Drop for PollingFixture {
        fn drop(&mut self) {
            unsafe {
                libgvproxy_sys::gvproxy_destroy(self.id);
            }
        }
    }

    /// Tracing-capture writer used to assert tracing output from
    /// `poll_and_route_once` without scraping a real subscriber. Same
    /// pattern as `vmm/controller/shim.rs::BufWriter`.
    #[derive(Clone)]
    struct BufWriter(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for BufWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for BufWriter {
        type Writer = BufWriter;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    /// ffi::poll_runtime_error round-trips: empty -> inject -> rendered
    /// event string surfaces with source + cause + RFC3339 timestamp.
    /// Validates the Rust-side wrapper of the gvproxy_poll_runtime_error
    /// FFI specifically (no tracing involved).
    #[test]
    fn ffi_poll_runtime_error_round_trips() {
        let f = PollingFixture::new();

        // Empty queue -> None.
        assert!(
            ffi::poll_runtime_error(f.id).unwrap().is_none(),
            "newly-created fixture must have no events",
        );

        inject_runtime_error(f.id, "vn.AcceptQemu", "synthesized cause");

        let event = ffi::poll_runtime_error(f.id)
            .expect("poll succeeded")
            .expect("event present after inject");

        assert!(
            event.contains("vn.AcceptQemu"),
            "event must name source 'vn.AcceptQemu'; got: {event}",
        );
        assert!(
            event.contains("synthesized cause"),
            "event must contain cause; got: {event}",
        );
        assert!(
            event.contains('T') && event.contains('Z'),
            "event must contain RFC3339 timestamp; got: {event}",
        );

        // Drained.
        assert!(ffi::poll_runtime_error(f.id).unwrap().is_none());
    }

    /// poll_and_route_once drains EVERY queued event into tracing in a
    /// single call (so bursty failures reach the operator within one
    /// poll cycle, not one event per cycle). Asserts on:
    ///   - returned drain count = number injected
    ///   - tracing output contains the rendered event for each
    ///   - tracing output uses the `gvproxy.runtime_error` target
    #[test]
    fn poll_and_route_once_drains_and_emits_tracing_per_event() {
        let f = PollingFixture::new();

        // Inject 3 events of distinct source / cause so we can verify
        // each one was forwarded to tracing.
        inject_runtime_error(f.id, "listener.Accept", "first event cause");
        inject_runtime_error(f.id, "vn.AcceptQemu", "second event cause");
        inject_runtime_error(f.id, "transport.AcceptVfkit", "third event cause");

        let buf = Arc::new(Mutex::new(Vec::<u8>::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(BufWriter(buf.clone()))
            .with_max_level(tracing::Level::WARN)
            .with_ansi(false)
            .finish();

        let drained = tracing::subscriber::with_default(subscriber, || poll_and_route_once(f.id));

        assert_eq!(
            drained, 3,
            "all 3 injected events must be drained in a single poll cycle",
        );

        let written = String::from_utf8(buf.lock().unwrap().clone()).unwrap();

        for (source, cause) in [
            ("listener.Accept", "first event cause"),
            ("vn.AcceptQemu", "second event cause"),
            ("transport.AcceptVfkit", "third event cause"),
        ] {
            assert!(
                written.contains(source),
                "tracing output must contain source {source}; got:\n{written}",
            );
            assert!(
                written.contains(cause),
                "tracing output must contain cause {cause}; got:\n{written}",
            );
        }
        assert!(
            written.contains("gvproxy.runtime_error"),
            "tracing output must use target gvproxy.runtime_error so operators can grep it; got:\n{written}",
        );
        assert!(
            written.contains(&format!("instance_id={}", f.id)),
            "tracing event must include instance_id={} for correlation; got:\n{written}",
            f.id,
        );
    }

    /// Polling an empty queue returns 0 and emits nothing — pins that
    /// the steady-state common case (no errors) is silent in tracing,
    /// so the 250ms tick doesn't flood logs on a healthy instance.
    #[test]
    fn poll_and_route_once_on_empty_queue_emits_nothing() {
        let f = PollingFixture::new();

        let buf = Arc::new(Mutex::new(Vec::<u8>::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(BufWriter(buf.clone()))
            .with_max_level(tracing::Level::WARN)
            .with_ansi(false)
            .finish();

        let drained = tracing::subscriber::with_default(subscriber, || poll_and_route_once(f.id));

        assert_eq!(drained, 0, "empty queue must return 0 drained events");

        let written = buf.lock().unwrap();
        assert!(
            written.is_empty(),
            "empty-queue poll must not emit any tracing; got: {:?}",
            String::from_utf8_lossy(&written),
        );
    }

    #[test]
    #[ignore] // Requires libgvproxy.dylib to be available
    fn test_gvproxy_version() {
        let version = GvproxyInstance::version().unwrap();
        assert!(!version.is_empty());
        assert!(version.contains("gvproxy-bridge"));
    }

    #[test]
    #[ignore] // Requires libgvproxy.dylib to be available
    fn test_gvproxy_create_destroy() {
        let socket_path = PathBuf::from("/tmp/test-gvproxy-instance.sock");
        let instance = GvproxyInstance::new(
            socket_path.clone(),
            &[(8080, 80), (8443, 443)],
            Vec::new(),
            Vec::new(),
            None,
            None,
        )
        .unwrap();

        // Socket path matches what we provided
        assert_eq!(instance.socket_path(), socket_path);

        // Instance will be destroyed automatically when dropped
    }

    #[test]
    #[ignore] // Requires libgvproxy.dylib to be available
    fn test_multiple_instances() {
        let path1 = PathBuf::from("/tmp/test-gvproxy-1.sock");
        let path2 = PathBuf::from("/tmp/test-gvproxy-2.sock");

        let instance1 = GvproxyInstance::new(
            path1.clone(),
            &[(8080, 80)],
            Vec::new(),
            Vec::new(),
            None,
            None,
        )
        .unwrap();
        let instance2 = GvproxyInstance::new(
            path2.clone(),
            &[(9090, 90)],
            Vec::new(),
            Vec::new(),
            None,
            None,
        )
        .unwrap();

        assert_ne!(instance1.id(), instance2.id());
        assert_ne!(instance1.socket_path(), instance2.socket_path());
    }
}
