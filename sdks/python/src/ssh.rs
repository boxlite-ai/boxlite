//! Python bindings for SSH control, mirroring the Rust `SshHandle`.
//!
//! `SshHandle` methods preserve core lifecycle policies: only `configure`
//! may implicitly start the box, and errors surface through `map_err`
//! unchanged. Configuration objects redact credentials in `repr()`; the
//! status type carries none.

use boxlite::{SshAccount, SshCaConfig, SshConfig, SshHandle, SshStatus};
use pyo3::prelude::*;

use crate::util::map_err;

/// Certificate authority and required certificate principal.
/// Both fields are credentials; `repr()` redacts them.
#[pyclass(name = "SshCaConfig")]
#[derive(Clone)]
pub(crate) struct PySshCaConfig {
    #[pyo3(get, set)]
    pub(crate) public_key: String,
    #[pyo3(get, set)]
    pub(crate) principal: String,
}

#[pymethods]
impl PySshCaConfig {
    #[new]
    fn new(public_key: String, principal: String) -> Self {
        Self {
            public_key,
            principal,
        }
    }

    fn __repr__(&self) -> String {
        "SshCaConfig(public_key=[REDACTED], principal=[REDACTED])".into()
    }
}

impl From<PySshCaConfig> for SshCaConfig {
    fn from(ca: PySshCaConfig) -> Self {
        SshCaConfig {
            public_key: ca.public_key,
            principal: ca.principal,
        }
    }
}

/// Credentials accepted for one SSH login (not a container OS identity).
/// `repr()` identifies the login and redacts its key material.
#[pyclass(name = "SshAccount")]
#[derive(Clone)]
pub(crate) struct PySshAccount {
    #[pyo3(get, set)]
    pub(crate) login: String,
    #[pyo3(get, set)]
    pub(crate) authorized_keys: Vec<String>,
    #[pyo3(get, set)]
    pub(crate) ca: Option<PySshCaConfig>,
}

#[pymethods]
impl PySshAccount {
    #[new]
    #[pyo3(signature = (login, authorized_keys=vec![], ca=None))]
    fn new(login: String, authorized_keys: Vec<String>, ca: Option<PySshCaConfig>) -> Self {
        Self {
            login,
            authorized_keys,
            ca,
        }
    }

    fn __repr__(&self) -> String {
        format!(
            "SshAccount(login={:?}, authorized_keys=[REDACTED], ca={})",
            self.login,
            self.ca.as_ref().map(|_| "[REDACTED]").unwrap_or("None")
        )
    }
}

impl From<PySshAccount> for SshAccount {
    fn from(account: PySshAccount) -> Self {
        SshAccount {
            login: account.login,
            authorized_keys: account.authorized_keys,
            ca: account.ca.map(SshCaConfig::from),
        }
    }
}

/// Complete guest SSH configuration; keys are never persisted by the runtime.
/// `repr()` keeps the listener address and redacts all key material.
#[pyclass(name = "SshConfig")]
#[derive(Clone)]
pub(crate) struct PySshConfig {
    #[pyo3(get, set)]
    pub(crate) listen_address: String,
    #[pyo3(get, set)]
    pub(crate) host_private_key: String,
    #[pyo3(get, set)]
    pub(crate) accounts: Vec<PySshAccount>,
}

#[pymethods]
impl PySshConfig {
    #[new]
    #[pyo3(signature = (listen_address, host_private_key, accounts=vec![]))]
    fn new(listen_address: String, host_private_key: String, accounts: Vec<PySshAccount>) -> Self {
        Self {
            listen_address,
            host_private_key,
            accounts,
        }
    }

    fn __repr__(&self) -> String {
        format!(
            "SshConfig(listen_address={:?}, host_private_key=[REDACTED], accounts=[{}])",
            self.listen_address,
            self.accounts
                .iter()
                .map(|a| a.__repr__())
                .collect::<Vec<_>>()
                .join(", ")
        )
    }
}

impl From<PySshConfig> for SshConfig {
    fn from(config: PySshConfig) -> Self {
        SshConfig {
            listen_address: config.listen_address,
            host_private_key: config.host_private_key,
            accounts: config.accounts.into_iter().map(SshAccount::from).collect(),
        }
    }
}

/// Guest listener state and public host identity; contains no credentials.
#[pyclass(name = "SshStatus")]
#[derive(Clone, Debug)]
pub(crate) struct PySshStatus {
    #[pyo3(get)]
    pub(crate) enabled: bool,
    /// Full `u64` generation, exposed as an exact Python `int`.
    #[pyo3(get)]
    pub(crate) generation: u64,
    #[pyo3(get)]
    pub(crate) listen_address: String,
    #[pyo3(get)]
    pub(crate) host_public_key: String,
    #[pyo3(get)]
    pub(crate) host_key_fingerprint: String,
}

impl From<SshStatus> for PySshStatus {
    fn from(status: SshStatus) -> Self {
        Self {
            enabled: status.enabled,
            generation: status.generation,
            listen_address: status.listen_address,
            host_public_key: status.host_public_key,
            host_key_fingerprint: status.host_key_fingerprint,
        }
    }
}

#[pymethods]
impl PySshStatus {
    fn __repr__(&self) -> String {
        format!(
            "SshStatus(enabled={}, generation={}, listen_address={:?}, host_public_key={:?}, host_key_fingerprint={:?})",
            self.enabled,
            self.generation,
            self.listen_address,
            self.host_public_key,
            self.host_key_fingerprint
        )
    }
}

/// SSH control handle; only `configure` may implicitly start the box.
#[pyclass(name = "SshHandle")]
#[derive(Clone)]
pub(crate) struct PySshHandle {
    handle: SshHandle,
}

impl PySshHandle {
    pub(crate) fn new(handle: SshHandle) -> Self {
        Self { handle }
    }
}

#[pymethods]
impl PySshHandle {
    /// Validate and replace SSH configuration, disconnecting existing
    /// clients. May start a box that uses its image's default command.
    fn configure<'py>(&self, py: Python<'py>, config: PySshConfig) -> PyResult<Bound<'py, PyAny>> {
        let handle = self.handle.clone();
        let config = SshConfig::from(config);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let status = handle.configure(config).await.map_err(map_err)?;
            Ok(PySshStatus::from(status))
        })
    }

    /// Query SSH state without starting the VM or the main command.
    fn status<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = self.handle.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let status = handle.status().await.map_err(map_err)?;
            Ok(PySshStatus::from(status))
        })
    }

    /// Stop SSH and disconnect clients. Repeatable; never starts the VM.
    fn disable<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = self.handle.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let status = handle.disable().await.map_err(map_err)?;
            Ok(PySshStatus::from(status))
        })
    }

    fn __repr__(&self) -> String {
        // The core Debug impl keeps only the box id; it holds no credentials.
        format!("{:?}", self.handle)
    }
}

#[cfg(test)]
#[path = "tests/ssh.rs"]
mod tests;
