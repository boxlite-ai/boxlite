//! HTTP client for the BoxLite REST API.

use std::sync::Arc;
use std::time::{Duration, SystemTime};

use reqwest::{Client, Method, RequestBuilder, StatusCode};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::sync::RwLock;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::credential::{AccessToken, Credential};
use super::error::{map_http_error, map_http_status};
use super::options::BoxliteRestOptions;
use super::types::{ErrorResponse, SandboxConfigResponse};

/// Re-request a token once it is within this leeway of `expires_at`.
const REFRESH_LEEWAY: Duration = Duration::from_secs(60);

/// HTTP client for the BoxLite REST API.
///
/// Handles base URL construction, bearer auth (any [`Credential`] impl),
/// and error response parsing.
#[derive(Clone)]
pub(crate) struct ApiClient {
    http: Client,
    base_url: String,
    prefix: String,
    /// Bearer credential. `None` = unauthenticated.
    credential: Option<Arc<dyn Credential>>,
    /// Last token fetched, cached until near expiry. Generic over any
    /// `Credential` impl — API keys (`expires_at == None`) are fetched
    /// once and cached forever.
    cached: Arc<RwLock<Option<AccessToken>>>,
    config_cache: Arc<RwLock<Option<SandboxConfigResponse>>>,
}

impl ApiClient {
    pub fn new(config: &BoxliteRestOptions) -> BoxliteResult<Self> {
        let http = Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| BoxliteError::Config(format!("failed to create HTTP client: {}", e)))?;

        let base_url = config.url.trim_end_matches('/').to_string();
        let prefix = config.effective_prefix().to_string();

