//! The core-side gvproxy backend: produces the shim provisioning spec and drives
//! gvproxy's ServicesMux (runtime network control).
//!
//! [`GvproxyBackend`] is the [`NetworkBackend`] the boxlite *core* owns for a box
//! (see `BoxImpl::network`). From its held [`NetworkBackendConfig`] it produces
//! the wire [`NetworkBackendSpec`] (`spec()`), and for a running box it dials
//! gvproxy's control socket (`gvproxy-ctl.sock`) over HTTP/1.1-on-unix to drive
//! dynamic port forwarding, DNS, and lease/stat inspection — mirroring the
//! unix-connector pattern in `portal/connection.rs`.
//!
//! The socket is bound by gvproxy inside the shim (see the Go bridge) and lives
//! for the VM's lifetime, so a core process that reconnects after detach can
//! still change forwards.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::client::conn::http1;
use hyper::{Method, Request};
use hyper_util::rt::TokioIo;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use crate::net::{
    BoxTunnel, DnsZoneSpec, Forward, NetworkBackend, NetworkBackendConfig, NetworkBackendSpec,
    NetworkBackendStats, TransportProtocol,
};

/// Upper bound on a single control exchange. A bound-but-unserved socket (the
/// tiny window between `listen` and `serve` in the shim) must never hang a call.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// gvproxy backend — the [`NetworkBackend`] the core constructs for a box from
/// its [`NetworkBackendConfig`]. It produces the wire [`NetworkBackendSpec`] (via
/// [`spec`](NetworkBackend::spec)) and is the runtime control client: each
/// control call opens a one-shot HTTP/1.1 connection to the derived control socket.
#[derive(Debug, Clone)]
pub struct GvproxyBackend {
    /// The box's network config — read by [`spec`](NetworkBackend::spec) and the
    /// source of the data socket the control socket is derived from.
    config: NetworkBackendConfig,
    /// gvproxy's control socket (`gvproxy-ctl.sock`) — dialed for control.
    control_socket_path: PathBuf,
}

impl GvproxyBackend {
    /// Build the gvproxy backend for the box described by `config`. The control
    /// socket is derived as a sibling of the data socket
    /// ([`super::control_socket_path`]), so no gvproxy-specific socket path leaks
    /// into neutral layers.
    pub fn from_config(config: &NetworkBackendConfig) -> Self {
        Self {
            control_socket_path: super::control_socket_path(&config.socket_path),
            config: config.clone(),
        }
    }

    /// One-shot HTTP/1.1 request to the services socket. Returns `(status, body)`.
    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<String>,
    ) -> BoxliteResult<(u16, String)> {
        let exchange = async move {
            let stream = UnixStream::connect(&self.control_socket_path)
                .await
                .map_err(|e| {
                    BoxliteError::Network(format!(
                        "gvproxy services connect {} failed: {e}",
                        self.control_socket_path.display()
                    ))
                })?;

            let (mut sender, conn) = http1::handshake(TokioIo::new(stream)).await.map_err(|e| {
                BoxliteError::Network(format!("gvproxy services handshake failed: {e}"))
            })?;

            // Drive the connection concurrently while we read the response.
            tokio::spawn(async move {
                let _ = conn.await;
            });

            let req = Request::builder()
                .method(method)
                .uri(path)
                .header(hyper::header::HOST, "gvproxy")
                .body(Full::<Bytes>::new(Bytes::from(body.unwrap_or_default())))
                .map_err(|e| {
                    BoxliteError::Network(format!("gvproxy services request build failed: {e}"))
                })?;

            let resp = sender.send_request(req).await.map_err(|e| {
                BoxliteError::Network(format!("gvproxy services request to {path} failed: {e}"))
            })?;

            let status = resp.status().as_u16();
            let bytes = resp
                .into_body()
                .collect()
                .await
                .map_err(|e| {
                    BoxliteError::Network(format!("gvproxy services read {path} failed: {e}"))
                })?
                .to_bytes();
            Ok((status, String::from_utf8_lossy(&bytes).into_owned()))
        };

        // Explicit timeout for external work (CLAUDE.md): never hang a control call.
        tokio::time::timeout(REQUEST_TIMEOUT, exchange)
            .await
            .map_err(|_| {
                BoxliteError::Network(format!(
                    "gvproxy services request to {path} timed out after {}s",
                    REQUEST_TIMEOUT.as_secs()
                ))
            })?
    }

    /// Send a request and require a 2xx, returning the body. A non-2xx carries
    /// gvproxy's own message (e.g. `"proxy already running"`, `"proxy not found"`).
    async fn request_ok(
        &self,
        method: Method,
        path: &str,
        body: Option<String>,
    ) -> BoxliteResult<String> {
        let (status, body) = self.request(method, path, body).await?;
        if (200..300).contains(&status) {
            Ok(body)
        } else {
            Err(BoxliteError::Network(format!(
                "gvproxy {path} returned {status}: {}",
                body.trim()
            )))
        }
    }
}

