//! Tests for NetworkSpec behavior.

mod common;

use boxlite::BoxCommand;
use boxlite::net::constants::{HOST_HOSTNAME, HOST_IP};
use boxlite::runtime::options::{BoxOptions, BoxliteOptions, NetworkSpec};
use common::TestRuntime as BoxliteRuntime;
use futures::StreamExt;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
use std::sync::mpsc;
use std::thread;

/// Pre-split source compatibility. `NetworkSpec` is untouched by the split —
/// same name, same variants, same field on `BoxOptions` — so every shape
/// pre-split callers wrote still compiles verbatim, with no conversion at
/// the assignment site. Inbound lives in the sibling field
/// `BoxOptions::inbound_network`. This test is the contract: if it stops
/// compiling, the Rust API broke.
#[test]
fn pre_split_network_spec_source_shape_still_compiles() {
    let spec = NetworkSpec::Enabled {
        allow_net: vec!["api.openai.com".into()],
    };
    match &spec {
        NetworkSpec::Enabled { allow_net } => assert_eq!(allow_net.len(), 1),
        NetworkSpec::Disabled => panic!("expected enabled"),
    }

    // No `.into()`, no container: the field type is still the enum.
    let opts = BoxOptions {
        network: NetworkSpec::Disabled,
        ..Default::default()
    };
    assert!(matches!(opts.network, NetworkSpec::Disabled));

    // The direction the pre-split API could not express defaults to private.
    assert!(matches!(opts.inbound_network, NetworkSpec::Disabled));
}

/// The two directions are independent: a box can refuse egress while the
/// services it exposes stay reachable. Sibling fields express that directly.
#[test]
fn directions_are_independent() {
    let opts = BoxOptions {
        network: NetworkSpec::Disabled,
        inbound_network: NetworkSpec::Enabled {
            allow_net: Vec::new(),
        },
        ..Default::default()
    };

    assert!(matches!(opts.network, NetworkSpec::Disabled));
    assert!(matches!(opts.inbound_network, NetworkSpec::Enabled { .. }));
}

/// Already-persisted box configs predate `inbound_network`; the missing
/// field must default to private rather than fail the load.
#[test]
fn pre_split_persisted_json_still_deserializes() {
    let json = r#"{
        "rootfs": {"Image": "alpine:latest"},
        "env": [],
        "volumes": [],
        "network": {"Enabled": {"allow_net": ["api.openai.com"]}},
        "ports": []
    }"#;
    let opts: BoxOptions = serde_json::from_str(json).unwrap();
    assert!(
        matches!(opts.network, NetworkSpec::Enabled { ref allow_net } if allow_net == &["api.openai.com".to_string()])
    );
    assert!(matches!(opts.inbound_network, NetworkSpec::Disabled));
}

use std::time::{Duration, Instant};

#[test]
fn default_is_enabled_with_empty_allowlist() {
    let spec = NetworkSpec::default();
    match spec {
        NetworkSpec::Enabled { allow_net } => assert!(allow_net.is_empty()),
        NetworkSpec::Disabled => panic!("default should be Enabled"),
    }
}

#[test]
fn serde_enabled_roundtrip() {
    let spec = NetworkSpec::Enabled {
        allow_net: vec!["api.openai.com".into(), "*.anthropic.com".into()],
    };
    let json = serde_json::to_string(&spec).unwrap();
    let rt: NetworkSpec = serde_json::from_str(&json).unwrap();
    match rt {
        NetworkSpec::Enabled { allow_net } => assert_eq!(allow_net.len(), 2),
        _ => panic!("should be Enabled"),
    }
}

#[test]
fn serde_disabled_roundtrip() {
    let spec = NetworkSpec::Disabled;
    let json = serde_json::to_string(&spec).unwrap();
    let rt: NetworkSpec = serde_json::from_str(&json).unwrap();
    assert!(matches!(rt, NetworkSpec::Disabled));
}

#[test]
fn box_options_default_has_enabled_network() {
    let opts = BoxOptions::default();
    assert!(matches!(opts.network, NetworkSpec::Enabled { .. }));
}

#[test]
fn box_options_with_allowlist_serde() {
    let opts = BoxOptions {
        network: NetworkSpec::Enabled {
            allow_net: vec!["api.openai.com".into()],
        },
        ..Default::default()
    };
    let json = serde_json::to_string(&opts).unwrap();
    let rt: BoxOptions = serde_json::from_str(&json).unwrap();
    match rt.network {
        NetworkSpec::Enabled { allow_net } => {
            assert_eq!(allow_net, vec!["api.openai.com"]);
        }
        _ => panic!("should be Enabled"),
    }
}

#[tokio::test]
async fn disabled_network_returns_no_network_config() {
    let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();

    // Box with Disabled network should still create (just no eth0)
    let opts = BoxOptions {
        network: NetworkSpec::Disabled,
        ..common::alpine_opts()
    };
    let litebox = runtime.create(opts, None).await.unwrap();
    assert!(!litebox.id().as_str().is_empty());
}

