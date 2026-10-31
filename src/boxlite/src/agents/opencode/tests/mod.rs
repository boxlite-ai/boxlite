//! Adapter tests against a scripted OpenCode server on in-memory connections.
//! Response shapes follow what OpenCode 2.2.2 returned to the same requests.

use super::*;
use crate::litebox::{BoxConnection, BoxTunnel, TunnelOptions};
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

/// Answers each tunnel connection with the next scripted response and keeps
/// every request it received, so tests assert on what the adapter sent. An
/// empty response closes the connection without replying, as a lost response.
#[derive(Default)]
struct ScriptedServer {
    responses: Mutex<VecDeque<String>>,
    requests: Arc<Mutex<Vec<String>>>,
}

#[async_trait::async_trait]
impl BoxNetworkBackend for ScriptedServer {
    async fn tunnel(
        &self,
        _target: SocketAddr,
        _options: TunnelOptions,
    ) -> BoxliteResult<BoxTunnel> {
        let response = self.responses.lock().unwrap().pop_front();
        let response = Arc::new(Mutex::new(response));
        let requests = Arc::clone(&self.requests);
        Ok(BoxTunnel::new(None, move || {
            let response = response.lock().unwrap().take();
            let requests = Arc::clone(&requests);
            async move {
                let response = response
                    .ok_or_else(|| BoxliteError::Network("no scripted response left".into()))?;
                let (client, mut server) = UnixStream::pair()?;
                tokio::spawn(async move {
                    let request = read_request(&mut server).await;
                    requests.lock().unwrap().push(request);
                    let _ = server.write_all(response.as_bytes()).await;
                    let _ = server.shutdown().await;
                });
                Ok(BoxConnection::new(client))
            }
        }))
    }
}

type Requests = Arc<Mutex<Vec<String>>>;

fn scripted_session(responses: Vec<String>) -> (Session, Requests) {
    let backend = Arc::new(ScriptedServer {
        responses: Mutex::new(responses.into()),
        requests: Arc::default(),
    });
    let requests = Arc::clone(&backend.requests);
    let server = Arc::new(Server::new(backend, "password"));
    let info = json!({ "id": "ses_test", "model": { "providerID": "fake", "id": "model" } });
    (Session::new(server, &info).unwrap(), requests)
}

/// Read one request head and its `content-length` body.
async fn read_request(stream: &mut UnixStream) -> String {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let read = stream.read(&mut buffer).await.unwrap_or(0);
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
        let text = String::from_utf8_lossy(&bytes);
        if let Some(end) = text.find("\r\n\r\n") {
            let length =
                header(&text[..end], "content-length").map_or(0, |value| value.parse().unwrap());
            if bytes.len() >= end + 4 + length {
                break;
            }
        }
    }
    String::from_utf8(bytes).unwrap()
}

fn header<'a>(request: &'a str, name: &str) -> Option<&'a str> {
    request.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

fn body_of(request: &str) -> Value {
    serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap()
}

fn ok(body: Value) -> String {
    respond("200 OK", body)
}

fn respond(status: &str, body: Value) -> String {
    let body = body.to_string();
    format!(
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    )
}

#[tokio::test]
async fn send_queues_text_under_a_minted_id_with_the_password() {
    let (session, requests) = scripted_session(vec![ok(
        json!({ "data": { "type": "user", "delivery": "queue" } }),
    )]);

    let state = session
        .send("hello", &AgentSendOptions::default())
        .await
        .unwrap();

    assert!(state.id.starts_with("msg_"), "{}", state.id);
    assert_eq!(
        (state.status, state.agent_id.as_str()),
        (AgentTurnStatus::Queued, "ses_test")
    );
    let request = requests.lock().unwrap()[0].clone();
    assert!(
        request.starts_with("POST /api/session/ses_test/prompt HTTP/1.1"),
        "{request}"
    );
    // base64("opencode:password")
    assert_eq!(
        header(&request, "authorization"),
        Some("Basic b3BlbmNvZGU6cGFzc3dvcmQ=")
    );
    assert_eq!(
        body_of(&request),
        json!({ "id": state.id, "text": "hello", "delivery": "queue" })
    );
}

#[tokio::test]
async fn a_lost_send_response_is_retried_with_the_same_id() {
    let (session, requests) = scripted_session(vec![String::new(), ok(json!({ "data": {} }))]);

    let state = session
        .send("hello", &AgentSendOptions::default())
        .await
        .unwrap();

    let bodies: Vec<Value> = requests
        .lock()
        .unwrap()
        .iter()
        .map(|request| body_of(request))
        .collect();
    assert_eq!(bodies.len(), 2);
    assert_eq!(bodies[0], bodies[1], "the retry repeats the minted ID");
    assert_eq!(bodies[1]["id"], json!(state.id));
}