        Ok(Self {
            http,
            base_url,
            prefix,
            credential: config.credential.clone(),
            cached: Arc::new(RwLock::new(None)),
            config_cache: Arc::new(RwLock::new(None)),
        })
    }

    /// Build the full URL for a path under the versioned prefix.
    /// e.g., "/sandboxes" → "https://api.example.com/v1/default/sandboxes"
    fn url(&self, path: &str) -> String {
        format!("{}/{}/default{}", self.base_url, self.prefix, path)
    }

    /// Build URL without the tenant prefix (for auth endpoints).
    fn url_root(&self, path: &str) -> String {
        format!("{}/{}{}", self.base_url, self.prefix, path)
    }

    /// Return a usable bearer, re-requesting from the credential when the
    /// cached token is absent or within [`REFRESH_LEEWAY`] of `expires_at`.
    /// `expires_at == None` (API keys) → fetched once, cached forever.
    /// `None` means the client has no credential configured.
    async fn current_bearer(&self) -> BoxliteResult<Option<String>> {
        let Some(cred) = &self.credential else {
            return Ok(None);
        };
        {
            let guard = self.cached.read().await;
            if let Some(tok) = guard.as_ref() {
                let fresh = match tok.expires_at {
                    None => true,
                    Some(exp) => SystemTime::now() + REFRESH_LEEWAY < exp,
                };
                if fresh {
                    return Ok(Some(tok.token.clone()));
                }
            }
        }
        let tok = cred.get_token().await?;
        let bearer = tok.token.clone();
        *self.cached.write().await = Some(tok);
        Ok(Some(bearer))
    }

    /// Add auth header to a request builder.
    async fn authorize(&self, builder: RequestBuilder) -> BoxliteResult<RequestBuilder> {
        match self.current_bearer().await? {
            Some(bearer) => Ok(builder.bearer_auth(bearer)),
            None => Ok(builder),
        }
    }

    /// Send a request and parse a JSON response.
    async fn send_json<T: DeserializeOwned>(&self, builder: RequestBuilder) -> BoxliteResult<T> {
        let builder = self.authorize(builder).await?;
        let resp = builder
            .send()
            .await
            .map_err(|e| BoxliteError::Internal(format!("HTTP request failed: {}", e)))?;

        let status = resp.status();
        if status.is_success() {
            resp.json::<T>()
                .await
                .map_err(|e| BoxliteError::Internal(format!("failed to parse response: {}", e)))
        } else {
            self.handle_error(status, resp).await
        }
    }

    /// Send a request and expect no response body (204).
    async fn send_no_content(&self, builder: RequestBuilder) -> BoxliteResult<()> {
        let builder = self.authorize(builder).await?;
        let resp = builder
            .send()
            .await
            .map_err(|e| BoxliteError::Internal(format!("HTTP request failed: {}", e)))?;

        let status = resp.status();
        if status.is_success() {
            Ok(())
        } else {
            self.handle_error(status, resp).await
        }
    }

    /// Parse an error response body and map to BoxliteError.
    async fn handle_error<T>(
        &self,
        status: StatusCode,
        resp: reqwest::Response,
    ) -> BoxliteResult<T> {
        let text = resp.text().await.unwrap_or_default();
        if let Ok(err_resp) = serde_json::from_str::<ErrorResponse>(&text) {
            Err(map_http_error(status, &err_resp.error))
        } else {
            Err(map_http_status(status, &text))
        }
    }

    // ========================================================================
    // Convenience methods
    // ========================================================================

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> BoxliteResult<T> {
        let builder = self.http.get(self.url(path));
        self.send_json(builder).await
    }

    pub async fn get_root<T: DeserializeOwned>(&self, path: &str) -> BoxliteResult<T> {
        let builder = self.http.get(self.url_root(path));
        self.send_json(builder).await
    }

    pub async fn post<B: Serialize, T: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
    ) -> BoxliteResult<T> {
        let builder = self.http.post(self.url(path)).json(body);
        self.send_json(builder).await
    }

    pub async fn post_no_content<B: Serialize>(&self, path: &str, body: &B) -> BoxliteResult<()> {
        let builder = self.http.post(self.url(path)).json(body);
        self.send_no_content(builder).await
    }

    pub async fn post_empty<T: DeserializeOwned>(&self, path: &str) -> BoxliteResult<T> {
        let builder = self.http.post(self.url(path));
        self.send_json(builder).await
    }

    pub async fn post_empty_no_content(&self, path: &str) -> BoxliteResult<()> {
        let builder = self.http.post(self.url(path));
        self.send_no_content(builder).await
    }

    pub async fn post_for_bytes<B: Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> BoxliteResult<Vec<u8>> {
        let builder = self.http.post(self.url(path)).json(body);
        let builder = self.authorize(builder).await?;
        let resp = builder
            .send()
            .await
            .map_err(|e| BoxliteError::Internal(format!("HTTP request failed: {}", e)))?;

        let status = resp.status();
        if status.is_success() {
            let bytes = resp
                .bytes()
                .await
                .map_err(|e| BoxliteError::Internal(format!("failed to read response: {}", e)))?;
            Ok(bytes.to_vec())
        } else {
            self.handle_error::<Vec<u8>>(status, resp).await
        }
    }

    pub async fn delete(&self, path: &str) -> BoxliteResult<()> {
        let builder = self.http.delete(self.url(path));
        self.send_no_content(builder).await
    }

    pub async fn delete_with_query(&self, path: &str, query: &[(&str, &str)]) -> BoxliteResult<()> {
        let builder = self.http.delete(self.url(path)).query(query);
        self.send_no_content(builder).await
    }

    pub async fn head_exists(&self, path: &str) -> BoxliteResult<bool> {
        let builder = self.http.head(self.url(path));
        let builder = self.authorize(builder).await?;
        let resp = builder
            .send()
            .await
            .map_err(|e| BoxliteError::Internal(format!("HTTP request failed: {}", e)))?;
        match resp.status().as_u16() {
            204 | 200 => Ok(true),
            404 => Ok(false),
            _ => {
                let status = resp.status();
                self.handle_error::<bool>(status, resp).await
            }
        }
    }

    /// Open an authenticated WebSocket connection at the given REST path.
    ///
    /// Translates the http(s) URL to ws(s), attaches the Bearer header
    /// when configured, and returns the upgraded stream.
    pub(crate) async fn connect_ws(
        &self,
        path: &str,
    ) -> BoxliteResult<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    > {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::http::HeaderValue;

        let http_url = self.url(path);
        let ws_url = if let Some(rest) = http_url.strip_prefix("https://") {
            format!("wss://{}", rest)
        } else if let Some(rest) = http_url.strip_prefix("http://") {
            format!("ws://{}", rest)
        } else {
            return Err(BoxliteError::Internal(format!(
                "WS connect: unsupported URL scheme in {}",
                http_url
            )));
        };

        let mut request = ws_url
            .as_str()
            .into_client_request()
            .map_err(|e| BoxliteError::Internal(format!("WS request build failed: {}", e)))?;

        if let Some(bearer) = self.current_bearer().await? {
            let value = HeaderValue::from_str(&format!("Bearer {}", bearer))
                .map_err(|e| BoxliteError::Internal(format!("WS auth header invalid: {}", e)))?;
            request.headers_mut().insert("Authorization", value);
        }

        let (stream, _resp) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(map_ws_error)?;
        Ok(stream)
    }

    /// Build an authorized request (for custom operations like file upload/download).
    pub async fn authorized_request(
        &self,
        method: Method,
        path: &str,
    ) -> BoxliteResult<RequestBuilder> {
        let builder = self.http.request(method, self.url(path));
        self.authorize(builder).await
    }

    pub async fn get_config(&self) -> BoxliteResult<SandboxConfigResponse> {
        {
            let cache = self.config_cache.read().await;
            if let Some(config) = cache.as_ref() {
                return Ok(config.clone());
            }
        }

        let config: SandboxConfigResponse = self.get_root("/config").await?;
        let mut cache = self.config_cache.write().await;
        *cache = Some(config.clone());
        Ok(config)
    }

    pub async fn require_snapshots_enabled(&self) -> BoxliteResult<()> {
        let config = self.get_config().await?;
        let capabilities = config.capabilities.ok_or_else(|| {
            BoxliteError::Unsupported(
                "Remote server did not advertise snapshots capability".to_string(),
            )
        })?;
        ensure_capability("snapshots", capabilities.snapshots_enabled)
    }

    pub async fn require_clone_enabled(&self) -> BoxliteResult<()> {
        let config = self.get_config().await?;
        let capabilities = config.capabilities.ok_or_else(|| {
            BoxliteError::Unsupported(
                "Remote server did not advertise clone capability".to_string(),
            )
        })?;
        ensure_capability("clone", capabilities.clone_enabled)
    }

    pub async fn require_export_enabled(&self) -> BoxliteResult<()> {
        let config = self.get_config().await?;
        let capabilities = config.capabilities.ok_or_else(|| {
            BoxliteError::Unsupported(
                "Remote server did not advertise export capability".to_string(),
            )
        })?;
        ensure_capability("export", capabilities.export_enabled)
    }

    pub async fn require_import_enabled(&self) -> BoxliteResult<()> {
        let config = self.get_config().await?;
        let capabilities = config.capabilities.ok_or_else(|| {
            BoxliteError::Unsupported(
                "Remote server did not advertise import capability".to_string(),
            )
        })?;
        ensure_capability("import", capabilities.import_enabled)
    }

    /// POST binary data with query params, parse JSON response.
    pub async fn post_bytes_for_json<T: DeserializeOwned>(
        &self,
        path: &str,
        data: Vec<u8>,
        query: &[(&str, &str)],
    ) -> BoxliteResult<T> {
        let builder = self
            .http
            .post(self.url(path))
            .header("Content-Type", "application/octet-stream")
            .query(query)
            .body(data);
        self.send_json(builder).await
    }
}