#[tokio::test]
async fn disabled_network_runs_without_eth0() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();

    let opts = BoxOptions {
        network: NetworkSpec::Disabled,
        ..common::alpine_opts()
    };

    let litebox = runtime.create(opts, None).await.unwrap();
    litebox.start().await.unwrap();

    // Non-network commands should work fine
    let out = run_stdout(&litebox, "echo", &["hello-no-network"]).await;
    assert!(
        out.contains("hello-no-network"),
        "echo should work without network, got: {out}"
    );

    let out = run_stdout(&litebox, "ls", &["/"]).await;
    assert!(!out.is_empty(), "ls should work without network");

    let status = run_exit_code(&litebox, "sh", &["-c", "test ! -e /sys/class/net/eth0"]).await;
    assert_eq!(
        status, 0,
        "disabled network should remove eth0 entirely, got exit code {status}"
    );

    let status = run_exit_code(&litebox, "ping", &["-c", "1", "-W", "1", "127.0.0.1"]).await;
    assert_eq!(
        status, 0,
        "localhost must work with external networking disabled"
    );

    litebox.stop().await.unwrap();
}

#[tokio::test]
async fn enabled_network_runs_with_eth0_and_host_alias_dns() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();

    let litebox = runtime.create(common::alpine_opts(), None).await.unwrap();
    litebox.start().await.unwrap();

    let has_eth0 = run_exit_code(&litebox, "sh", &["-c", "test -e /sys/class/net/eth0"]).await;
    assert_eq!(
        has_eth0, 0,
        "enabled network should create eth0, got exit code {has_eth0}"
    );

    let nslookup = run_stdout(&litebox, "nslookup", &[HOST_HOSTNAME]).await;
    assert!(
        nslookup.contains(HOST_IP),
        "host alias should resolve through the enabled backend, got: {nslookup}"
    );

    litebox.stop().await.unwrap();
}

/// Helper: run a command and collect stdout.
async fn run_stdout(litebox: &boxlite::LiteBox, cmd: &str, args: &[&str]) -> String {
    let mut ex = litebox
        .exec(BoxCommand::new(cmd).args(args.iter().map(|s| s.to_string()).collect::<Vec<_>>()))
        .await
        .unwrap();
    let mut out = String::new();
    if let Some(mut stdout) = ex.stdout() {
        while let Some(chunk) = stdout.next().await {
            out.push_str(&chunk);
        }
    }
    let _ = ex.wait().await;
    out
}

/// Helper: run a command and return its exit status.
async fn run_exit_code(litebox: &boxlite::LiteBox, cmd: &str, args: &[&str]) -> i32 {
    let ex = litebox
        .exec(BoxCommand::new(cmd).args(args.iter().map(|s| s.to_string()).collect::<Vec<_>>()))
        .await
        .unwrap();
    ex.wait().await.unwrap().exit_code
}

fn wget_url_command(url: &str) -> String {
    format!("wget -O- --timeout=5 {url} 2>&1; printf '\\nEXIT:%s\\n' $?")
}

/// Confirms the endpoint a negative allowlist probe targets is actually up.
///
/// A refused connection inside the box only implicates the allowlist if the
/// destination answers when nothing is filtering. An outage or a closed port
/// there fails exactly the way a blocked dial does, so without this the
/// negative assertion passes while filtering is broken. Returns false when the
/// host cannot supply the precondition, which the caller turns into a skip.
fn unlisted_endpoint_is_up(test: &str, host: &str, port: u16) -> bool {
    let addrs = match (host, port).to_socket_addrs() {
        Ok(addrs) => addrs.filter(SocketAddr::is_ipv4).collect::<Vec<_>>(),
        Err(err) => {
            skip_missing_egress(test, &format!("cannot resolve {host}:{port}: {err}"));
            return false;
        }
    };
    if addrs
        .iter()
        .any(|addr| TcpStream::connect_timeout(addr, Duration::from_secs(5)).is_ok())
    {
        return true;
    }
    skip_missing_egress(
        test,
        &format!(
            "{host}:{port} is unreachable from the host, so a refusal inside \
             the box would prove nothing"
        ),
    );
    false
}

const UDP_PROBE_MARKER: &str = "boxlite-udp-allow-net-probe";
const UDP_PROBE_EXIT_PREFIX: &str = "UDP_PROBE_EXIT:";

/// The probe reports its own exit status, because `run_stdout` drops it. A
/// missing or failing `nc` otherwise produces the same silence as a blocked
/// datagram, letting the negative test pass without ever sending one.
fn nc_udp_command(host: &str, port: u16) -> String {
    format!(
        "printf %s {UDP_PROBE_MARKER} | nc -u -w 2 {host} {port}; \
         printf '\\n{UDP_PROBE_EXIT_PREFIX}%s\\n' $?"
    )
}

/// TCP reachability, reported with its own exit status for the same reason
/// `nc_udp_command` does: a missing `nc` must not read as a blocked
/// connection. Unlike the UDP probe, `nc -z` does reflect whether the
/// connection was established.
fn nc_tcp_command(host: &str, port: u16) -> String {
    format!("nc -w 3 -z {host} {port}; printf '\\nTCP_PROBE_EXIT:%s\\n' $?")
}

