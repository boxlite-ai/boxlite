//! Node.js bindings for guest SSH control.
//!
//! Mirrors `boxlite::SshHandle`: only `configure` may start the box. The
//! credential-bearing input types implement `Debug` with every credential
//! field redacted, so key material cannot reach logs through this crate.

use std::fmt;

use boxlite::{LiteBox, SshAccount, SshCaConfig, SshConfig, SshHandle, SshStatus};
use napi::{bindgen_prelude::sys, bindgen_prelude::*};
use napi_derive::napi;

use crate::util::map_err;

/// Certificate authority and required certificate principal for one login.
#[napi(object)]
pub struct JsSshCaConfig {
    pub public_key: String,
    pub principal: String,
}

impl fmt::Debug for JsSshCaConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JsSshCaConfig")
            .field("public_key", &"[redacted]")
            .field("principal", &"[redacted]")
            .finish()
    }
}

/// Credentials accepted for one SSH login (not a container OS identity).
#[napi(object)]
pub struct JsSshAccount {
    pub login: String,
    pub authorized_keys: Option<Vec<String>>,
    pub ca: Option<JsSshCaConfig>,
}

impl fmt::Debug for JsSshAccount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JsSshAccount")
            .field("login", &self.login)
            .field("authorized_keys", &"[redacted]")
            .field("ca", &"[redacted]")
            .finish()
    }
}
/// Complete guest SSH configuration; keys are never persisted by the runtime.
#[napi(object)]
pub struct JsSshConfig {
    pub listen_address: String,
    pub host_private_key: String,
    pub accounts: Vec<JsSshAccount>,
}

impl fmt::Debug for JsSshConfig {
    // Accounts render through `JsSshAccount`'s redacted `Debug`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JsSshConfig")
            .field("listen_address", &self.listen_address)
            .field("host_private_key", &"[redacted]")
            .field("accounts", &self.accounts)
            .finish()
    }
}
impl From<JsSshCaConfig> for SshCaConfig {
    fn from(ca: JsSshCaConfig) -> Self {
        Self {
            public_key: ca.public_key,
            principal: ca.principal,
        }
    }
}

impl From<JsSshAccount> for SshAccount {
    fn from(account: JsSshAccount) -> Self {
        Self {
            login: account.login,
            authorized_keys: account.authorized_keys.unwrap_or_default(),
            ca: account.ca.map(Into::into),
        }
    }
}

impl From<JsSshConfig> for SshConfig {
    fn from(config: JsSshConfig) -> Self {
        Self {
            listen_address: config.listen_address,
            host_private_key: config.host_private_key,
            accounts: config.accounts.into_iter().map(Into::into).collect(),
        }
    }
}

/// `configure`'s argument: the generated `JsSshConfig` conversion with every
/// failure replaced by one fixed message.
///
/// napi's conversion errors quote the rejected JavaScript value — for this
/// credential-bearing type that would echo key material into the thrown
/// error — so any conversion failure, top-level or nested, becomes a single
/// sanitized `InvalidArg` before the handle, or any SSH request, is touched.
pub struct SshConfigArg(JsSshConfig);

/// Same redaction as the wrapped configuration; the wrapper adds no fields.
impl fmt::Debug for SshConfigArg {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl FromNapiValue for SshConfigArg {
    /// Convert the `configure` argument into the wrapper.
    ///
    /// # Safety
    ///
    /// The napi-rs `FromNapiValue` contract; the error mapping below does
    /// not waive any part of it:
    ///
    /// - `env` must be a valid `napi_env` pointer.
    /// - `napi_val` must be a valid JavaScript value pointer in `env`.
    /// - The value's type must be accepted by `ValidateNapiValue::validate`.
    unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
        // SAFETY: the caller upholds the contract above for both handles;
        // the generated conversion only reads from them.
        unsafe { JsSshConfig::from_napi_value(env, napi_val) }
            .map(SshConfigArg)
            .map_err(|_| Error::new(Status::InvalidArg, "invalid SSH configuration"))
    }
}

/// Guest listener state and public host identity; contains no credentials.
#[napi(object)]
#[derive(Debug)]
pub struct JsSshStatus {
    pub enabled: bool,
    /// Increments on each successful listener start; `bigint` keeps all
    /// 64 bits of the core `u64` exactly.
    pub generation: BigInt,
    pub listen_address: String,
    pub host_public_key: String,
    pub host_key_fingerprint: String,
}

