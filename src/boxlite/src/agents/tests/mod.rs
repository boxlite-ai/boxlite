use super::*;
use crate::litebox::{BoxTunnel, TunnelOptions};
use crate::{BoxOptions, BoxStatus, BoxliteOptions, BoxliteRuntime};
use std::net::SocketAddr;

mod go_records;

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

/// The ID is what another process passes to `Agents::get`; it needs no state support.
#[test]
fn agent_id_is_the_native_session_id_even_without_state_support() {
    let agent = offline_agent();
    assert_eq!(agent.id(), "ses_test");
    assert!(agent.state().is_err(), "OpenCode still lacks agent.state");
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
            data: Some(serde_json::value::to_raw_value(&serde_json::json!({ "k": 1 })).unwrap()),
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
    let after = AgentEventsOptions {
        after: Some("cursor".into()),
    };
    assert_eq!(
        unsupported_message(agent.events(after).await),
        "agent.events after a cursor is not supported by OpenCode 2.2"
    );
}

#[tokio::test]
async fn null_send_data_means_no_data() {
    let agent = offline_agent();
    let options = AgentSendOptions {
        data: Some(serde_json::value::RawValue::NULL.to_owned()),
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

/// Records use the field names and enum strings documented under "C JSON fields".
#[test]
fn agents_records_use_documented_json_shapes() {
    use crate::agents::{
        AgentOutcome, AgentRequest, AgentRequestKind, AgentResult, AgentState, AgentStatus,
        AgentSteeringReceipt, AgentSteeringStatus, AgentTurnState, AgentTurnStatus,
    };
    use serde_json::json;
    let request = AgentRequest {
        id: "req".into(),
        turn_id: "msg".into(),
        kind: AgentRequestKind::Permission {
            tool: "bash".into(),
            arguments: json!({"command": "ls"}),
        },
    };
    let receipt = AgentSteeringReceipt {
        id: "steer".into(),
        turn_id: "msg".into(),
        status: AgentSteeringStatus::Applied,
    };
    let state = AgentState {
        id: "ses".into(),
        status: AgentStatus::Busy,
        cursor: None,
        active_turn_id: Some("msg".into()),
        queued_turn_ids: vec!["next".into()],
        requests: vec![request.clone()],
        steering: vec![receipt.clone()],
    };
    assert_eq!(
        records::agent_state(&state),
        json!({
            "id": "ses", "status": "busy", "cursor": null, "active_turn_id": "msg",
            "queued_turn_ids": ["next"],
            "requests": [{"id": "req", "turn_id": "msg",
                "kind": {"type": "permission", "tool": "bash", "arguments": {"command": "ls"}}}],
            "steering": [{"id": "steer", "turn_id": "msg", "status": "applied"}],
        })
    );

    let result = AgentResult {
        turn_id: "msg".into(),
        status: AgentTurnStatus::WaitingInput,
        outcome: Some(AgentOutcome::Question),
        text: Some("which file?".into()),
        data: None,
        artifacts: vec![],
        usage: None,
        error: None,
    };
    let turn = AgentTurnState {
        id: "msg".into(),
        agent_id: "ses".into(),
        status: AgentTurnStatus::WaitingInput,
        cursor: Some("c1".into()),
        result: Some(result),
        requests: vec![],
        steering: vec![],
    };
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(records::turn_state(&turn).get()).unwrap(),
        json!({
            "id": "msg", "agent_id": "ses", "status": "waiting_input", "cursor": "c1",
            "result": {"turn_id": "msg", "status": "waiting_input", "outcome": "question",
                "text": "which file?", "data": null, "artifacts": [], "usage": null, "error": null},
            "requests": [], "steering": [],
        })
    );
}

#[test]
fn agents_config_and_capabilities_records_omit_or_null_unknowns() {
    use crate::agents::{AgentCapabilities, AgentConfig};
    use serde_json::json;
    use std::time::Duration;
    let config = AgentConfig {
        model: Some("fake/fake-model".into()),
        ..AgentConfig::default()
    };
    assert_eq!(
        records::config(&config),
        json!({"model": "fake/fake-model", "tools": [], "mcp": []})
    );
    let capabilities = AgentCapabilities {
        operations: vec!["agent.send".into()],
        input_kinds: vec!["text".into()],
        max_queued_turns: None,
        max_pending_steering: Some(1),
        idempotency_retention: Some(Duration::from_millis(1500)),
    };
    assert_eq!(
        records::capabilities(&capabilities),
        json!({"operations": ["agent.send"], "input_kinds": ["text"], "max_queued_turns": null,
            "max_pending_steering": 1, "idempotency_retention_seconds": 1.5})
    );
}

#[test]
fn agents_respond_parses_answers_and_permissions_and_rejects_other_shapes() {
    use crate::BoxliteError;
    use crate::agents::AgentResponse;
    use serde_json::json;
    assert!(matches!(
        records::parse_response(&json!({"type": "answer", "text": "yes", "data": {"n": 1}}).to_string()),
        Ok(AgentResponse::Answer { text, data: Some(data) }) if text == "yes" && data.get() == r#"{"n":1}"#
    ));
    assert!(matches!(
        records::parse_response(&json!({"type": "permission", "approved": false}).to_string()),
        Ok(AgentResponse::Permission { approved: false })
    ));
    for invalid in [
        json!({"type": "answer"}),
        json!({"type": "permission", "approved": "yes"}),
        json!({"type": "vote", "approved": true}),
        json!({"type": "answer", "text": "yes", "extra": 1}),
        json!("yes"),
    ] {
        assert!(
            matches!(
                records::parse_response(&invalid.to_string()),
                Err(BoxliteError::InvalidArgument(_))
            ),
            "accepted {invalid}"
        );
    }
}

#[test]
fn agents_config_parses_documented_fields_and_rejects_unknown_ones() {
    use crate::BoxliteError;
    use serde_json::json;
    let config =
        records::parse_config(json!({"model": "fake/fake-model", "tools": ["bash"]})).unwrap();
    assert_eq!(config.model.as_deref(), Some("fake/fake-model"));
    assert_eq!(config.tools, ["bash"]);
    assert!(config.mcp.is_empty());
    assert!(matches!(
        records::parse_config(json!({"modle": "typo"})),
        Err(BoxliteError::InvalidArgument(message)) if message.contains("modle")
    ));
}

#[test]
fn agent_records_reject_wrong_field_types() {
    use serde_json::json;

    for invalid in [
        json!({"model": 7}),
        json!({"reasoning": false}),
        json!({"instructions": []}),
        json!({"tools": "bash"}),
        json!({"mcp": [42]}),
    ] {
        assert!(
            matches!(
                records::parse_config(invalid.clone()),
                Err(BoxliteError::InvalidArgument(_))
            ),
            "accepted {invalid}"
        );
    }
    assert!(matches!(
        records::parse_response(&json!({"type": "answer", "text": false}).to_string()),
        Err(BoxliteError::InvalidArgument(_))
    ));
}

#[test]
fn agent_config_preserves_false_zero_empty_collections_and_nested_nulls() {
    use serde_json::json;

    let input = json!({
        "tools": [],
        "mcp": [],
        "permissions": {"enabled": false, "rules": [], "nested": {"value": null}},
        "limits": {"count": 0, "options": {}},
        "output_schema": {"items": [null, {"value": null}]}
    });
    let parsed = records::parse_config(input.clone()).unwrap();
    assert_eq!(records::config(&parsed), input);
}
