//! Identity capability — backend-agnostic.
//!
//! Provides [`AuthHandle`] for credential-identity operations and the
//! [`Principal`] DTO. Mirrors the `images` module (`ImageBackend` /
//! `ImageHandle`): the trait is `pub(crate)` and a handle is returned from a
//! `BoxliteRuntime` accessor. Backends without a meaningful notion of remote
//! identity (e.g., local runtime) simply do not implement [`AuthBackend`];
//! `BoxliteRuntime::auth()` then returns [`BoxliteError::Unsupported`].

use async_trait::async_trait;
use std::sync::Arc;

use serde::Deserialize;

use crate::BoxliteResult;

/// Identity + scopes returned by the server (e.g., `GET /v1/me` for REST).
///
/// Public: surfaced through [`crate::AuthHandle::whoami`] so callers can
/// confirm *who* a credential authenticates as. Field names are snake_case
/// per the Box API spec.
#[derive(Debug, Deserialize, Clone)]
pub struct Principal {
    /// Stable opaque principal id — treat as opaque.
    pub sub: String,
    /// `user` for interactive keys; `service_account` for automation.
    pub principal_type: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    /// Routing-slot value the client substitutes into the
    /// `{prefix}` URL segment on box-scoped requests.
    ///
    /// Opaque per the OpenAPI contract — the server decides what
    /// goes here (organization id, workspace name, catalog, region+
    /// team pair, …). `None` when the deployment does not use a
    /// routing slot (e.g. `boxlite serve`) or when the credential
    /// has no scope assigned yet; clients then build URLs without
    /// the segment.
    ///
    /// Per the spec the field is `nullable: true` and the response
    /// envelope always carries the key; serde tolerates both an
    /// absent key and explicit `null` via `#[serde(default)]`.
    #[serde(default)]
    pub path_prefix: Option<String>,
    pub scopes: Vec<String>,
    /// Optional expiry; `None`/absent for long-lived dashboard keys.
    #[serde(default)]
    pub expires_at: Option<String>,
}

/// Internal trait for identity (`whoami`) operations.
///
/// Implemented by backends with a meaningful notion of remote identity.
/// Currently only `RestRuntime` implements this; local runtimes do not.
#[async_trait]
pub(crate) trait AuthBackend: Send + Sync {
    /// Confirm the active credential and return its identity.
    ///
    /// REST mapping: 404 ⇒ `BoxliteError::NotFound`;
    /// 401/403 ⇒ `BoxliteError::Config("auth: …")`.
    async fn whoami(&self) -> BoxliteResult<Principal>;
}

/// Handle for performing identity operations.
///
/// Obtained via [`BoxliteRuntime::auth`](crate::BoxliteRuntime::auth) —
/// mirrors [`ImageHandle`](crate::ImageHandle) for image operations. Holds an
/// `Arc` view of the runtime's existing backend, so no additional client is
/// constructed.
#[derive(Clone)]
pub struct AuthHandle {
    backend: Arc<dyn AuthBackend>,
}

impl AuthHandle {
    /// Create a new `AuthHandle` with the given backend.
    ///
    /// Internal constructor used by `BoxliteRuntime`.
    pub(crate) fn new(backend: Arc<dyn AuthBackend>) -> Self {
        Self { backend }
    }

    /// Confirm the active credential and fetch its identity.
    pub async fn whoami(&self) -> BoxliteResult<Principal> {
        self.backend.whoami().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_principal_deserialization() {
        // Required fields only; optional email/display_name/expires_at absent.
        let json = r#"{
            "sub": "usr_01ABC",
            "principal_type": "user",
            "path_prefix": "acme",
            "scopes": ["box:read", "box:write"]
        }"#;
        let p: Principal = serde_json::from_str(json).unwrap();
        assert_eq!(p.sub, "usr_01ABC");
        assert_eq!(p.principal_type, "user");
        assert_eq!(p.path_prefix.as_deref(), Some("acme"));
        assert_eq!(p.scopes, vec!["box:read", "box:write"]);
        assert_eq!(p.email, None);
        assert_eq!(p.display_name, None);
        assert_eq!(p.expires_at, None);

        let full = r#"{
            "sub": "svc_1",
            "principal_type": "service_account",
            "email": "ci@acme.test",
            "display_name": "CI",
            "path_prefix": "acme",
            "scopes": [],
            "expires_at": "2027-01-01T00:00:00Z"
        }"#;
        let p: Principal = serde_json::from_str(full).unwrap();
        assert_eq!(p.email.as_deref(), Some("ci@acme.test"));
        assert_eq!(p.display_name.as_deref(), Some("CI"));
        assert_eq!(p.expires_at.as_deref(), Some("2027-01-01T00:00:00Z"));
    }

    /// `path_prefix` is `nullable: true` in the OpenAPI contract.
    /// The client must accept both shapes the contract permits:
    /// the field present with an explicit `null`, and the field
    /// absent entirely. Both deserialize to `None`.
    #[test]
    fn principal_accepts_null_or_absent_path_prefix() {
        let explicit_null = r#"{
            "sub": "google-oauth2|123",
            "principal_type": "user",
            "path_prefix": null,
            "scopes": []
        }"#;
        let p: Principal = serde_json::from_str(explicit_null).unwrap();
        assert!(p.path_prefix.is_none(), "explicit null should yield None");

        let omitted = r#"{
            "sub": "google-oauth2|123",
            "principal_type": "user",
            "scopes": []
        }"#;
        let p: Principal = serde_json::from_str(omitted).unwrap();
        assert!(p.path_prefix.is_none(), "omitted field should yield None");
    }
}
