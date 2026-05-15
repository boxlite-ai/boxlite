//! Configuration for connecting to a remote BoxLite REST API server.

use std::fmt;

use serde::{Deserialize, Serialize};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::runtime::constants::envs;

/// Bearer credential for the REST API.
///
/// The wire form is always `Authorization: Bearer <token>`. The server is
/// bearer-format-agnostic — customers fronting BoxLite with their own auth
/// layer can put any opaque bearer here; the SDK doesn't validate format.
///
/// Marked `#[non_exhaustive]` so additional auth modes (e.g. OAuth device
/// flow) can be added without breaking downstream Rust callers. FFI layers
/// keep flat per-mode fields (`api_key`, future `oauth`, …) and translate
/// here in their `From` impls — the sum stays internal to Rust.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum Credential {
    /// Opaque long-lived API key (`blk_live_…` from the BoxLite dashboard,
    /// or any other opaque bearer recognized by the server's validation
    /// pipeline).
    ApiKey { key: String },
}

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
///     .with_api_key("blk_live_opaque".into());
///
/// // From environment variables
/// let opts = BoxliteRestOptions::from_env().unwrap();
/// ```
#[derive(Clone)]
pub struct BoxliteRestOptions {
    /// REST API base URL (e.g., "https://api.example.com").
    pub url: String,

    /// Bearer credential. `None` = unauthenticated.
    pub credential: Option<Credential>,

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
            .map(|key| Credential::ApiKey { key });

        let prefix = std::env::var(envs::BOXLITE_REST_PREFIX).ok();

        Ok(Self {
            url,
            credential,
            prefix,
        })
    }

    /// Builder-style: set an opaque API key.
    pub fn with_api_key(mut self, key: String) -> Self {
        self.credential = Some(Credential::ApiKey { key });
        self
    }

    /// Builder-style: set the full credential value (typed).
    pub fn with_credential(mut self, credential: Credential) -> Self {
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
        // Full-mask redaction. Token length and last-4 both leak signal —
        // a length channel narrows brute-force search, a suffix can
        // correlate with a leaked token.
        let mut s = f.debug_struct("BoxliteRestOptions");
        s.field("url", &self.url);
        match &self.credential {
            None => {
                s.field("credential", &Option::<()>::None);
            }
            Some(Credential::ApiKey { .. }) => {
                s.field("credential", &"ApiKey([REDACTED])");
            }
        }
        s.field("prefix", &self.prefix);
        s.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_minimal() {
        let opts = BoxliteRestOptions::new("https://api.example.com");
        assert_eq!(opts.url, "https://api.example.com");
        assert!(opts.credential.is_none());
        assert!(opts.prefix.is_none());
    }

    #[test]
    fn test_with_api_key() {
        let opts =
            BoxliteRestOptions::new("https://api.example.com").with_api_key("blk_live_x".into());
        match opts.credential {
            Some(Credential::ApiKey { key }) => assert_eq!(key, "blk_live_x"),
            other => panic!("expected ApiKey, got is_some={}", other.is_some()),
        }
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
        let opts = BoxliteRestOptions::new("https://api.example.com")
            .with_api_key("opaque-key-1234".into());
        let dbg = format!("{:?}", opts);
        assert!(
            !dbg.contains("opaque-key-1234"),
            "Debug output leaked api_key: {dbg}"
        );
        assert!(dbg.contains("REDACTED"));
    }
}