/// BusyBox `nc -u -w` exits 0 once the wait elapses, whether or not anything
/// answered, so a nonzero status means the probe never ran (127 = no `nc`).
fn assert_udp_probe_ran(output: &str) {
    assert!(
        output.contains(&format!("{UDP_PROBE_EXIT_PREFIX}0")),
        "UDP probe did not run in the guest: {output}"
    );
}

/// Binds a loopback-or-wildcard UDP socket and hands the first datagram to the
/// returned channel. The reader thread exits on the first packet or after
/// `listen_for`, so callers waiting for "nothing arrives" still terminate.
fn start_host_udp_receiver(
    bind_addr: &str,
    listen_for: Duration,
) -> (u16, mpsc::Receiver<Vec<u8>>, thread::JoinHandle<()>) {
    let socket = UdpSocket::bind(bind_addr).expect("bind host udp receiver");
    let port = socket.local_addr().expect("host udp receiver addr").port();
    socket
        .set_read_timeout(Some(listen_for))
        .expect("set host udp receiver timeout");

    let (tx, rx) = mpsc::channel();
    let handle = thread::spawn(move || {
        let mut buf = [0_u8; 2048];
        if let Ok((len, _)) = socket.recv_from(&mut buf) {
            let _ = tx.send(buf[..len].to_vec());
        }
    });

    (port, rx, handle)
}

/// The host's outward-facing IPv4, discovered without sending anything: a
/// connected UDP socket only records the route the kernel would pick. Tests
/// need an address that is reachable from gvproxy yet outside both allow_net
/// and the always-allowed internal IPs, which the 192.168.127.0/24 aliases
/// cannot provide.
fn host_routable_ipv4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    match socket.local_addr().ok()? {
        SocketAddr::V4(addr) if !addr.ip().is_loopback() => Some(*addr.ip()),
        _ => None,
    }
}

const REQUIRE_EGRESS_ENV: &str = "BOXLITE_TEST_REQUIRE_EGRESS";

/// Handles a host that cannot supply an egress precondition. Skipping keeps the
/// suite usable on developer machines and in routeless sandboxes; a runner that
/// is supposed to have egress sets `BOXLITE_TEST_REQUIRE_EGRESS=1` so the skip
/// becomes a failure instead of a green test that exercised no allowlist at all.
fn skip_missing_egress(test: &str, reason: &str) {
    assert!(
        std::env::var_os(REQUIRE_EGRESS_ENV).is_none(),
        "{test}: {reason}; {REQUIRE_EGRESS_ENV} is set, so this host must provide egress"
    );
    eprintln!("SKIP {test}: {reason}");
}

fn start_host_http_server(response_body: &'static str) -> (u16, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind host test server");
    listener
        .set_nonblocking(true)
        .expect("set host test server nonblocking");
    let port = listener.local_addr().expect("host test server addr").port();

    let handle = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        let (mut stream, _) = loop {
            match listener.accept() {
                Ok(conn) => break conn,
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < deadline,
                        "timed out waiting for host test server connection"
                    );
                    thread::yield_now();
                }
                Err(err) => panic!("accept host test server: {err}"),
            }
        };
        let mut request_buf = [0_u8; 1024];
        // We only care that wget opened the connection; the request body is irrelevant.
        let _ = stream.read(&mut request_buf);

        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            response_body.len(),
            response_body
        );
        stream
            .write_all(response.as_bytes())
            .expect("write host test server response");
    });

    (port, handle)
}

fn start_host_http_server_expect_no_connection() -> (u16, mpsc::Sender<()>, thread::JoinHandle<()>)
{
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind host negative test server");
    listener
        .set_nonblocking(true)
        .expect("set host negative test server nonblocking");
    let port = listener
        .local_addr()
        .expect("host negative test server addr")
        .port();
    let (stop_tx, stop_rx) = mpsc::channel();

    let handle = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match listener.accept() {
                Ok((_, addr)) => panic!("expected no host test server connection, got {addr}"),
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    match stop_rx.try_recv() {
                        Ok(()) | Err(mpsc::TryRecvError::Disconnected) => break,
                        Err(mpsc::TryRecvError::Empty) => {}
                    }

                    assert!(
                        Instant::now() < deadline,
                        "negative server deadline exceeded before stop signal"
                    );
                    thread::yield_now();
                }
                Err(err) => panic!("accept host negative test server: {err}"),
            }
        }
    });

    (port, stop_tx, handle)
}

/// The container's resolver is the gateway, where gvproxy serves DNS. The
/// guest writes that address as a literal because the guest agent cannot
/// depend on the host crate, so this is what keeps the two from drifting
/// apart silently.
#[tokio::test]
#[ignore = "requires VM runtime (run with make test)"]
async fn container_resolver_is_the_gateway() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();

    let litebox = runtime.create(common::alpine_opts(), None).await.unwrap();
    litebox.start().await.unwrap();

    let out = run_stdout(&litebox, "cat", &["/etc/resolv.conf"]).await;
    assert!(
        out.contains(&format!(
            "nameserver {}",
            boxlite::net::constants::GATEWAY_IP
        )),
        "resolv.conf should name the gateway, got: {out}"
    );

    litebox.stop().await.unwrap();
}

