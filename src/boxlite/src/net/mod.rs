//! Network backend abstraction for Boxes.
//!
//! [`NetworkBackend`] is a box's host-side network backend, owned per-box by
//! [`BoxImpl`](crate::litebox). It has two jobs: produce the wire
//! [`NetworkBackendSpec`] the shim uses to stand up the server ([`NetworkBackend::spec`]),
//! and be the **runtime control** seam — dynamic port forwarding, DNS, DHCP
//! leases, and stats, dialed from the core over the backend's control socket.
//! In the shim, the concrete gvproxy instance consumes the spec and yields the
//! [`NetworkBackendEndpoint`] value type the engine wires into the NIC.

use async_trait::async_trait;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use serde_json::Value;
use std::io;
use std::net::SocketAddr;
use std::os::fd::OwnedFd;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::UnixStream;

/// MITM CA generation — only the runtime-side gvproxy backend mints one (in `spec()`).
pub(crate) mod ca;
pub mod constants;
pub mod socket_path;

pub mod gvproxy;

pub use gvproxy::GvproxyBackend;

/// How the Box connects to the network backend.
///
/// This represents the connection information that needs to be passed to the engine.
/// Different backends provide different connection methods that the engine must handle.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum NetworkBackendEndpoint {
    /// Path to a Unix socket to connect to.
    /// The path can be passed across process boundaries via JSON.
    /// Used by: gvproxy, passt, libslirp, socket_vmnet
    UnixSocket {
        path: PathBuf,
        connection_type: ConnectionType,
        /// MAC address for the guest network interface
        /// This must match the DHCP static lease configured in the network backend
        mac_address: [u8; 6],
    },
}

/// The core-side inputs used to **create** a box's network backend.
///
/// Built by the core from the box's options + layout, then handed to
/// [`NetworkBackendFactory::create`]. The backend turns it into the wire
/// [`NetworkBackendSpec`] (via [`NetworkBackend::spec`]) that crosses to the shim.
/// `secrets` redacts itself in `Debug` and `ca_dir` is a plain path, so `Debug`
/// can derive.
#[derive(Debug, Clone)]
pub struct NetworkBackendConfig {
    /// Port mappings: (host_port, guest_port).
    pub port_mappings: Vec<(u16, u16)>,
    /// Unix socket path for the network backend (`net.sock`).
    pub socket_path: PathBuf,
    /// Network allowlist. When non-empty, DNS sinkhole blocks unlisted hosts.
    pub allow_net: Vec<String>,
    /// Secrets for MITM proxy injection.
    pub secrets: Vec<crate::runtime::options::Secret>,
    /// Directory in which to mint the ephemeral MITM CA — used only when
    /// `secrets` is non-empty. The backend mints the CA in [`NetworkBackend::spec`].
    pub ca_dir: PathBuf,
}

/// The wire blob a [`NetworkBackend`] produces (via [`NetworkBackend::spec`]) for
/// the shim to stand up the backend server. Crosses the core→shim boundary as
/// JSON inside `InstanceSpec`.
///
/// `Debug` is implemented manually (below) because `ca_key_pem` is a PKCS8 CA
/// private key and the derived form would print it in full into any `{:?}` log
/// line. `secrets` already redacts via [`Secret`](crate::runtime::options::Secret).
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct NetworkBackendSpec {
    /// Port mappings: (host_port, guest_port).
    pub port_mappings: Vec<(u16, u16)>,
    /// Unix socket path for the network backend.
    pub socket_path: PathBuf,
    /// Network allowlist. When non-empty, DNS sinkhole blocks unlisted hosts.
    #[serde(default)]
    pub allow_net: Vec<String>,
    /// Secrets for MITM proxy injection. Passed through to gvproxy.
    #[serde(default)]
    pub secrets: Vec<crate::runtime::options::Secret>,
    /// PEM-encoded MITM CA certificate (minted when secrets are configured).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ca_cert_pem: Option<String>,
    /// PEM-encoded MITM CA private key (PKCS8, minted when secrets are configured).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ca_key_pem: Option<String>,
}

