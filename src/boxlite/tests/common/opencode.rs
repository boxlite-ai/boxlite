//! Shared OpenCode agent test harness: a scripted OpenAI-compatible model on
//! the host and the OpenCode provider config that points a Box at it. Used by
//! the core `agents_opencode` tests and, through `#[path]`, the CLI `agents` tests.

use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// The OpenCode 2.2.2 glibc Linux binary each agent test copies into its Box.
pub const BINARY_ENV: &str = "BOXLITE_TEST_OPENCODE_BINARY";

/// Start the fake model on a loopback port; returns the port and its log.
pub async fn start_fake_model() -> (u16, ModelLog) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let log = ModelLog::default();
    tokio::spawn(serve_fake_model(listener, Arc::clone(&log)));
    (port, log)
}

/// OpenCode config that routes `fake/fake-model` to the fake model on `port`,
/// reached from the Box through `host.boxlite.internal`.
pub fn provider_config(port: u16) -> Value {
    json!({
        "provider": { "fake": { "npm": "@ai-sdk/openai-compatible", "name": "Fake",
            "options": { "baseURL": format!("http://host.boxlite.internal:{port}/v1"), "apiKey": "fake" },
            "models": { "fake-model": { "name": "Fake" } } } },
        "small_model": "fake/fake-model",
    })
}

/// What the fake model saw, in order: each prompt as `user: <text>` and each
/// tool result as `tool: <message JSON>`.
pub type ModelLog = Arc<Mutex<Vec<String>>>;

/// Answer chat completions, keyed on the last user text: SLOW streams one
/// chunk per second for a minute, READ <file> calls the `read` tool on that
/// file, ASK calls the `question` tool, and anything else answers
/// `pong: <text>`. After a tool result it answers `after tool`, naming a
/// `SECRET` the result contained.
async fn serve_fake_model(listener: TcpListener, log: ModelLog) {
    while let Ok((stream, _)) = listener.accept().await {
        tokio::spawn(answer_completion(stream, Arc::clone(&log)));
    }
}

async fn answer_completion(mut stream: TcpStream, log: ModelLog) {
    let Some(body) = read_json_body(&mut stream).await else {
        return;
    };
    let messages = body["messages"].as_array().cloned().unwrap_or_default();
    let prompt = messages
        .iter()
        .rev()
        .find(|message| message["role"] == "user")
        .map(|message| match &message["content"] {
            Value::String(text) => text.clone(),
            parts => parts
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|part| part["text"].as_str())
                .collect(),
        })
        .unwrap_or_default();
    let chunk = |delta: Value, finish: Option<&str>| {
        json!({ "id": "c", "object": "chat.completion.chunk", "model": "fake-model",
            "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }] })
    };
    let text = |content: &str| chunk(json!({ "role": "assistant", "content": content }), None);
    let stop = chunk(json!({}), Some("stop"));
    let tool_call = |name: &str, arguments: Value| {
        let call = json!({ "index": 0, "id": format!("call_{name}"), "type": "function",
            "function": { "name": name, "arguments": arguments.to_string() } });
        vec![
            chunk(json!({ "role": "assistant", "tool_calls": [call] }), None),
            chunk(json!({}), Some("tool_calls")),
        ]
    };
    if body["stream"] != true {
        let completion = json!({ "id": "c", "object": "chat.completion", "model": "fake-model",
            "choices": [{ "index": 0, "message": { "role": "assistant", "content": "title" }, "finish_reason": "stop" }] })
        .to_string();
        let head = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            completion.len()
        );
        let _ = stream
            .write_all(format!("{head}{completion}").as_bytes())
            .await;
        return;
    }
    let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n";
    if stream.write_all(head.as_bytes()).await.is_err() {
        return;
    }
    let tool_result = messages.last().filter(|last| last["role"] == "tool");
    log.lock().unwrap().push(match tool_result {
        Some(result) => format!("tool: {result}"),
        None => format!("user: {prompt}"),
    });
    let (chunks, delay) = if let Some(result) = tool_result {
        // Echo a secret the tool returned, so a test sees what the model read.
        let reply = if result.to_string().contains("SECRET") {
            "after tool: read SECRET"
        } else {
            "after tool"
        };
        (vec![text(reply), stop], Duration::ZERO)
    } else if let Some(file) = prompt.strip_prefix("READ ") {
        (tool_call("read", json!({ "path": file })), Duration::ZERO)
    } else if prompt.contains("ASK") {
        let question = json!({ "questions": [{ "question": "Pick one", "header": "Choice",
            "options": [{ "label": "A", "description": "first" }, { "label": "B", "description": "second" }] }] });
        (tool_call("question", question), Duration::ZERO)
    } else if prompt.contains("SLOW") {
        let mut ticks: Vec<Value> = (0..60).map(|tick| text(&format!("tick {tick} "))).collect();
        ticks.push(stop);
        (ticks, Duration::from_secs(1))
    } else {
        (vec![text(&format!("pong: {prompt}")), stop], Duration::ZERO)
    };
    for item in chunks {
        if stream
            .write_all(format!("data: {item}\n\n").as_bytes())
            .await
            .is_err()
        {
            return;
        }
        tokio::time::sleep(delay).await;
    }
    let _ = stream.write_all(b"data: [DONE]\n\n").await;
}

async fn read_json_body(stream: &mut TcpStream) -> Option<Value> {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = stream
            .read(&mut buffer)
            .await
            .ok()
            .filter(|read| *read > 0)?;
        request.extend_from_slice(&buffer[..read]);
        let text = String::from_utf8_lossy(&request).into_owned();
        let Some(end) = text.find("\r\n\r\n") else {
            continue;
        };
        let length = text[..end]
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .map(|value| value.trim().parse::<usize>().unwrap())
            })
            .unwrap_or(0);
        if request.len() >= end + 4 + length {
            return serde_json::from_slice(&request[end + 4..end + 4 + length]).ok();
        }
    }
}