/// Map a tungstenite connect error to a typed `BoxliteError`. The WS
/// upgrade returns HTTP status codes for rejections (404 for a missing
/// session, 409 for an already-attached one); callers want to see those
/// as `NotFound` / `AlreadyExists` rather than generic `Internal` so
/// they can map onward to `SessionReaped`.
fn map_ws_error(err: tokio_tungstenite::tungstenite::Error) -> BoxliteError {
    use tokio_tungstenite::tungstenite::Error as TgErr;
    if let TgErr::Http(resp) = &err {
        let status = resp.status();
        let body = resp
            .body()
            .as_ref()
            .map(|b| String::from_utf8_lossy(b).into_owned())
            .unwrap_or_default();
        return match status.as_u16() {
            404 => BoxliteError::NotFound(if body.is_empty() {
                "session not found".to_string()
            } else {
                body
            }),
            409 => BoxliteError::AlreadyExists(if body.is_empty() {
                "another client is already attached".to_string()
            } else {
                body
            }),
            401 | 403 => BoxliteError::Config(format!("WS auth rejected ({}): {}", status, body)),
            _ => BoxliteError::Internal(format!("WS upgrade failed (HTTP {}): {}", status, body)),
        };
    }
    BoxliteError::Internal(format!("WS connect failed: {}", err))
}