/// allow_net is enforced when the gateway dials, not by filtering DNS. An
/// unlisted name therefore resolves like any other — the first assertion pins
/// that, checking the lookup succeeded and returned an address rather than
/// merely lacking the old sinkhole answer — and still cannot be reached. Two
/// controls keep the negative honest: the preflight shows example.org answers
/// when nothing filters, and the allowed-host probe in between shows this box
/// has a working network. Without them the final assertion would also pass on
/// a broken box, or against a host that is simply down.
///
/// A query for an unlisted name does leave the box and reach the host
/// resolver. That is a known, accepted consequence of treating allow_net as a
/// connection-layer control.
#[tokio::test]
#[ignore = "requires VM runtime (run with make test)"]
async fn unlisted_host_resolves_but_connection_is_refused() {
    if !unlisted_endpoint_is_up(
        "unlisted_host_resolves_but_connection_is_refused",
        "example.org",
        80,
    ) {
        return;
    }

    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();

    let opts = BoxOptions {
        network: NetworkSpec::Enabled {
            allow_net: vec!["example.com".into()],
        },
        ..common::alpine_opts()
    };

    let litebox = runtime.create(opts, None).await.unwrap();
    litebox.start().await.unwrap();

    // DNS is unfiltered: the unlisted name resolves, and to a real address.
    // Both halves are needed — `nslookup` failing outright also contains no
    // "0.0.0.0", so the absence of the sinkhole answer proves nothing alone.
    let dns = run_stdout(
        &litebox,
        "sh",
        &["-c", "nslookup example.org; printf '\\nEXIT:%s\\n' $?"],
    )
    .await;
    assert!(
        dns.contains("EXIT:0") && dns.contains("Address") && !dns.contains("0.0.0.0"),
        "allow_net no longer filters DNS; an unlisted name must resolve to a real \
         address, got: {dns}"
    );

    // Control, same box: the listed host is reachable, so a failure below is
    // the allowlist and not a dead network.
    let allowed = run_stdout(
        &litebox,
        "sh",
        &["-c", &wget_url_command("http://example.com/")],
    )
    .await;
    assert!(
        allowed.contains("EXIT:0"),
        "listed host must stay reachable, got: {allowed}"
    );

    // Subject: the unlisted host is refused when the gateway dials.
    let blocked = run_stdout(
        &litebox,
        "sh",
        &["-c", &wget_url_command("http://example.org/")],
    )
    .await;
    assert!(
        blocked.contains("EXIT:") && !blocked.contains("EXIT:0"),
        "unlisted host must be refused at connect time, got: {blocked}"
    );

    litebox.stop().await.unwrap();
}

/// A wildcard rule covers each subdomain on its own. Asserted at the
/// connection layer: which address a subdomain resolves to is the gateway's
/// business now, and is covered in the bridge's own tests. The subdomain probe
/// is the in-box control for the negative; the preflight is what rules out a
/// refusal that is really example.org being down.
#[tokio::test]
#[ignore = "requires VM runtime (run with make test)"]
async fn wildcard_allows_subdomain_connection_not_other_domains() {
    if !unlisted_endpoint_is_up(
        "wildcard_allows_subdomain_connection_not_other_domains",
        "example.org",
        80,
    ) {
        return;
    }

    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();

    let opts = BoxOptions {
        network: NetworkSpec::Enabled {
            allow_net: vec!["*.example.com".into()],
        },
        ..common::alpine_opts()
    };

    let litebox = runtime.create(opts, None).await.unwrap();
    litebox.start().await.unwrap();

    let sub = run_stdout(
        &litebox,
        "sh",
        &["-c", &wget_url_command("http://www.example.com/")],
    )
    .await;
    assert!(
        sub.contains("EXIT:0"),
        "a subdomain under the wildcard must be reachable, got: {sub}"
    );

    let other = run_stdout(
        &litebox,
        "sh",
        &["-c", &wget_url_command("http://example.org/")],
    )
    .await;
    assert!(
        other.contains("EXIT:") && !other.contains("EXIT:0"),
        "a domain outside the wildcard must be refused, got: {other}"
    );

    litebox.stop().await.unwrap();
}

/// A Local Box with an empty allowlist permits the direct-IP control used in
/// `tcp_filter_blocks_direct_ip_connection`.
#[tokio::test]
#[ignore = "requires VM runtime (run with make test)"]
async fn empty_allowlist_permits_direct_ip() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();

    let opts = BoxOptions {
        network: NetworkSpec::Enabled { allow_net: vec![] },
        ..common::alpine_opts()
    };

    let litebox = runtime.create(opts, None).await.unwrap();
    litebox.start().await.unwrap();

    let out = run_stdout(&litebox, "sh", &["-c", &nc_tcp_command("1.1.1.1", 443)]).await;
    assert!(
        out.contains("TCP_PROBE_EXIT:0"),
        "an empty allowlist must permit a direct-IP connection, got: {out}"
    );

    litebox.stop().await.unwrap();
}

