//! The system certificate store, which registry clients trust on top of
//! oci-client's bundled Mozilla roots, as Docker does.

use oci_client::client::{Certificate, CertificateEncoding};
use tokio::sync::OnceCell;

static ROOT_CERTIFICATES: OnceCell<Vec<Certificate>> = OnceCell::const_new();

/// Take a process-wide snapshot of the system roots on first use. Changes to
/// the host store, `SSL_CERT_FILE`, or `SSL_CERT_DIR` require a restart.
pub(super) async fn root_certificates() -> &'static [Certificate] {
    ROOT_CERTIFICATES
        .get_or_init(|| async {
            tokio::task::spawn_blocking(load_root_certificates)
                .await
                .inspect_err(|e| tracing::warn!("could not read the system certificate store: {e}"))
                .unwrap_or_default()
        })
        .await
}

fn load_root_certificates() -> Vec<Certificate> {
    let loaded = rustls_native_certs::load_native_certs();
    for error in &loaded.errors {
        tracing::debug!("skipped part of the system certificate store: {error}");
    }
    loaded
        .certs
        .into_iter()
        // oci-client adds extra roots strictly: one legacy certificate that
        // rustls cannot parse would otherwise fail every pull.
        .filter(|cert| webpki::anchor_from_trusted_cert(cert).is_ok())
        .map(|cert| Certificate {
            encoding: CertificateEncoding::Der,
            data: cert.to_vec(),
        })
        .collect()
}
