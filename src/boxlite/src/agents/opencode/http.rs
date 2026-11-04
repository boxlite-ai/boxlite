//! HTTP/1.1 JSON and SSE client for the Box's OpenCode server.
//!
//! Every request opens its own Box tunnel connection, so no connection state
//! outlives a call. The event stream keeps one connection until its reader
//! drops it or the server ends it.

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
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::litebox::{BoxConnection, NetworkHandle, TunnelOptions};
use crate::runtime::backend::BoxNetworkBackend;
use crate::{BoxliteError, BoxliteResult};

/// Largest JSON response read; a larger body fails instead of growing memory.
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
/// Largest single SSE event; a larger one fails the stream instead of growing memory.
const MAX_EVENT_BYTES: usize = 1024 * 1024;
/// Bound on one JSON exchange; agent work itself runs asynchronously in the server.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Events held for a slow reader. Beyond this the connection stops reading,
/// and OpenCode fails an overflowing subscriber, which the reader then sees.
const EVENT_BUFFER: usize = 64;

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

    /// Subscribe to the server's live events. `keep` maps each native event,
    /// in order, to an item, to an error that ends the stream, or to nothing,
    /// and may track state across events. The stream also ends with one error
    /// item when the server closes or fails it or sends an invalid or oversized
    /// event, because later events are lost.
    pub(super) async fn events<T, F>(
        &self,
        path: &str,
        keep: F,
    ) -> BoxliteResult<ReceiverStream<BoxliteResult<T>>>
    where
        T: Send + 'static,
        F: FnMut(Value) -> Option<BoxliteResult<T>> + Send + 'static,
    {
        // One deadline covers the error body too, so a stalled one cannot hang opening.
        let opening = async {
            let response = self.send(Method::GET, path, None).await?;
            let status = response.status();
            if status.is_success() {
                return Ok(response);
            }
            let body = read_body(&Method::GET, path, response).await?;
            Err(native_error(&Method::GET, path, status, &body))
        };
        let response = tokio::time::timeout(REQUEST_TIMEOUT, opening)
            .await
            .map_err(|_| timed_out(&Method::GET, path))??;
        let (sender, receiver) = mpsc::channel(EVENT_BUFFER);
        tokio::spawn(forward_events(response.into_body(), sender, keep));
        Ok(ReceiverStream::new(receiver))
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

/// Copy parsed events into `sender` until the reader leaves or the stream stops.
async fn forward_events<T, F>(
    mut body: Incoming,
    sender: mpsc::Sender<BoxliteResult<T>>,
    mut keep: F,
) where
    F: FnMut(Value) -> Option<BoxliteResult<T>>,
{
    let mut parser = EventParser::default();
    loop {
        let frame = tokio::select! {
            _ = sender.closed() => return,
            frame = body.frame() => frame,
        };
        let chunk = match frame {
            None => {
                let ended = BoxliteError::Network(
                    "OpenCode event stream ended; later events are not delivered".into(),
                );
                let _ = sender.send(Err(ended)).await;
                return;
            }
            Some(Err(error)) => {
                let failed =
                    BoxliteError::Network(format!("OpenCode event stream failed: {error}"));
                let _ = sender.send(Err(failed)).await;
                return;
            }
            Some(Ok(frame)) => match frame.into_data() {
                Ok(chunk) => chunk,
                Err(_) => continue,
            },
        };
        let mut events = Vec::new();
        let parsed = parser.push(&chunk, &mut events);
        let items = events
            .into_iter()
            .filter_map(&mut keep)
            .chain(parsed.err().map(Err));
        for item in items {
            let ends = item.is_err();
            if sender.send(item).await.is_err() || ends {
                return;
            }
        }
    }
}

/// Splits a `text/event-stream` body into the JSON carried by each event's
/// `data` lines. Comments such as heartbeats and other fields are ignored.
#[derive(Default)]
pub(super) struct EventParser {
    /// Received bytes after the last line end.
    pending: Vec<u8>,
    /// Length of the `pending` prefix already searched for a line end.
    searched: usize,
    data: String,
}

impl EventParser {
    /// Append the events `chunk` completes to `events`. On an invalid or
    /// oversized event, the events before it stay appended, so the caller can
    /// deliver them ahead of the error.
    ///
    /// Each byte is searched for a line end once, however the body is split
    /// into chunks, and complete lines are read in place and dropped together,
    /// so parsing costs linear time in the bytes received.
    pub(super) fn push(&mut self, chunk: &[u8], events: &mut Vec<Value>) -> BoxliteResult<()> {
        self.pending.extend_from_slice(chunk);
        let mut start = 0;
        while let Some(offset) = self.pending[self.searched..]
            .iter()
            .position(|byte| *byte == b'\n')
        {
            let end = self.searched + offset;
            let line = std::str::from_utf8(&self.pending[start..end])
                .map_err(|_| BoxliteError::Internal("OpenCode sent a non-UTF-8 event line".into()))?
                .trim_end_matches('\r');
            start = end + 1;
            self.searched = start;
            if line.is_empty() {
                if !self.data.is_empty() {
                    let data = std::mem::take(&mut self.data);
                    events.push(serde_json::from_str(&data).map_err(|error| {
                        BoxliteError::Internal(format!("OpenCode sent an invalid event: {error}"))
                    })?);
                }
            } else if let Some(value) = line.strip_prefix("data:") {
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data.push_str(value.strip_prefix(' ').unwrap_or(value));
                if self.data.len() > MAX_EVENT_BYTES {
                    return Err(oversized_event());
                }
            }
        }
        self.pending.drain(..start);
        self.searched = self.pending.len();
        if self.pending.len() + self.data.len() > MAX_EVENT_BYTES {
            return Err(oversized_event());
        }
        Ok(())
    }
}

fn oversized_event() -> BoxliteError {
    BoxliteError::ResourceExhausted(format!("OpenCode event exceeds {MAX_EVENT_BYTES} bytes"))
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
