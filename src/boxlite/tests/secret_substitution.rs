//! Tests for secret substitution types, config propagation, and value redaction.
//!
//! These tests verify:
//! - JSON serialization matches what Go gvproxy expects
//! - Placeholder format is correct and consistent
//! - Debug/Display never leak secret values

use boxlite::runtime::options::{BoxOptions, Secret};

fn make_secret(name: &str, host: &str, value: &str) -> Secret {
    Secret {
        name: name.to_string(),
        hosts: vec![host.to_string()],
        placeholder: format!("<BOXLITE_SECRET:{}>", name),
        value: value.to_string(),
    }
}

#[cfg(feature = "gvproxy")]
mod gvproxy_tests {
    use super::*;
    use boxlite::net::gvproxy::{GvproxyConfig, GvproxySecretConfig};
    use std::path::PathBuf;

    #[test]
    fn test_secret_config_json_matches_go_expectations() {
        // Go's gvproxy expects: {"name":"...","hosts":[...],"placeholder":"...","value":"..."}
        let secret = make_secret("openai", "api.openai.com", "sk-test-key");
        let gvproxy_secret = GvproxySecretConfig::from(&secret);

        let json_value = serde_json::to_value(&gvproxy_secret).unwrap();
        let obj = json_value.as_object().unwrap();

        // Verify exact field names Go expects
        assert!(obj.contains_key("name"), "Go expects 'name' field");
        assert!(obj.contains_key("hosts"), "Go expects 'hosts' field");
        assert!(
            obj.contains_key("placeholder"),
            "Go expects 'placeholder' field"
        );
        assert!(obj.contains_key("value"), "Go expects 'value' field");

        // Verify types
        assert!(obj["name"].is_string());
        assert!(obj["hosts"].is_array());
        assert!(obj["placeholder"].is_string());
        assert!(obj["value"].is_string());

        // Verify a full GvproxyConfig with secrets serializes correctly
        let config = GvproxyConfig::new(PathBuf::from("/tmp/test.sock"), vec![])
            .with_secrets(vec![gvproxy_secret]);
        let config_json = serde_json::to_value(&config).unwrap();
        let secrets_arr = config_json["secrets"].as_array().unwrap();
        assert_eq!(secrets_arr.len(), 1);
        assert_eq!(secrets_arr[0]["name"], "openai");
    }

    #[test]
    fn test_secret_propagation_to_gvproxy_config() {
        let secrets = [
            make_secret("openai", "api.openai.com", "sk-openai"),
            make_secret("anthropic", "api.anthropic.com", "sk-ant"),
        ];

        let gvproxy_secrets: Vec<GvproxySecretConfig> =
            secrets.iter().map(GvproxySecretConfig::from).collect();

        let config = GvproxyConfig::new(PathBuf::from("/tmp/test.sock"), vec![(8080, 80)])
            .with_secrets(gvproxy_secrets);

        assert_eq!(config.secrets.len(), 2);
        assert_eq!(config.secrets[0].name, "openai");
        assert_eq!(config.secrets[0].hosts, vec!["api.openai.com"]);
        assert_eq!(config.secrets[1].name, "anthropic");
        assert_eq!(config.secrets[1].hosts, vec!["api.anthropic.com"]);
    }

    #[test]
    fn test_gvproxy_secret_debug_contains_struct_info() {
        let secret = make_secret("test", "example.com", "sk-SUPER-SECRET");
        let gvproxy_secret = GvproxySecretConfig::from(&secret);
        let debug = format!("{:?}", gvproxy_secret);
        assert!(debug.contains("test"));
    }
}

#[test]
fn test_secret_placeholder_format() {
    let secret = make_secret("my_api_key", "example.com", "secret-val");
    assert_eq!(secret.placeholder, "<BOXLITE_SECRET:my_api_key>");

    // Placeholder should be preserved through serde
    let json = serde_json::to_string(&secret).unwrap();
    let rt: Secret = serde_json::from_str(&json).unwrap();
    assert_eq!(rt.placeholder, "<BOXLITE_SECRET:my_api_key>");
}

#[test]
fn test_secret_debug_never_leaks_value() {
    let test_value = "sk-SUPER-SECRET-DO-NOT-LEAK-12345";

    // Test Secret Debug
    let secret = make_secret("test", "example.com", test_value);
    let debug = format!("{:?}", secret);
    assert!(
        !debug.contains(test_value),
        "Secret Debug must not contain the value, got: {debug}"
    );
    assert!(debug.contains("[REDACTED]"));

    // Test Secret Display
    let display = format!("{}", secret);
    assert!(
        !display.contains(test_value),
        "Secret Display must not contain the value, got: {display}"
    );
    assert!(display.contains("[REDACTED]"));

    // Test BoxOptions with secrets - Debug should not leak
    let opts = BoxOptions {
        secrets: vec![secret],
        ..Default::default()
    };
    let opts_debug = format!("{:?}", opts);
    assert!(
        !opts_debug.contains(test_value),
        "BoxOptions Debug must not leak secret values, got: {opts_debug}"
    );
}

#[test]
fn test_box_options_secrets_backward_compatible() {
    // JSON without "secrets" field should still deserialize (serde default)
    let json = r#"{
        "rootfs": {"Image": "alpine:latest"},
        "env": [],
        "volumes": [],
        "network": {"Enabled": {"allow_net": []}},
        "ports": []
    }"#;
    let opts: BoxOptions = serde_json::from_str(json).unwrap();
    assert!(opts.secrets.is_empty());
}
