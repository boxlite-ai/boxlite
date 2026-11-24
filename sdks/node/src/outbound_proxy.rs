//! Node.js access to the guarded Cloud proxy registry.

use boxlite::{OutboundProxyHandle, ProxyCredential, ProxyCredentialChange};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::map_err;

pub(crate) fn public_value(value: impl serde::Serialize) -> Result<serde_json::Value> {
    serde_json::to_value(value).map_err(|_| Error::from_reason("invalid public proxy response"))
}

#[napi(object)]
pub struct JsProxyCredentialInput {
    pub username: String,
    pub password: String,
}

impl std::fmt::Debug for JsProxyCredentialInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ProxyCredential([redacted])")
    }
}

impl TryFrom<JsProxyCredentialInput> for ProxyCredential {
    type Error = boxlite::BoxliteError;

    fn try_from(value: JsProxyCredentialInput) -> std::result::Result<Self, Self::Error> {
        Self::new(value.username, value.password)
    }
}

#[napi(object)]
pub struct JsProxyUpdate {
    pub url: Option<String>,
    pub credential: Option<JsProxyCredentialInput>,
    pub clear_credential: Option<bool>,
}

#[napi]
pub struct JsOutboundProxyHandle {
    pub(crate) handle: OutboundProxyHandle,
}

#[napi]
impl JsOutboundProxyHandle {
    #[napi]
    pub async fn list(&self) -> Result<serde_json::Value> {
        public_value(self.handle.list().await.map_err(map_err)?)
    }

    #[napi]
    pub async fn get(&self, name: String) -> Result<serde_json::Value> {
        public_value(self.handle.get(&name).await.map_err(map_err)?)
    }

    #[napi]
    pub async fn create(
        &self,
        name: String,
        url: String,
        credential: Option<JsProxyCredentialInput>,
    ) -> Result<serde_json::Value> {
        let credential = credential
            .map(ProxyCredential::try_from)
            .transpose()
            .map_err(map_err)?;
        public_value(
            self.handle
                .create(&name, &url, credential.as_ref())
                .await
                .map_err(map_err)?,
        )
    }

    #[napi]
    pub async fn update(&self, name: String, options: JsProxyUpdate) -> Result<serde_json::Value> {
        let change = match (
            options.credential,
            options.clear_credential.unwrap_or(false),
        ) {
            (Some(_), true) => {
                return Err(map_err(boxlite::BoxliteError::InvalidArgument(
                    "choose either to clear or replace the proxy credential".into(),
                )));
            }
            (Some(credential), false) => {
                ProxyCredentialChange::Set(ProxyCredential::try_from(credential).map_err(map_err)?)
            }
            (None, true) => ProxyCredentialChange::Clear,
            (None, false) => ProxyCredentialChange::Keep,
        };
        public_value(
            self.handle
                .update(&name, options.url.as_deref(), change)
                .await
                .map_err(map_err)?,
        )
    }

    #[napi]
    pub async fn remove(&self, name: String) -> Result<serde_json::Value> {
        public_value(self.handle.remove(&name).await.map_err(map_err)?)
    }
}
