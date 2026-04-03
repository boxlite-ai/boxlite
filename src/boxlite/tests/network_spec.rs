//! Tests for NetworkSpec enum behavior.

mod common;

use boxlite::runtime::options::{BoxOptions, BoxliteOptions, NetworkSpec};
use boxlite::{BoxCommand, BoxliteRuntime};
use futures::StreamExt;

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
    let mut ex = litebox
        .exec(BoxCommand::new(cmd).args(args.iter().map(|s| s.to_string()).collect::<Vec<_>>()))
        .await
        .unwrap();
    ex.wait().await.unwrap().exit_code
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
