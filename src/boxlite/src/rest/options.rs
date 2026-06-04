//! Configuration for connecting to a remote BoxLite REST API server.

use std::fmt;
use std::sync::Arc;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::credential::{ApiKeyCredential, Credential};
use crate::runtime::constants::envs;

/// Configuration for connecting to a remote BoxLite REST API server.
///
/// # URL composition
///
/// The `v1` segment is hardcoded. Box-scoped requests resolve to
/// `{url}/v1/{prefix}/{path}` when `path_prefix` is set and
/// non-empty (e.g. `https://api.example.com/v1/acme/boxes`), and to
/// `{url}/v1/{path}` when `path_prefix` is `None` or empty
/// (`https://api.example.com/v1/boxes`). The empty-prefix shape is the
/// canonical single-tenant deployment shape — used by `boxlite serve`
/// and any other single-scope REST deployment.
///
/// The `path_prefix` field is **opaque** — the client substitutes
/// whatever the server told it to use via `Principal.path_prefix`
/// (see `GET /v1/me`) verbatim into the URL. Internal `/`
/// characters are preserved, enabling multi-segment routing values
/// such as `us-east/team-42`.
///
/// Identity endpoints (`/v1/me`, `/v1/config`) live under
/// `{url}/v1/{path}` — no prefix segment, by spec.
///
/// # Examples
///
/// ```rust,no_run
/// use boxlite::BoxliteRestOptions;
///
/// // Unauthenticated, empty path_prefix (boxlite serve / single-tenant)
/// let opts = BoxliteRestOptions::new("https://api.example.com");
///
/// // With an API key (long-lived bearer)
/// let opts = BoxliteRestOptions::new("https://api.example.com")
///     .with_api_key("blk_live_opaque");
///
/// // With an explicit routing prefix (multi-tenant control plane —
/// // the value comes from Principal.path_prefix at login time)
/// let opts = BoxliteRestOptions::new("https://api.example.com")
///     .with_api_key("blk_live_opaque")
///     .with_path_prefix("acme");
///
/// // From environment variables
/// let opts = BoxliteRestOptions::from_env().unwrap();
/// ```
#[derive(Clone)]
pub struct BoxliteRestOptions {
    /// REST API base URL (e.g., "https://api.example.com").
    pub url: String,

    /// Bearer credential. `None` = unauthenticated.
    pub credential: Option<Arc<dyn Credential>>,

    /// Routing-slot value substituted into the `{prefix}` URL segment.
    /// `None` or empty → URL skips the segment entirely (single-tenant /
    /// empty-prefix deployment shape).
    pub path_prefix: Option<String>,
}

impl BoxliteRestOptions {
    /// Create config with just a URL. Minimal — no auth, no path_prefix.
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            credential: None,
            path_prefix: None,
        }
    }

    /// Create config from environment variables.
    ///
    /// Reads:
    /// - `BOXLITE_REST_URL` (required)
    /// - `BOXLITE_API_KEY` (optional)
    /// - `BOXLITE_REST_PATH_PREFIX` (optional)
    pub fn from_env() -> BoxliteResult<Self> {
        let url = std::env::var(envs::BOXLITE_REST_URL)
            .map_err(|_| BoxliteError::Config("BOXLITE_REST_URL not set".into()))?;

        let credential = std::env::var(envs::BOXLITE_API_KEY)
            .ok()
            .map(|key| Arc::new(ApiKeyCredential::new(key)) as Arc<dyn Credential>);

        let path_prefix = std::env::var(envs::BOXLITE_REST_PATH_PREFIX).ok();

        Ok(Self {
            url,
            credential,
            path_prefix,
        })
    }

    /// Builder-style: set an opaque API key. Convenience wrapper that
    /// constructs an [`ApiKeyCredential`] internally.
    pub fn with_api_key(mut self, key: impl Into<String>) -> Self {
        self.credential = Some(Arc::new(ApiKeyCredential::new(key)));
        self
    }

    /// Builder-style: set any [`Credential`] implementation.
    pub fn with_credential(mut self, credential: Arc<dyn Credential>) -> Self {
        self.credential = Some(credential);
        self
    }

    /// Builder-style: set the routing-slot path_prefix.
    pub fn with_path_prefix(mut self, path_prefix: impl Into<String>) -> Self {
        self.path_prefix = Some(path_prefix.into());
        self
    }
}

impl fmt::Debug for BoxliteRestOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The inner `dyn Credential` Debug impl is responsible for
        // redacting its own secret material (verified in credential.rs
        // tests). `Option<Arc<dyn Credential>>` Debug delegates to it.
        f.debug_struct("BoxliteRestOptions")
            .field("url", &self.url)
            .field("credential", &self.credential)
            .field("path_prefix", &self.path_prefix)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_new_minimal() {
        let opts = BoxliteRestOptions::new("https://api.example.com");
        assert_eq!(opts.url, "https://api.example.com");
        assert!(opts.credential.is_none());
        assert!(opts.path_prefix.is_none());
    }

    #[tokio::test]
    async fn test_with_api_key() {
        let opts = BoxliteRestOptions::new("https://api.example.com").with_api_key("blk_live_x");
        let cred = opts.credential.expect("credential set");
        let tok = cred.get_token().await.expect("get_token");
        assert_eq!(tok.token, "blk_live_x");
        assert!(tok.expires_at.is_none());
    }

    #[test]
    fn test_with_path_prefix() {
        let opts = BoxliteRestOptions::new("https://api.example.com").with_path_prefix("acme");
        assert_eq!(opts.path_prefix.as_deref(), Some("acme"));
    }

    #[test]
    fn test_path_prefix_unset_is_none() {
        let opts = BoxliteRestOptions::new("https://api.example.com");
        assert!(opts.path_prefix.is_none());
    }

    #[test]
    fn test_debug_redacts_api_key() {
        let opts =
            BoxliteRestOptions::new("https://api.example.com").with_api_key("opaque-key-1234");
        let dbg = format!("{:?}", opts);
        assert!(
            !dbg.contains("opaque-key-1234"),
            "Debug output leaked api_key"
        );
        assert!(dbg.contains("REDACTED"));
    }
}
