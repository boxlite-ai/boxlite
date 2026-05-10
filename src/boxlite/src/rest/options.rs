//! Configuration for connecting to a remote BoxLite REST API server.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::runtime::constants::envs;

/// Configuration for connecting to a remote BoxLite REST API server.
///
/// Separate from `BoxliteOptions` — local and remote configs are
/// fundamentally different data and should never share a struct.
///
/// # Examples
///
/// ```rust,no_run
/// use boxlite::BoxliteRestOptions;
///
/// // Minimal — just a URL
/// let opts = BoxliteRestOptions::new("https://api.example.com");
///
/// // With OAuth2 credentials
/// let opts = BoxliteRestOptions::new("https://api.example.com")
///     .with_credentials("client-id".into(), "secret".into());
///
/// // From environment variables
/// let opts = BoxliteRestOptions::from_env().unwrap();
/// ```
#[derive(Clone, Debug)]
pub struct BoxliteRestOptions {
    /// REST API base URL (e.g., "https://api.example.com").
    pub url: String,

    /// OAuth2 client ID (optional).
    pub client_id: Option<String>,

    /// OAuth2 client secret (optional).
    pub client_secret: Option<String>,

    /// API path prefix (default: "v1").
    pub prefix: Option<String>,
}

impl BoxliteRestOptions {
    /// Create config with just a URL. Minimal — no auth.
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            client_id: None,
            client_secret: None,
            prefix: None,
        }
    }

    /// Create config from environment variables.
    ///
    /// Reads:
    /// - `BOXLITE_REST_URL` (required)
    /// - `BOXLITE_REST_CLIENT_ID` (optional)
    /// - `BOXLITE_REST_CLIENT_SECRET` (optional)
    /// - `BOXLITE_REST_PREFIX` (optional)
    pub fn from_env() -> BoxliteResult<Self> {
        let url = std::env::var(envs::BOXLITE_REST_URL)
            .map_err(|_| BoxliteError::Config("BOXLITE_REST_URL not set".into()))?;
        Ok(Self {
            url,
            client_id: std::env::var(envs::BOXLITE_REST_CLIENT_ID).ok(),
            client_secret: std::env::var(envs::BOXLITE_REST_CLIENT_SECRET).ok(),
            prefix: std::env::var(envs::BOXLITE_REST_PREFIX).ok(),
        })
    }

    /// Builder-style: add OAuth2 credentials.
    pub fn with_credentials(mut self, client_id: String, client_secret: String) -> Self {
        self.client_id = Some(client_id);
        self.client_secret = Some(client_secret);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_minimal() {
        let opts = BoxliteRestOptions::new("https://api.example.com");
        assert_eq!(opts.url, "https://api.example.com");
        assert!(opts.client_id.is_none());
        assert!(opts.client_secret.is_none());
        assert!(opts.prefix.is_none());
    }

    #[test]
    fn test_with_credentials() {
        let opts = BoxliteRestOptions::new("https://api.example.com")
            .with_credentials("id".into(), "secret".into());
        assert_eq!(opts.client_id.as_deref(), Some("id"));
        assert_eq!(opts.client_secret.as_deref(), Some("secret"));
    }

    #[test]
    fn test_with_prefix() {
        let opts = BoxliteRestOptions::new("https://api.example.com").with_prefix("v2".into());
        assert_eq!(opts.prefix.as_deref(), Some("v2"));
        assert_eq!(opts.effective_prefix(), "v2");
    }

    #[test]
    fn test_effective_prefix_default() {
        let opts = BoxliteRestOptions::new("https://api.example.com");
        assert_eq!(opts.effective_prefix(), "v1");
    }

    #[test]
    fn test_builder_chaining() {
        let opts = BoxliteRestOptions::new("https://api.example.com")
            .with_credentials("cid".into(), "csec".into())
            .with_prefix("v3".into());
        assert_eq!(opts.url, "https://api.example.com");
        assert_eq!(opts.client_id.as_deref(), Some("cid"));
        assert_eq!(opts.client_secret.as_deref(), Some("csec"));
        assert_eq!(opts.effective_prefix(), "v3");
    }
}