#[async_trait]
impl NetworkBackend for GvproxyBackend {
    fn name(&self) -> &'static str {
        "gvisor-tap-vsock"
    }

    fn spec(&self) -> NetworkBackendSpec {
        let cfg = &self.config;
        let mut spec = NetworkBackendSpec {
            port_mappings: cfg.port_mappings.clone(),
            socket_path: cfg.socket_path.clone(),
            allow_net: cfg.allow_net.clone(),
            secrets: cfg.secrets.clone(),
            ca_cert_pem: None,
            ca_key_pem: None,
        };

        // Mint the ephemeral MITM CA when secrets are configured. The cert+key
        // flow through the spec → GvproxyConfig → Go. On failure, drop the
        // secrets rather than run MITM injection without a CA.
        if !cfg.secrets.is_empty() {
            match crate::net::ca::load_or_generate(&cfg.ca_dir) {
                Ok(ca) => {
                    spec.ca_cert_pem = Some(ca.cert_pem);
                    spec.ca_key_pem = Some(ca.key_pem);
                }
                Err(e) => {
                    tracing::error!("MITM: CA setup failed, secrets disabled: {e}");
                    spec.secrets.clear();
                }
            }
        }

        spec
    }

    async fn expose(
        &self,
        local: &str,
        remote: &str,
        protocol: TransportProtocol,
    ) -> BoxliteResult<()> {
        let body = serde_json::json!({
            "local": local,
            "remote": remote,
            "protocol": protocol.as_str(),
        });
        self.request_ok(
            Method::POST,
            "/services/forwarder/expose",
            Some(body.to_string()),
        )
        .await?;
        Ok(())
    }

    async fn unexpose(&self, local: &str, protocol: TransportProtocol) -> BoxliteResult<()> {
        let body = serde_json::json!({ "local": local, "protocol": protocol.as_str() });
        self.request_ok(
            Method::POST,
            "/services/forwarder/unexpose",
            Some(body.to_string()),
        )
        .await?;
        Ok(())
    }

    async fn list_forwards(&self) -> BoxliteResult<Vec<Forward>> {
        let body = self
            .request_ok(Method::GET, "/services/forwarder/all", None)
            .await?;
        serde_json::from_str(&body).map_err(|e| {
            BoxliteError::Network(format!(
                "gvproxy /services/forwarder/all parse failed: {e} (body: {body})"
            ))
        })
    }

    async fn add_dns_zone(&self, zone: DnsZoneSpec) -> BoxliteResult<()> {
        let wire = dns_zone_to_wire(&zone);
        self.request_ok(Method::POST, "/services/dns/add", Some(wire.to_string()))
            .await?;
        Ok(())
    }

    async fn dns_zones(&self) -> BoxliteResult<Value> {
        let body = self
            .request_ok(Method::GET, "/services/dns/all", None)
            .await?;
        parse_json(&body, "/services/dns/all")
    }

    async fn dhcp_leases(&self) -> BoxliteResult<Value> {
        let body = self
            .request_ok(Method::GET, "/services/dhcp/leases", None)
            .await?;
        parse_json(&body, "/services/dhcp/leases")
    }

    async fn cam(&self) -> BoxliteResult<Value> {
        let body = self.request_ok(Method::GET, "/cam", None).await?;
        parse_json(&body, "/cam")
    }

    async fn stats(&self) -> BoxliteResult<NetworkBackendStats> {
        let body = self.request_ok(Method::GET, "/stats", None).await?;
        parse_stats(&body)
    }

    async fn tunnel(&self, target: SocketAddr) -> BoxliteResult<BoxTunnel> {
        // `/tunnel` hijacks the HTTP connection — no HTTP response is returned —
        // so we speak it raw (not via hyper): send gvproxy's request, read its
        // literal "OK" ack, and the socket becomes a raw pipe to the guest target.
        // Mirrors gvproxy's own `transport.Tunnel` (`POST /tunnel?ip=&port=`).
        let ctl = self.control_socket_path.clone();
        let handshake = async {
            let mut stream = UnixStream::connect(&ctl).await.map_err(|e| {
                BoxliteError::Network(format!(
                    "gvproxy tunnel connect {} failed: {e}",
                    ctl.display()
                ))
            })?;
            let req = format!(
                "POST /tunnel?ip={}&port={} HTTP/1.1\r\nHost: gvproxy\r\n\r\n",
                target.ip(),
                target.port()
            );
            stream.write_all(req.as_bytes()).await.map_err(|e| {
                BoxliteError::Network(format!("gvproxy tunnel request failed: {e}"))
            })?;
            let mut ack = [0u8; 2];
            stream.read_exact(&mut ack).await.map_err(|e| {
                BoxliteError::Network(format!("gvproxy tunnel ack read failed: {e}"))
            })?;
            Ok::<_, BoxliteError>((stream, ack))
        };

        // Bound only the handshake; the returned tunnel itself is long-lived.
        let (stream, ack) = tokio::time::timeout(REQUEST_TIMEOUT, handshake)
            .await
            .map_err(|_| {
                BoxliteError::Network(format!(
                    "gvproxy tunnel to {target} timed out after {}s",
                    REQUEST_TIMEOUT.as_secs()
                ))
            })??;

        if &ack != b"OK" {
            return Err(BoxliteError::Network(format!(
                "gvproxy tunnel handshake: expected \"OK\", got {:?}",
                String::from_utf8_lossy(&ack)
            )));
        }

        Ok(BoxTunnel::from_local(stream, target))
    }
}

