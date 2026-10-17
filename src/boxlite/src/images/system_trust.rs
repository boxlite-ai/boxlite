//! The system certificate store, which registry clients trust on top of
//! oci-client's bundled Mozilla roots, as Docker does.

use oci_client::client::{Certificate, CertificateEncoding};

/// Read the system certificate store for one pull.
///
/// Reading it blocks on file I/O, so it runs off the async runtime. Each pull
/// reads it again, so a CA installed on the host applies without a restart.
/// `SSL_CERT_FILE` and `SSL_CERT_DIR` replace the store when set. Like
/// reqwest's own native-roots loader, this skips certificates rustls cannot
/// parse: stores often hold ancient ones, and oci-client adds extra roots
/// strictly, so one of them would fail every pull.
pub(super) async fn root_certificates() -> Vec<Certificate> {
    let loaded = tokio::task::spawn_blocking(rustls_native_certs::load_native_certs)
        .await
        .inspect_err(|e| tracing::warn!("could not read the system certificate store: {e}"))
        .unwrap_or_default();
    for error in &loaded.errors {
        tracing::debug!("skipped part of the system certificate store: {error}");
    }
    loaded
        .certs
        .into_iter()
        .filter(|cert| webpki::anchor_from_trusted_cert(cert).is_ok())
        .map(|cert| Certificate {
            encoding: CertificateEncoding::Der,
            data: cert.to_vec(),
        })
        .collect()
}
