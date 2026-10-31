//! Adapter tests against a scripted OpenCode server on in-memory connections.
//! Response shapes follow what OpenCode 2.2.2 returned to the same requests.

use super::*;
use crate::agents::{Agent, AgentWaitOptions};
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

fn request_lines(requests: &Requests) -> Vec<String> {
    requests
        .lock()
        .unwrap()
        .iter()
        .map(|request| request.lines().next().unwrap_or_default().to_owned())
        .collect()
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

fn empty() -> String {
    ok(json!({ "data": [] }))
}

fn user(id: &str, created: f64) -> Value {
    json!({ "id": id, "type": "user", "text": "hi", "time": { "created": created } })
}

fn assistant(id: &str, text: &str, finish: Option<&str>) -> Value {
    let mut message = json!({
        "id": id, "type": "assistant", "agent": "build",
        "content": [{ "type": "text", "text": text }],
        "tokens": { "input": 3, "output": 2 }, "cost": 0,
    });
    if let Some(finish) = finish {
        message["finish"] = json!(finish);
    }
    message
}

fn idle(outcome: &str) -> Value {
    json!({ "id": "msg_idle", "type": "idle", "outcome": outcome })
}

/// The notice OpenCode adds before it continues a run, here after a restart.
fn synthetic() -> Value {
    json!({ "id": "msg_syn", "type": "synthetic", "description": "Continuing after restart",
            "text": "The server restarted while you were working." })
}

/// History as OpenCode pages it: newest first, ending at the turn's input.
fn history(newest_first: Vec<Value>) -> String {
    ok(json!({ "data": newest_first, "cursor": { "next": "eyJuZXh0IjoxfQ" } }))
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

    assert!(is_message_id(&state.id), "{}", state.id);
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
                message.contains(&format!("agent.get_turn({turn_id:?})")),
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
async fn a_turn_in_the_inbox_is_queued() {
    let inbox = ok(json!({ "data": [{ "id": "msg_1", "type": "user", "delivery": "queue" }] }));
    let (session, requests) = scripted_session(vec![inbox]);

    let state = session.turn("msg_1").await.unwrap();

    assert_eq!(state.status, AgentTurnStatus::Queued);
    assert_eq!(
        request_lines(&requests),
        ["GET /api/session/ses_test/inbox HTTP/1.1"]
    );
}

#[tokio::test]
async fn a_turn_in_history_reports_its_execution_outcome() {
    let page = history(vec![
        idle("succeeded"),
        assistant("msg_2", "pong: hi", Some("stop")),
        user("msg_1", 10.0),
    ]);
    let (session, requests) = scripted_session(vec![empty(), page]);

    let state = session.turn("msg_1").await.unwrap();

    assert_eq!(state.status, AgentTurnStatus::Completed);
    let result = state.result.unwrap();
    assert_eq!(
        (result.text.as_deref(), result.outcome),
        (Some("pong: hi"), Some(AgentOutcome::Answer))
    );
    assert_eq!(result.usage.unwrap()[0]["message_id"], "msg_2");
    assert_eq!(
        request_lines(&requests),
        [
            "GET /api/session/ses_test/inbox HTTP/1.1",
            "GET /api/session/ses_test/message?order=desc&limit=50 HTTP/1.1",
        ]
    );
}

#[tokio::test]
async fn a_turn_without_an_outcome_stays_running() {
    // A Box stop cut the step off; the managed service resumes it at boot.
    let page = history(vec![assistant("msg_2", "tick", None), user("msg_1", 10.0)]);
    let (session, requests) = scripted_session(vec![empty(), page, empty(), empty()]);

    let state = session.turn("msg_1").await.unwrap();

    assert_eq!(state.status, AgentTurnStatus::Running);
    assert!(state.result.is_none());
    assert_eq!(
        request_lines(&requests),
        [
            "GET /api/session/ses_test/inbox HTTP/1.1",
            "GET /api/session/ses_test/message?order=desc&limit=50 HTTP/1.1",
            "GET /api/permission/request HTTP/1.1",
            "GET /api/form HTTP/1.1",
        ]
    );
}

#[tokio::test]
async fn a_turn_missing_from_history_is_not_found() {
    let first =
        ok(json!({ "data": [user("msg_9", 10.0)], "cursor": { "next": "eyJwYWdlIjoyfQ" } }));
    let last = ok(json!({ "data": [], "cursor": { "next": null } }));
    let (session, requests) = scripted_session(vec![empty(), first, last]);

    let error = session.turn("msg_1").await.err().unwrap();

    assert!(matches!(error, BoxliteError::NotFound(_)), "{error}");
    // OpenCode 2.2.2 answers InvalidCursorError when a cursor comes with `order`.
    assert_eq!(
        request_lines(&requests)[2],
        "GET /api/session/ses_test/message?limit=50&cursor=eyJwYWdlIjoyfQ HTTP/1.1"
    );
}

#[tokio::test]
async fn a_history_cursor_outside_base64url_never_reaches_a_request() {
    let page = ok(json!({ "data": [user("msg_9", 10.0)], "cursor": { "next": "a&order=asc" } }));
    let (session, requests) = scripted_session(vec![empty(), page]);

    let error = session.turn("msg_1").await.err().unwrap();

    assert!(matches!(error, BoxliteError::NotFound(_)), "{error}");
    assert_eq!(
        request_lines(&requests),
        [
            "GET /api/session/ses_test/inbox HTTP/1.1",
            "GET /api/session/ses_test/message?order=desc&limit=50 HTTP/1.1",
        ]
    );
}

#[tokio::test]
async fn history_is_searched_for_at_most_1000_messages() {
    let pages = (0..HISTORY_MAX_PAGES).map(|page| {
        ok(json!({ "data": [user(&format!("msg_old{page}"), 10.0)],
                   "cursor": { "next": format!("cGFnZQ{page}") } }))
    });
    let (session, requests) = scripted_session(std::iter::once(empty()).chain(pages).collect());

    let error = session.turn("msg_1").await.err().unwrap();

    assert!(
        matches!(&error, BoxliteError::NotFound(message) if message.contains("last 1000 messages")),
        "{error}"
    );
    assert_eq!(request_lines(&requests).len(), 1 + HISTORY_MAX_PAGES);
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

#[tokio::test]
async fn a_running_turn_waits_on_its_own_and_its_subagent_requests() {
    // Shapes recorded on 2.2.2: a `.env` read, the question tool, and a subagent read.
    let page = history(vec![assistant("msg_2", "", None), user("msg_1", 10.0)]);
    let permissions = ok(json!({ "data": [
        { "id": "per_own", "sessionID": "ses_test", "action": "read", "resources": [".env"],
          "source": { "type": "tool", "messageID": "msg_2", "id": "call_read" } },
        { "id": "per_child", "sessionID": "ses_child", "action": "read", "resources": [".env"],
          "source": { "type": "tool", "messageID": "msg_c1", "id": "call_read" } },
        { "id": "per_other", "sessionID": "ses_test", "action": "bash", "resources": ["ls"],
          "source": { "type": "tool", "messageID": "msg_elsewhere", "id": "call_bash" } },
    ] }));
    let forms = ok(json!({ "data": [
        { "id": "frm_own", "sessionID": "ses_test", "title": "Questions",
          "metadata": { "kind": "question", "tool": { "messageID": "msg_2", "id": "call_question" } },
          "fields": [{ "key": "q0", "title": "Choice", "description": "Pick one", "type": "string", "custom": true }] },
    ] }));
    let child = ok(
        json!({ "data": { "id": "ses_child", "parentID": "ses_test", "time": { "created": 12.0 } } }),
    );
    let (session, _) = scripted_session(vec![empty(), page, permissions, forms, child]);

    let state = session.turn("msg_1").await.unwrap();

    assert_eq!(state.status, AgentTurnStatus::WaitingInput);
    let ids: Vec<&str> = state
        .requests
        .iter()
        .map(|request| request.id.as_str())
        .collect();
    assert_eq!(ids, ["per_own", "per_child", "frm_own"]);
    assert!(
        state
            .requests
            .iter()
            .all(|request| request.turn_id == "msg_1")
    );
    match &state.requests[0].kind {
        AgentRequestKind::Permission { tool, arguments } => {
            assert_eq!(
                (tool.as_str(), &arguments["resources"]),
                ("read", &json!([".env"]))
            );
        }
        other => panic!("expected a permission, got {other:?}"),
    }
    match &state.requests[2].kind {
        AgentRequestKind::Question { text, schema } => {
            assert_eq!(text, "Pick one");
            assert_eq!(schema.as_ref().unwrap()[0]["key"], "q0");
        }
        other => panic!("expected a question, got {other:?}"),
    }
}

#[tokio::test]
async fn a_subagent_from_an_earlier_turn_does_not_block_this_one() {
    let page = history(vec![assistant("msg_2", "", None), user("msg_1", 10.0)]);
    let permissions = ok(json!({ "data": [
        { "id": "per_child", "sessionID": "ses_child", "action": "read", "resources": [".env"],
          "source": { "type": "tool", "messageID": "msg_c1", "id": "call_read" } },
    ] }));
    let earlier_child = ok(
        json!({ "data": { "id": "ses_child", "parentID": "ses_test", "time": { "created": 5.0 } } }),
    );
    let (session, _) = scripted_session(vec![empty(), page, permissions, empty(), earlier_child]);

    let state = session.turn("msg_1").await.unwrap();

    assert_eq!(state.status, AgentTurnStatus::Running);
    assert!(state.requests.is_empty());
}

#[tokio::test]
async fn malformed_native_session_ids_never_reach_a_request_path() {
    let page = history(vec![assistant("msg_2", "", None), user("msg_1", 10.0)]);
    let permissions = ok(json!({ "data": [
        { "id": "per_bad", "sessionID": "ses_x/../../api/config", "action": "read", "resources": [".env"],
          "source": { "type": "tool", "messageID": "msg_c1", "id": "call_read" } },
        { "id": "per_child", "sessionID": "ses_child", "action": "read", "resources": [".env"],
          "source": { "type": "tool", "messageID": "msg_c2", "id": "call_read" } },
    ] }));
    let child = ok(
        json!({ "data": { "id": "ses_child", "parentID": "ses_test/../../api/config",
                                     "time": { "created": 12.0 } } }),
    );
    let (session, requests) = scripted_session(vec![empty(), page, permissions, empty(), child]);

    let state = session.turn("msg_1").await.unwrap();

    assert_eq!(state.status, AgentTurnStatus::Running);
    assert!(state.requests.is_empty());
    let lines = request_lines(&requests);
    assert_eq!(lines.last().unwrap(), "GET /api/session/ses_child HTTP/1.1");
    assert!(!lines.iter().any(|line| line.contains("..")), "{lines:?}");
}

#[tokio::test]
async fn wait_deadline_returns_without_interrupting() {
    let page = history(vec![assistant("msg_2", "tick", None), user("msg_1", 10.0)]);
    let (session, requests) = scripted_session(vec![empty(), page, empty(), empty()]);
    let state = session.turn_state("msg_1", AgentTurnStatus::Running, None);
    let turn = Agent::new(session).turn(state);

    let error = turn
        .wait(AgentWaitOptions {
            timeout: Some(Duration::from_millis(200)),
        })
        .await
        .err()
        .unwrap();

    assert!(
        matches!(&error, BoxliteError::InvalidState(message) if message.contains("keeps running")),
        "{error}"
    );
    assert_eq!(
        request_lines(&requests),
        [
            "GET /api/session/ses_test/inbox HTTP/1.1",
            "GET /api/session/ses_test/message?order=desc&limit=50 HTTP/1.1",
            "GET /api/permission/request HTTP/1.1",
            "GET /api/form HTTP/1.1",
        ],
        "one poll, and no interrupt"
    );
}

#[tokio::test]
async fn wait_reports_a_turn_that_ended_without_an_outcome() {
    // The step never finished, and a later run took the next input.
    let page = history(vec![
        idle("succeeded"),
        assistant("msg_4", "x", Some("stop")),
        user("msg_3", 20.0),
        assistant("msg_2", "half", None),
        user("msg_1", 10.0),
    ]);
    let (session, _) = scripted_session(vec![empty(), page]);
    let state = session.turn_state("msg_1", AgentTurnStatus::Running, None);
    let turn = Agent::new(session).turn(state);

    let error = turn.wait(AgentWaitOptions::default()).await.err().unwrap();

    assert!(
        matches!(&error, BoxliteError::InvalidState(message) if message.contains("without a recorded outcome")),
        "{error}"
    );
}

#[test]
fn history_maps_each_execution_outcome() {
    let cancelled = observe(
        "msg_1",
        &[
            assistant("msg_2", "tick", Some("stop")),
            idle("interrupted"),
        ],
    );
    assert_eq!(cancelled.status, AgentTurnStatus::Cancelled);
    assert_eq!(cancelled.result.unwrap().text.as_deref(), Some("tick"));

    // Recorded on 2.2.2: a provider error ends the step with `finish: error`.
    let mut failing = assistant("msg_2", "", Some("error"));
    failing["error"] = json!({ "type": "provider.internal", "message": "fake provider failure" });
    let failed = observe("msg_1", &[failing, idle("failed")]);
    assert_eq!(failed.status, AgentTurnStatus::Failed);
    assert_eq!(
        failed.result.unwrap().error.as_deref(),
        Some("fake provider failure")
    );

    let running = observe("msg_1", &[assistant("msg_2", "tick", None)]);
    assert_eq!(
        (running.status, running.steps.as_slice()),
        (AgentTurnStatus::Running, ["msg_2".to_string()].as_slice())
    );
    assert!(running.result.is_none());
    assert_eq!(
        observe("msg_1", &[idle("paused")]).status,
        AgentTurnStatus::Unknown
    );
}

#[test]
fn queued_turns_in_one_busy_period_end_at_the_next_input() {
    // Recorded on 2.2.2: queued inputs drained in one busy period, one idle at the end.
    let later = [
        assistant("msg_2", "tick tick", Some("stop")),
        user("msg_3", 20.0),
        assistant("msg_4", "pong: queued A", Some("stop")),
        idle("succeeded"),
    ];
    let first = observe("msg_1", &later);
    assert_eq!(first.status, AgentTurnStatus::Completed);
    assert_eq!(first.result.unwrap().text.as_deref(), Some("tick tick"));
    assert_eq!(first.next_input, Some(20.0));
    assert_eq!(
        observe("msg_3", &later[2..])
            .result
            .unwrap()
            .text
            .as_deref(),
        Some("pong: queued A")
    );
}

#[test]
fn a_steered_input_shares_the_turn_and_a_cut_off_step_is_unknown() {
    let steered = [
        assistant("msg_2", "mine", Some("tool-calls")),
        user("msg_3", 20.0),
        assistant("msg_4", "theirs", Some("stop")),
        idle("succeeded"),
    ];
    let shared = observe("msg_1", &steered);
    assert_eq!(
        shared.status,
        AgentTurnStatus::Completed,
        "ends with the shared execution"
    );
    assert_eq!(
        (
            shared.result.unwrap().text.as_deref(),
            shared.steps.as_slice()
        ),
        (Some("mine"), ["msg_2".to_string()].as_slice())
    );

    // The step never finished; the next input came after a restart.
    let cut_off = [
        assistant("msg_2", "half", None),
        user("msg_3", 20.0),
        assistant("msg_4", "x", Some("stop")),
        idle("succeeded"),
    ];
    let unknown = observe("msg_1", &cut_off);
    assert_eq!(unknown.status, AgentTurnStatus::Unknown);
    assert!(unknown.result.is_none());
}

#[test]
fn a_resumed_run_completes_the_turn_and_the_input_it_delivered() {
    // At boot the service continues a cut-off turn after a `synthetic` notice
    // and delivers the queued input into the same run.
    let resumed = [
        assistant("msg_2", "half", None),
        synthetic(),
        user("msg_3", 20.0),
        assistant("msg_4", "pong: both", Some("stop")),
        idle("succeeded"),
    ];
    let first = observe("msg_1", &resumed);
    assert_eq!(first.status, AgentTurnStatus::Completed);
    let result = first.result.unwrap();
    assert_eq!((result.text.as_deref(), result.error), (Some("half"), None));
    let second = observe("msg_3", &resumed[3..]);
    assert_eq!(second.result.unwrap().text.as_deref(), Some("pong: both"));
}

#[test]
fn a_step_error_that_a_continuation_recovered_is_not_the_turn_error() {
    let mut cut_off = assistant("msg_2", "pon", None);
    cut_off["error"] = json!({ "type": "stream", "message": "stream ended early" });
    let later = [
        cut_off,
        synthetic(),
        assistant("msg_3", "g", Some("stop")),
        idle("succeeded"),
    ];

    let observed = observe("msg_1", &later);

    let result = observed.result.unwrap();
    assert_eq!(
        (observed.status, result.text.as_deref(), result.error),
        (AgentTurnStatus::Completed, Some("pong"), None)
    );
}

#[test]
fn a_failed_run_reports_the_reason_on_its_idle_marker() {
    // An exhausted resume fails the run with the reason on the idle marker.
    let mut failed = idle("failed");
    failed["error"] = json!({ "type": "aborted",
        "message": "Execution was interrupted repeatedly and will not be resumed automatically." });

    let observed = observe("msg_1", &[assistant("msg_2", "half", None), failed]);

    assert_eq!(observed.status, AgentTurnStatus::Failed);
    assert_eq!(
        observed.result.unwrap().error.as_deref(),
        Some("Execution was interrupted repeatedly and will not be resumed automatically.")
    );
}

#[test]
fn a_background_report_never_reopens_a_finished_turn() {
    // A background subagent reported after the turn's run went idle.
    let later = [
        assistant("msg_2", "started it", Some("stop")),
        idle("succeeded"),
        synthetic(),
        assistant("msg_3", "the report says", Some("stop")),
        idle("succeeded"),
    ];

    let observed = observe("msg_1", &later);

    assert_eq!(observed.status, AgentTurnStatus::Completed);
    assert_eq!(observed.result.unwrap().text.as_deref(), Some("started it"));
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
    assert!(is_message_id("msg_18c3376e3001FnH4vAmSQF6xi5"));
    assert!(!is_message_id("ses_e73cc8962ffej6cXCLaMIrn4mr"));
}