impl std::fmt::Debug for NetworkBackendSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NetworkBackendSpec")
            .field("port_mappings", &self.port_mappings)
            .field("socket_path", &self.socket_path)
            .field("allow_net", &self.allow_net)
            .field("secrets", &self.secrets)
            .field(
                "ca_cert_pem",
                &self.ca_cert_pem.as_ref().map(|_| "[REDACTED]"),
            )
            .field(
                "ca_key_pem",
                &self.ca_key_pem.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

/// A forwarding rule as reported by gvproxy's `/services/forwarder/all`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Forward {
    /// Host-side bind address, `ip:port`.
    pub local: String,
    /// Guest-side target address, `ip:port`.
    pub remote: String,
    /// Transport protocol (`tcp` by default).
    #[serde(default)]
    pub protocol: String,
}

/// Transport protocol for a runtime forward.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransportProtocol {
    #[default]
    Tcp,
    Udp,
    Unix,
    Npipe,
}

impl TransportProtocol {
    /// Lowercase wire token (`"tcp"`, `"udp"`, `"unix"`, `"npipe"`).
    pub fn as_str(self) -> &'static str {
        match self {
            TransportProtocol::Tcp => "tcp",
            TransportProtocol::Udp => "udp",
            TransportProtocol::Unix => "unix",
            TransportProtocol::Npipe => "npipe",
        }
    }
}

/// A DNS zone to add at runtime. Backend-neutral: the gvproxy impl maps this to
/// gvproxy's capitalized `types.Zone` wire form internally.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DnsZoneSpec {
    /// Zone name, e.g. `"myapp.local."`.
    pub name: String,
    /// Exact A records in the zone.
    pub records: Vec<DnsRecordSpec>,
    /// Default IP for unmatched names in the zone (`None` = no default).
    pub default_ip: Option<String>,
}

/// An A record within a [`DnsZoneSpec`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DnsRecordSpec {
    pub name: String,
    pub ip: String,
}

/// Backend-neutral network statistics — bytes moved plus TCP health counters.
///
/// Produced by [`NetworkBackend::stats`] and read through typed getters only (no
/// opaque blob). A backend maps its own counters onto these known fields; gvproxy
/// maps its `/stats` `BytesSent`/`BytesReceived` + `TCP` group. Fields are
/// `pub(crate)` so backends assemble one with a self-documenting struct literal,
/// while external callers see getters only.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct NetworkBackendStats {
    pub(crate) bytes_sent: u64,
    pub(crate) bytes_received: u64,
    pub(crate) tcp_established: u64,
    pub(crate) tcp_failed_connections: u64,
    pub(crate) tcp_retransmits: u64,
    pub(crate) tcp_timeouts: u64,
    pub(crate) tcp_forward_max_inflight_drop: u64,
}

impl NetworkBackendStats {
    /// Total bytes sent to the guest.
    pub fn bytes_sent(&self) -> u64 {
        self.bytes_sent
    }
    /// Total bytes received from the guest.
    pub fn bytes_received(&self) -> u64 {
        self.bytes_received
    }
    /// TCP connections currently ESTABLISHED.
    pub fn tcp_established(&self) -> u64 {
        self.tcp_established
    }
    /// TCP connection attempts that failed.
    pub fn tcp_failed_connections(&self) -> u64 {
        self.tcp_failed_connections
    }
    /// TCP segments retransmitted (a performance indicator).
    pub fn tcp_retransmits(&self) -> u64 {
        self.tcp_retransmits
    }
    /// TCP retransmission-timeout (RTO) events.
    pub fn tcp_timeouts(&self) -> u64 {
        self.tcp_timeouts
    }
    /// SYNs dropped because the forwarder's max-in-flight limit was hit.
    pub fn tcp_forward_max_inflight_drop(&self) -> u64 {
        self.tcp_forward_max_inflight_drop
    }
}

/// The transport backing a [`BoxTunnel`] — a small, closed set (one variant per
/// transport). Only the local gvproxy unix socket exists today; a cloud WS/TLS
/// variant lands with the cloud data plane. Keeping the concrete type (rather than
/// erasing to `Box<dyn>`) is deliberate: the local variant can hand its raw OS fd
/// to an SDK with no unsafe downcast, and split lock-free. Mirrors pingora's
/// `enum RawStream` and tungstenite's `MaybeTlsStream`.
enum TunnelStream {
    /// A raw unix-socket pipe to a same-host backend (gvproxy `/tunnel`).
    Local(UnixStream),
}

