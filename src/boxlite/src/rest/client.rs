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
use super::types::{ErrorResponse, FlatErrorResponse, ServerConfig};
use crate::runtime::auth::Principal;

/// Re-request a token once it is within this leeway of `expires_at`.
const REFRESH_LEEWAY: Duration = Duration::from_secs(60);
const TUNNEL_SETUP_TIMEOUT: Duration = Duration::from_secs(30);

type TunnelConnector =
    hyper_rustls::HttpsConnector<hyper_util::client::legacy::connect::HttpConnector>;

/// Bound on the WebSocket handshake (TCP + TLS + HTTP upgrade). Without it a
/// stalled connect blocks the attach caller indefinitely — unlike HTTP calls,
/// which ride the reqwest client's own timeout.
const WS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

/// An upgraded attach WebSocket.
pub(crate) type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// The HTTP 101 response that upgraded a [`WsStream`].
pub(crate) type WsHandshakeResponse = tokio_tungstenite::tungstenite::handshake::client::Response;

/// HTTP client for the BoxLite REST API.
///
/// Handles base URL construction, bearer auth (any [`Credential`] impl),
/// and error response parsing.
#[derive(Clone)]
pub(crate) struct ApiClient {
    http: Client,
    tunnel_connector: TunnelConnector,
    base_url: String,
    /// Routing-slot value substituted into the `{prefix}` URL segment
    /// on box-scoped requests. `None` or empty → URL skips the segment
    /// entirely (single-tenant / empty-prefix deployment shape).
    /// Captured at construction from `BoxliteRestOptions::path_prefix`;
    /// opaque to the client.
    path_prefix: Option<String>,
    /// Bearer credential. `None` = unauthenticated.
    credential: Option<Arc<dyn Credential>>,
    /// Last token fetched, cached until near expiry. Generic over any
    /// `Credential` impl — API keys (`expires_at == None`) are fetched
    /// once and cached forever.
    cached: Arc<RwLock<Option<AccessToken>>>,
    config_cache: Arc<RwLock<Option<ServerConfig>>>,
}

impl ApiClient {
    pub fn new(config: &BoxliteRestOptions) -> BoxliteResult<Self> {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let http = Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| BoxliteError::Config(format!("failed to create HTTP client: {}", e)))?;
        let tunnel_connector = hyper_rustls::HttpsConnectorBuilder::new()
            .with_native_roots()
            .map_err(|e| BoxliteError::Config(format!("failed to load TLS roots: {e}")))?
            .https_or_http()
            .enable_http1()
            .build();

        let base_url = config.url.trim_end_matches('/').to_string();
        let path_prefix = config.path_prefix.clone();

