//! Configuration for connecting to a remote BoxLite REST API server.

use std::fmt;
use std::sync::Arc;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::credential::{ApiKeyCredential, Credential};
use crate::runtime::constants::envs;

/// Configuration for connecting to a remote BoxLite REST API server.
///
/// # Examples
///
/// ```rust,no_run
/// use boxlite::BoxliteRestOptions;
///
/// // Unauthenticated (no credential)
/// let opts = BoxliteRestOptions::new("https://api.example.com");
///
/// // With an API key (long-lived bearer)
/// let opts = BoxliteRestOptions::new("https://api.example.com")
///     .with_api_key("blk_live_opaque");
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

    /// API path prefix (default: "v1").
    pub prefix: Option<String>,
}

impl BoxliteRestOptions {
    /// Create config with just a URL. Minimal — no auth.
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            credential: None,
            prefix: None,
        }
    }

    /// Create config from environment variables.
    ///
    /// Reads:
    /// - `BOXLITE_REST_URL` (required)
    /// - `BOXLITE_API_KEY` (optional)
    /// - `BOXLITE_REST_PREFIX` (optional)
    pub fn from_env() -> BoxliteResult<Self> {
        let url = std::env::var(envs::BOXLITE_REST_URL)
            .map_err(|_| BoxliteError::Config("BOXLITE_REST_URL not set".into()))?;

        let credential = std::env::var(envs::BOXLITE_API_KEY)
            .ok()
            .map(|key| Arc::new(ApiKeyCredential::new(key)) as Arc<dyn Credential>);

        let prefix = std::env::var(envs::BOXLITE_REST_PREFIX).ok();

        Ok(Self {
            url,
            credential,
            prefix,
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

    /// Builder-style: set API path prefix (default: "v1").
    pub fn with_prefix(mut self, prefix: String) -> Self {
        self.prefix = Some(prefix);
        self
    }

    /// Get the effective prefix (defaults to "v1").
    pub(crate) fn effective_prefix(&self) -> &str {
        self.prefix.as_deref().unwrap_or("v1")
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
            .field("prefix", &self.prefix)
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
        assert!(opts.prefix.is_none());
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
    fn test_with_prefix() {
        let opts = BoxliteRestOptions::new("https://api.example.com").with_prefix("v2".into());
        assert_eq!(opts.effective_prefix(), "v2");
    }

    #[test]
    fn test_effective_prefix_default() {
        let opts = BoxliteRestOptions::new("https://api.example.com");
        assert_eq!(opts.effective_prefix(), "v1");
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