fn ensure_capability(name: &str, enabled: Option<bool>) -> BoxliteResult<()> {
    match enabled {
        Some(true) => Ok(()),
        Some(false) => Err(BoxliteError::Unsupported(format!(
            "Remote server does not support {} operations",
            name
        ))),
        None => Err(BoxliteError::Unsupported(format!(
            "Remote server did not advertise {} capability",
            name
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::ensure_capability;
    use super::*;
    use crate::rest::credential::{AccessToken, Credential};
    use async_trait::async_trait;
    use boxlite_shared::errors::BoxliteError;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Rotating credential with a finite expiry already in the past, so
    /// `current_bearer` must re-request on every call. Proves the cache
    /// is expiry-driven and works for any `Credential` impl, not just
    /// `ApiKeyCredential`.
    #[derive(Debug)]
    struct RotatingMock {
        calls: AtomicUsize,
        /// When false, behaves like an API key (`expires_at: None`).
        expiring: bool,
    }

    #[async_trait]
    impl Credential for RotatingMock {
        async fn get_token(&self) -> BoxliteResult<AccessToken> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(AccessToken {
                token: format!("tok-{n}"),
                // Past instant → always within leeway → always re-fetch.
                expires_at: self
                    .expiring
                    .then(|| SystemTime::now() - Duration::from_secs(3600)),
            })
        }
    }

    fn client_with(cred: Arc<dyn Credential>) -> ApiClient {
        let opts = BoxliteRestOptions::new("http://localhost:1").with_credential(cred);
        ApiClient::new(&opts).expect("client")
    }

    #[tokio::test]
    async fn expiring_credential_is_re_requested_each_call() {
        let mock = Arc::new(RotatingMock {
            calls: AtomicUsize::new(0),
            expiring: true,
        });
        let client = client_with(mock.clone());
        let a = client.current_bearer().await.unwrap();
        let b = client.current_bearer().await.unwrap();
        assert_eq!(a.as_deref(), Some("tok-0"));
        assert_eq!(b.as_deref(), Some("tok-1"), "expired token must rotate");
        assert_eq!(mock.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn non_expiring_credential_is_fetched_once() {
        let mock = Arc::new(RotatingMock {
            calls: AtomicUsize::new(0),
            expiring: false,
        });
        let client = client_with(mock.clone());
        let a = client.current_bearer().await.unwrap();
        let b = client.current_bearer().await.unwrap();
        assert_eq!(a.as_deref(), Some("tok-0"));
        assert_eq!(b.as_deref(), Some("tok-0"), "API-key token must cache");
        assert_eq!(
            mock.calls.load(Ordering::SeqCst),
            1,
            "expires_at=None must be fetched exactly once"
        );
    }

    #[tokio::test]
    async fn no_credential_yields_no_bearer() {
        let opts = BoxliteRestOptions::new("http://localhost:1");
        let client = ApiClient::new(&opts).expect("client");
        assert_eq!(client.current_bearer().await.unwrap(), None);
    }

    #[test]
    fn test_ensure_capability_enabled() {
        assert!(ensure_capability("snapshots", Some(true)).is_ok());
    }

    #[test]
    fn test_ensure_capability_disabled() {
        let err = ensure_capability("snapshots", Some(false)).unwrap_err();
        assert!(matches!(err, BoxliteError::Unsupported(_)));
    }

    #[test]
    fn test_ensure_capability_missing() {
        let err = ensure_capability("snapshots", None).unwrap_err();
        assert!(matches!(err, BoxliteError::Unsupported(_)));
    }
}
