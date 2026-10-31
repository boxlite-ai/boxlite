//! Real-VM coverage of the OpenCode 2.2 agent adapter.
//!
//! The Box runs the OpenCode release binary; its model is a scripted
//! OpenAI-compatible server on the host, reached through `host.boxlite.internal`.
//! It needs `make runtime:debug`, network access for the image pull, and the
//! glibc Linux build matching the host architecture:
//!
//! ```sh
//! gh release download v2.2.2 --repo anomalyco/opencode --pattern 'opencode-linux-arm64.tar.gz'
//! tar -xzf opencode-linux-arm64.tar.gz
//! BOXLITE_TEST_OPENCODE_BINARY=$PWD/opencode make test:integration:agents
//! ```

mod common;

use boxlite::agents::{
    Agent, AgentCreateOptions, AgentSendOptions, AgentTurnStatus, AgentWaitOptions,
};
use boxlite::runtime::options::{BoxOptions, RootfsSpec};
use boxlite::{BoxCommand, BoxliteError, BoxliteOptions, BoxliteRuntime, CopyOptions, LiteBox};
use futures::StreamExt;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const BINARY_ENV: &str = "BOXLITE_TEST_OPENCODE_BINARY";
const RECORD: &str = "/root/.local/state/opencode/service.json";
const WAIT: AgentWaitOptions = AgentWaitOptions {
    timeout: Some(Duration::from_secs(120)),
};

/// What the fake model saw, in order: each prompt as `user: <text>` and each
/// tool result as `tool: <message JSON>`.
type ModelLog = Arc<Mutex<Vec<String>>>;

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

/// A started Box with OpenCode and a provider config pointing at the fake model.
/// The Box environment sets a conflicting `OPENCODE_PASSWORD` on purpose.
async fn opencode_box(home: &common::home::PerTestBoxHome) -> (BoxliteRuntime, LiteBox, ModelLog) {
    let binary = std::env::var(BINARY_ENV).unwrap_or_else(|_| panic!("set {BINARY_ENV}"));
    let model = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let model_port = model.local_addr().unwrap().port();
    let log = ModelLog::default();
    tokio::spawn(serve_fake_model(model, Arc::clone(&log)));

    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap();
    let sandbox = runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("debian:bookworm-slim".into()),
                env: vec![("OPENCODE_PASSWORD".into(), "inherited-from-the-box".into())],
                auto_delete: Some(0),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    sandbox.start().await.unwrap();
    sandbox
        .copy_into(&binary, "/usr/local/bin/opencode", CopyOptions::default())
        .await
        .unwrap();
    let config = json!({
        "provider": { "fake": { "npm": "@ai-sdk/openai-compatible", "name": "Fake",
            "options": { "baseURL": format!("http://host.boxlite.internal:{model_port}/v1"), "apiKey": "fake" },
            "models": { "fake-model": { "name": "Fake" } } } },
        "small_model": "fake/fake-model",
    });
    let config_file = home.path.join("opencode.json");
    std::fs::write(&config_file, config.to_string()).unwrap();
    run(
        &sandbox,
        "chmod 755 /usr/local/bin/opencode && mkdir -p /root/.config/opencode",
    )
    .await;
    sandbox
        .copy_into(
            &config_file,
            "/root/.config/opencode/opencode.json",
            CopyOptions::default(),
        )
        .await
        .unwrap();
    (runtime, sandbox, log)
}

async fn run(sandbox: &LiteBox, script: &str) {
    output(sandbox, script).await;
}

/// Run a shell script in the Box; it must succeed. Returns its trimmed stdout.
async fn output(sandbox: &LiteBox, script: &str) -> String {
    let mut execution = sandbox
        .exec(BoxCommand::new("sh").args(["-c", script]))
        .await
        .unwrap();
    let stdout = match execution.stdout() {
        Some(stream) => stream.collect::<Vec<String>>().await.concat(),
        None => String::new(),
    };
    assert_eq!(
        execution.wait().await.unwrap().exit_code,
        0,
        "script failed: {script}"
    );
    stdout.trim().to_owned()
}

