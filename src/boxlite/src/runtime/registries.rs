//! Registry logins handle.
//!
//! Provides [`RegistryHandle`] for the logins a server presents when it pulls
//! a private image for a box. Mirrors [`AuthHandle`](crate::AuthHandle): only a
//! REST runtime implements [`RegistryBackend`], so
//! `BoxliteRuntime::registries()` refuses a local runtime with `Unsupported`.
//! A local runtime takes its registry logins from `BoxliteOptions` instead.
//!
//! A password goes up once, inside a create, and never comes back: the type a
//! login is read back as has no field for one.

use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use boxlite_shared::errors::BoxliteError;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::BoxliteResult;

/// A registry login as the server keeps it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistryCredential {
    /// Server-assigned UUID, which [`RegistryHandle::remove`] takes.
    pub id: String,
    /// The registry the login is for, such as `ghcr.io`.
    pub registry_host: String,
    /// The repositories it covers, as whole path segments ending in `/`;
    /// empty for the whole registry.
    pub repository_prefix: String,
    /// The username the registry expects.
    pub username: String,
    /// The user who added it, when the server knows.
    pub created_by: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// A registry login to add.
///
/// `Debug` leaves the password out, so a login logged on its way to the
/// server holds none.
#[derive(Clone)]
pub struct NewRegistryCredential {
    pub registry_host: String,
    /// `None` for the whole registry.
    pub repository_prefix: Option<String>,
    pub username: String,
    /// Password or access token.
    pub password: String,
}

impl fmt::Debug for NewRegistryCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NewRegistryCredential")
            .field("registry_host", &self.registry_host)
            .field("repository_prefix", &self.repository_prefix)
            .field("username", &self.username)
            .field("password", &"[redacted]")
            .finish()
    }
}

/// Internal trait for registry logins. Only `RestRuntime` implements it.
///
/// `id` arguments have passed [`checked_id`].
#[async_trait]
pub(crate) trait RegistryBackend: Send + Sync {
    async fn list_registries(&self) -> BoxliteResult<Vec<RegistryCredential>>;

    async fn create_registry(
        &self,
        credential: &NewRegistryCredential,
    ) -> BoxliteResult<RegistryCredential>;

    async fn remove_registry(&self, id: &str) -> BoxliteResult<()>;
}

/// `id` if it is a hyphenated UUID, refused otherwise.
///
/// Refused before a request, since the id becomes a URL segment: anything
/// else could reach another route.
fn checked_id(id: &str) -> BoxliteResult<&str> {
    if id.len() == 36 && uuid::Uuid::try_parse(id).is_ok() {
        return Ok(id);
    }
    Err(BoxliteError::InvalidArgument(format!(
        "a registry login id is a UUID, got {id:?}"
    )))
}

/// Handle for the registry logins a server pulls private images with.
///
/// Obtained via [`BoxliteRuntime::registries`](crate::BoxliteRuntime::registries).
#[derive(Clone)]
pub struct RegistryHandle {
    backend: Arc<dyn RegistryBackend>,
}

impl RegistryHandle {
    /// Internal constructor used by `BoxliteRuntime`.
    pub(crate) fn new(backend: Arc<dyn RegistryBackend>) -> Self {
        Self { backend }
    }

    /// Every login the caller's organization holds, oldest first.
    pub async fn list(&self) -> BoxliteResult<Vec<RegistryCredential>> {
        self.backend.list_registries().await
    }

    /// Add a login. Fails with `AlreadyExists` while one is held for the same
    /// registry and prefix.
    pub async fn create(
        &self,
        credential: &NewRegistryCredential,
    ) -> BoxliteResult<RegistryCredential> {
        self.backend.create_registry(credential).await
    }

    /// Remove a login by id. Fails with `InvalidState`, naming the boxes,
    /// while a box still pulls through it, and with `NotFound` when no login
    /// has the id.
    pub async fn remove(&self, id: &str) -> BoxliteResult<()> {
        self.backend.remove_registry(checked_id(id)?).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_login_prints_without_its_password() {
        let login = NewRegistryCredential {
            registry_host: "ghcr.io".into(),
            repository_prefix: Some("acme/".into()),
            username: "acme-bot".into(),
            password: "ghp_not-a-real-token".into(),
        };

        let printed = format!("{login:?}");

        assert!(!printed.contains("ghp_not-a-real-token"), "{printed}");
        assert!(printed.contains("acme-bot"), "{printed}");
    }

    #[test]
    fn checked_id_takes_a_hyphenated_uuid_only() {
        let id = "0aaa0000-0000-4000-8000-000000000001";
        assert_eq!(checked_id(id).unwrap(), id);
        for not_an_id in [
            "",
            "x",
            "../images",
            "0aaa0000-0000-4000-8000-00000000000g",
            "0aaa0000000040008000000000000001",
            "{0aaa0000-0000-4000-8000-000000000001}",
        ] {
            let error = checked_id(not_an_id).unwrap_err();
            assert!(
                matches!(error, BoxliteError::InvalidArgument(_)),
                "{not_an_id:?}: {error}"
            );
        }
    }
}
