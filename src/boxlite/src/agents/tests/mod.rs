use super::*;
use crate::litebox::{BoxTunnel, TunnelOptions};
use crate::{BoxOptions, BoxStatus, BoxliteOptions, BoxliteRuntime};
use std::net::SocketAddr;

/// A network with no tunnels: any operation that reaches the Box fails with
/// this message, so a different error proves the call stopped earlier.
struct NoTunnels;

const NO_TUNNELS: &str = "test network refuses tunnels";

#[async_trait::async_trait]
impl BoxNetworkBackend for NoTunnels {
    async fn tunnel(
        &self,
        _target: SocketAddr,
        _options: TunnelOptions,
    ) -> BoxliteResult<BoxTunnel> {
        Err(BoxliteError::Network(NO_TUNNELS.into()))
    }
}

fn offline_agent() -> Agent {
    let server = Arc::new(opencode::Server::new(Arc::new(NoTunnels), "password"));
    let info =
        serde_json::json!({ "id": "ses_test", "model": { "providerID": "fake", "id": "model" } });
    Agent::new(opencode::Session::new(server, &info).unwrap())
}

fn unsupported_message<T>(result: BoxliteResult<T>) -> String {
    match result.err().expect("operation must fail") {
        BoxliteError::Unsupported(message) => message,
        other => panic!("expected Unsupported, got {other}"),
    }
}

#[tokio::test]
async fn namespace_rejects_without_starting_box() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = BoxliteRuntime::new_for_test(BoxliteOptions {
        home_dir: directory.path().into(),
        ..Default::default()
    })
    .unwrap();
    let sandbox = runtime
        .create(
            BoxOptions {
                rootfs: crate::RootfsSpec::Image("alpine:latest".into()),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let agents = sandbox.agents();

    let unknown = unsupported_message(agents.create("coder", AgentCreateOptions::default()).await);
    assert!(unknown.contains("\"coder\" is not supported"), "{unknown}");

    let mut options = AgentCreateOptions::default();
    options.config.tools = vec!["shell".into()];
    let option = unsupported_message(agents.create("opencode", options).await);
    assert_eq!(
        option,
        "agents.create option config.tools is not supported by OpenCode 2.2"
    );

    let missing = agents.get("not-a-session").await.err().unwrap();
    assert!(matches!(missing, BoxliteError::NotFound(_)), "{missing}");
    assert_eq!(sandbox.info().await.unwrap().status, BoxStatus::Configured);
}

#[tokio::test]
async fn unsupported_operations_fail_before_reaching_the_box() {
    let agent = offline_agent();
    let turn = agent.turn(AgentTurnState {
        id: "msg_test".into(),
        agent_id: "ses_test".into(),
        status: AgentTurnStatus::Queued,
        cursor: None,
        result: None,
        requests: Vec::new(),
        steering: Vec::new(),
    });
    let expected = |operation: &str| format!("{operation} is not supported by OpenCode 2.2");

    assert_eq!(
        unsupported_message(agent.close(AgentControlOptions::default()).await),
        expected("agent.close")
    );
    assert_eq!(
        unsupported_message(agent.requests().await),
        expected("agent.requests")
    );
    let answer = AgentResponse::Permission { approved: false };
    assert_eq!(
        unsupported_message(
            agent
                .respond("per_test", answer, AgentControlOptions::default())
                .await
        ),
        expected("agent.respond")
    );
    assert_eq!(unsupported_message(agent.state()), expected("agent.state"));
    assert_eq!(
        unsupported_message(turn.events(AgentEventsOptions::default()).await),
        expected("turn.events")
    );
    assert_eq!(
        unsupported_message(turn.steer("left", AgentControlOptions::default()).await),
        expected("turn.steer")
    );
    assert_eq!(
        unsupported_message(turn.interrupt(AgentControlOptions::default()).await),
        expected("turn.interrupt")
    );

    for options in [
        AgentSendOptions {
            mode: AgentSendMode::Reject,
            ..Default::default()
        },
        AgentSendOptions {
            data: Some(serde_json::json!({ "k": 1 })),
            ..Default::default()
        },
        AgentSendOptions {
            idempotency_key: Some("key".into()),
            ..Default::default()
        },
    ] {
        let message = unsupported_message(agent.send("task", options).await);
        assert!(message.starts_with("agent.send option"), "{message}");
    }
    assert_eq!(
        unsupported_message(agent.get_turn("msg_test").await),
        expected("agent.get_turn")
    );
    assert_eq!(
        unsupported_message(turn.wait(AgentWaitOptions::default()).await),
        expected("turn.wait")
    );
    assert_eq!(
        unsupported_message(agent.events(AgentEventsOptions::default()).await),
        expected("agent.events")
    );
}

#[tokio::test]
async fn null_send_data_means_no_data() {
    let agent = offline_agent();
    let options = AgentSendOptions {
        data: Some(serde_json::Value::Null),
        ..Default::default()
    };
    // Validation accepts null, so the call proceeds to the Box and hits the test network.
    let error = agent.send("task", options).await.err().unwrap();
    assert!(error.to_string().contains(NO_TUNNELS), "{error}");
}

#[tokio::test]
async fn reads_cached_config_capabilities_and_turn_state() {
    let agent = offline_agent();
    assert_eq!(agent.config().unwrap().model.as_deref(), Some("fake/model"));
    let capabilities = agent.capabilities().unwrap();
    assert!(capabilities.operations.contains(&"agent.send".to_string()));
    assert!(
        !capabilities
            .operations
            .contains(&"turn.interrupt".to_string())
    );
    assert_eq!(capabilities.max_queued_turns, None);

    let turn = agent.turn(AgentTurnState {
        id: "msg_test".into(),
        agent_id: "ses_test".into(),
        status: AgentTurnStatus::Running,
        cursor: None,
        result: None,
        requests: Vec::new(),
        steering: Vec::new(),
    });
    assert_eq!(turn.state().unwrap().status, AgentTurnStatus::Running);
}
