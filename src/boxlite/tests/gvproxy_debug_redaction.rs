//! Integration test: `GvproxyConfig::Debug` must redact PEM fields.
//!
//! The unit-test counterpart of this assertion lives in `src/net/mod.rs`
//! for `NetworkBackendConfig`, which is reachable from `--no-default-features`
//! and therefore runs under `make test:unit:rust`. `GvproxyConfig`, in
//! contrast, lives behind `#[cfg(feature = "gvproxy")]` — so an in-crate
//! `#[test]` would never compile under the standard unit-test target
//! (see the comment at `make/test.mk:177`).
//!
//! Putting the assertion here, gated on the `gvproxy` feature, lets the
//! existing `make test:integration:rust` target (which already passes
//! `--features krun,gvproxy --test '*'`) pick it up.

#![cfg(feature = "gvproxy")]

use boxlite::net::gvproxy::GvproxyConfig;
use std::path::PathBuf;

#[test]
fn gvproxy_config_debug_redacts_ca_pem_fields() {
    let key_sentinel = "----BEGIN PRIVATE KEY----TOPSECRETPKCS8";
    let cert_sentinel = "----BEGIN CERTIFICATE----TOPSECRETCERT";

    let mut config = GvproxyConfig::new(PathBuf::from("/tmp/test-gvproxy.sock"), vec![]);
    config.ca_key_pem = Some(key_sentinel.to_string());
    config.ca_cert_pem = Some(cert_sentinel.to_string());

    let rendered = format!("{:?}", config);

    assert!(
        !rendered.contains(key_sentinel),
        "Debug leaked ca_key_pem: {rendered}"
    );
    assert!(
        !rendered.contains(cert_sentinel),
        "Debug leaked ca_cert_pem: {rendered}"
    );
    assert!(
        rendered.contains("[REDACTED]"),
        "expected redaction marker, got: {rendered}"
    );
}
