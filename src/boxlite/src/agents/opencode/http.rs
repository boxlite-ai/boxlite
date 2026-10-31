//! HTTP/1.1 JSON client for the Box's OpenCode server.
//!
//! Every request opens its own Box tunnel connection, so no connection state
//! outlives a call.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode, header};
use hyper_util::rt::TokioIo;
use serde_json::Value;

use crate::litebox::{BoxConnection, NetworkHandle, TunnelOptions};
use crate::runtime::backend::BoxNetworkBackend;
use crate::{BoxliteError, BoxliteResult};

/// Largest JSON response read; a larger body fails instead of growing memory.
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
/// Bound on one JSON exchange; agent work itself runs asynchronously in the server.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) struct Client {
    network: Arc<dyn BoxNetworkBackend>,
    port: u16,
    /// `Basic` credentials for the server password; never logged.
    authorization: String,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Client")
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

impl Client {
    pub(super) fn new(network: Arc<dyn BoxNetworkBackend>, port: u16, password: &str) -> Self {
        let token =
            base64::engine::general_purpose::STANDARD.encode(format!("opencode:{password}"));
        Self {
            network,
            port,
            authorization: format!("Basic {token}"),
        }
    }

    pub(super) async fn get(&self, path: &str) -> BoxliteResult<Value> {
        self.json(Method::GET, path, None).await
    }

    /// POST a body that carries a client-chosen ID OpenCode deduplicates, so a
    /// request whose response was lost can be repeated once without a second
    /// admission. Only transport failures are retried.
    pub(super) async fn post_idempotent(&self, path: &str, body: &Value) -> BoxliteResult<Value> {
        match self.json(Method::POST, path, Some(body)).await {
            Err(BoxliteError::Network(_)) => self.json(Method::POST, path, Some(body)).await,
            outcome => outcome,
        }
    }

    async fn json(&self, method: Method, path: &str, body: Option<&Value>) -> BoxliteResult<Value> {
        let exchange = async {
            let response = self.send(method.clone(), path, body).await?;
            let status = response.status();
            let bytes = read_body(&method, path, response).await?;
            if !status.is_success() {
                return Err(native_error(&method, path, status, &bytes));
            }
            if bytes.is_empty() {
                return Ok(Value::Null);
            }
            serde_json::from_slice(&bytes).map_err(|error| {
                BoxliteError::Internal(format!(
                    "OpenCode {method} {path} returned invalid JSON: {error}"
                ))
            })
        };
        tokio::time::timeout(REQUEST_TIMEOUT, exchange)
            .await
            .map_err(|_| timed_out(&method, path))?
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> BoxliteResult<Response<Incoming>> {
        let connection = self.connect().await?;
        let (mut sender, driver) = hyper::client::conn::http1::handshake(TokioIo::new(connection))
            .await
            .map_err(|error| transport_error(&method, path, error))?;
        tokio::spawn(async move {
            let _ = driver.await;
        });
        let mut request = Request::builder()
            .method(method.clone())
            .uri(path)
            .header(header::HOST, "opencode")
            .header(header::AUTHORIZATION, &self.authorization);
        let payload = match body {
            Some(body) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Bytes::from(serde_json::to_vec(body)?)
            }
            None => Bytes::new(),
        };
        let request = request.body(Full::new(payload)).map_err(|error| {
            BoxliteError::Internal(format!(
                "OpenCode {method} {path}: invalid request: {error}"
            ))
        })?;
        sender
            .send_request(request)
            .await
            .map_err(|error| transport_error(&method, path, error))
    }

    async fn connect(&self) -> BoxliteResult<BoxConnection> {
        // The tunnel resolves loopback to the guest address; see `NetworkHandle::tunnel`.
        let target = SocketAddr::from((Ipv4Addr::LOCALHOST, self.port));
        NetworkHandle::new(Arc::clone(&self.network))
            .tunnel(target, TunnelOptions::default())
            .await?
            .connect()
            .await
    }
}

async fn read_body(
    method: &Method,
    path: &str,
    response: Response<Incoming>,
) -> BoxliteResult<Bytes> {
    Limited::new(response.into_body(), MAX_RESPONSE_BYTES)
        .collect()
        .await
        .map(|collected| collected.to_bytes())
        .map_err(|error| {
            BoxliteError::Network(format!(
                "OpenCode {method} {path}: reading response failed: {error}"
            ))
        })
}

/// Keep OpenCode's error tag and message; the status selects the BoxLite class.
fn native_error(method: &Method, path: &str, status: StatusCode, body: &[u8]) -> BoxliteError {
    let detail = match serde_json::from_slice::<Value>(body) {
        Ok(error) => format!(
            "{} {}",
            error["_tag"].as_str().unwrap_or_default(),
            error["message"].as_str().unwrap_or_default()
        ),
        Err(_) => String::from_utf8_lossy(&body[..body.len().min(512)]).into_owned(),
    };
    let message = format!(
        "OpenCode {method} {path} returned {status}: {}",
        detail.trim()
    );
    match status {
        StatusCode::BAD_REQUEST => BoxliteError::InvalidArgument(message),
        StatusCode::UNAUTHORIZED => BoxliteError::InvalidState(message),
        StatusCode::NOT_FOUND => BoxliteError::NotFound(message),
        StatusCode::CONFLICT => BoxliteError::InvalidState(message),
        _ => BoxliteError::Internal(message),
    }
}

fn transport_error(method: &Method, path: &str, error: hyper::Error) -> BoxliteError {
    BoxliteError::Network(format!("OpenCode {method} {path}: {error}"))
}

fn timed_out(method: &Method, path: &str) -> BoxliteError {
    BoxliteError::Network(format!(
        "OpenCode {method} {path} timed out after {REQUEST_TIMEOUT:?}"
    ))
}
