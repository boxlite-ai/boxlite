//! OpenID Connect support for `boxlite auth login`.
//!
//! Houses the three flows that talk to a Dex / Auth0-style IdP:
//!
//! - [`discovery`] — resolve issuer / client_id / audience and pull the OIDC
//!   well-known document so the auth-code and device-code flows know which
//!   endpoints to hit.
//! - [`auth_code`] — browser-based Authorization Code with PKCE; spins up a
//!   local axum listener for the redirect callback.
//! - [`device_code`] — RFC 8628 device-authorization grant for headless /
//!   SSH sessions; relies on the polling helpers in `openidconnect` so we
//!   don't reimplement the back-off rules.
//! - [`refresh`] — proactive refresh-token exchange called from
//!   `credentials::load_active` before any authenticated request.
//!
//! The credentials file is the authoritative source of truth for OIDC
//! sessions; nothing in this module persists state on its own. Each flow
//! returns an [`OidcTokens`] value that the caller folds back into a
//! [`crate::credentials::Profile`].

use chrono::{DateTime, Utc};
use secrecy::SecretString;

pub mod auth_code;
pub mod device_code;
pub mod discovery;
pub mod refresh;

/// Resolved OIDC parameters needed to start any of the three flows.
///
/// Built by [`discovery::resolve`]; the fields after `issuer` are the
/// configurable surface a user can override with `--issuer`/`--client-id`/
/// `--audience` or with environment variables.
#[derive(Debug, Clone)]
pub struct OidcConfig {
    pub issuer: openidconnect::IssuerUrl,
    pub client_id: openidconnect::ClientId,
    /// Resource indicator (`aud`). Auth0 requires it; Dex tolerates `None`.
    pub audience: Option<String>,
    /// OAuth scopes to request. Always includes `openid`; `offline_access`
    /// is what makes refresh tokens come back, so we ask for it by default.
    pub scopes: Vec<String>,
}

impl OidcConfig {
    /// Default *additional* scopes — `openid` is **not** listed here because
    /// the `openidconnect` crate prepends it unconditionally (it is required
    /// for any OIDC request). Listing it explicitly produced
    /// `scope=openid openid profile email offline_access` in the
    /// authorization URL, which Auth0 dedupes but which looked broken.
    ///
    /// Scope set matches what `apps/cli/cmd/auth/login.go:166-169` requests
    /// (minus the duplicate `openid`) so an existing Dex / Auth0 client
    /// allow-list does not need to change.
    pub fn default_scopes() -> Vec<String> {
        vec![
            "profile".to_string(),
            "email".to_string(),
            "offline_access".to_string(),
        ]
    }
}

/// Optional overrides the user supplies on the CLI. `None` means "take
/// whatever the server / env tells us"; `Some(...)` wins over every other
/// source. Kept as a separate struct so each flow's arg parsing has a
/// single typed value to plumb through.
#[derive(Debug, Default, Clone)]
pub struct DiscoveryOverrides {
    pub issuer: Option<String>,
    pub client_id: Option<String>,
    pub audience: Option<String>,
}

/// Tokens returned by any OIDC flow. The caller decides how to fold these
/// into a `Profile` (auth-code and device-code both produce all three; a
/// refresh response only updates `access_token` and `expires_at`).
#[derive(Debug, Clone)]
pub struct OidcTokens {
    pub access_token: SecretString,
    pub refresh_token: Option<SecretString>,
    pub id_token: Option<SecretString>,
    pub expires_at: DateTime<Utc>,
}
