//! Bounded SSE decoding for remote agent events.

use futures::StreamExt;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use super::super::{AgentEvent, AgentEventStream, AgentEventsOptions};
use crate::rest::client::ApiClient;
use crate::rest::error::map_http_body;
use crate::{BoxliteError, BoxliteResult};

const MAX_EVENT_BYTES: usize = 1024 * 1024;
const EVENT_BUFFER: usize = 64;
// Allow two missed 15-second server heartbeats before reporting a stalled stream.
const READ_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Deserialize)]
struct WireEvent {
    cursor: Option<String>,
    agent_id: String,
    turn_id: Option<String>,
    kind: String,
    data: Value,
}

#[derive(Default)]
struct Parser {
    line: Vec<u8>,
    data: String,
    event: String,
    after_cr: bool,
    started: bool,
}

impl Parser {
    fn feed(&mut self, byte: u8) -> BoxliteResult<Option<(String, String)>> {
        if self.after_cr {
            self.after_cr = false;
            if byte == b'\n' {
                return Ok(None);
            }
        }
        if byte != b'\r' && byte != b'\n' {
            self.line.push(byte);
            if self.line.len() + self.data.len() > MAX_EVENT_BYTES {
                return Err(BoxliteError::ResourceExhausted(
                    "agent event exceeds 1 MiB".into(),
                ));
            }
            return Ok(None);
        }
        self.after_cr = byte == b'\r';
        let line = std::str::from_utf8(&self.line)
            .map_err(|_| BoxliteError::Internal("agent event is not UTF-8".into()))?;
        let line = if self.started {
            line
        } else {
            self.started = true;
            line.strip_prefix('\u{feff}').unwrap_or(line)
        };
        let mut completed = None;
        if line.is_empty() {
            if !self.data.is_empty() {
                self.data.pop();
                completed = Some((
                    std::mem::take(&mut self.event),
                    std::mem::take(&mut self.data),
                ));
            } else {
                self.event.clear();
            }
        } else if !line.starts_with(':') {
            let (field, value) = line.split_once(':').unwrap_or((line, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match field {
                "event" => self.event = value.to_owned(),
                "data" => {
                    self.data.push_str(value);
                    self.data.push('\n');
                }
                _ => {}
            }
        }
        self.line.clear();
        if self.event.len() + self.data.len() > MAX_EVENT_BYTES {
            return Err(BoxliteError::ResourceExhausted(
                "agent event exceeds 1 MiB".into(),
            ));
        }
        Ok(completed)
    }
}

pub(super) async fn open(
    client: &ApiClient,
    path: &str,
    agent_id: &str,
    turn_id: Option<&str>,
    options: &AgentEventsOptions,
) -> BoxliteResult<AgentEventStream> {
    let response = client
        .agent_events(&format!("{path}/events"), options.after.as_deref(), turn_id)
        .await?;
    let agent_id = agent_id.to_owned();
    let turn_id = turn_id.map(str::to_owned);
    let (sender, receiver) = mpsc::channel(EVENT_BUFFER);
    tokio::spawn(async move {
        let mut parser = Parser::default();
        let mut stream = response.bytes_stream();
        loop {
            let next = tokio::select! {
                _ = sender.closed() => return,
                next = stream.next() => next,
                _ = tokio::time::sleep(READ_IDLE_TIMEOUT) => {
                    let _ = sender.send(Err(BoxliteError::Network(
                        "agent event stream idle for 30 seconds".into(),
                    ))).await;
                    return;
                }
            };
            let chunk = match next {
                Some(Ok(chunk)) => chunk,
                Some(Err(error)) => {
                    let _ = sender
                        .send(Err(BoxliteError::Network(format!(
                            "agent event stream failed: {error}"
                        ))))
                        .await;
                    return;
                }
                None => {
                    let _ = sender
                        .send(Err(BoxliteError::Network(
                            "agent event stream ended".into(),
                        )))
                        .await;
                    return;
                }
            };
            for byte in chunk {
                let frame = match parser.feed(byte) {
                    Ok(Some(frame)) => frame,
                    Ok(None) => continue,
                    Err(error) => {
                        let _ = sender.send(Err(error)).await;
                        return;
                    }
                };
                let (name, data) = frame;
                let result = if name == "error" {
                    Err(map_http_body(
                        reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                        &data,
                    ))
                } else if name == "agent" || name.is_empty() {
                    serde_json::from_str::<WireEvent>(&data)
                        .map_err(|error| {
                            BoxliteError::Internal(format!("invalid agent event: {error}"))
                        })
                        .and_then(|event| {
                            if event.agent_id != agent_id
                                || turn_id
                                    .as_ref()
                                    .is_some_and(|id| event.turn_id.as_ref() != Some(id))
                            {
                                return Err(BoxliteError::Internal(
                                    "agent event has wrong parent".into(),
                                ));
                            }
                            Ok(AgentEvent {
                                cursor: event.cursor,
                                agent_id: event.agent_id,
                                turn_id: event.turn_id,
                                kind: event.kind,
                                data: event.data,
                            })
                        })
                } else {
                    Err(BoxliteError::Internal("unknown agent event type".into()))
                };
                let failed = result.is_err();
                if sender.send(result).await.is_err() || failed {
                    return;
                }
            }
        }
    });
    Ok(Box::pin(ReceiverStream::new(receiver)))
}

#[cfg(test)]
#[path = "tests/events.rs"]
mod tests;