/// A raw, bidirectional byte tunnel to a guest `ip:port`, opened via
/// [`NetworkBackend::tunnel`].
///
/// It *is* an async stream (`AsyncRead + AsyncWrite`) — read/write bytes directly
/// or `tokio::io::copy_bidirectional` it against another socket; `tokio::io::split`
/// it for concurrent read+write. The transport is swappable behind [`TunnelStream`]
/// so the same type carries a local unix pipe now and a cloud stream later without
/// touching [`NetworkBackend::tunnel`]'s signature. `peer_addr()` is the guest
/// target; [`into_fd`](Self::into_fd) recovers the tunnel's owned OS fd — the
/// transport-agnostic handle an SDK wraps as a native socket.
pub struct BoxTunnel {
    stream: TunnelStream,
    peer: SocketAddr,
}

impl BoxTunnel {
    /// Wrap a same-host unix-socket tunnel already connected to `peer`.
    pub fn from_local(stream: UnixStream, peer: SocketAddr) -> Self {
        Self {
            stream: TunnelStream::Local(stream),
            peer,
        }
    }

    /// The guest `ip:port` this tunnel targets.
    pub fn peer_addr(&self) -> SocketAddr {
        self.peer
    }

    /// Recover the tunnel's owned OS file descriptor — the transport-agnostic
    /// handle an SDK wraps as a native socket (the glue does `.into_raw_fd()`,
    /// then e.g. Python `socket.socket(fileno=fd)`). `None` for a transport with
    /// no single host fd (a cloud stream), where callers fall back to a
    /// local-listener bridge. This is the FFI-handoff shape libtailscale uses.
    pub fn into_fd(self) -> Option<OwnedFd> {
        match self.stream {
            // tokio → std deregisters from the reactor; the std socket owns the fd.
            TunnelStream::Local(stream) => stream.into_std().ok().map(OwnedFd::from),
        }
    }
}

impl std::fmt::Debug for BoxTunnel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BoxTunnel")
            .field("peer", &self.peer)
            .finish_non_exhaustive()
    }
}

impl AsyncRead for BoxTunnel {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match &mut self.get_mut().stream {
            TunnelStream::Local(s) => Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for BoxTunnel {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match &mut self.get_mut().stream {
            TunnelStream::Local(s) => Pin::new(s).poll_write(cx, buf),
        }
    }

    // Forward the vectored path so `copy_bidirectional` doesn't fall back to
    // byte-copies (hyper `Upgraded` / pingora / tonic all forward it).
    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        match &mut self.get_mut().stream {
            TunnelStream::Local(s) => Pin::new(s).poll_write_vectored(cx, bufs),
        }
    }

    fn is_write_vectored(&self) -> bool {
        match &self.stream {
            TunnelStream::Local(s) => s.is_write_vectored(),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match &mut self.get_mut().stream {
            TunnelStream::Local(s) => Pin::new(s).poll_flush(cx),
        }
    }

    // Half-close (write FIN to the guest), distinct from dropping the tunnel.
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match &mut self.get_mut().stream {
            TunnelStream::Local(s) => Pin::new(s).poll_shutdown(cx),
        }
    }
}

/// Error for a control operation a backend does not implement.
fn control_unsupported(op: &str) -> BoxliteError {
    BoxliteError::Unsupported(format!(
        "network backend does not support runtime control ({op})"
    ))
}

/// Host-side runtime **control** seam for a box's network.
///
/// The methods drive the backend's control API (for gvproxy, its ServicesMux):
/// dynamic port forwarding, DNS, DHCP leases, and stats. Backends that can't do
/// runtime control inherit the default `Unsupported` implementations. Owned
/// per-box by the core (see `BoxImpl::network`); provisioning the VM's NIC is a
/// separate, non-trait concern.
#[async_trait]
pub trait NetworkBackend: Send + Sync + std::fmt::Debug {
    /// A human-readable name for this backend (e.g. `"gvisor-tap-vsock"`).
    fn name(&self) -> &'static str;