/// Parse gvproxy's `/stats` body onto the neutral [`NetworkBackendStats`]'s typed
/// fields. Parsing goes via gvproxy's own `NetworkStats` wire shape (PascalCase),
/// so that gvproxy-specific format stays out of `net::`.
fn parse_stats(body: &str) -> BoxliteResult<NetworkBackendStats> {
    let wire = super::NetworkStats::from_json_str(body).map_err(|e| {
        BoxliteError::Network(format!("gvproxy /stats parse failed: {e} (body: {body})"))
    })?;
    Ok(NetworkBackendStats {
        bytes_sent: wire.bytes_sent,
        bytes_received: wire.bytes_received,
        tcp_established: wire.tcp.current_established,
        tcp_failed_connections: wire.tcp.failed_connection_attempts,
        tcp_retransmits: wire.tcp.retransmits,
        tcp_timeouts: wire.tcp.timeouts,
        tcp_forward_max_inflight_drop: wire.tcp.forward_max_inflight_drop,
    })
}

fn parse_json(body: &str, path: &str) -> BoxliteResult<Value> {
    serde_json::from_str(body).map_err(|e| {
        BoxliteError::Network(format!("gvproxy {path} parse failed: {e} (body: {body})"))
    })
}

/// Map a neutral [`DnsZoneSpec`] to gvproxy's `types.Zone` wire form.
///
/// gvproxy's `types.Zone` Go struct has **no json tags**, so the wire keys are
/// the Go field names: `Name`, `Records`, `DefaultIP`, and per-record
/// `Name`/`IP`. This differs from the snake_case create-path config; getting the
/// case wrong silently no-ops the zone add, so this mapping is the single source
/// of truth for the runtime `POST /services/dns/add` body.
fn dns_zone_to_wire(zone: &DnsZoneSpec) -> Value {
    let records: Vec<Value> = zone
        .records
        .iter()
        .map(|r| serde_json::json!({ "Name": r.name, "IP": r.ip }))
        .collect();
    let mut obj = serde_json::json!({ "Name": zone.name, "Records": records });
    if let Some(default_ip) = &zone.default_ip {
        obj["DefaultIP"] = Value::from(default_ip.clone());
    }
    obj
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::DnsRecordSpec;

    #[test]
    fn dns_zone_maps_to_capitalized_wire_keys() {
        let zone = DnsZoneSpec {
            name: "myapp.local.".to_string(),
            records: vec![DnsRecordSpec {
                name: "api".to_string(),
                ip: "192.168.127.10".to_string(),
            }],
            default_ip: Some("192.168.127.254".to_string()),
        };
        let wire = dns_zone_to_wire(&zone);
        // gvproxy's types.Zone has no json tags → Go field names.
        assert_eq!(wire["Name"], "myapp.local.");
        assert_eq!(wire["DefaultIP"], "192.168.127.254");
        assert_eq!(wire["Records"][0]["Name"], "api");
        assert_eq!(wire["Records"][0]["IP"], "192.168.127.10");
        // Guard against snake_case leaking (the footgun this mapping exists for).
        assert!(wire.get("name").is_none());
        assert!(wire.get("default_ip").is_none());
        assert!(wire["Records"][0].get("ip").is_none());
    }

    #[test]
    fn dns_zone_without_default_omits_defaultip() {
        let zone = DnsZoneSpec {
            name: "z.".to_string(),
            records: vec![],
            default_ip: None,
        };
        let wire = dns_zone_to_wire(&zone);
        assert!(wire.get("DefaultIP").is_none());
    }

    #[test]
    fn forward_deserializes_from_gvproxy_all_payload() {
        // Shape of GET /services/forwarder/all.
        let payload =
            r#"[{"local":"127.0.0.1:2222","remote":"192.168.127.2:22","protocol":"tcp"}]"#;
        let forwards: Vec<Forward> = serde_json::from_str(payload).unwrap();
        assert_eq!(forwards.len(), 1);
        assert_eq!(forwards[0].local, "127.0.0.1:2222");
        assert_eq!(forwards[0].remote, "192.168.127.2:22");
        assert_eq!(forwards[0].protocol, "tcp");
    }

    #[test]
    fn spec_reflects_config_and_mints_no_ca_without_secrets() {
        // `spec()` turns the held config into the wire spec. Without secrets it
        // copies the fields through and mints no CA (never touching `ca_dir`).
        let config = NetworkBackendConfig {
            port_mappings: vec![(8080, 80), (2222, 22)],
            socket_path: PathBuf::from("/tmp/bl-box/net.sock"),
            allow_net: vec!["example.com".to_string()],
            secrets: Vec::new(),
            ca_dir: PathBuf::from("/tmp/bl-box/does-not-exist"),
        };
        let spec = GvproxyBackend::from_config(&config).spec();
        assert_eq!(spec.port_mappings, config.port_mappings);
        assert_eq!(spec.socket_path, config.socket_path);
        assert_eq!(spec.allow_net, config.allow_net);
        assert!(spec.ca_cert_pem.is_none());
        assert!(spec.ca_key_pem.is_none());
    }

    #[test]
    fn parse_stats_maps_gvproxy_stats_to_typed_getters() {
        // gvproxy /stats (PascalCase, bytes at root + TCP group) → typed getters.
        let json = r#"{"BytesSent":1024,"BytesReceived":2048,"TCP":{"ForwardMaxInFlightDrop":3,"CurrentEstablished":5,"FailedConnectionAttempts":2,"Retransmits":10,"Timeouts":1}}"#;
        let stats = parse_stats(json).unwrap();
        assert_eq!(stats.bytes_sent(), 1024);
        assert_eq!(stats.bytes_received(), 2048);
        assert_eq!(stats.tcp_established(), 5);
        assert_eq!(stats.tcp_failed_connections(), 2);
        assert_eq!(stats.tcp_retransmits(), 10);
        assert_eq!(stats.tcp_timeouts(), 1);
        assert_eq!(stats.tcp_forward_max_inflight_drop(), 3);
    }

    #[test]
    fn transport_protocol_wire_tokens() {
        assert_eq!(TransportProtocol::Tcp.as_str(), "tcp");
        assert_eq!(TransportProtocol::Udp.as_str(), "udp");
        assert_eq!(TransportProtocol::default(), TransportProtocol::Tcp);
        // serde agrees with as_str().
        assert_eq!(
            serde_json::to_string(&TransportProtocol::Udp).unwrap(),
            "\"udp\""
        );
    }

    /// End-to-end over a live gvproxy instance: the core dials the services
    /// socket to expose a forward, sees it in `/all`, unexposes it, and sees it
    /// gone. No VM is needed — the ServicesMux answers independently of the tap.
    /// Requires the libgvproxy dylib; run with `--ignored`.
    #[tokio::test]
    #[ignore]
    async fn expose_unexpose_roundtrip_over_services_socket() {
        use crate::net::gvproxy::GvproxyInstance;
        use std::time::Duration;

        // Short socket dir (sun_path budget); auto-removed on drop.
        let dir = tempfile::Builder::new()
            .prefix("bl-svc-test-")
            .tempdir_in("/tmp")
            .unwrap();
        let net_sock = dir.path().join("net.sock");

        // Bind a real gvproxy instance; it derives + serves its control socket
        // (`gvproxy-ctl.sock`) as a sibling of net.sock.
        let _instance =
            GvproxyInstance::new(net_sock.clone(), &[], Vec::new(), Vec::new(), None, None)
                .expect("create gvproxy instance");

        let config = NetworkBackendConfig {
            port_mappings: Vec::new(),
            socket_path: net_sock.clone(),
            allow_net: Vec::new(),
            secrets: Vec::new(),
            ca_dir: dir.path().to_path_buf(),
        };
        let ctl = GvproxyBackend::from_config(&config);

        // The services socket is bound just after create returns; wait for it.
        let mut ready = false;
        for _ in 0..50 {
            if ctl.list_forwards().await.is_ok() {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(ready, "services socket never became reachable");

        let local = "127.0.0.1:18080";
        let has = |fs: &[Forward]| fs.iter().any(|f| f.local == local);

        assert!(
            !has(&ctl.list_forwards().await.unwrap()),
            "forward should be absent before expose"
        );

        ctl.expose(local, "192.168.127.2:80", TransportProtocol::Tcp)
            .await
            .expect("expose");
        assert!(
            has(&ctl.list_forwards().await.unwrap()),
            "forward should be present after expose"
        );

        ctl.unexpose(local, TransportProtocol::Tcp)
            .await
            .expect("unexpose");
        assert!(
            !has(&ctl.list_forwards().await.unwrap()),
            "forward should be gone after unexpose"
        );
    }

    /// End-to-end over a live gvproxy instance: dial `/tunnel` and verify the
    /// `"OK"` handshake. gvproxy writes `"OK"` *before* it dials the guest, so the
    /// handshake completes even with no guest listening — enough to exercise the
    /// raw-hijack protocol without a VM. Requires the libgvproxy dylib; `--ignored`.
    #[tokio::test]
    #[ignore]
    async fn tunnel_handshake_over_services_socket() {
        use crate::net::gvproxy::GvproxyInstance;
        use std::time::Duration;

        let dir = tempfile::Builder::new()
            .prefix("bl-tun-test-")
            .tempdir_in("/tmp")
            .unwrap();
        let net_sock = dir.path().join("net.sock");
        let _instance =
            GvproxyInstance::new(net_sock.clone(), &[], Vec::new(), Vec::new(), None, None)
                .expect("create gvproxy instance");

        let config = NetworkBackendConfig {
            port_mappings: Vec::new(),
            socket_path: net_sock.clone(),
            allow_net: Vec::new(),
            secrets: Vec::new(),
            ca_dir: dir.path().to_path_buf(),
        };
        let backend = GvproxyBackend::from_config(&config);

        // Wait for the services socket to be served.
        let mut ready = false;
        for _ in 0..50 {
            if backend.list_forwards().await.is_ok() {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(ready, "services socket never became reachable");

        let target: SocketAddr = "192.168.127.2:8080".parse().unwrap();
        let tunnel = backend.tunnel(target).await.expect("tunnel handshake");
        assert_eq!(tunnel.peer_addr(), target);
        // The owned OS fd is recoverable for an SDK handoff.
        assert!(tunnel.into_fd().is_some());
    }
}
