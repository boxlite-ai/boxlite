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
mod tests {
    use super::*;

    #[test]
    fn parser_handles_chunk_boundaries_and_all_line_endings() {
        let mut parser = Parser::default();
        let input = b": keepalive\r\nevent: agent\rdata: {\"text\":\r\ndata: \"hi\"}\n\n";
        let frames: Vec<_> = input
            .iter()
            .filter_map(|byte| parser.feed(*byte).unwrap())
            .collect();
        assert_eq!(
            frames,
            vec![("agent".to_string(), "{\"text\":\n\"hi\"}".to_string())]
        );
        let value: Value = serde_json::from_str(&frames[0].1).unwrap();
        assert_eq!(value["text"], "hi");
    }

    #[test]
    fn parser_rejects_oversized_or_invalid_utf8_lines() {
        let mut parser = Parser::default();
        for _ in 0..MAX_EVENT_BYTES {
            parser.feed(b'x').unwrap();
        }
        assert!(matches!(
            parser.feed(b'x'),
            Err(BoxliteError::ResourceExhausted(_))
        ));
        let mut parser = Parser::default();
        parser.feed(0xff).unwrap();
        assert!(matches!(parser.feed(b'\n'), Err(BoxliteError::Internal(_))));
    }

    #[test]
    fn parser_accepts_initial_utf8_bom() {
        let mut parser = Parser::default();
        let frames: Vec<_> = "\u{feff}data: hello\n\n"
            .bytes()
            .filter_map(|byte| parser.feed(byte).unwrap())
            .collect();
        assert_eq!(frames, vec![(String::new(), "hello".to_string())]);
    }

    #[tokio::test]
    async fn stream_delivers_events_before_one_terminal_error() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
            }
            let body = concat!(
                "event: agent\ndata: {\"cursor\":null,\"agent_id\":\"agent-1\",\"turn_id\":null,\"kind\":\"message\",\"data\":{}}\n\n",
                "event: error\ndata: {\"error\":{\"message\":\"stream unavailable\",\"type\":\"UnsupportedError\",\"code\":\"unsupported\"}}\n\n"
            );
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        });
        let client =
            ApiClient::new(&crate::BoxliteRestOptions::new(format!("http://{addr}"))).unwrap();
        let mut stream = open(
            &client,
            "/boxes/box-1/agents/agent-1",
            "agent-1",
            None,
            &Default::default(),
        )
        .await
        .unwrap();
        assert_eq!(stream.next().await.unwrap().unwrap().kind, "message");
        assert!(matches!(
            stream.next().await.unwrap(),
            Err(BoxliteError::Unsupported(_))
        ));
        assert!(stream.next().await.is_none());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn unknown_event_error_is_bounded() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
            }
            let body = format!("event: {}\ndata: {{}}\n\n", "x".repeat(4096));
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        });
        let client =
            ApiClient::new(&crate::BoxliteRestOptions::new(format!("http://{addr}"))).unwrap();
        let mut stream = open(
            &client,
            "/boxes/box-1/agents/agent-1",
            "agent-1",
            None,
            &Default::default(),
        )
        .await
        .unwrap();
        let error = stream.next().await.unwrap().unwrap_err().to_string();
        assert!(error.contains("unknown agent event type"), "{error}");
        assert!(error.len() < 256, "error contains {} bytes", error.len());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn dropping_stream_closes_the_http_connection() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
            }
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .await
                .unwrap();
            socket.read(&mut byte).await.unwrap()
        });
        let client =
            ApiClient::new(&crate::BoxliteRestOptions::new(format!("http://{addr}"))).unwrap();
        let stream = open(
            &client,
            "/boxes/box-1/agents/agent-1",
            "agent-1",
            None,
            &Default::default(),
        )
        .await
        .unwrap();
        drop(stream);
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(5), server)
                .await
                .unwrap()
                .unwrap(),
            0
        );
    }
}