/// A hostname-only allowlist authorizes no address, so the same fetch by IP is
/// refused. Two controls keep the negative honest, as in
/// `unlisted_host_resolves_but_connection_is_refused`: the preflight shows
/// 8.8.8.8:80 answers when nothing filters, and the listed-host probe shows
/// this box has a working network and a working `wget` — the old assertion
/// accepted empty stdout, which a missing `wget` produces just as readily as a
/// blocked dial.
#[tokio::test]
#[ignore = "requires VM runtime (run with make test)"]
async fn tcp_filter_blocks_direct_ip_connection() {
    if !unlisted_endpoint_is_up("tcp_filter_blocks_direct_ip_connection", "8.8.8.8", 80) {
        return;
    }

    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();

    // Allow only example.com — direct IP connections should be blocked
    let opts = BoxOptions {
        network: NetworkSpec::Enabled {
            allow_net: vec!["example.com".into()],
        },
        ..common::alpine_opts()
    };

    let litebox = runtime.create(opts, None).await.unwrap();
    litebox.start().await.unwrap();

    let allowed = run_stdout(
        &litebox,
        "sh",
        &["-c", &wget_url_command("http://example.com/")],
    )
    .await;
    assert!(
        allowed.contains("EXIT:0"),
        "listed host must stay reachable, got: {allowed}"
    );

    let out = run_stdout(
        &litebox,
        "sh",
        &["-c", &wget_url_command("http://8.8.8.8/")],
    )
    .await;
    assert!(
        out.contains("EXIT:") && !out.contains("EXIT:0"),
        "direct IP should be blocked by TCP filter, got: {out}"
    );

    litebox.stop().await.unwrap();
}

/// The UDP twin of `tcp_filter_blocks_direct_ip_connection`. A hostname-only
/// allowlist cannot be enforced for UDP by inspection, so datagrams to an
/// address outside the allowlist must be dropped rather than forwarded.
#[tokio::test]
async fn udp_filter_blocks_direct_ip_datagram() {
    let Some(host_ip) = host_routable_ipv4() else {
        skip_missing_egress(
            "udp_filter_blocks_direct_ip_datagram",
            "no routable host IPv4 to use as an unlisted destination",
        );
        return;
    };

    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();

    let opts = BoxOptions {
        network: NetworkSpec::Enabled {
            allow_net: vec!["example.com".into()],
        },
        ..common::alpine_opts()
    };

    let litebox = runtime.create(opts, None).await.unwrap();
    litebox.start().await.unwrap();

    let (port, received, receiver) = start_host_udp_receiver("0.0.0.0:0", Duration::from_secs(8));
    let command = nc_udp_command(&host_ip.to_string(), port);
    let probe = run_stdout(&litebox, "sh", &["-c", &command]).await;
    assert_udp_probe_ran(&probe);

    let leaked = received.recv_timeout(Duration::from_secs(5));
    assert!(
        leaked.is_err(),
        "UDP to unlisted {host_ip} escaped the allowlist: {:?}",
        leaked.map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    );

    receiver.join().unwrap();
    litebox.stop().await.unwrap();
}

/// The UDP twin of `host_alias_blocked_by_restrictive_allowlist`. The host
/// alias NATs to host loopback, so it is an egress destination and an
/// allowlist that does not name it must drop the datagram.
#[tokio::test]
async fn udp_to_host_alias_blocked_by_restrictive_allowlist() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();

    let opts = BoxOptions {
        network: NetworkSpec::Enabled {
            allow_net: vec!["example.com".into()],
        },
        ..common::alpine_opts()
    };

    let litebox = runtime.create(opts, None).await.unwrap();
    litebox.start().await.unwrap();

    // The host alias NATs to loopback, so bind where the datagram would land.
    let (port, received, receiver) = start_host_udp_receiver("127.0.0.1:0", Duration::from_secs(8));
    let command = nc_udp_command(HOST_IP, port);
    let probe = run_stdout(&litebox, "sh", &["-c", &command]).await;
    assert_udp_probe_ran(&probe);

    let leaked = received.recv_timeout(Duration::from_secs(5));
    assert!(
        leaked.is_err(),
        "UDP to unlisted host alias {HOST_IP} escaped the allowlist: {:?}",
        leaked.map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    );

    receiver.join().unwrap();
    litebox.stop().await.unwrap();
}

/// Listing the host alias restores it: policy matches the pre-NAT address
/// while the forwarder dials the NAT-translated loopback, so the datagram
/// still reaches the host.
#[tokio::test]
async fn udp_reaches_host_alias_when_listed() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();

    let opts = BoxOptions {
        network: NetworkSpec::Enabled {
            allow_net: vec![HOST_IP.into()],
        },
        ..common::alpine_opts()
    };

    let litebox = runtime.create(opts, None).await.unwrap();
    litebox.start().await.unwrap();

    let (port, received, receiver) = start_host_udp_receiver("127.0.0.1:0", Duration::from_secs(8));
    let command = nc_udp_command(HOST_IP, port);
    let probe = run_stdout(&litebox, "sh", &["-c", &command]).await;
    assert_udp_probe_ran(&probe);

    let payload = received
        .recv_timeout(Duration::from_secs(5))
        .expect("a listed host alias should still deliver UDP");
    assert_eq!(String::from_utf8_lossy(&payload), UDP_PROBE_MARKER);

    receiver.join().unwrap();
    litebox.stop().await.unwrap();
}