/// The pid in the OpenCode service registration.
async fn registered_pid(sandbox: &LiteBox) -> String {
    output(
        sandbox,
        &format!(r#"sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' {RECORD}"#),
    )
    .await
}

fn model_seen(log: &ModelLog) -> usize {
    log.lock().unwrap().len()
}

/// Wait for the first request after the first `skip` that matches `want`. Title
/// requests interleave with the conversation, so matching is by content.
async fn model_next(log: &ModelLog, skip: usize, want: impl Fn(&str) -> bool) -> String {
    for _ in 0..480 {
        let found = log
            .lock()
            .unwrap()
            .iter()
            .skip(skip)
            .find(|entry| want(entry))
            .cloned();
        if let Some(entry) = found {
            return entry;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("the fake model saw only {:?}", log.lock().unwrap());
}

fn fake_model_options() -> AgentCreateOptions {
    let mut options = AgentCreateOptions::default();
    options.config.model = Some("fake/fake-model".into());
    options
}

async fn wait_for_status(agent: &Agent, turn_id: &str, status: AgentTurnStatus) {
    for _ in 0..120 {
        if agent
            .get_turn(turn_id)
            .await
            .unwrap()
            .state()
            .unwrap()
            .status
            == status
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("turn {turn_id} never reached {status:?}");
}

#[tokio::test]
#[ignore = "needs a VM, network and BOXLITE_TEST_OPENCODE_BINARY; see the module docs"]
async fn opencode_agent_creates_sends_and_waits() {
    let home = common::home::PerTestBoxHome::new();
    let (runtime, sandbox, _) = opencode_box(&home).await;

    // Two first creates set up one service, one at a time.
    let agents = sandbox.agents();
    let (agent, other) = tokio::join!(
        agents.create("opencode", fake_model_options()),
        agents.create("opencode", fake_model_options()),
    );
    let (agent, other) = (agent.unwrap(), other.unwrap());
    let services = output(
        &sandbox,
        r#"for p in /proc/[0-9]*; do case "$(tr '\0' ' ' <"$p/cmdline" 2>/dev/null)" in *[o]pencode*serve*--service*) echo "${p#/proc/}";; esac; done"#,
    )
    .await;
    assert_eq!(services, registered_pid(&sandbox).await, "one service runs");
    assert!(agent.state().is_err(), "agent.state stays unsupported");
    assert_eq!(
        agent.config().unwrap().model.as_deref(),
        Some("fake/fake-model")
    );
    assert_eq!(
        other.config().unwrap().model.as_deref(),
        Some("fake/fake-model")
    );

    let turn = agent
        .send("hello", AgentSendOptions::default())
        .await
        .unwrap();
    let result = turn.wait(WAIT).await.unwrap();
    assert_eq!(
        (result.status, result.text.as_deref()),
        (AgentTurnStatus::Completed, Some("pong: hello"))
    );

    let turn_id = turn.state().unwrap().id;
    // A second handle, as another process would obtain it, reuses the service.
    let agent_id = turn.state().unwrap().agent_id;
    let reattached = sandbox.agents().get(&agent_id).await.unwrap();
    let finished = reattached.get_turn(&turn_id).await.unwrap();
    assert_eq!(finished.state().unwrap().status, AgentTurnStatus::Completed);

    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "needs a VM, network and BOXLITE_TEST_OPENCODE_BINARY; see the module docs"]
async fn an_old_turn_is_read_beyond_the_first_history_page() {
    let home = common::home::PerTestBoxHome::new();
    let (runtime, sandbox, _) = opencode_box(&home).await;
    let agent = sandbox
        .agents()
        .create("opencode", fake_model_options())
        .await
        .unwrap();
    // Each turn adds an input and a reply, so 30 turns outgrow one 50-message page.
    let mut turns = Vec::new();
    for index in 0..30 {
        let turn = agent
            .send(&format!("turn {index}"), AgentSendOptions::default())
            .await
            .unwrap();
        turns.push(turn.state().unwrap().id);
    }
    let last = agent.get_turn(turns.last().unwrap()).await.unwrap();
    last.wait(WAIT).await.unwrap();

    let first = agent.get_turn(&turns[0]).await.unwrap();

    assert_eq!(first.state().unwrap().status, AgentTurnStatus::Completed);
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "needs a VM, network and BOXLITE_TEST_OPENCODE_BINARY; see the module docs"]
async fn a_box_restart_resumes_the_running_turn_and_delivers_the_queued_one() {
    let home = common::home::PerTestBoxHome::new();
    let (runtime, sandbox, _) = opencode_box(&home).await;
    let agent = sandbox
        .agents()
        .create("opencode", fake_model_options())
        .await
        .unwrap();
    let running = agent
        .send("SLOW please", AgentSendOptions::default())
        .await
        .unwrap()
        .state()
        .unwrap();
    wait_for_status(&agent, &running.id, AgentTurnStatus::Running).await;
    let queued = agent
        .send("after the restart", AgentSendOptions::default())
        .await
        .unwrap()
        .state()
        .unwrap();
    wait_for_status(&agent, &queued.id, AgentTurnStatus::Queued).await;

    sandbox.stop().await.unwrap();
    // stop() invalidates the handle; a restarted Box comes from the runtime.
    let sandbox = runtime.get(sandbox.id().as_ref()).await.unwrap().unwrap();
    sandbox.start().await.unwrap();
    let reattached = sandbox.agents().get(&running.agent_id).await.unwrap();

    for turn_id in [&running.id, &queued.id] {
        let turn = reattached.get_turn(turn_id).await.unwrap();
        let result = turn.wait(WAIT).await.unwrap();
        assert_eq!(result.status, AgentTurnStatus::Completed, "{turn_id}");
    }

    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "needs a VM, network and BOXLITE_TEST_OPENCODE_BINARY; see the module docs"]
async fn a_foreign_server_on_the_agent_port_is_reported() {
    let home = common::home::PerTestBoxHome::new();
    let (runtime, sandbox, _) = opencode_box(&home).await;
    // A server BoxLite did not start, with a password BoxLite does not know.
    let _foreign = sandbox
        .exec(BoxCommand::new("sh").args([
            "-c",
            "OPENCODE_PASSWORD=foreign exec opencode serve --hostname 0.0.0.0 --port 47096 >/tmp/foreign.log 2>&1",
        ]))
        .await
        .unwrap();
    run(&sandbox, "for _ in $(seq 1 100); do grep -q listening /tmp/foreign.log && exit 0; sleep 0.2; done; exit 1").await;

    let error = sandbox
        .agents()
        .create("opencode", fake_model_options())
        .await
        .err()
        .unwrap();

    assert!(
        matches!(&error, BoxliteError::InvalidState(message) if message.contains("held by another server")),
        "{error}"
    );
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "needs a VM, network and BOXLITE_TEST_OPENCODE_BINARY; see the module docs"]
async fn a_box_without_opencode_is_reported() {
    let home = common::home::PerTestBoxHome::new();
    let (runtime, sandbox, _) = opencode_box(&home).await;
    run(&sandbox, "rm /usr/local/bin/opencode").await;

    let error = sandbox
        .agents()
        .create("opencode", fake_model_options())
        .await
        .err()
        .unwrap();

    assert!(
        matches!(&error, BoxliteError::Execution(message) if message.contains("must provide OpenCode 2.2.2")),
        "{error}"
    );
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "needs a VM, network and BOXLITE_TEST_OPENCODE_BINARY; see the module docs"]
async fn a_user_service_is_refused_ready_or_frozen_and_left_running() {
    let home = common::home::PerTestBoxHome::new();
    let (runtime, sandbox, _) = opencode_box(&home).await;
    // The user's own service, on OpenCode's default address.
    let url = output(&sandbox, "opencode service start 2>&1 | tail -n 1").await;
    let pid = registered_pid(&sandbox).await;

    for signal in ["", "kill -STOP"] {
        if !signal.is_empty() {
            run(&sandbox, &format!("{signal} {pid}")).await;
        }
        let error = sandbox
            .agents()
            .create("opencode", fake_model_options())
            .await
            .err()
            .unwrap();
        assert!(
            matches!(&error, BoxliteError::InvalidState(message) if message.contains(&format!("runs at {url}"))),
            "{signal:?}: {error}"
        );
    }

    run(&sandbox, &format!("kill -CONT {pid}")).await;
    assert_eq!(output(&sandbox, "opencode service status").await, url);
    assert_eq!(registered_pid(&sandbox).await, pid, "the same service runs");
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "needs a VM, network and BOXLITE_TEST_OPENCODE_BINARY; see the module docs"]
async fn a_stale_registration_is_dropped_without_signalling_its_pid() {
    let home = common::home::PerTestBoxHome::new();
    let (runtime, sandbox, _) = opencode_box(&home).await;
    // A service that died uncleanly left its registration, and its pid now
    // belongs to an unrelated process.
    run(&sandbox, "opencode service start >/dev/null 2>&1").await;
    let dead = registered_pid(&sandbox).await;
    run(
        &sandbox,
        &format!("cp {RECORD} /root/stale.json && kill -9 {dead}"),
    )
    .await;
    let holder = output(&sandbox, "sleep 600 >/dev/null 2>&1 & echo $!").await;
    run(
        &sandbox,
        &format!(r#"sed 's/"pid":{dead}/"pid":{holder}/' /root/stale.json > {RECORD}"#),
    )
    .await;

    let agent = sandbox
        .agents()
        .create("opencode", fake_model_options())
        .await
        .unwrap();
    let turn = agent
        .send("hello", AgentSendOptions::default())
        .await
        .unwrap();
    let result = turn.wait(WAIT).await.unwrap();

    assert_eq!(result.text.as_deref(), Some("pong: hello"));
    let state = output(
        &sandbox,
        &format!("sed -n 's/^State:[[:space:]]*//p' /proc/{holder}/status"),
    )
    .await;
    assert!(
        state.starts_with('S'),
        "sleep {holder} was signalled: {state:?}"
    );
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "needs a VM, network and BOXLITE_TEST_OPENCODE_BINARY; see the module docs"]
async fn sessions_deny_env_reads_and_questions_and_keep_running() {
    let home = common::home::PerTestBoxHome::new();
    let (runtime, sandbox, model) = opencode_box(&home).await;
    run(
        &sandbox,
        "mkdir -p /root/work && cd /root/work && for f in .env .env.local .env.example; do echo SECRET=1 > $f; done",
    )
    .await;
    let mut options = fake_model_options();
    options.cwd = Some("/root/work".into());
    let agent = sandbox.agents().create("opencode", options).await.unwrap();
    let tool_result = |entry: &str| entry.starts_with("tool: ");
    let send = async |text: &str| {
        let skip = model_seen(&model);
        agent.send(text, AgentSendOptions::default()).await.unwrap();
        skip
    };

    // The deny rules leave `.env.example` readable.
    let skip = send("READ .env.example").await;
    let allowed = model_next(&model, skip, tool_result).await;
    assert!(allowed.contains("SECRET"), "{allowed}");

    // OpenCode's defaults would ask before these reads and the question, and
    // a pending ask would hold every later input.
    for file in [".env", ".env.local"] {
        let skip = send(&format!("READ {file}")).await;
        let denied = model_next(&model, skip, tool_result).await;
        assert!(!denied.contains("SECRET"), "{file}: {denied}");
    }
    let skip = send("ASK please").await;
    model_next(&model, skip, tool_result).await;
    let skip = send("and then").await;
    model_next(&model, skip, |entry| entry == "user: and then").await;

    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "needs a VM, network and BOXLITE_TEST_OPENCODE_BINARY; see the module docs"]
async fn a_frozen_agent_service_is_reported_and_left_alone() {
    let home = common::home::PerTestBoxHome::new();
    let (runtime, sandbox, _) = opencode_box(&home).await;
    sandbox
        .agents()
        .create("opencode", fake_model_options())
        .await
        .unwrap();
    let pid = registered_pid(&sandbox).await;
    run(&sandbox, &format!("kill -STOP {pid}")).await;

    let error = sandbox
        .agents()
        .create("opencode", fake_model_options())
        .await
        .err()
        .unwrap();

    assert!(
        matches!(&error, BoxliteError::InvalidState(message) if message.contains("not responding")),
        "{error}"
    );
    run(&sandbox, &format!("kill -CONT {pid}")).await;
    sandbox
        .agents()
        .create("opencode", fake_model_options())
        .await
        .unwrap();
    assert_eq!(registered_pid(&sandbox).await, pid, "the same service runs");
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "needs a VM, network and BOXLITE_TEST_OPENCODE_BINARY; see the module docs"]
async fn remote_access_is_refused_before_a_service_starts() {
    let home = common::home::PerTestBoxHome::new();
    let (runtime, sandbox, _) = opencode_box(&home).await;
    // What `opencode service set remote` records, without opening its tunnel.
    run(
        &sandbox,
        r#"printf '{"remote":{"route":"test"}}' > /root/.config/opencode/service.json"#,
    )
    .await;

    let error = sandbox
        .agents()
        .create("opencode", fake_model_options())
        .await
        .err()
        .unwrap();

    assert!(
        matches!(&error, BoxliteError::InvalidState(message) if message.contains("remote access is on")),
        "{error}"
    );
    let registration = output(
        &sandbox,
        &format!("test -e {RECORD} && echo registered || echo none"),
    )
    .await;
    assert_eq!(registration, "none");
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}