        Ok(Self {
            http,
            tunnel_connector,
            base_url,
            path_prefix,
            credential: config.credential.clone(),
            cached: Arc::new(RwLock::new(None)),
            config_cache: Arc::new(RwLock::new(None)),
        })
    }

    /// Build the full URL for a box-scoped path.
    ///
    /// With a non-empty `prefix`, produces `{base}/v1/{prefix}{path}`
    /// (e.g. `https://api.example.com/v1/acme/boxes`). With an unset
    /// or empty `prefix`, the segment is dropped entirely
    /// (`https://api.example.com/v1/boxes`) — the single-tenant
    /// `boxlite serve` shape. Multi-segment prefixes like
    /// `us-east/team-42` are substituted verbatim.
    fn url(&self, path: &str) -> String {
        match self.path_prefix.as_deref().filter(|s| !s.is_empty()) {
            Some(p) => format!("{}/v1/{}{}", self.base_url, p, path),
            None => format!("{}/v1{}", self.base_url, path),
        }
    }

    /// Build URL without the organization segment (for identity / config
    /// endpoints — `/v1/me`, `/v1/config`).
    fn url_root(&self, path: &str) -> String {
        format!("{}/v1{}", self.base_url, path)
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

    /// Add the bearer-auth header to a request builder.
    ///
    /// Authentication is the *only* thing this client sends as a
    /// per-request header. The routing-slot value is carried in the
    /// URL path (`/v1/<prefix>/...`) per `openapi/box.openapi.yaml`.
    async fn authorize(&self, builder: RequestBuilder) -> BoxliteResult<RequestBuilder> {
        match self.current_bearer().await? {
            Some(bearer) => Ok(builder.bearer_auth(bearer)),
            None => Ok(builder),
        }
    }

    /// Send a request and parse a JSON response.
    ///
    /// On parse failure, the response body is included (truncated) in the
    /// error so the caller can see WHICH field mismatched — `reqwest`'s
    /// default error is just "error decoding response body", which is
    /// useless when the schema drifts between client and server. The body
    /// is bounded to 4 KiB so a runaway HTML error page can't blow up
    /// terminal output.
    async fn send_json<T: DeserializeOwned>(&self, builder: RequestBuilder) -> BoxliteResult<T> {
        let builder = self.authorize(builder).await?;
        let resp = builder.send().await.map_err(transport_error)?;

        let status = resp.status();
        if !status.is_success() {
            return self.handle_error(status, resp).await;
        }
        // Read the body as bytes once, then parse; this is what lets us
        // include the body in a parse-failure error without re-issuing the
        // request.
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| BoxliteError::Internal(format!("reading response body: {}", e)))?;
        serde_json::from_slice::<T>(&bytes).map_err(|e| {
            let preview = String::from_utf8_lossy(&bytes);
            let preview = if preview.len() > 4096 {
                format!(
                    "{}… (truncated, {} bytes total)",
                    &preview[..4096],
                    bytes.len()
                )
            } else {
                preview.into_owned()
            };
            BoxliteError::Internal(format!(
                "failed to parse response: {} \n--- response body ({} bytes) ---\n{}\n--- end ---",
                e,
                bytes.len(),
                preview
            ))
        })
    }

    /// Send a request and expect no response body (204).
    async fn send_no_content(&self, builder: RequestBuilder) -> BoxliteResult<()> {
        let builder = self.authorize(builder).await?;
        let resp = builder.send().await.map_err(transport_error)?;

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
        } else if let Ok(err_resp) = serde_json::from_str::<FlatErrorResponse>(&text) {
            Err(map_http_error(status, &err_resp.into_error_model()))
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
        let resp = builder.send().await.map_err(transport_error)?;

        let status = resp.status();
        if status.is_success() {
            let bytes = resp.bytes().await.map_err(transport_error)?;
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
        let resp = builder.send().await.map_err(transport_error)?;
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
    pub(crate) async fn connect_ws(&self, path: &str) -> BoxliteResult<WsStream> {
        let (stream, _resp) = self.connect_ws_with_response(path).await?;
        Ok(stream)
    }

    /// Like [`connect_ws`](Self::connect_ws), but also returns the handshake
    /// response so the caller can read server-assigned metadata off the
    /// upgrade — `/boxes/{id}/attach` answers with the main session's
    /// execution id, which the client has no other way to learn.
    pub(crate) async fn connect_ws_with_response(
        &self,
        path: &str,
    ) -> BoxliteResult<(WsStream, WsHandshakeResponse)> {
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

        tokio::time::timeout(
            WS_HANDSHAKE_TIMEOUT,
            tokio_tungstenite::connect_async(request),
        )
        .await
        .map_err(|_| {
            BoxliteError::Network(format!(
                "WebSocket handshake timed out after {}s",
                WS_HANDSHAKE_TIMEOUT.as_secs()
            ))
        })?
        .map_err(map_ws_error)
    }

    pub(crate) async fn connect_box_network_tunnel(
        &self,
        uri: &str,
    ) -> BoxliteResult<tokio::io::DuplexStream> {
        use http_body_util::Empty;
        use hyper::{Method, Request, Uri};
        use hyper_util::rt::TokioIo;
        use tower::Service;

        let uri: Uri = uri
            .parse()
            .map_err(|e| BoxliteError::Config(format!("invalid CONNECT URI: {e}")))?;
        let authority = uri
            .authority()
            .ok_or_else(|| BoxliteError::Config("CONNECT URI has no authority".into()))?
            .clone();
        let mut connector = self.tunnel_connector.clone();
        let io = tokio::time::timeout(TUNNEL_SETUP_TIMEOUT, connector.call(uri.clone()))
            .await
            .map_err(|_| BoxliteError::Network("CONNECT socket setup timed out".into()))?
            .map_err(|e| BoxliteError::Network(format!("CONNECT socket setup failed: {e}")))?;
        let (mut sender, connection) = hyper::client::conn::http1::handshake(io)
            .await
            .map_err(|e| BoxliteError::Network(format!("CONNECT handshake failed: {e}")))?;
        tokio::spawn(async move {
            let _ = connection.with_upgrades().await;
        });
        let request = Request::builder()
            .method(Method::CONNECT)
            .uri(authority.as_str())
            .header("Host", authority.as_str())
            .body(Empty::<bytes::Bytes>::new())
            .map_err(|e| BoxliteError::Internal(format!("CONNECT request build failed: {e}")))?;
        let response = tokio::time::timeout(TUNNEL_SETUP_TIMEOUT, sender.send_request(request))
            .await
            .map_err(|_| BoxliteError::Network("CONNECT response timed out".into()))?
            .map_err(|e| BoxliteError::Network(format!("CONNECT request failed: {e}")))?;
        let status = response.status();
        if !status.is_success() {
            return Err(map_http_status(status, "CONNECT proxy rejected tunnel"));
        }
        let upgraded = hyper::upgrade::on(response)
            .await
            .map_err(|e| BoxliteError::Network(format!("CONNECT upgrade failed: {e}")))?;
        let (local, mut pump_end) = tokio::io::duplex(64 * 1024);
        let mut remote = TokioIo::new(upgraded);
        tokio::spawn(async move {
            let _ = tokio::io::copy_bidirectional(&mut pump_end, &mut remote).await;
        });
        Ok(local)
    }

    /// Prepare a box service tunnel and return its public descriptor.
    pub(crate) async fn prepare_box_tunnel(
        &self,
        box_id: impl AsRef<str>,
        port: u16,
    ) -> BoxliteResult<String> {
        #[derive(serde::Deserialize)]
        struct TunnelDescriptor {
            uri: String,
        }
        let path = format!("/boxes/{}/network/tunnel?port={port}", box_id.as_ref());
        let request = self
            .authorize(
                self.http
                    .post(self.url(&path))
                    .header(reqwest::header::ACCEPT, "application/json"),
            )
            .await?;
        let response = request
            .send()
            .await
            .map_err(|e| BoxliteError::Network(e.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return self.handle_error(status, response).await;
        }
        let descriptor: TunnelDescriptor = response
            .json()
            .await
            .map_err(|e| BoxliteError::Internal(format!("invalid tunnel descriptor: {e}")))?;
        Ok(descriptor.uri)
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

    pub async fn get_config(&self) -> BoxliteResult<ServerConfig> {
        {
            let cache = self.config_cache.read().await;
            if let Some(config) = cache.as_ref() {
                return Ok(config.clone());
            }
        }

        let config: ServerConfig = self.get_root("/config").await?;
        let mut cache = self.config_cache.write().await;
        *cache = Some(config.clone());
        Ok(config)
    }

    /// `GET /v1/me` — identity of the calling credential. Not cached
    /// (identity is per-credential and cheap; unlike static capabilities).
    /// A 404 surfaces as `BoxliteError::NotFound` (server without `/v1/me`);
    /// 401/403 as `BoxliteError::Config("auth: …")` — callers branch on these.
    pub async fn get_me(&self) -> BoxliteResult<Principal> {
        self.get_root("/me").await
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

/// Convert a `reqwest::Error` into a typed `BoxliteError::Network` with
/// the underlying cause described in the message. Distinguishes
/// connect/DNS/TLS failures from request-build failures from timeouts
/// so the user can act on the diagnosis — a connect refused is "is the
/// server running?" while a builder error is a client-side bug.
///
/// The wrapper preserves the original `reqwest::Error` Display chain
/// (URL, status, cause) which usually includes the destination host —
/// invaluable for diagnosing transparent-proxy regressions like the
/// Clash `:7890` interception that produced bare 502s in
/// production.
fn transport_error(err: reqwest::Error) -> BoxliteError {
    let url_hint = err.url().map(|u| u.as_str().to_string());
    let kind = if err.is_connect() {
        "connect failed"
    } else if err.is_timeout() {
        "timed out"
    } else if err.is_request() {
        "request build failed"
    } else if err.is_decode() {
        "response decode failed"
    } else {
        "transport error"
    };
    let detail = match url_hint {
        Some(url) => format!("{kind} reaching {url}: {err}"),
        None => format!("{kind}: {err}"),
    };
    BoxliteError::Network(detail)
}

/// Map a tungstenite connect error to a typed `BoxliteError`. The WS
/// upgrade returns HTTP status codes for rejections (404 for a missing
/// session, 409 for an already-attached one, 410 once an exec has been
/// reaped). Symmetric with the REST mapper in [`super::error`].
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
            410 => BoxliteError::SessionReaped(if body.is_empty() {
                "exec session reaped; start a new exec".to_string()
            } else {
                body
            }),
            401 | 403 => BoxliteError::Config(format!("WS auth rejected ({}): {}", status, body)),
            502..=504 => BoxliteError::Network(format!(
                "WS upstream returned HTTP {} (proxy or load balancer): {}",
                status,
                if body.is_empty() { "<empty>" } else { &body }
            )),
            _ => BoxliteError::Internal(format!("WS upgrade failed (HTTP {}): {}", status, body)),
        };
    }
    BoxliteError::Network(format!("WS connect failed: {}", err))
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

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
    #[allow(clippy::result_large_err)]
    async fn connect_box_network_tunnel_uses_connect_and_streams_both_directions() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut headers = Vec::new();
            while !headers.ends_with(b"\r\n\r\n") {
                headers.push(socket.read_u8().await.unwrap());
            }
            let headers = String::from_utf8(headers).unwrap();
            assert!(headers.starts_with(&format!("CONNECT 127.0.0.1:{port} HTTP/1.1")));
            socket
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await
                .unwrap();

            let mut payload = [0; 4];
            socket.read_exact(&mut payload).await.unwrap();
            assert_eq!(&payload, b"ping");
            socket.write_all(&payload).await.unwrap();
        });

        let client =
            ApiClient::new(&BoxliteRestOptions::new(format!("http://127.0.0.1:{port}"))).unwrap();
        let mut stream = client
            .connect_box_network_tunnel(&format!("http://127.0.0.1:{port}"))
            .await
            .unwrap();
        stream.write_all(b"ping").await.unwrap();
        let mut response = [0; 4];
        stream.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"ping");
        server.await.unwrap();
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
    fn flat_nest_error_response_maps_by_code() {
        let parsed: FlatErrorResponse = serde_json::from_str(
            r#"{"statusCode":502,"error":"Bad Gateway","message":"Runner API returned a non-JSON error response","code":"runner_non_json_error"}"#,
        )
        .expect("flat error response");

        let err = map_http_error(StatusCode::BAD_GATEWAY, &parsed.into_error_model());

        match err {
            BoxliteError::Network(message) => {
                assert!(message.contains("Runner API returned a non-JSON error response"))
            }
            other => panic!("expected Network error for runner non-JSON response, got {other:?}"),
        }
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

    // ========================================================================
    // URL shape — vendor-agnostic routing slot.
    //
    // Locks in the three shapes the OpenAPI contract supports for the
    // `{prefix}` slot: single-segment, empty (no slot), and
    // multi-segment-with-slashes. The single-segment case is what
    // boxlite cloud uses (org UUID); the empty case is what
    // `boxlite serve` and single-tenant deployments use; the multi-
    // segment case unlocks future region+team / workspace shapes per
    // the spec note in `openapi/box.openapi.yaml`.
    // ========================================================================

    fn unauthenticated_client(opts: BoxliteRestOptions) -> ApiClient {
        ApiClient::new(&opts).expect("client")
    }

    #[test]
    fn url_substitutes_path_prefix_when_set() {
        let opts = BoxliteRestOptions::new("https://api.example.com").with_path_prefix("acme");
        let client = unauthenticated_client(opts);
        assert_eq!(
            client.url("/boxes"),
            "https://api.example.com/v1/acme/boxes",
            "non-empty prefix must round-trip verbatim into the URL"
        );
    }

    #[test]
    fn url_skips_segment_when_path_prefix_unset() {
        let opts = BoxliteRestOptions::new("https://api.example.com");
        let client = unauthenticated_client(opts);
        assert_eq!(
            client.url("/boxes"),
            "https://api.example.com/v1/boxes",
            "unset prefix must drop the segment — empty-prefix is the canonical \
             single-tenant deployment shape"
        );
    }

    #[test]
    fn url_skips_segment_when_path_prefix_empty() {
        let opts = BoxliteRestOptions::new("https://api.example.com").with_path_prefix("");
        let client = unauthenticated_client(opts);
        assert_eq!(
            client.url("/boxes"),
            "https://api.example.com/v1/boxes",
            "explicit empty-string prefix is wire-equivalent to unset"
        );
    }

    #[test]
    fn url_passes_multi_segment_path_prefix_verbatim() {
        // Multi-segment prefix per spec — internal `/` characters are
        // preserved (allowReserved: true on the path parameter). Unlocks
        // region+team / catalog routing for vendors that need it.
        let opts =
            BoxliteRestOptions::new("https://api.example.com").with_path_prefix("us-east/team-42");
        let client = unauthenticated_client(opts);
        assert_eq!(
            client.url("/boxes"),
            "https://api.example.com/v1/us-east/team-42/boxes",
            "multi-segment prefix must pass slashes through verbatim"
        );
    }

    #[test]
    fn url_root_omits_path_prefix_segment() {
        // `/v1/me`, `/v1/config` are root identity/discovery endpoints
        // and never include the prefix segment, per spec.
        let opts = BoxliteRestOptions::new("https://api.example.com").with_path_prefix("acme");
        let client = unauthenticated_client(opts);
        assert_eq!(
            client.url_root("/me"),
            "https://api.example.com/v1/me",
            "url_root must skip the prefix segment regardless of its value"
        );
    }
}