#[tokio::test]
#[ignore = "requires VM runtime (run with make test)"]
async fn tcp_filter_sni_allows_https_to_allowed_host() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();

    let opts = BoxOptions {
        network: NetworkSpec::Enabled {
            allow_net: vec!["example.com".into()],
        },
        ..common::alpine_opts()
    };

    let litebox = runtime.create(opts, None).await.unwrap();
    litebox.start().await.unwrap();

    // HTTPS to allowed host should work (SNI matches allowlist)
    let out = run_stdout(
        &litebox,
        "wget",
        &["-q", "-O-", "--timeout=5", "https://example.com/"],
    )
    .await;
    assert!(
        !out.is_empty(),
        "HTTPS to allowed host should work via SNI match, got empty output"
    );

    litebox.stop().await.unwrap();
}

#[tokio::test]
#[ignore = "requires VM runtime (run with make test)"]
async fn host_alias_resolves_to_dedicated_host_ip() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();

    let litebox = runtime.create(common::alpine_opts(), None).await.unwrap();
    litebox.start().await.unwrap();

    let out = run_stdout(&litebox, "nslookup", &[HOST_HOSTNAME]).await;
    assert!(
        out.contains(HOST_IP),
        "host alias should resolve to the dedicated host IP, got: {out}"
    );

    litebox.stop().await.unwrap();
}

#[tokio::test]
#[ignore = "requires VM runtime (run with make test)"]
async fn host_alias_reaches_host_loopback_service() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();

    let litebox = runtime.create(common::alpine_opts(), None).await.unwrap();
    litebox.start().await.unwrap();

    let (port, server) = start_host_http_server("boxlite-host-alias");
    let command = wget_url_command(&format!("http://{HOST_HOSTNAME}:{port}/"));
    let out = run_stdout(&litebox, "sh", &["-c", &command]).await;

    assert!(
        out.contains("boxlite-host-alias"),
        "host alias should reach host loopback service, got: {out}"
    );

    server.join().unwrap();
    litebox.stop().await.unwrap();
}

/// On the Local runtime, DNS serves the alias while the Box allowlist denies
/// the connection to its address.
#[tokio::test]
#[ignore = "requires VM runtime (run with make test)"]
async fn host_alias_blocked_by_restrictive_allowlist() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();

    let opts = BoxOptions {
        network: NetworkSpec::Enabled {
            allow_net: vec!["example.com".into()],
        },
        ..common::alpine_opts()
    };

    let litebox = runtime.create(opts, None).await.unwrap();
    litebox.start().await.unwrap();

    let nslookup = run_stdout(&litebox, "nslookup", &[HOST_HOSTNAME]).await;
    assert!(
        nslookup.contains(HOST_IP),
        "host alias should still resolve under restrictive allowlist, got: {nslookup}"
    );

    let (port, stop_server, server) = start_host_http_server_expect_no_connection();
    let command = wget_url_command(&format!("http://{HOST_HOSTNAME}:{port}/"));
    let out = run_stdout(&litebox, "sh", &["-c", &command]).await;

    assert!(
        out.contains("EXIT:") && !out.contains("EXIT:0"),
        "unlisted host alias should not reach host loopback, got: {out}"
    );

    let _ = stop_server.send(());
    server.join().unwrap();
    litebox.stop().await.unwrap();
}

/// Listing the alias IP restores host loopback access: policy is matched on
/// the pre-NAT address, the dial still lands on 127.0.0.1.
#[tokio::test]
#[ignore = "requires VM runtime (run with make test)"]
async fn host_alias_reaches_host_loopback_service_when_listed() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();

    let opts = BoxOptions {
        network: NetworkSpec::Enabled {
            allow_net: vec![HOST_IP.into()],
        },
        ..common::alpine_opts()
    };

    let litebox = runtime.create(opts, None).await.unwrap();
    litebox.start().await.unwrap();

    let (port, server) = start_host_http_server("boxlite-host-alias-allowlist");
    let command = wget_url_command(&format!("http://{HOST_HOSTNAME}:{port}/"));
    let out = run_stdout(&litebox, "sh", &["-c", &command]).await;

    assert!(
        out.contains("boxlite-host-alias-allowlist"),
        "a listed host alias should reach host loopback, got: {out}"
    );

    server.join().unwrap();
    litebox.stop().await.unwrap();
}