impl From<SshStatus> for JsSshStatus {
    fn from(status: SshStatus) -> Self {
        Self {
            enabled: status.enabled,
            generation: BigInt::from(status.generation),
            listen_address: status.listen_address,
            host_public_key: status.host_public_key,
            host_key_fingerprint: status.host_key_fingerprint,
        }
    }
}

/// Handle for guest SSH control on a Box.
///
/// Accessed as a property: `box.ssh.configure(...)`. Creating it and calling
/// `status`/`disable` never start the VM; only `configure` may, and the core
/// owns that startup policy.
#[napi]
pub struct JsSshHandle {
    pub(crate) handle: SshHandle,
}

impl fmt::Debug for JsSshHandle {
    /// Non-exhaustive: the core handle and its backend are not printable.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JsSshHandle").finish_non_exhaustive()
    }
}

#[napi]
impl JsSshHandle {
    /// Validate and replace the SSH configuration, disconnecting clients.
    /// A configuration the binding cannot convert is refused with one fixed
    /// message, before the handle runs.
    #[napi(ts_args_type = "config: JsSshConfig")]
    pub async fn configure(&self, config: SshConfigArg) -> Result<JsSshStatus> {
        self.handle
            .configure(config.0.into())
            .await
            .map_err(map_err)
            .map(JsSshStatus::from)
    }

    /// Query SSH state without starting the VM or its main command.
    #[napi]
    pub async fn status(&self) -> Result<JsSshStatus> {
        self.handle
            .status()
            .await
            .map_err(map_err)
            .map(JsSshStatus::from)
    }

    /// Stop SSH and disconnect clients; repeated calls are supported.
    #[napi]
    pub async fn disable(&self) -> Result<JsSshStatus> {
        self.handle
            .disable()
            .await
            .map_err(map_err)
            .map(JsSshStatus::from)
    }
}

impl From<&LiteBox> for JsSshHandle {
    fn from(box_handle: &LiteBox) -> Self {
        Self {
            handle: box_handle.ssh(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_converts_camel_case_fields_and_defaults() {
        let config: SshConfig = JsSshConfig {
            listen_address: "0.0.0.0:2222".into(),
            host_private_key: "host key".into(),
            accounts: vec![JsSshAccount {
                login: "alice".into(),
                authorized_keys: None,
                ca: Some(JsSshCaConfig {
                    public_key: "ca key".into(),
                    principal: "alice-principal".into(),
                }),
            }],
        }
        .into();

        assert_eq!(config.listen_address, "0.0.0.0:2222");
        assert_eq!(config.host_private_key, "host key");
        assert_eq!(config.accounts.len(), 1);
        assert_eq!(config.accounts[0].login, "alice");
        assert!(config.accounts[0].authorized_keys.is_empty());
        let ca = config.accounts[0].ca.as_ref().unwrap();
        assert_eq!(ca.public_key, "ca key");
        assert_eq!(ca.principal, "alice-principal");
    }

    #[test]
    fn status_generation_keeps_full_u64_precision() {
        let status = JsSshStatus::from(SshStatus {
            enabled: true,
            generation: u64::MAX,
            listen_address: "0.0.0.0:2222".into(),
            host_public_key: "pub".into(),
            host_key_fingerprint: "fp".into(),
        });

        assert!(status.enabled);
        let (negative, value, lossless) = status.generation.get_u64();
        assert!(!negative);
        assert!(lossless);
        assert_eq!(value, u64::MAX);
    }

    #[test]
    fn debug_output_redacts_every_credential_field() {
        let ca = JsSshCaConfig {
            public_key: "ca-key-sentinel".into(),
            principal: "principal-sentinel".into(),
        };
        let ca_debug = format!("{ca:?}");
        let account = JsSshAccount {
            login: "alice".into(),
            authorized_keys: Some(vec!["authorized-key-sentinel".into()]),
            ca: Some(ca),
        };
        let account_debug = format!("{account:?}");
        let config = JsSshConfig {
            listen_address: "0.0.0.0:2222".into(),
            host_private_key: "host-key-sentinel".into(),
            accounts: vec![account],
        };
        let config_debug = format!("{config:?}");
        let arg_debug = format!("{:?}", SshConfigArg(config));

        for output in [ca_debug, account_debug, config_debug, arg_debug] {
            for sentinel in [
                "ca-key-sentinel",
                "principal-sentinel",
                "authorized-key-sentinel",
                "host-key-sentinel",
            ] {
                assert!(
                    !output.contains(sentinel),
                    "credential leaked in Debug output"
                );
            }
            assert!(output.contains("[redacted]"), "missing redaction marker");
        }
    }
}
