//! Node.js bindings for guest SSH control.
//!
//! Mirrors `boxlite::SshHandle`: only `configure` may start the box, and the
//! credential-bearing input types deliberately have no `Debug` impl so key
//! material cannot reach logs through this crate.

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

/// Credentials accepted for one SSH login (not a container OS identity).
#[napi(object)]
pub struct JsSshAccount {
    pub login: String,
    pub authorized_keys: Option<Vec<String>>,
    pub ca: Option<JsSshCaConfig>,
}

/// Complete guest SSH configuration; keys are never persisted by the runtime.
#[napi(object)]
pub struct JsSshConfig {
    pub listen_address: String,
    pub host_private_key: String,
    pub accounts: Vec<JsSshAccount>,
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
/// sanitized `InvalidArg` before the handle, or any request, is touched.
pub struct SshConfigArg(JsSshConfig);

impl FromNapiValue for SshConfigArg {
    unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
        unsafe { JsSshConfig::from_napi_value(env, napi_val) }
            .map(SshConfigArg)
            .map_err(|_| Error::new(Status::InvalidArg, "invalid SSH configuration"))
    }
}

/// Guest listener state and public host identity; contains no credentials.
#[napi(object)]
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
}
