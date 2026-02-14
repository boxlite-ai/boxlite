//! HTTP client with OAuth2 token management.

use std::sync::Arc;

use reqwest::{Client, Method, RequestBuilder, StatusCode};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::sync::RwLock;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::error::{map_http_error, map_http_status};
use super::options::BoxliteRestOptions;
use super::types::{ErrorResponse, TokenRequest, TokenResponse};

/// Cached OAuth2 token with expiry.
struct TokenCache {
    token: String,
    /// Expiry as seconds since epoch.
    expires_at: u64,
}

/// HTTP client for the BoxLite REST API.
///
/// Handles base URL construction, OAuth2 token caching/refresh,
/// and error response parsing.
#[derive(Clone)]
pub(crate) struct ApiClient {
    http: Client,
    base_url: String,
    prefix: String,
    client_id: Option<String>,
    client_secret: Option<String>,
    token_cache: Arc<RwLock<Option<TokenCache>>>,
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
            client_id: config.client_id.clone(),
            client_secret: config.client_secret.clone(),
            token_cache: Arc::new(RwLock::new(None)),
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

    /// Get a valid Bearer token, refreshing if needed.
    async fn get_token(&self) -> BoxliteResult<Option<String>> {
        let (client_id, client_secret) = match (&self.client_id, &self.client_secret) {
            (Some(id), Some(secret)) => (id.clone(), secret.clone()),
            _ => return Ok(None),
        };

        // Check cached token
        {
            let cache = self.token_cache.read().await;
            if let Some(ref cached) = *cache {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                // Refresh 60 seconds before expiry
                if now + 60 < cached.expires_at {
                    return Ok(Some(cached.token.clone()));
                }
            }
        }

        // Refresh token
        let token_url = self.url_root("/oauth/tokens");
        let req = TokenRequest {
            grant_type: "client_credentials",
            client_id: &client_id,
            client_secret: &client_secret,
        };

        let resp = self
            .http
            .post(&token_url)
            .form(&req)
            .send()
            .await
            .map_err(|e| BoxliteError::Config(format!("token request failed: {}", e)))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(BoxliteError::Config(format!(
                "token exchange failed (HTTP {}): {}",
                status, text
            )));
        }

        let token_resp: TokenResponse = resp
            .json()
            .await
            .map_err(|e| BoxliteError::Config(format!("failed to parse token response: {}", e)))?;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let token = token_resp.access_token.clone();
        let expires_at = now + token_resp.expires_in;

        let mut cache = self.token_cache.write().await;
        *cache = Some(TokenCache {
            token: token.clone(),
            expires_at,
        });

        Ok(Some(token))
    }

    /// Add auth header to a request builder.
    async fn authorize(&self, builder: RequestBuilder) -> BoxliteResult<RequestBuilder> {
        if let Some(token) = self.get_token().await? {
            Ok(builder.bearer_auth(token))
        } else {
            Ok(builder)
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

    /// Get the raw reqwest client (for SSE streaming).
    #[allow(dead_code)]
    pub fn raw_client(&self) -> &Client {
        &self.http
    }

    /// Build an authorized GET request (for SSE streaming).
    pub async fn authorized_get(&self, path: &str) -> BoxliteResult<RequestBuilder> {
        let builder = self.http.get(self.url(path));
        self.authorize(builder).await
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

    /// Send raw bytes as POST body (for stdin input).
    pub async fn post_bytes(
        &self,
        path: &str,
        data: Vec<u8>,
        close_stdin: bool,
    ) -> BoxliteResult<()> {
        let mut builder = self
            .http
            .post(self.url(path))
            .header("Content-Type", "application/octet-stream")
            .body(data);

        if close_stdin {
            builder = builder.header("X-Close-Stdin", "true");
        }

        self.send_no_content(builder).await
    }
}
