use crate::util::map_err;
use napi::bindgen_prelude::*;
use napi_derive::napi;
#[napi(object)]
pub struct JsSshCaConfig {
    pub public_key: String,
    pub principal: String,
}
impl From<JsSshCaConfig> for boxlite::SshCaConfig {
    fn from(value: JsSshCaConfig) -> Self {
        Self {
            public_key: value.public_key,
            principal: value.principal,
        }
    }
}
#[napi(object)]
pub struct JsSshAccount {
    pub login: String,
    pub authorized_keys: Vec<String>,
    pub ca: Option<JsSshCaConfig>,
}
impl From<JsSshAccount> for boxlite::SshAccount {
    fn from(value: JsSshAccount) -> Self {
        Self {
            login: value.login,
            authorized_keys: value.authorized_keys,
            ca: value.ca.map(Into::into),
        }
    }
}
#[napi(object)]
pub struct JsSshConfig {
    pub listen_address: String,
    pub host_private_key: String,
    pub accounts: Vec<JsSshAccount>,
}
impl From<JsSshConfig> for boxlite::SshConfig {
    fn from(value: JsSshConfig) -> Self {
        Self {
            listen_address: value.listen_address,
            host_private_key: value.host_private_key,
            accounts: value.accounts.into_iter().map(Into::into).collect(),
        }
    }
}
#[napi(object)]
pub struct JsSshStatus {
    pub enabled: bool,
    pub generation: BigInt,
    pub listen_address: String,
    pub host_public_key: String,
    pub host_key_fingerprint: String,
}
impl From<boxlite::SshStatus> for JsSshStatus {
    fn from(value: boxlite::SshStatus) -> Self {
        Self {
            enabled: value.enabled,
            generation: value.generation.into(),
            listen_address: value.listen_address,
            host_public_key: value.host_public_key,
            host_key_fingerprint: value.host_key_fingerprint,
        }
    }
}
#[napi]
pub struct JsSshHandle {
    pub(crate) handle: boxlite::SshHandle,
}
#[napi]
impl JsSshHandle {
    #[napi]
    pub async fn configure(&self, config: JsSshConfig) -> Result<JsSshStatus> {
        self.handle
            .configure(config.into())
            .await
            .map(Into::into)
            .map_err(map_err)
    }
    #[napi]
    pub async fn status(&self) -> Result<JsSshStatus> {
        self.handle.status().await.map(Into::into).map_err(map_err)
    }
    #[napi]
    pub async fn disable(&self) -> Result<JsSshStatus> {
        self.handle.disable().await.map(Into::into).map_err(map_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ssh_status_generation_is_lossless_bigint() {
        let status = JsSshStatus::from(boxlite::SshStatus {
            enabled: true,
            generation: u64::MAX,
            listen_address: "addr".into(),
            host_public_key: "key".into(),
            host_key_fingerprint: "fp".into(),
        });
        assert_eq!(status.generation.get_u64(), (false, u64::MAX, true));
    }
    #[test]
    fn ssh_config_preserves_nested_ca() {
        let config: boxlite::SshConfig = JsSshConfig {
            listen_address: "addr".into(),
            host_private_key: "private".into(),
            accounts: vec![JsSshAccount {
                login: "alice".into(),
                authorized_keys: vec!["key".into()],
                ca: Some(JsSshCaConfig {
                    public_key: "ca".into(),
                    principal: "principal".into(),
                }),
            }],
        }
        .into();
        assert_eq!(
            config.accounts[0].ca.as_ref().unwrap().principal,
            "principal"
        );
        assert_eq!(config.host_private_key, "private");
    }
}
