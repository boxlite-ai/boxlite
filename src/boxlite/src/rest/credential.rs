//! Credential abstraction for the REST API.
//!
//! A credential is a *token factory* that returns a token plus its
//! expiry. The SDK core ([`super::client::ApiClient::current_bearer`])
//! owns the decision of when to re-request based on `expires_at` + a
//! refresh leeway. This keeps the trait `&self`-friendly — the trivial
//! [`ApiKeyCredential`] needs no interior mutability — while leaving
//! room for a future refreshing impl (e.g. OAuth) to manage its own
//! rotation behind interior mutability inside that impl only.

use std::fmt::{self, Debug};
use std::time::SystemTime;

use async_trait::async_trait;

use boxlite_shared::errors::BoxliteResult;

/// A bearer token plus its expiry.
///
/// `expires_at == None` means the token never expires (e.g. long-lived
/// API keys) — the core fetches it once and never re-requests.
#[derive(Clone)]
pub struct AccessToken {
    pub token: String,
    pub expires_at: Option<SystemTime>,
}

impl Debug for AccessToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Full-mask redaction — never leak token length or suffix.
        f.debug_struct("AccessToken")
            .field("token", &"[REDACTED]")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// Abstraction over a bearer credential for the REST API.
///
/// `get_token` returns the current token plus its expiry. The SDK core
/// decides when to re-call based on `expires_at` + a refresh leeway.
///
/// `Send + Sync` for the async REST client. `Debug` is constrained at the
/// trait level so [`super::options::BoxliteRestOptions`] can derive Debug;
/// each impl is responsible for redacting its own secrets.
#[async_trait]
pub trait Credential: Send + Sync + Debug {
    async fn get_token(&self) -> BoxliteResult<AccessToken>;
}

/// Long-lived opaque API key. The only concrete [`Credential`] shipped today.
pub struct ApiKeyCredential {
    key: String,
}

impl ApiKeyCredential {
    pub fn new(key: impl Into<String>) -> Self {
        Self { key: key.into() }
    }
}

#[async_trait]
impl Credential for ApiKeyCredential {
    async fn get_token(&self) -> BoxliteResult<AccessToken> {
        // API keys never expire — `None` tells the core not to re-request.
        Ok(AccessToken {
            token: self.key.clone(),
            expires_at: None,
        })
    }
}

impl Debug for ApiKeyCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ApiKeyCredential")
            .field("key", &"[REDACTED]")
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[tokio::test]
    async fn api_key_never_expires() {
        let cred = ApiKeyCredential::new("blk_live_x");
        let tok = cred.get_token().await.expect("get_token");
        assert_eq!(tok.token, "blk_live_x");
        assert!(tok.expires_at.is_none(), "API keys must not carry expiry");
    }

    #[test]
    fn debug_redacts_key() {
        let cred = ApiKeyCredential::new("super-secret-key");
        let dbg = format!("{:?}", cred);
        assert!(!dbg.contains("super-secret-key"), "Debug leaked key");
        assert!(dbg.contains("REDACTED"));
    }

    #[test]
    fn access_token_debug_redacts() {
        let tok = AccessToken {
            token: "leak-me".into(),
            expires_at: None,
        };
        let dbg = format!("{:?}", tok);
        assert!(!dbg.contains("leak-me"), "Debug leaked token");
    }

    /// Forward-compat: an arbitrary `Credential` impl with rotating tokens
    /// and a finite expiry proves the abstraction is real, not
    /// `ApiKeyCredential`-shaped. Exercised against the client cache in
    /// `client.rs` tests; here we just confirm trait-object dispatch works.
    #[derive(Debug)]
    struct RotatingMock {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl Credential for RotatingMock {
        async fn get_token(&self) -> BoxliteResult<AccessToken> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(AccessToken {
                token: format!("tok-{n}"),
                expires_at: Some(SystemTime::now() + Duration::from_secs(1)),
            })
        }
    }

    #[tokio::test]
    async fn trait_object_dispatch() {
        let cred: Arc<dyn Credential> = Arc::new(RotatingMock {
            calls: AtomicUsize::new(0),
        });
        let a = cred.get_token().await.unwrap();
        let b = cred.get_token().await.unwrap();
        assert_eq!(a.token, "tok-0");
        assert_eq!(b.token, "tok-1");
        assert!(a.expires_at.is_some());
    }
}
