use std::sync::Arc;

use boxlite::runtime::{NewRegistryCredential, RegistryCredential, RegistryHandle};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::map_err;

/// A registry login the server pulls private images with. It has no
/// password field: the server never returns one.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsRegistryCredential {
    /// UUID that `remove` takes.
    pub id: String,
    #[napi(js_name = "registryHost")]
    pub registry_host: String,
    /// Whole path segments ending in "/"; empty for the whole registry.
    #[napi(js_name = "repositoryPrefix")]
    pub repository_prefix: String,
    pub username: String,
    /// The user who added it, when the server knows.
    #[napi(js_name = "createdBy")]
    pub created_by: Option<String>,
    /// RFC 3339.
    #[napi(js_name = "createdAt")]
    pub created_at: String,
}

impl From<RegistryCredential> for JsRegistryCredential {
    fn from(credential: RegistryCredential) -> Self {
        Self {
            id: credential.id,
            registry_host: credential.registry_host,
            repository_prefix: credential.repository_prefix,
            username: credential.username,
            created_by: credential.created_by,
            created_at: credential.created_at.to_rfc3339(),
        }
    }
}

/// A registry login to add. No `Debug`: it holds the password.
#[napi(object)]
pub struct JsNewRegistryCredential {
    #[napi(js_name = "registryHost")]
    pub registry_host: String,
    /// Omit for the whole registry.
    #[napi(js_name = "repositoryPrefix")]
    pub repository_prefix: Option<String>,
    pub username: String,
    /// Password or access token.
    pub password: String,
}

impl From<JsNewRegistryCredential> for NewRegistryCredential {
    fn from(credential: JsNewRegistryCredential) -> Self {
        Self {
            registry_host: credential.registry_host,
            repository_prefix: credential.repository_prefix,
            username: credential.username,
            password: credential.password,
        }
    }
}

/// The server's registry logins. REST runtimes only.
#[napi]
pub struct JsRegistryHandle {
    pub(crate) handle: Arc<RegistryHandle>,
}

#[napi]
impl JsRegistryHandle {
    /// Every login the organization holds, oldest first.
    #[napi]
    pub async fn list(&self) -> Result<Vec<JsRegistryCredential>> {
        let handle = Arc::clone(&self.handle);
        let logins = handle.list().await.map_err(map_err)?;
        Ok(logins.into_iter().map(JsRegistryCredential::from).collect())
    }

    /// Add a login; `already_exists` while one is held for the same registry
    /// and prefix.
    #[napi]
    pub async fn create(
        &self,
        credential: JsNewRegistryCredential,
    ) -> Result<JsRegistryCredential> {
        let handle = Arc::clone(&self.handle);
        let created = handle
            .create(&NewRegistryCredential::from(credential))
            .await
            .map_err(map_err)?;
        Ok(JsRegistryCredential::from(created))
    }

    /// Remove a login by id; `invalid_state`, naming the boxes, while a box
    /// still pulls through it.
    #[napi]
    pub async fn remove(&self, id: String) -> Result<()> {
        let handle = Arc::clone(&self.handle);
        handle.remove(&id).await.map_err(map_err)
    }
}
