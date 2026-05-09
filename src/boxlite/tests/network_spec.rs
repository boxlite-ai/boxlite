//! Tests for NetworkSpec enum behavior.

mod common;

use boxlite::net::constants::{HOST_HOSTNAME, HOST_IP};
use boxlite::runtime::options::{BoxOptions, BoxliteOptions, NetworkSpec};
use boxlite::{BoxCommand, BoxliteRuntime};
use futures::StreamExt;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;
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

#[tokio::test]
#[ignore = "requires VM runtime (run with make test)"]
async fn dns_sinkhole_blocks_unlisted_host() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
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

    // Blocked host should resolve to 0.0.0.0 (DNS sinkhole)
    let out = run_stdout(&litebox, "nslookup", &["evil.com"]).await;
    assert!(
        out.contains("0.0.0.0") || out.contains("NXDOMAIN") || out.contains("server can't find"),
        "blocked host should be sinkholed, got: {out}"
    );

    litebox.stop().await.unwrap();
}

#[tokio::test]
#[ignore = "requires VM runtime (run with make test)"]
async fn dns_sinkhole_allows_listed_host() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
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

    // Allowed host should resolve to a real IP (not 0.0.0.0)
    let out = run_stdout(&litebox, "nslookup", &["example.com"]).await;
    assert!(
        !out.contains("0.0.0.0"),
        "allowed host should resolve to real IP, got: {out}"
    );

    litebox.stop().await.unwrap();
}

#[tokio::test]
#[ignore = "requires VM runtime (run with make test)"]
async fn empty_allowlist_allows_all() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .unwrap();

    let opts = BoxOptions {
        network: NetworkSpec::Enabled { allow_net: vec![] },
        ..common::alpine_opts()
    };

    let litebox = runtime.create(opts, None).await.unwrap();
    litebox.start().await.unwrap();

    let out = run_stdout(&litebox, "nslookup", &["example.com"]).await;
    assert!(
        !out.contains("0.0.0.0"),
        "empty allowlist should allow all, got: {out}"
    );

    litebox.stop().await.unwrap();
}

#[tokio::test]
#[ignore = "requires VM runtime (run with make test)"]
async fn tcp_filter_blocks_direct_ip_connection() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
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

    // Direct IP connection to Google DNS (8.8.8.8) should be blocked by TCP filter
    let out = run_stdout(
        &litebox,
        "wget",
        &["-q", "-O-", "--timeout=3", "http://8.8.8.8/"],
    )
    .await;
    assert!(
        out.is_empty() || out.contains("error") || out.contains("timed out"),
        "direct IP should be blocked by TCP filter, got: {out}"
    );

    litebox.stop().await.unwrap();
}

#[tokio::test]
#[ignore = "requires VM runtime (run with make test)"]
async fn tcp_filter_sni_allows_https_to_allowed_host() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
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

#[tokio::test]
#[ignore = "requires VM runtime (run with make test)"]
async fn host_alias_reaches_host_loopback_service_with_restrictive_allowlist() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
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

    let (port, server) = start_host_http_server("boxlite-host-alias-allowlist");
    let command = wget_url_command(&format!("http://{HOST_HOSTNAME}:{port}/"));
    let out = run_stdout(&litebox, "sh", &["-c", &command]).await;

    assert!(
        out.contains("boxlite-host-alias-allowlist"),
        "host alias should bypass allowlist filtering for internal host access, got: {out}"
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