#[tokio::test]
#[ignore = "requires VM runtime (run with make test)"]
async fn disabled_network_cannot_reach_host_virtual_ip() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();

    let opts = BoxOptions {
        network: NetworkSpec::Disabled,
        ..common::alpine_opts()
    };

    let litebox = runtime.create(opts, None).await.unwrap();
    litebox.start().await.unwrap();

    let no_eth0 = run_exit_code(&litebox, "sh", &["-c", "test ! -e /sys/class/net/eth0"]).await;
    assert_eq!(
        no_eth0, 0,
        "disabled network should remove eth0 entirely, got exit code {no_eth0}"
    );

    let (port, stop_server, server) = start_host_http_server_expect_no_connection();
    let command = wget_url_command(&format!("http://{HOST_IP}:{port}/"));
    let out = run_stdout(&litebox, "sh", &["-c", &command]).await;

    assert!(
        out.contains("EXIT:") && !out.contains("EXIT:0"),
        "host virtual IP should be unreachable with network disabled, got: {out}"
    );

    let _ = stop_server.send(());
    server.join().unwrap();
    litebox.stop().await.unwrap();
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod runtime_update {
    use super::*;
    use boxlite::litebox::NetworkHandle;
    use boxlite::net::{
        CompleteOutboundPolicy, OutboundAdmission, OutboundApplicationState,
        OutboundReplaceOutcome, OutboundRevision,
    };
    use boxlite::runtime::options::{NetworkMode, PortSpec, RootfsSpec};
    use boxlite::{ExecStdin, Execution, LiteBox};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::time::timeout;

    const WAIT: Duration = Duration::from_secs(5);
    const GUEST_PORT: u16 = 8080;
    const GUEST_CLIENT: &str = r#"
import socket
import sys
with socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=2) as stream:
    for line in sys.stdin.buffer:
        stream.sendall(line)
