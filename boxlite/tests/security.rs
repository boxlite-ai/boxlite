//! Integration tests for security features: audit, network policy, secrets.

mod common;

use std::collections::HashMap;

use boxlite::runtime::options::{
    BoxOptions, BoxliteOptions, NetworkPolicy, NetworkSpec, SecretSpec,
};
use boxlite::{AuditEventKind, BoxCommand, BoxliteRuntime};
use futures::StreamExt;

// ============================================================================
// AUDIT LOG TESTS
// ============================================================================

#[tokio::test]
#[ignore = "requires VM runtime (run via `make test` from main repo)"]
async fn audit_log_records_start_and_exec_events() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let litebox = runtime.create(common::alpine_opts(), None).await.unwrap();
    litebox.start().await.unwrap();

    let mut run = litebox
        .exec(BoxCommand::new("echo").args(["hello"]))
        .await
        .unwrap();
    // Drain stdout
    if let Some(mut stdout) = run.stdout() {
        while stdout.next().await.is_some() {}
    }
    let _ = run.wait().await;

    let events = litebox.audit_log().await.unwrap();
    assert!(
        events
            .iter()
            .any(|e| matches!(e.kind, AuditEventKind::BoxStarted)),
        "should have BoxStarted event"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e.kind, AuditEventKind::ExecStarted { .. })),
        "should have ExecStarted event"
    );

    litebox.stop().await.unwrap();

    let events = litebox.audit_log().await.unwrap();
    assert!(
        events
            .iter()
            .any(|e| matches!(e.kind, AuditEventKind::BoxStopped { .. })),
        "should have BoxStopped event"
    );
}

// ============================================================================
// NETWORK POLICY TESTS
// ============================================================================

#[test]
fn default_network_is_isolated() {
    assert!(matches!(
        BoxOptions::default().network,
        NetworkSpec::Isolated
    ));
}

#[tokio::test]
async fn restricted_network_creates_box() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let opts = BoxOptions {
        network: NetworkSpec::Restricted(NetworkPolicy {
            allow_net: vec!["api.openai.com".into()],
        }),
        ..common::alpine_opts()
    };

    let litebox = runtime.create(opts, None).await.unwrap();
    assert!(!litebox.id().as_str().is_empty());
}

// ============================================================================
// SECRETS TESTS
// ============================================================================

#[test]
fn default_secrets_is_empty() {
    assert!(BoxOptions::default().secrets.is_empty());
}

#[tokio::test]
#[ignore = "requires VM runtime (run via `make test` from main repo)"]
async fn secret_env_shows_placeholder_not_real_value() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let opts = BoxOptions {
        secrets: HashMap::from([(
            "API_KEY".into(),
            SecretSpec {
                hosts: vec!["api.openai.com".into()],
                value: "sk-real-secret".into(),
            },
        )]),
        ..common::alpine_opts()
    };

    let litebox = runtime.create(opts, None).await.unwrap();
    litebox.start().await.unwrap();

    // env var should contain placeholder, NOT real secret
    let mut run = litebox
        .exec(BoxCommand::new("sh").args(["-c", "echo $API_KEY"]))
        .await
        .unwrap();
    let mut stdout_str = String::new();
    if let Some(mut stdout) = run.stdout() {
        while let Some(chunk) = stdout.next().await {
            stdout_str.push_str(&chunk);
        }
    }
    let _ = run.wait().await;
    let stdout_trimmed = stdout_str.trim();

    assert!(
        stdout_trimmed.contains("<BOXLITE_SECRET:API_KEY>"),
        "env should show placeholder, got: {stdout_trimmed}"
    );
    assert!(
        !stdout_trimmed.contains("sk-real-secret"),
        "env should NOT show real secret"
    );

    litebox.stop().await.unwrap();
}

// ============================================================================
// SERDE BACKWARD COMPATIBILITY
// ============================================================================

#[test]
fn old_config_without_secrets_deserializes() {
    let json = r#"{
        "rootfs": {"Image": "alpine:latest"},
        "env": [],
        "volumes": [],
        "network": "Isolated",
        "ports": []
    }"#;
    let opts: BoxOptions = serde_json::from_str(json).unwrap();
    assert!(opts.secrets.is_empty());
    assert!(matches!(opts.network, NetworkSpec::Isolated));
}

#[test]
fn network_restricted_roundtrip() {
    let spec = NetworkSpec::Restricted(NetworkPolicy {
        allow_net: vec!["api.openai.com".into(), "*.anthropic.com".into()],
    });
    let json = serde_json::to_string(&spec).unwrap();
    let rt: NetworkSpec = serde_json::from_str(&json).unwrap();
    if let NetworkSpec::Restricted(p) = rt {
        assert_eq!(p.allow_net.len(), 2);
    } else {
        panic!("should be Restricted");
    }
}
