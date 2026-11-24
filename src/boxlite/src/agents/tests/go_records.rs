use super::*;
use serde_json::json;

const NUMERIC_DATA: &str = r#"[9007199254740992,9007199254740993,-9223372036854775808,9223372036854775807,18446744073709551615,0.123456789012345678901,0.123456789012345678902]"#;

#[test]
fn opaque_agent_numbers_round_trip() {
    let config = records::parse_config(
        serde_json::from_str(&format!(r#"{{"limits":{NUMERIC_DATA}}}"#)).unwrap(),
    )
    .unwrap();
    assert_eq!(records::config(&config)["limits"].to_string(), NUMERIC_DATA);
    let response = records::parse_response(&format!(
        r#"{{"type":"answer","text":"yes","data":{NUMERIC_DATA}}}"#
    ))
    .unwrap();
    let AgentResponse::Answer {
        data: Some(data), ..
    } = response
    else {
        panic!("expected answer data")
    };
    assert_eq!(data.to_string(), NUMERIC_DATA);
}

#[test]
fn capabilities_retention_preserves_nanoseconds() {
    for (duration, expected) in [
        (
            Duration::from_nanos(i64::MAX as u64),
            "9223372036.854775807",
        ),
        (Duration::ZERO, "0"),
        (Duration::from_nanos(1), "0.000000001"),
        (Duration::from_millis(1500), "1.5"),
        (
            Duration::from_nanos(9_007_199_254_740_991),
            "9007199.254740991",
        ),
        (
            Duration::from_nanos(9_007_199_254_740_992),
            "9007199.254740992",
        ),
        (
            Duration::from_nanos(9_007_199_254_740_993),
            "9007199.254740993",
        ),
        (
            Duration::from_nanos(i64::MAX as u64 - 1),
            "9223372036.854775806",
        ),
        (
            Duration::from_nanos(i64::MAX as u64 + 1),
            "9223372036.854775808",
        ),
        (Duration::MAX, "18446744073709551615.999999999"),
    ] {
        let capabilities = AgentCapabilities {
            operations: vec![],
            input_kinds: vec![],
            max_queued_turns: None,
            max_pending_steering: None,
            idempotency_retention: Some(duration),
        };
        assert_eq!(
            records::capabilities(&capabilities)["idempotency_retention_seconds"].to_string(),
            expected,
            "duration {duration:?} must retain its nanoseconds in the JSON number"
        );
    }
}

#[test]
fn go_json_fixture_matches_core_records() {
    let numeric_data: serde_json::Value = serde_json::from_str(NUMERIC_DATA).unwrap();
    let data = json!({"enabled": false, "count": 0, "items": [], "nested": {"value": null}, "numbers": numeric_data});
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
        data: Some(serde_json::value::to_raw_value(&data).unwrap()),
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
    let max_capabilities = AgentCapabilities {
        idempotency_retention: Some(Duration::from_nanos(i64::MAX as u64)),
        ..capabilities.clone()
    };
    let overflow_capabilities = AgentCapabilities {
        idempotency_retention: Some(Duration::from_nanos(i64::MAX as u64 + 1)),
        ..capabilities.clone()
    };
    let numeric_config = records::parse_config(json!({
        "limits": numeric_data, "permissions": numeric_data, "output_schema": numeric_data,
    }))
    .unwrap();
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
        records::parse_response(&answer.to_string()).unwrap(),
        AgentResponse::Answer { .. }
    ));
    assert!(matches!(
        records::parse_response(&denial.to_string()).unwrap(),
        AgentResponse::Permission { approved: false }
    ));
    assert!(matches!(
        records::parse_response(&approval.to_string()).unwrap(),
        AgentResponse::Permission { approved: true }
    ));
    let fixture = json!({
        "numeric_data": numeric_data, "numeric_config": records::config(&numeric_config),
        "capabilities_max": records::capabilities(&max_capabilities),
        "capabilities_overflow": records::capabilities(&overflow_capabilities),
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
