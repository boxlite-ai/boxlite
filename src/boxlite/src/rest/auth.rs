//! Identity for a REST runtime.
//!
//! Identity (`GET /v1/me`) is an auth concern, deliberately **not** a
//! `RuntimeBackend` box operation and **not** a method on the inert
//! [`BoxliteRestOptions`](super::options::BoxliteRestOptions) config struct.
//! It is reached the same way image operations are — a capability handle
//! returned by an accessor on `BoxliteRuntime` (`runtime.auth()?.whoami()`),
//! mirroring `runtime.images()?.pull()`. The handle wraps the *same*
//! [`RestRuntime`](super::runtime::RestRuntime)/`ApiClient` as box ops (an
//! `Arc` view, not a second client).

use std::sync::Arc;

use boxlite_shared::errors::BoxliteResult;

use super::types::Principal;

/// Identity capability of a backend. `pub(crate)` — internal abstraction,
/// surfaced publicly only via [`AuthHandle`]. Mirrors `ImageBackend`.
#[async_trait::async_trait]
pub(crate) trait AuthBackend: Send + Sync {
    /// Identity + scopes of the calling credential (`GET /v1/me`).
    ///
    /// `BoxliteError::NotFound` (404) ⇒ server without `/v1/me`;
    /// `BoxliteError::Config("auth: …")` (401/403) ⇒ rejected credential.
    async fn whoami(&self) -> BoxliteResult<Principal>;
}

/// Identity operations for a REST runtime.
///
/// Obtained via [`BoxliteRuntime::auth`](crate::BoxliteRuntime::auth) — the
/// mirror of [`ImageHandle`](crate::ImageHandle). Holds an `Arc` view of the
/// runtime's existing REST backend, so no additional client is constructed.
pub struct AuthHandle {
    backend: Arc<dyn AuthBackend>,
}

impl AuthHandle {
    pub(crate) fn new(backend: Arc<dyn AuthBackend>) -> Self {
        Self { backend }
    }

    /// Confirm the active credential and fetch its identity (`GET /v1/me`).
    pub async fn whoami(&self) -> BoxliteResult<Principal> {
        self.backend.whoami().await
    }
}
