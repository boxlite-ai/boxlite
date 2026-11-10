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
#[path = "common/opencode.rs"]
mod opencode;

use opencode::{BINARY_ENV, ModelLog, provider_config, start_fake_model};

use boxlite::agents::{
    Agent, AgentCreateOptions, AgentEventsOptions, AgentSendOptions, AgentTurnStatus,
    AgentWaitOptions,
};
use boxlite::runtime::options::{BoxOptions, RootfsSpec};
use boxlite::{BoxCommand, BoxliteError, BoxliteOptions, BoxliteRuntime, CopyOptions, LiteBox};
use futures::StreamExt;
use std::time::Duration;

const RECORD: &str = "/root/.local/state/opencode/service.json";
const WAIT: AgentWaitOptions = AgentWaitOptions {
    timeout: Some(Duration::from_secs(120)),
};

/// A started Box with OpenCode and a provider config pointing at the fake model.
/// The Box environment sets a conflicting `OPENCODE_PASSWORD` on purpose.
async fn opencode_box(home: &common::home::PerTestBoxHome) -> (BoxliteRuntime, LiteBox, ModelLog) {
    let binary = std::env::var(BINARY_ENV).unwrap_or_else(|_| panic!("set {BINARY_ENV}"));
    let (model_port, log) = start_fake_model().await;

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
    let config = provider_config(model_port);
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
async fn opencode_agent_creates_sends_streams_and_waits() {
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

    let mut events = agent.events(AgentEventsOptions::default()).await.unwrap();
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
    let enqueued = tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(event) = events.next().await {
            let event = event.unwrap();
            if event.kind == "session.inbox.enqueued" {
                return event;
            }
        }
        panic!("event stream ended before the turn was enqueued");
    })
    .await
    .unwrap();
    assert_eq!(enqueued.turn_id.as_deref(), Some(turn_id.as_str()));

    // A second handle, as another process would obtain it, reuses the service.
    let reattached = sandbox.agents().get(&enqueued.agent_id).await.unwrap();
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

/// A started Box like [`opencode_box`], but with OpenCode removed from the image
/// and installed from the host into the share instead.
#[cfg(feature = "test-support")]
async fn delivered_box(home: &common::home::PerTestBoxHome) -> (BoxliteRuntime, LiteBox) {
    let (runtime, sandbox, _) = opencode_box(home).await;
    run(&sandbox, "rm /usr/local/bin/opencode").await;
    install(&sandbox).await;
    (runtime, sandbox)
}

#[cfg(feature = "test-support")]
async fn install(sandbox: &LiteBox) {
    let binary = std::env::var(BINARY_ENV).unwrap_or_else(|_| panic!("set {BINARY_ENV}"));
    sandbox
        .agents()
        .install_from_host("opencode", std::path::Path::new(&binary))
        .await
        .unwrap();
}

/// How many mounts the container has at the agents mount point.
#[cfg(feature = "test-support")]
async fn agent_mounts(sandbox: &LiteBox) -> String {
    output(
        sandbox,
        r#"awk '$2 == "/opt/boxlite/agents"' /proc/mounts | wc -l"#,
    )
    .await
}

/// Create an agent, complete one turn, and return the agent ID that turn names.
#[cfg(feature = "test-support")]
async fn agent_with_a_completed_turn(sandbox: &LiteBox) -> String {
    let agent = sandbox
        .agents()
        .create("opencode", fake_model_options())
        .await
        .unwrap();
    let turn = agent
        .send("ping", AgentSendOptions::default())
        .await
        .unwrap();
    assert_eq!(
        turn.wait(WAIT).await.unwrap().status,
        AgentTurnStatus::Completed
    );
    turn.state().unwrap().agent_id
}

#[cfg(feature = "test-support")]
async fn restart(runtime: &BoxliteRuntime, sandbox: LiteBox) -> LiteBox {
    sandbox.stop().await.unwrap();
    // stop() invalidates the handle; a restarted Box comes from the runtime.
    let sandbox = runtime.get(sandbox.id().as_ref()).await.unwrap().unwrap();
    sandbox.start().await.unwrap();
    sandbox
}

