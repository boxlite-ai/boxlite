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

    #[test]
    fn parse_stats_rejects_malformed_body() {
        // The /stats parser fails loudly (echoing the body) on junk rather than
        // silently zeroing counters.
        let err = parse_stats("{ not json").unwrap_err();
        assert!(
            format!("{err}").contains("/stats parse failed"),
            "err: {err}"
        );
    }

    #[test]
    fn parse_stats_rejects_partial_stats() {
        // gvproxy's NetworkStats has no serde defaults, so a body missing the TCP
        // group is an error, not a partially-zeroed struct.
        assert!(parse_stats(r#"{"BytesSent":1,"BytesReceived":2}"#).is_err());
    }

    fn test_secret() -> crate::runtime::options::Secret {
        crate::runtime::options::Secret {
            name: "openai".to_string(),
            hosts: vec!["api.openai.com".to_string()],
            placeholder: "<BOXLITE_SECRET:openai>".to_string(),
            value: "sk-test-not-a-real-key".to_string(),
        }
    }

    #[derive(Debug)]
    struct CapturedRequest {
        request_line: String,
        body: String,
    }

    fn test_backend(
        dir: &tempfile::TempDir,
    ) -> (GvproxyBackend, std::path::PathBuf, NetworkBackendConfig) {
        let net_sock = dir.path().join("net.sock");
        let config = NetworkBackendConfig {
            port_mappings: Vec::new(),
            socket_path: net_sock.clone(),
            allow_net: Vec::new(),
            secrets: Vec::new(),
            ca_dir: dir.path().to_path_buf(),
        };
        (
            GvproxyBackend::from_config(&config),
            super::super::control_socket_path(&net_sock),
            config,
        )
    }

    fn spawn_services_response(
        ctl: &std::path::Path,
        status: u16,
        body: impl Into<String>,
    ) -> tokio::task::JoinHandle<CapturedRequest> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::UnixListener;

        let body = body.into();
        let _ = std::fs::remove_file(ctl);
        let listener = UnixListener::bind(ctl).unwrap();
        tokio::spawn(async move {
            let (mut conn, _) = listener.accept().await.unwrap();
            let mut headers = Vec::new();
            let mut byte = [0u8; 1];
            while !headers.ends_with(b"\r\n\r\n") {
                conn.read_exact(&mut byte).await.unwrap();
                headers.push(byte[0]);
            }

            let headers_text = String::from_utf8_lossy(&headers);
            let content_len = headers_text
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            let mut request_body = vec![0u8; content_len];
            if content_len > 0 {
                conn.read_exact(&mut request_body).await.unwrap();
            }

            let response = format!(
                "HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            conn.write_all(response.as_bytes()).await.unwrap();

            CapturedRequest {
                request_line: headers_text.lines().next().unwrap().to_string(),
                body: String::from_utf8_lossy(&request_body).into_owned(),
            }
        })
    }

    fn json_body(req: &CapturedRequest) -> Value {
        serde_json::from_str(&req.body).unwrap()
    }

    #[test]
    fn spec_with_secrets_mints_a_ca_from_ca_dir() {
        // With secrets configured, spec() mints an ephemeral MITM CA into ca_dir
        // and threads the PEMs (and the secrets) onto the wire spec.
        let ca_dir = tempfile::tempdir().unwrap();
        let config = NetworkBackendConfig {
            port_mappings: Vec::new(),
            socket_path: PathBuf::from("/tmp/bl-box/net.sock"),
            allow_net: Vec::new(),
            secrets: vec![test_secret()],
            ca_dir: ca_dir.path().to_path_buf(),
        };
        let spec = GvproxyBackend::from_config(&config).spec();
        assert!(
            spec.ca_cert_pem
                .as_deref()
                .unwrap()
                .contains("BEGIN CERTIFICATE"),
            "expected a minted CA cert"
        );
        assert!(
            spec.ca_key_pem.as_deref().unwrap().contains("PRIVATE KEY"),
            "expected a minted CA key"
        );
        assert_eq!(spec.secrets.len(), 1, "secrets flow onto the wire spec");
        // The CA was persisted under ca_dir (load_or_generate wrote it).
        assert!(ca_dir.path().join("cert.pem").exists());
    }

    #[test]
    fn spec_disables_secrets_when_ca_dir_is_unusable() {
        // The core must not hand secrets to gvproxy when it failed to provision
        // the MITM CA. Use a plain file as ca_dir so load_or_generate fails at
        // the project boundary, then assert spec() drops the secret material.
        let dir = tempfile::tempdir().unwrap();
        let ca_dir = dir.path().join("ca-dir-is-a-file");
        std::fs::write(&ca_dir, "not a directory").unwrap();
        let config = NetworkBackendConfig {
            port_mappings: Vec::new(),
            socket_path: PathBuf::from("/tmp/bl-box/net.sock"),
            allow_net: Vec::new(),
            secrets: vec![test_secret()],
            ca_dir,
        };

        let spec = GvproxyBackend::from_config(&config).spec();

        assert!(
            spec.secrets.is_empty(),
            "secrets must be disabled when CA setup fails"
        );
        assert!(spec.ca_cert_pem.is_none());
        assert!(spec.ca_key_pem.is_none());
    }

    #[tokio::test]
    async fn list_forwards_reports_missing_services_socket_path() {
        let dir = tempfile::Builder::new()
            .prefix("bl-svctest-missing-")
            .tempdir_in("/tmp")
            .unwrap();
        let (backend, ctl, _) = test_backend(&dir);

        let err = backend.list_forwards().await.unwrap_err();

        let err = format!("{err}");
        assert!(err.contains("gvproxy services connect"), "err: {err}");
        assert!(err.contains(&ctl.display().to_string()), "err: {err}");
    }

    #[tokio::test]
    async fn tunnel_reports_missing_services_socket_path() {
        let dir = tempfile::Builder::new()
            .prefix("bl-tuntest-missing-")
            .tempdir_in("/tmp")
            .unwrap();
        let (backend, ctl, _) = test_backend(&dir);
        let target: SocketAddr = "192.168.127.2:8080".parse().unwrap();

        let err = backend.tunnel(target).await.unwrap_err();

        let err = format!("{err}");
        assert!(err.contains("gvproxy tunnel connect"), "err: {err}");
        assert!(err.contains(&ctl.display().to_string()), "err: {err}");
    }

    #[tokio::test]
    async fn expose_posts_forwarder_payload_to_services_socket() {
        let dir = tempfile::Builder::new()
            .prefix("bl-svctest-")
            .tempdir_in("/tmp")
            .unwrap();
        let (backend, ctl, _) = test_backend(&dir);
        let server = spawn_services_response(&ctl, 204, "");

        backend
            .expose(
                "127.0.0.1:18080",
                "192.168.127.2:80",
                TransportProtocol::Udp,
            )
            .await
            .unwrap();

        let req = server.await.unwrap();
        assert_eq!(req.request_line, "POST /services/forwarder/expose HTTP/1.1");
        let body = json_body(&req);
        assert_eq!(body["local"], "127.0.0.1:18080");
        assert_eq!(body["remote"], "192.168.127.2:80");
        assert_eq!(body["protocol"], "udp");
    }

    #[tokio::test]
    async fn unexpose_posts_local_and_protocol_to_services_socket() {
        let dir = tempfile::Builder::new()
            .prefix("bl-svctest-")
            .tempdir_in("/tmp")
            .unwrap();
        let (backend, ctl, _) = test_backend(&dir);
        let server = spawn_services_response(&ctl, 200, "");

        backend
            .unexpose("127.0.0.1:18080", TransportProtocol::Tcp)
            .await
            .unwrap();

        let req = server.await.unwrap();
        assert_eq!(
            req.request_line,
            "POST /services/forwarder/unexpose HTTP/1.1"
        );
        let body = json_body(&req);
        assert_eq!(body["local"], "127.0.0.1:18080");
        assert_eq!(body["protocol"], "tcp");
        assert!(body.get("remote").is_none());
    }

    #[tokio::test]
    async fn add_dns_zone_posts_gvproxy_zone_wire_shape() {
        let dir = tempfile::Builder::new()
            .prefix("bl-svctest-")
            .tempdir_in("/tmp")
            .unwrap();
        let (backend, ctl, _) = test_backend(&dir);
        let server = spawn_services_response(&ctl, 200, "");

        backend
            .add_dns_zone(DnsZoneSpec {
                name: "svc.local.".to_string(),
                records: vec![DnsRecordSpec {
                    name: "api".to_string(),
                    ip: "192.168.127.50".to_string(),
                }],
                default_ip: Some("192.168.127.254".to_string()),
            })
            .await
            .unwrap();

        let req = server.await.unwrap();
        assert_eq!(req.request_line, "POST /services/dns/add HTTP/1.1");
        let body = json_body(&req);
        assert_eq!(body["Name"], "svc.local.");
        assert_eq!(body["DefaultIP"], "192.168.127.254");
        assert_eq!(body["Records"][0]["Name"], "api");
        assert_eq!(body["Records"][0]["IP"], "192.168.127.50");
        assert!(body.get("default_ip").is_none());
    }

    #[tokio::test]
    async fn list_forwards_gets_and_parses_forwarder_all() {
        let dir = tempfile::Builder::new()
            .prefix("bl-svctest-")
            .tempdir_in("/tmp")
            .unwrap();
        let (backend, ctl, _) = test_backend(&dir);
        let body = r#"[{"local":"127.0.0.1:2222","remote":"192.168.127.2:22","protocol":"tcp"}]"#;
        let server = spawn_services_response(&ctl, 200, body);

        let forwards = backend.list_forwards().await.unwrap();

        let req = server.await.unwrap();
        assert_eq!(req.request_line, "GET /services/forwarder/all HTTP/1.1");
        assert_eq!(
            forwards,
            vec![Forward {
                local: "127.0.0.1:2222".to_string(),
                remote: "192.168.127.2:22".to_string(),
                protocol: "tcp".to_string(),
            }]
        );
    }

    #[tokio::test]
    async fn json_read_endpoints_get_expected_paths_and_parse_bodies() {
        let dir = tempfile::Builder::new()
            .prefix("bl-svctest-")
            .tempdir_in("/tmp")
            .unwrap();
        let (backend, ctl, _) = test_backend(&dir);

        let server = spawn_services_response(&ctl, 200, r#"{"Zones":["svc.local."]}"#);
        assert_eq!(backend.dns_zones().await.unwrap()["Zones"][0], "svc.local.");
        assert_eq!(
            server.await.unwrap().request_line,
            "GET /services/dns/all HTTP/1.1"
        );

        let server = spawn_services_response(&ctl, 200, r#"{"Leases":[{"IP":"192.168.127.2"}]}"#);
        assert_eq!(
            backend.dhcp_leases().await.unwrap()["Leases"][0]["IP"],
            "192.168.127.2"
        );
        assert_eq!(
            server.await.unwrap().request_line,
            "GET /services/dhcp/leases HTTP/1.1"
        );

        let server = spawn_services_response(&ctl, 200, r#"{"Table":{"aa:bb":"tap0"}}"#);
        assert_eq!(backend.cam().await.unwrap()["Table"]["aa:bb"], "tap0");
        assert_eq!(server.await.unwrap().request_line, "GET /cam HTTP/1.1");
    }

    #[tokio::test]
    async fn stats_gets_and_maps_services_socket_response() {
        let dir = tempfile::Builder::new()
            .prefix("bl-svctest-")
            .tempdir_in("/tmp")
            .unwrap();
        let (backend, ctl, _) = test_backend(&dir);
        let body = r#"{"BytesSent":7,"BytesReceived":11,"TCP":{"ForwardMaxInFlightDrop":13,"CurrentEstablished":17,"FailedConnectionAttempts":19,"Retransmits":23,"Timeouts":29}}"#;
        let server = spawn_services_response(&ctl, 200, body);

        let stats = backend.stats().await.unwrap();

        assert_eq!(server.await.unwrap().request_line, "GET /stats HTTP/1.1");
        assert_eq!(stats.bytes_sent(), 7);
        assert_eq!(stats.bytes_received(), 11);
        assert_eq!(stats.tcp_established(), 17);
        assert_eq!(stats.tcp_failed_connections(), 19);
        assert_eq!(stats.tcp_retransmits(), 23);
        assert_eq!(stats.tcp_timeouts(), 29);
        assert_eq!(stats.tcp_forward_max_inflight_drop(), 13);
    }

    #[tokio::test]
    async fn non_success_control_response_includes_path_status_and_body() {
        let dir = tempfile::Builder::new()
            .prefix("bl-svctest-")
            .tempdir_in("/tmp")
            .unwrap();
        let (backend, ctl, _) = test_backend(&dir);
        let server = spawn_services_response(&ctl, 409, "proxy already running");

        let err = backend
            .expose(
                "127.0.0.1:18080",
                "192.168.127.2:80",
                TransportProtocol::Tcp,
            )
            .await
            .unwrap_err();

        assert_eq!(
            server.await.unwrap().request_line,
            "POST /services/forwarder/expose HTTP/1.1"
        );
        let err = format!("{err}");
        assert!(err.contains("/services/forwarder/expose"), "err: {err}");
        assert!(err.contains("409"), "err: {err}");
        assert!(err.contains("proxy already running"), "err: {err}");
    }

    #[tokio::test]
    async fn list_forwards_rejects_malformed_json_response() {
        let dir = tempfile::Builder::new()
            .prefix("bl-svctest-")
            .tempdir_in("/tmp")
            .unwrap();
        let (backend, ctl, _) = test_backend(&dir);
        let server = spawn_services_response(&ctl, 200, "not-json");

        let err = backend.list_forwards().await.unwrap_err();

        assert_eq!(
            server.await.unwrap().request_line,
            "GET /services/forwarder/all HTTP/1.1"
        );
        let err = format!("{err}");
        assert!(err.contains("/services/forwarder/all parse failed"));
        assert!(err.contains("not-json"));
    }

    #[tokio::test]
    async fn json_read_endpoints_reject_malformed_json_response() {
        let dir = tempfile::Builder::new()
            .prefix("bl-svctest-")
            .tempdir_in("/tmp")
            .unwrap();
        let (backend, ctl, _) = test_backend(&dir);
        let server = spawn_services_response(&ctl, 200, "not-json");

        let err = backend.cam().await.unwrap_err();

        assert_eq!(server.await.unwrap().request_line, "GET /cam HTTP/1.1");
        let err = format!("{err}");
        assert!(err.contains("/cam parse failed"));
        assert!(err.contains("not-json"));
    }

    /// The raw-hijack `/tunnel` client, exercised without a live gvproxy: a fake
    /// control server speaks the `POST /tunnel` + `"OK"` handshake, then echoes —
    /// proving the request wire format, the ack, and that the returned tunnel is a
    /// live bidirectional pipe carrying the target as its peer.
    #[tokio::test]
    async fn tunnel_speaks_raw_hijack_and_returns_a_live_pipe() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::UnixListener;

        // Short socket dir (sun_path budget), auto-removed on drop.
        let dir = tempfile::Builder::new()
            .prefix("bl-tuntest-")
            .tempdir_in("/tmp")
            .unwrap();
        let net_sock = dir.path().join("net.sock");
        // Bind the fake server at the exact control socket the backend will dial.
        let ctl = super::super::control_socket_path(&net_sock);
        let listener = UnixListener::bind(&ctl).unwrap();

        let server = tokio::spawn(async move {
            let (mut conn, _) = listener.accept().await.unwrap();
            // Read the request line + headers up to the blank line.
            let mut req = Vec::new();
            let mut b = [0u8; 1];
            while !req.ends_with(b"\r\n\r\n") {
                conn.read_exact(&mut b).await.unwrap();
                req.push(b[0]);
            }
            conn.write_all(b"OK").await.unwrap();
            // Prove the socket is a live pipe after the handshake.
            let mut msg = [0u8; 4];
            conn.read_exact(&mut msg).await.unwrap();
            conn.write_all(&msg).await.unwrap();
            String::from_utf8_lossy(&req).into_owned()
        });

        let config = NetworkBackendConfig {
            port_mappings: Vec::new(),
            socket_path: net_sock,
            allow_net: Vec::new(),
            secrets: Vec::new(),
            ca_dir: dir.path().to_path_buf(),
        };
        let target: SocketAddr = "192.168.127.2:8080".parse().unwrap();
        let mut tunnel = GvproxyBackend::from_config(&config)
            .tunnel(target)
            .await
            .expect("handshake ok");

        assert_eq!(tunnel.peer_addr(), target);
        tunnel.write_all(b"ping").await.unwrap();
        let mut echoed = [0u8; 4];
        tunnel.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"ping");

        let req = server.await.unwrap();
        assert!(
            req.starts_with("POST /tunnel?ip=192.168.127.2&port=8080 HTTP/1.1"),
            "unexpected request line: {req}"
        );
    }

    /// A non-`"OK"` ack must surface as an error, not a half-open tunnel.
    #[tokio::test]
    async fn tunnel_errors_when_ack_is_not_ok() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::UnixListener;

        let dir = tempfile::Builder::new()
            .prefix("bl-tuntest-")
            .tempdir_in("/tmp")
            .unwrap();
        let net_sock = dir.path().join("net.sock");
        let ctl = super::super::control_socket_path(&net_sock);
        let listener = UnixListener::bind(&ctl).unwrap();
        tokio::spawn(async move {
            let (mut conn, _) = listener.accept().await.unwrap();
            let mut b = [0u8; 1];
            let mut req = Vec::new();
            while !req.ends_with(b"\r\n\r\n") {
                conn.read_exact(&mut b).await.unwrap();
                req.push(b[0]);
            }
            conn.write_all(b"NO").await.unwrap(); // reject
        });

        let config = NetworkBackendConfig {
            port_mappings: Vec::new(),
            socket_path: net_sock,
            allow_net: Vec::new(),
            secrets: Vec::new(),
            ca_dir: dir.path().to_path_buf(),
        };
        let target: SocketAddr = "192.168.127.2:8080".parse().unwrap();
        let err = GvproxyBackend::from_config(&config)
            .tunnel(target)
            .await
            .unwrap_err();
        assert!(format!("{err}").contains(r#"expected "OK""#), "err: {err}");
    }

    /// End-to-end over a live gvproxy instance: the core dials the services
    /// socket to expose a forward, sees it in `/all`, unexposes it, and sees it
    /// gone. No VM is needed — the ServicesMux answers independently of the tap.
    /// Requires the libgvproxy dylib; run with `--ignored`.
    #[cfg(feature = "gvproxy")]
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
    #[cfg(feature = "gvproxy")]
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
