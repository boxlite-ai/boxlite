//! MITM CA certificate installation for secret substitution.
//!
//! When the host configures secrets, it creates an ephemeral CA and passes
//! the PEM-encoded certificate as the `BOXLITE_CA_PEM` env var (base64-encoded).
//! This module decodes it and appends to the system CA bundle so HTTPS clients
//! trust the MITM proxy's generated certificates.

use base64::Engine;
use tracing::{info, warn};

/// System CA bundle path (Alpine Linux / musl)
pub(crate) const CA_BUNDLE_PATH: &str = "/etc/ssl/certs/ca-certificates.crt";

/// Environment variable containing the base64-encoded CA PEM
const CA_PEM_ENV: &str = "BOXLITE_CA_PEM";

/// SSL trust environment variables to set for common HTTPS clients
pub(crate) const SSL_TRUST_VARS: &[(&str, &str)] = &[
    ("SSL_CERT_FILE", CA_BUNDLE_PATH),
    ("REQUESTS_CA_BUNDLE", CA_BUNDLE_PATH),  // Python requests
    ("NODE_EXTRA_CA_CERTS", CA_BUNDLE_PATH), // Node.js
    ("CURL_CA_BUNDLE", CA_BUNDLE_PATH),      // curl
];

/// Install the MITM CA certificate from the environment variable.
///
/// If `BOXLITE_CA_PEM` is set, decodes it and appends to the system CA bundle.
/// Also sets SSL trust env vars so HTTPS clients in this process (and any
/// children that inherit env) trust the MITM CA.
///
/// This is a best-effort operation — failures are logged but don't prevent
/// the guest from starting (secrets just won't work for HTTPS).
pub fn install_ca_from_env() {
    let b64 = match std::env::var(CA_PEM_ENV) {
        Ok(v) if !v.is_empty() => v,
        _ => return, // No CA cert to install
    };

    let pem = match base64::engine::general_purpose::STANDARD.decode(&b64) {
        Ok(bytes) => bytes,
        Err(e) => {
            warn!("Failed to decode {CA_PEM_ENV}: {e}");
            return;
        }
    };

    // Try to append CA cert to guest's system bundle (may fail on small rootfs)
    if let Err(e) = append_to_ca_bundle(&pem) {
        warn!("Failed to write CA cert to guest rootfs (expected on small initramfs): {e}");
        // Continue — the CA cert will be injected into the container rootfs
        // by container.rs during Container.Init, reading BOXLITE_CA_PEM directly.
    } else {
        info!("MITM CA cert installed into {CA_BUNDLE_PATH}");
    }

    // Set SSL trust env vars for this process and children.
    // These are also injected into container env by container_rootfs.rs on the host.
    for (key, value) in SSL_TRUST_VARS {
        std::env::set_var(key, value);
    }

    // Note: BOXLITE_CA_PEM is removed in container.rs after Container.Init
    // reads it. It must persist until then because the container rootfs
    // overlay also needs the CA cert.
}

/// Append PEM bytes to the system CA bundle file.
fn append_to_ca_bundle(pem: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    // Ensure the directory exists
    if let Some(parent) = std::path::Path::new(CA_BUNDLE_PATH).parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(CA_BUNDLE_PATH)?;

    // Ensure we start on a new line
    file.write_all(b"\n")?;
    file.write_all(pem)?;
    file.write_all(b"\n")?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ssl_trust_vars_have_correct_path() {
        for (_, path) in SSL_TRUST_VARS {
            assert_eq!(*path, CA_BUNDLE_PATH);
        }
    }
}
