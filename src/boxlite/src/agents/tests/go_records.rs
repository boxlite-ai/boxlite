use super::*;
use serde_json::json;

#[test]
fn go_json_fixture_matches_core_records() {
    let data = json!({"enabled": false, "count": 0, "items": [], "nested": {"value": null}});
    let requests = vec![
        AgentRequest {
            id: "question-1".into(),
            turn_id: "turn-1".into(),
            kind: AgentRequestKind::Question {
                text: "continue?".into(),
                schema: None,
            },
        },
        AgentRequest {
            id: "permission-1".into(),
            turn_id: "turn-1".into(),
            kind: AgentRequestKind::Permission {
                tool: "shell".into(),
                arguments: data.clone(),
            },
        },
    ];
    let receipt = AgentSteeringReceipt {
        id: "steer-1".into(),
        turn_id: "turn-1".into(),
        status: AgentSteeringStatus::Applied,
    };
    let result = AgentResult {
        turn_id: "turn-1".into(),
        status: AgentTurnStatus::Completed,
        outcome: Some(AgentOutcome::Answer),
        text: Some("done".into()),
        data: Some(data.clone()),
        artifacts: vec![],
        usage: Some(json!({"tokens": 0})),
        error: None,
    };
    let unknown_result = AgentResult {
        turn_id: "turn-2".into(),
        status: AgentTurnStatus::Unknown,
        outcome: None,
        text: None,
        data: None,
        artifacts: vec![],
        usage: None,
        error: None,
    };
    let turn = AgentTurnState {
        id: "turn-1".into(),
        agent_id: "agent-1".into(),
        status: AgentTurnStatus::Completed,
        cursor: None,
        result: Some(result.clone()),
        requests: requests.clone(),
        steering: vec![receipt.clone()],
    };
    let queued = AgentTurnState {
        id: "turn-2".into(),
        agent_id: "agent-1".into(),
        status: AgentTurnStatus::Queued,
        cursor: None,
        result: None,
        requests: vec![],
        steering: vec![],
    };
    let state = AgentState {
        id: "agent-1".into(),
        status: AgentStatus::Busy,
        cursor: None,
        active_turn_id: Some("turn-1".into()),
        queued_turn_ids: vec!["turn-2".into()],
        requests: requests.clone(),
        steering: vec![receipt.clone()],
    };
    let empty_state = AgentState {
        id: "agent-1".into(),
        status: AgentStatus::Ready,
        cursor: None,
        active_turn_id: None,
        queued_turn_ids: vec![],
        requests: vec![],
        steering: vec![],
    };
    let config = AgentConfig {
        model: Some("fake/model".into()),
        reasoning: Some("high".into()),
        instructions: Some("be brief".into()),
        tools: vec![],
        mcp: vec!["files".into()],
        permissions: Some(json!(false)),
        limits: Some(json!(0)),
        output_schema: Some(json!({"properties": {}, "required": [], "nested": null})),
    };
    let capabilities = AgentCapabilities {
        operations: vec!["agent.send".into()],
        input_kinds: vec!["text".into()],
        max_queued_turns: Some(0),
        max_pending_steering: None,
        idempotency_retention: Some(Duration::from_millis(1500)),
    };
    let unknown_capabilities = AgentCapabilities {
        operations: vec![],
        input_kinds: vec![],
        max_queued_turns: None,
        max_pending_steering: None,
        idempotency_retention: None,
    };
    let event = AgentEvent {
        cursor: None,
        agent_id: "agent-1".into(),
        turn_id: None,
        kind: "progress".into(),
        data: data.clone(),
    };
    let answer = json!({"type": "answer", "text": "yes", "data": data});
    let null_event = AgentEvent {
        data: serde_json::Value::Null,
        ..event.clone()
    };
    let null_permission = AgentRequest {
        id: "permission-null".into(),
        turn_id: "turn-1".into(),
        kind: AgentRequestKind::Permission {
            tool: "shell".into(),
            arguments: serde_json::Value::Null,
        },
    };
    let denial = json!({"type": "permission", "approved": false});
    let approval = json!({"type": "permission", "approved": true});
    assert!(matches!(
        records::parse_response(answer.clone()).unwrap(),
        AgentResponse::Answer { .. }
    ));
    assert!(matches!(
        records::parse_response(denial.clone()).unwrap(),
        AgentResponse::Permission { approved: false }
    ));
    assert!(matches!(
        records::parse_response(approval.clone()).unwrap(),
        AgentResponse::Permission { approved: true }
    ));
    let fixture = json!({
        "config": records::config(&config), "config_default": records::config(&AgentConfig::default()),
        "capabilities": records::capabilities(&capabilities), "capabilities_unknown": records::capabilities(&unknown_capabilities),
        "state": records::agent_state(&state), "state_empty": records::agent_state(&empty_state),
        "turn": records::turn_state(&turn), "turn_queued": records::turn_state(&queued),
        "result": records::result(&result), "result_unknown": records::result(&unknown_result),
        "receipt": records::receipt(&receipt), "event": records::event(&event),
        "event_null": records::event(&null_event), "requests_null": records::requests(&[null_permission]),
        "requests": records::requests(&requests), "answer": answer, "denial": denial, "approval": approval,
    });
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sdks/go/testdata/agents.json");
    if std::env::var("BOXLITE_UPDATE_AGENT_FIXTURES").as_deref() == Ok("1") {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            format!("{}\n", serde_json::to_string_pretty(&fixture).unwrap()),
        )
        .unwrap();
    }
    let committed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(
        fixture, committed,
        "Go fixtures must match the core JSON mapping"
    );
}