    /// Produce the wire [`NetworkBackendSpec`] the shim uses to stand up this
    /// backend's server — reading the backend's held config and minting any
    /// backend-specific material (e.g. gvproxy's MITM CA).
    fn spec(&self) -> NetworkBackendSpec;

    /// Add a forward: bind host `local` (`ip:port`) → guest `remote` (`ip:port`).
    async fn expose(
        &self,
        _local: &str,
        _remote: &str,
        _protocol: TransportProtocol,
    ) -> BoxliteResult<()> {
        Err(control_unsupported("expose"))
    }

    /// Remove the forward bound at host `local`.
    async fn unexpose(&self, _local: &str, _protocol: TransportProtocol) -> BoxliteResult<()> {
        Err(control_unsupported("unexpose"))
    }

    /// List the active forwards.
    async fn list_forwards(&self) -> BoxliteResult<Vec<Forward>> {
        Err(control_unsupported("list_forwards"))
    }

    /// Add (or extend) a local DNS zone.
    async fn add_dns_zone(&self, _zone: DnsZoneSpec) -> BoxliteResult<()> {
        Err(control_unsupported("add_dns_zone"))
    }

    /// List the configured DNS zones (raw JSON).
    async fn dns_zones(&self) -> BoxliteResult<Value> {
        Err(control_unsupported("dns_zones"))
    }

    /// Current DHCP leases (raw JSON).
    async fn dhcp_leases(&self) -> BoxliteResult<Value> {
        Err(control_unsupported("dhcp_leases"))
    }

    /// Switch CAM (MAC) table (raw JSON).
    async fn cam(&self) -> BoxliteResult<Value> {
        Err(control_unsupported("cam"))
    }

    /// Network statistics — bytes moved and TCP health.
    async fn stats(&self) -> BoxliteResult<NetworkBackendStats> {
        Err(control_unsupported("stats"))
    }

    /// Open a raw byte tunnel to the guest `target` (the data plane, as opposed
    /// to the control methods above). Returns a [`BoxTunnel`] the caller
    /// reads/writes directly. Backends without a tunnel inherit `Unsupported`.
    async fn tunnel(&self, _target: SocketAddr) -> BoxliteResult<BoxTunnel> {
        Err(control_unsupported("tunnel"))
    }
}

/// The protocol type for network connections.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub enum ConnectionType {
    /// Unix stream socket (SOCK_STREAM) - used by passt, socket_vmnet, libslirp, gvproxy (Linux)
    UnixStream,

    /// Unix datagram socket (SOCK_DGRAM) - used by gvproxy (macOS)
    UnixDgram,
}

/// Abstract factory for a box's host-side network backend.
///
/// The factory is itself the abstraction: the runtime holds one
/// (`Arc<dyn NetworkBackendFactory>`) and every box creates its backend through
/// it, so the concrete backend is chosen in exactly one place and callers never
/// name it. Swap the whole backend by swapping the factory (e.g. inject a mock).
pub trait NetworkBackendFactory: Send + Sync {
    /// Create the box's host-side network backend from its [`NetworkBackendConfig`].
    /// `None` when this factory intentionally provides no backend.
    fn create(&self, config: &NetworkBackendConfig) -> Option<Box<dyn NetworkBackend>>;
}

/// Factory used when no network backend is compiled in — always yields `None`.
pub struct NoBackendFactory;

impl NetworkBackendFactory for NoBackendFactory {
    fn create(&self, _: &NetworkBackendConfig) -> Option<Box<dyn NetworkBackend>> {
        None
    }
}

