//! Python bindings for hosted SSH certificate credentials.
//!
//! The private key is generated on the client by the Rust core and is never
//! sent anywhere. These bindings keep that property observable from Python:
//! the key is reachable only through [`PySshCredentialBundle::expose_private_key`],
//! and never through `repr()`, `str()` or an attribute.

use std::sync::Arc;

use boxlite::{LiteBox, SshCertificateCredential};
use pyo3::prelude::*;

use crate::util::map_err;

/// Public metadata for one issued certificate credential.
///
/// Every field is safe to display, log and persist — there is no private key
/// material here by construction.
#[pyclass(name = "SshCertificateCredential")]
#[derive(Clone)]
pub(crate) struct PySshCertificateCredential {
    #[pyo3(get)]
    pub id: String,
    #[pyo3(get)]
    pub box_id: String,
    #[pyo3(get)]
    pub certificate: String,
    #[pyo3(get)]
    pub public_key: String,
    #[pyo3(get)]
    pub fingerprint: String,
    #[pyo3(get)]
    pub serial: u64,
    #[pyo3(get)]
    pub ca_key_id: String,
    #[pyo3(get)]
    pub valid_after: String,
    #[pyo3(get)]
    pub expires_at: String,
    #[pyo3(get)]
    pub revoked_at: Option<String>,
    #[pyo3(get)]
    pub host: String,
    #[pyo3(get)]
    pub port: u16,
    #[pyo3(get)]
    pub ssh_command: String,
    #[pyo3(get)]
    pub proxy_command: String,
    #[pyo3(get)]
    pub known_hosts: String,
    #[pyo3(get)]
    pub created_at: String,
    #[pyo3(get)]
    pub updated_at: String,
}

#[pymethods]
impl PySshCertificateCredential {
    fn __repr__(&self) -> String {
        format!(
            "SshCertificateCredential(id={:?}, box_id={:?}, fingerprint={:?}, expires_at={:?})",
            self.id, self.box_id, self.fingerprint, self.expires_at
        )
    }
}

impl From<SshCertificateCredential> for PySshCertificateCredential {
    fn from(c: SshCertificateCredential) -> Self {
        Self {
            id: c.id,
            box_id: c.box_id,
            certificate: c.certificate,
            public_key: c.public_key,
            fingerprint: c.fingerprint,
            serial: c.serial,
            ca_key_id: c.ca_key_id,
            valid_after: c.valid_after,
            expires_at: c.expires_at,
            revoked_at: c.revoked_at,
            host: c.host,
            port: c.port,
            ssh_command: c.ssh_command,
            proxy_command: c.proxy_command,
            known_hosts: c.known_hosts,
            created_at: c.created_at,
            updated_at: c.updated_at,
        }
    }
}

/// Everything needed to open an SSH session: the client-held private key plus
/// the issued certificate and endpoint metadata.
#[pyclass(name = "SshCredentialBundle")]
pub(crate) struct PySshCredentialBundle {
    private_key_openssh: String,
    credential: PySshCertificateCredential,
}

#[pymethods]
impl PySshCredentialBundle {
    /// Public certificate metadata for this credential.
    #[getter]
    fn credential(&self) -> PySshCertificateCredential {
        self.credential.clone()
    }

    /// The locally generated OpenSSH private key.
    ///
    /// Deliberately a method rather than a property, and named `expose_`, so
    /// every read of the secret is visible at the call site and in review.
    /// `repr()` and `str()` never contain it.
    fn expose_private_key(&self) -> String {
        self.private_key_openssh.clone()
    }

    /// Redacts the private key so a bundle cannot leak through a log line or
    /// a traceback. `str()` falls back to this.
    fn __repr__(&self) -> String {
        format!(
            "SshCredentialBundle(private_key=[REDACTED], credential={})",
            self.credential.__repr__()
        )
    }
}

/// Handle for SSH certificate operations on a Box.
///
/// Accessed as a property: `box.ssh_certificates.issue()`.
#[pyclass(name = "SshCertificateHandle")]
pub(crate) struct PySshCertificateHandle {
    pub(crate) handle: Arc<LiteBox>,
}

#[pymethods]
impl PySshCertificateHandle {
    /// Sign a certificate for a public key the caller already holds.
    ///
    /// `ttl_minutes` defaults to the server policy when omitted.
    #[pyo3(signature = (public_key, ttl_minutes=None))]
    fn create<'py>(
        &self,
        py: Python<'py>,
        public_key: String,
        ttl_minutes: Option<u32>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let credential = handle
                .ssh_certificates()
                .create(&public_key, ttl_minutes)
                .await
                .map_err(map_err)?;
            Ok(PySshCertificateCredential::from(credential))
        })
    }

    /// Public metadata for this box's credentials.
    fn list<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let credentials = handle.ssh_certificates().list().await.map_err(map_err)?;
            Ok(credentials
                .into_iter()
                .map(PySshCertificateCredential::from)
                .collect::<Vec<_>>())
        })
    }

    /// Revoke one credential by ID.
    fn revoke<'py>(&self, py: Python<'py>, credential_id: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle
                .ssh_certificates()
                .revoke(&credential_id)
                .await
                .map_err(map_err)?;
            Ok(())
        })
    }

    /// Generate a fresh Ed25519 key pair locally and get a certificate for it.
    ///
    /// This is the recommended entry point: only the public half is ever sent.
    /// Certificates are short-lived, so issue one immediately before
    /// connecting rather than ahead of time.
    #[pyo3(signature = (ttl_minutes=None))]
    fn issue<'py>(&self, py: Python<'py>, ttl_minutes: Option<u32>) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let bundle = handle
                .ssh_certificates()
                .issue(ttl_minutes)
                .await
                .map_err(map_err)?;
            Ok(PySshCredentialBundle {
                private_key_openssh: bundle.private_key.expose_openssh().to_string(),
                credential: PySshCertificateCredential::from(bundle.credential),
            })
        })
    }

    fn __repr__(&self) -> String {
        format!(
            "SshCertificateHandle(box_id={:?})",
            self.handle.id().to_string()
        )
    }
}