#[cfg(feature = "test-support")]
#[tokio::test]
#[ignore = "needs a VM, network and BOXLITE_TEST_OPENCODE_BINARY; see the module docs"]
async fn an_installed_opencode_runs_in_an_image_without_one() {
    let home = common::home::PerTestBoxHome::new();
    let (runtime, sandbox) = delivered_box(&home).await;

    let agent = sandbox
        .agents()
        .create("opencode", fake_model_options())
        .await
        .unwrap();
    let turn = agent
        .send("ping", AgentSendOptions::default())
        .await
        .unwrap();
    assert_eq!(
        turn.wait(WAIT).await.unwrap().status,
        AgentTurnStatus::Completed
    );

    // The image gained nothing on its PATH, and the delivered folder is read-only.
    assert_eq!(
        output(&sandbox, "command -v opencode || echo none").await,
        "none"
    );
    let write = output(
        &sandbox,
        "touch /opt/boxlite/agents/x 2>&1 && echo written || true",
    )
    .await;
    assert!(write.contains("Read-only file system"), "{write}");
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

#[cfg(feature = "test-support")]
#[tokio::test]
#[ignore = "needs a VM, network and BOXLITE_TEST_OPENCODE_BINARY; see the module docs"]
async fn installing_again_reuses_the_one_mount() {
    let home = common::home::PerTestBoxHome::new();
    let (runtime, sandbox) = delivered_box(&home).await;

    install(&sandbox).await;
    sandbox
        .agents()
        .create("opencode", fake_model_options())
        .await
        .unwrap();

    assert_eq!(agent_mounts(&sandbox).await, "1");
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

/// Later installs reach the running container through the mount it already
/// has. A failed lookup the guest made before the file existed must not hide it.
#[cfg(feature = "test-support")]
#[tokio::test]
#[ignore = "needs a VM, network and BOXLITE_TEST_OPENCODE_BINARY; see the module docs"]
async fn an_agent_installed_after_a_failed_lookup_is_found_at_once() {
    let home = common::home::PerTestBoxHome::new();
    let (runtime, sandbox) = delivered_box(&home).await;
    assert_eq!(
        output(
            &sandbox,
            "stat /opt/boxlite/agents/probe >/dev/null 2>&1 || echo missing"
        )
        .await,
        "missing"
    );
    let probe = home.path.join("probe");
    std::fs::write(&probe, "#!/bin/sh\necho probe-ran\n").unwrap();

    sandbox
        .agents()
        .install_from_host("probe", &probe)
        .await
        .unwrap();

    assert_eq!(
        output(
            &sandbox,
            "stat /opt/boxlite/agents/probe >/dev/null && /opt/boxlite/agents/probe/*/probe"
        )
        .await,
        "probe-ran"
    );
    assert_eq!(agent_mounts(&sandbox).await, "1");
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

#[cfg(feature = "test-support")]
#[tokio::test]
#[ignore = "needs a VM, network and BOXLITE_TEST_OPENCODE_BINARY; see the module docs"]
async fn a_restart_mounts_the_recorded_agent_on_first_use() {
    let home = common::home::PerTestBoxHome::new();
    let (runtime, sandbox) = delivered_box(&home).await;
    let agent_id = agent_with_a_completed_turn(&sandbox).await;

    let sandbox = restart(&runtime, sandbox).await;
    // A stop drops the mount; the empty mount point stays in the reused rootfs.
    assert_eq!(agent_mounts(&sandbox).await, "0");
    assert_eq!(output(&sandbox, "ls -A /opt/boxlite/agents").await, "");

    let agent = sandbox.agents().get(&agent_id).await.unwrap();
    let turn = agent
        .send("ping", AgentSendOptions::default())
        .await
        .unwrap();
    assert_eq!(
        turn.wait(WAIT).await.unwrap().status,
        AgentTurnStatus::Completed
    );
    assert_eq!(agent_mounts(&sandbox).await, "1");
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}

#[cfg(feature = "test-support")]
#[tokio::test]
#[ignore = "needs a VM, network and BOXLITE_TEST_OPENCODE_BINARY; see the module docs"]
async fn a_failed_mount_after_a_restart_is_reported_and_retried() {
    let home = common::home::PerTestBoxHome::new();
    let (runtime, sandbox) = delivered_box(&home).await;
    let agent_id = agent_with_a_completed_turn(&sandbox).await;
    let sandbox = restart(&runtime, sandbox).await;

    // A destination with entries is refused: the Box keeps running and the
    // agents call reports the mount error.
    run(&sandbox, "touch /opt/boxlite/agents/blocker").await;
    let error = sandbox.agents().get(&agent_id).await.err().unwrap();
    assert!(error.to_string().contains("/opt/boxlite/agents"), "{error}");
    assert_eq!(agent_mounts(&sandbox).await, "0");

    run(&sandbox, "rm /opt/boxlite/agents/blocker").await;
    sandbox.agents().get(&agent_id).await.unwrap();
    assert_eq!(agent_mounts(&sandbox).await, "1");
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
}