/// The process's default factory — the single composition root where the
/// concrete factory is chosen for the compiled-in backend.
pub fn default_factory() -> Arc<dyn NetworkBackendFactory> {
    Arc::new(gvproxy::GvproxyFactory)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Defense-in-depth: `Debug` on the wire spec must not print the CA private
    /// key or cert PEM. The derived `Debug` would; the manual impl redacts.
    #[test]
    fn debug_redacts_ca_pem_fields() {
        let key_sentinel = "----BEGIN PRIVATE KEY----TOPSECRETPKCS8";
        let cert_sentinel = "----BEGIN CERTIFICATE----TOPSECRETCERT";
        let spec = NetworkBackendSpec {
            port_mappings: vec![(8080, 80)],
            socket_path: PathBuf::from("/tmp/test-net.sock"),
            allow_net: Vec::new(),
            secrets: Vec::new(),
            ca_cert_pem: Some(cert_sentinel.to_string()),
            ca_key_pem: Some(key_sentinel.to_string()),
        };

        let rendered = format!("{:?}", spec);

        assert!(
            !rendered.contains(key_sentinel),
            "Debug leaked ca_key_pem: {}",
            rendered
        );
        assert!(
            !rendered.contains(cert_sentinel),
            "Debug leaked ca_cert_pem: {}",
            rendered
        );
        assert!(
            rendered.contains("[REDACTED]"),
            "expected redaction marker, got: {}",
            rendered
        );
    }

    /// The redaction above is `Debug`-only: serde MUST still carry the CA to the
    /// shim (it cannot run MITM injection without it). Guards against "fixing" the
    /// Debug leak by dropping the fields from the wire format too.
    #[test]
    fn spec_serde_carries_ca_pems_that_debug_redacts() {
        let spec = NetworkBackendSpec {
            port_mappings: vec![(8080, 80)],
            socket_path: PathBuf::from("/tmp/net.sock"),
            allow_net: Vec::new(),
            secrets: Vec::new(),
            ca_cert_pem: Some("CERTDATA".to_string()),
            ca_key_pem: Some("KEYDATA".to_string()),
        };
        let json = serde_json::to_string(&spec).unwrap();
        let back: NetworkBackendSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(back.ca_cert_pem.as_deref(), Some("CERTDATA"));
        assert_eq!(back.ca_key_pem.as_deref(), Some("KEYDATA"));
    }

    #[test]
    fn spec_serde_defaults_new_optional_fields_for_legacy_payloads() {
        let json = r#"{"port_mappings":[[8080,80]],"socket_path":"/tmp/net.sock"}"#;
        let spec: NetworkBackendSpec = serde_json::from_str(json).unwrap();

        assert_eq!(spec.port_mappings, vec![(8080, 80)]);
        assert_eq!(spec.socket_path, PathBuf::from("/tmp/net.sock"));
        assert!(spec.allow_net.is_empty());
        assert!(spec.secrets.is_empty());
        assert!(spec.ca_cert_pem.is_none());
        assert!(spec.ca_key_pem.is_none());
    }

    #[test]
    fn default_factory_creates_runtime_gvproxy_backend_without_ffi_feature() {
        let config = NetworkBackendConfig {
            port_mappings: vec![(8080, 80)],
            socket_path: PathBuf::from("/tmp/default-factory/net.sock"),
            allow_net: vec!["example.com".to_string()],
            secrets: Vec::new(),
            ca_dir: PathBuf::from("/tmp/default-factory/ca"),
        };

        let backend = default_factory()
            .create(&config)
            .expect("runtime-side gvproxy backend");
        let spec = backend.spec();

        assert_eq!(backend.name(), "gvisor-tap-vsock");
        assert_eq!(spec.socket_path, config.socket_path);
        assert_eq!(spec.port_mappings, config.port_mappings);
        assert_eq!(spec.allow_net, config.allow_net);
        assert!(spec.ca_cert_pem.is_none());
        assert!(spec.ca_key_pem.is_none());
    }

    #[test]
    fn sdk_and_cli_manifests_do_not_enable_shim_gvproxy_feature() {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repo_root = manifest_dir
            .parent()
            .and_then(|src_dir| src_dir.parent())
            .expect("boxlite crate lives under src/boxlite");
        let runtime_consumers = [
            "src/cli/Cargo.toml",
            "sdks/python/Cargo.toml",
            "sdks/node/Cargo.toml",
            "sdks/c/Cargo.toml",
        ];

        for relative_manifest in runtime_consumers {
            let manifest_path = repo_root.join(relative_manifest);
            let manifest = std::fs::read_to_string(&manifest_path)
                .unwrap_or_else(|e| panic!("read {}: {e}", manifest_path.display()));
            let parsed: toml::Value = toml::from_str(&manifest)
                .unwrap_or_else(|e| panic!("parse {}: {e}", manifest_path.display()));
            assert_manifest_has_no_gvproxy_feature(relative_manifest, &parsed);
        }
    }

    fn assert_manifest_has_no_gvproxy_feature(relative_manifest: &str, value: &toml::Value) {
        let Some(table) = value.as_table() else {
            return;
        };

        if let Some(boxlite_dependency) = table.get("boxlite") {
            let features = boxlite_dependency
                .as_table()
                .and_then(|dep| dep.get("features"))
                .and_then(toml::Value::as_array);
            if features.is_some_and(|features| {
                features
                    .iter()
                    .any(|feature| feature.as_str() == Some("gvproxy"))
            }) {
                panic!(
                    "{relative_manifest} must not enable boxlite/gvproxy; only boxlite-shim should link libgvproxy-sys"
                );
            }
        }

        for child in table.values() {
            assert_manifest_has_no_gvproxy_feature(relative_manifest, child);
        }
    }

    #[derive(Debug)]
    struct UnsupportedBackend;

    #[async_trait::async_trait]
    impl NetworkBackend for UnsupportedBackend {
        fn name(&self) -> &'static str {
            "unsupported-test"
        }

        fn spec(&self) -> NetworkBackendSpec {
            NetworkBackendSpec {
                port_mappings: Vec::new(),
                socket_path: PathBuf::from("/tmp/net.sock"),
                allow_net: Vec::new(),
                secrets: Vec::new(),
                ca_cert_pem: None,
                ca_key_pem: None,
            }
        }
    }

    fn assert_unsupported<T: std::fmt::Debug>(result: BoxliteResult<T>, op: &str) {
        let err = result.unwrap_err();
        let err = format!("{err}");
        assert!(err.contains("runtime control"), "err: {err}");
        assert!(err.contains(op), "err: {err}");
    }

    #[tokio::test]
    async fn default_control_methods_report_unsupported_operation() {
        let backend = UnsupportedBackend;
        let target: SocketAddr = "192.168.127.2:8080".parse().unwrap();
        let zone = DnsZoneSpec {
            name: "svc.local.".to_string(),
            records: vec![DnsRecordSpec {
                name: "api".to_string(),
                ip: "192.168.127.10".to_string(),
            }],
            default_ip: None,
        };

        assert_unsupported(
            backend
                .expose(
                    "127.0.0.1:18080",
                    "192.168.127.2:80",
                    TransportProtocol::Tcp,
                )
                .await,
            "expose",
        );
        assert_unsupported(
            backend
                .unexpose("127.0.0.1:18080", TransportProtocol::Tcp)
                .await,
            "unexpose",
        );
        assert_unsupported(backend.list_forwards().await, "list_forwards");
        assert_unsupported(backend.add_dns_zone(zone).await, "add_dns_zone");
        assert_unsupported(backend.dns_zones().await, "dns_zones");
        assert_unsupported(backend.dhcp_leases().await, "dhcp_leases");
        assert_unsupported(backend.cam().await, "cam");
        assert_unsupported(backend.stats().await, "stats");
        assert_unsupported(backend.tunnel(target).await, "tunnel");
    }

    #[tokio::test]
    async fn box_tunnel_pipes_bytes_and_carries_peer() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // A BoxTunnel over a real unix socketpair: bytes must cross its AsyncRead/
        // AsyncWrite dispatch in both directions, the peer is carried out-of-band,
        // and the concrete local stream stays recoverable (the SDK fd-bridge relies on it).
        let (near, mut far) = UnixStream::pair().unwrap();
        let peer: SocketAddr = "192.168.127.2:8080".parse().unwrap();
        let mut tunnel = BoxTunnel::from_local(near, peer);

        assert_eq!(tunnel.peer_addr(), peer);

        // write to the tunnel → arrives at the far end
        tunnel.write_all(b"ping").await.unwrap();
        let mut got = [0u8; 4];
        far.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"ping");

        // far end writes → readable from the tunnel
        far.write_all(b"pong").await.unwrap();
        let mut back = [0u8; 4];
        tunnel.read_exact(&mut back).await.unwrap();
        assert_eq!(&back, b"pong");

        // the owned OS fd is recoverable with no unsafe downcast (SDK handoff)
        assert!(tunnel.into_fd().is_some());
    }
}