"#;

    #[cfg(target_os = "linux")]
    fn listener_identity(port: u16) -> String {
        let endpoint = format!("0100007F:{port:04X}");
        std::fs::read_to_string("/proc/net/tcp")
            .unwrap()
            .lines()
            .skip(1)
            .find_map(|line| {
                let parts: Vec<_> = line.split_whitespace().collect();
                (parts.get(1) == Some(&endpoint.as_str()) && parts.get(3) == Some(&"0A"))
                    .then(|| parts[9].to_string())
            })
            .expect("published TCP listener is missing")
    }

    #[cfg(target_os = "macos")]
    fn listener_identity(port: u16) -> String {
        let selector = format!("-iTCP@127.0.0.1:{port}");
        let output = std::process::Command::new("/usr/sbin/lsof")
            .args(["-a", "-nP", &selector, "-sTCP:LISTEN"])
            .output()
            .unwrap();
        assert!(output.status.success());
        let endpoint = format!("127.0.0.1:{port}");
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .find_map(|line| {
                let parts: Vec<_> = line.split_whitespace().rev().collect();
                match parts.as_slice() {
                    ["(LISTEN)", local, "TCP", _, device, ..]
                        if *local == endpoint && device.starts_with("0x") =>
                    {
                        Some(device.to_string())
                    }
                    _ => None,
                }
            })
            .expect("published TCP socket identifier is missing")
    }

    async fn apply(
        network: &NetworkHandle,
        current: &mut OutboundRevision,
        mode: NetworkMode,
        deny: Vec<String>,
    ) {
        let next = OutboundRevision::fresh();
        let policy = CompleteOutboundPolicy {
            mode: mode.clone(),
            deny_net: Some(deny.clone()),
            ..Default::default()
        };
        assert_eq!(
            network
                .replace_outbound_policy(current.clone(), next.clone(), policy)
                .await
                .unwrap(),
            OutboundReplaceOutcome::Applied
        );
        let status = network.complete_outbound_status().await.unwrap();
        assert_eq!(
            status.application_state,
            OutboundApplicationState::Confirmed
        );
        assert!(status.pending_revision.is_none());
        assert_eq!(status.persisted.revision, next);
        assert_eq!(status.persisted.admission, OutboundAdmission::ExtendedIpv4);
        assert_eq!(status.persisted.policy.mode, mode);
        assert!(status.persisted.policy.allow_net.is_empty());
        assert_eq!(status.persisted.policy.deny_net, deny);
        assert_eq!(
            network.complete_outbound_snapshot().await.unwrap(),
            status.persisted
        );
        let observed = status.observed.unwrap();
        assert_eq!(
            observed.application_state,
            OutboundApplicationState::Confirmed
        );
        assert_eq!(observed.snapshot, status.persisted);
        *current = next;
    }

    async fn guest_tcp(
        litebox: &LiteBox,
        listener: &TcpListener,
    ) -> (Execution, ExecStdin, TcpStream) {
        let port = listener.local_addr().unwrap().port().to_string();
        let mut execution = litebox
            .exec(BoxCommand::new("python3").args(["-c", GUEST_CLIENT, HOST_IP, &port]))
            .await
            .unwrap();
        let input = execution.stdin().unwrap();
        let (stream, _) = timeout(WAIT, listener.accept())
            .await
            .expect("expected an admitted guest connection")
            .unwrap();
        (execution, input, stream)
    }

    async fn expect_delivery(input: &mut ExecStdin, stream: &mut TcpStream, bytes: &[u8]) {
        input.write_all(bytes).await.unwrap();
        let mut received = vec![0; bytes.len()];
        timeout(WAIT, stream.read_exact(&mut received))
            .await
            .expect("host did not receive the guest payload")
            .unwrap();
        assert_eq!(received, bytes);
    }

    async fn expect_fresh_denial(litebox: &LiteBox, listener: &TcpListener) {
        let port = listener.local_addr().unwrap().port().to_string();
        let mut attempt = litebox
            .exec(BoxCommand::new("python3").args(["-c", GUEST_CLIENT, HOST_IP, &port]))
            .await
            .unwrap();
        let mut input = attempt.stdin().unwrap();
        let _ = input.write_all(b"blocked-flow\n").await;
        input.close();
        let (arrival, exit) = tokio::join!(
            timeout(Duration::from_secs(2), listener.accept()),
            timeout(WAIT, attempt.wait())
        );
        assert!(arrival.is_err(), "denied flow reached the host listener");
        assert_ne!(
            exit.expect("guest denial probe did not finish")
                .unwrap()
                .exit_code,
            0
        );
    }

    async fn inbound_delivers(port: u16) -> bool {
        let result = timeout(Duration::from_millis(750), async {
            let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await?;
            stream.write_all(b"GET / HTTP/1.0\r\n\r\n").await?;
            let mut response = String::new();
            stream.read_to_string(&mut response).await?;
            std::io::Result::Ok(response.contains("original-inbound-service"))
        })
        .await;
        matches!(result, Ok(Ok(true)))
    }

    #[tokio::test]
    #[ignore = "requires VM runtime (run with make test)"]
    async fn outbound_replacement_preserves_live_flows_and_inbound_listener() {
        let home = boxlite_test_utils::home::PerTestBoxHome::new();
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: common::test_registries(),
            ..Default::default()
        })
        .unwrap();
        let mut options = common::alpine_opts();
        options.rootfs = RootfsSpec::Image("python:alpine".into());
        options.ports.push(PortSpec {
            guest_port: GUEST_PORT,
            host_ip: Some("127.0.0.1".into()),
            ..Default::default()
        });
        let litebox = runtime
            .create_with_outbound_policy(
                options,
                None,
                CompleteOutboundPolicy {
                    deny_net: Some(vec![]),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        litebox.start().await.unwrap();
        let network = litebox.network();
        let mut httpd = litebox
            .exec(BoxCommand::new("sh").args([
                "-ec",
                "mkdir -p /tmp/outbound-test-http; echo original-inbound-service >/tmp/outbound-test-http/index.html; exec python3 -u -m http.server --bind 0.0.0.0 --directory /tmp/outbound-test-http 8080",
            ]))
            .await
            .unwrap();
        let forwards = network.published_ports().await.unwrap().unwrap();
        let [forward] = forwards.as_slice() else {
            panic!("expected one inbound publish, got {forwards:?}");
        };
        let published = forward.host_port;
        let ready = timeout(WAIT, async {
            while !inbound_delivers(published).await {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        if ready.is_err() {
            let mut stderr = httpd.stderr().unwrap();
            let detail = timeout(Duration::from_millis(250), stderr.next()).await;
            panic!("inbound test service did not start: {detail:?}");
        }
        let inbound_identity = listener_identity(published);

        let egress = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let mut revision = network.complete_outbound_snapshot().await.unwrap().revision;
        apply(&network, &mut revision, NetworkMode::Enabled, vec![]).await;
        let (_old_guest, mut old_input, mut old_stream) = guest_tcp(&litebox, &egress).await;
        expect_delivery(&mut old_input, &mut old_stream, b"before update\n").await;

        let deny = format!("{HOST_IP}:{}", egress.local_addr().unwrap().port());
        apply(&network, &mut revision, NetworkMode::Enabled, vec![deny]).await;
        expect_delivery(&mut old_input, &mut old_stream, b"established flow\n").await;
        expect_fresh_denial(&litebox, &egress).await;
        assert_eq!(network.published_ports().await.unwrap().unwrap(), forwards);
        assert_eq!(listener_identity(published), inbound_identity);
        assert!(inbound_delivers(published).await);

        apply(&network, &mut revision, NetworkMode::Enabled, vec![]).await;
        let (_new_guest, mut new_input, mut new_stream) = guest_tcp(&litebox, &egress).await;
        expect_delivery(&mut new_input, &mut new_stream, b"after clear\n").await;

        apply(&network, &mut revision, NetworkMode::Disabled, vec![]).await;
        let _ = old_input.write_all(b"while disabled\n").await;
        let mut bytes = [0; 32];
        let result = timeout(Duration::from_millis(750), old_stream.read(&mut bytes)).await;
        assert!(
            !matches!(result, Ok(Ok(n)) if n > 0),
            "established guest data reached host while disabled"
        );
        expect_fresh_denial(&litebox, &egress).await;
        assert_eq!(network.published_ports().await.unwrap().unwrap(), forwards);
        assert_eq!(listener_identity(published), inbound_identity);
        assert!(!inbound_delivers(published).await);

        apply(&network, &mut revision, NetworkMode::Enabled, vec![]).await;
        let (_resumed_guest, mut resumed_input, mut resumed_stream) =
            guest_tcp(&litebox, &egress).await;
        expect_delivery(&mut resumed_input, &mut resumed_stream, b"after resume\n").await;
        assert_eq!(network.published_ports().await.unwrap().unwrap(), forwards);
        assert_eq!(listener_identity(published), inbound_identity);
        assert!(inbound_delivers(published).await);
        litebox.stop().await.unwrap();
    }
}