#[tokio::test]
async fn a_send_lost_twice_names_the_turn_to_reconcile() {
    let (session, requests) = scripted_session(vec![String::new(), String::new()]);

    let error = session
        .send("hello", &AgentSendOptions::default())
        .await
        .err()
        .unwrap();

    let turn_id = body_of(&requests.lock().unwrap()[0])["id"]
        .as_str()
        .unwrap()
        .to_owned();
    match error {
        BoxliteError::Network(message) => {
            assert!(message.contains("is uncertain"), "{message}");
            assert!(
                message.contains(&turn_id) && message.contains("may run it twice"),
                "{message}"
            );
        }
        other => panic!("expected Network, got {other}"),
    }
    assert_eq!(
        requests.lock().unwrap().len(),
        2,
        "one retry, then no further submission"
    );
}

#[tokio::test]
async fn native_errors_keep_their_tag_and_class() {
    let missing = json!({ "_tag": "SessionNotFoundError", "sessionID": "ses_test", "message": "Session not found" });
    let (session, _) = scripted_session(vec![respond("404 Not Found", missing)]);

    let error = session
        .send("hello", &AgentSendOptions::default())
        .await
        .err()
        .unwrap();

    match error {
        BoxliteError::NotFound(message) => assert!(
            message.contains("SessionNotFoundError Session not found"),
            "{message}"
        ),
        other => panic!("expected NotFound, got {other}"),
    }
}

#[test]
fn session_request_mints_an_id_and_maps_model_and_directory() {
    let mut options = AgentCreateOptions {
        cwd: Some("/work".into()),
        ..Default::default()
    };
    options.config.model = Some("fake/model".into());
    let request = SessionRequest::new(&options).unwrap();
    assert!(is_session_id(&request.id), "{}", request.id);
    assert_eq!(
        (
            &request.body["id"],
            &request.body["model"],
            &request.body["location"]
        ),
        (
            &json!(request.id),
            &json!({ "providerID": "fake", "id": "model" }),
            &json!({ "directory": "/work" })
        )
    );
    assert_eq!(
        request.body["permissions"],
        json!([
            { "action": "read", "resource": "*.env", "effect": "deny" },
            { "action": "read", "resource": "*.env.*", "effect": "deny" },
            { "action": "read", "resource": "*.env.example", "effect": "allow" },
            { "action": "question", "resource": "*", "effect": "deny" },
        ]),
        "asks nobody can answer are denied"
    );

    options.config.model = Some("model-without-provider".into());
    assert!(matches!(
        SessionRequest::new(&options),
        Err(BoxliteError::InvalidArgument(_))
    ));
    options.config.model = None;
    options.config.permissions = Some(Value::Null);
    assert!(
        SessionRequest::new(&options).is_ok(),
        "JSON null means no permissions"
    );
}

#[test]
fn only_verified_versions_are_accepted() {
    assert!(check_version("2.2.2").is_ok());
    for version in ["2.0.15", "2.2.3", "2.2.2-beta.1"] {
        assert!(
            matches!(check_version(version), Err(BoxliteError::Unsupported(message)) if message.contains(version)),
            "{version}"
        );
    }
}

#[test]
fn setup_replies_map_to_a_service_state_or_a_refusal() {
    assert_eq!(
        parse_setup("stopped\nsecret\n").unwrap(),
        (ServiceState::Stopped, "secret".to_string())
    );
    assert_eq!(
        parse_setup("live\nsecret").unwrap(),
        (ServiceState::Live, "secret".to_string())
    );

    let refusal = |reply: &str| match parse_setup(reply) {
        Err(BoxliteError::InvalidState(message)) => message,
        other => panic!("expected InvalidState for {reply:?}, got {other:?}"),
    };
    assert!(refusal("remote\n").contains("opencode service unset remote"));
    let foreign = refusal("foreign http://127.0.0.1:4096\n");
    assert!(
        foreign.contains("runs at http://127.0.0.1:4096"),
        "{foreign}"
    );
    let long = format!("foreign http://{}\n", "a".repeat(500));
    assert!(refusal(&long).len() < 400, "a reported URL is truncated");

    for reply in ["live\n", "", "garbage\nsecret"] {
        match parse_setup(reply) {
            Err(BoxliteError::Internal(message)) => {
                assert!(!message.contains("secret"), "{message}")
            }
            other => panic!("expected Internal for {reply:?}, got {other:?}"),
        }
    }
}

#[test]
fn native_ids_are_checked_before_use_in_paths() {
    assert!(is_session_id("ses_e73cc8962ffej6cXCLaMIrn4mr"));
    assert!(is_session_id(&mint_id("ses_")));
    assert!(!is_session_id("ses_../../api"));
    assert!(!is_session_id("ses_"));
}
