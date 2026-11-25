use super::*;
use crate::agents::AgentOutcome;

fn sample_turn(status: AgentTurnStatus) -> AgentTurnState {
    AgentTurnState {
        id: "turn-1".into(),
        agent_id: "agent-1".into(),
        status,
        cursor: Some("cursor".into()),
        result: Some(AgentResult {
            turn_id: "turn-1".into(),
            status,
            outcome: Some(AgentOutcome::Question),
            text: Some("answer".into()),
            data: Some(
                RawValue::from_string(r#"{ "nested": null, "big": 1e400 }"#.into()).unwrap(),
            ),
            artifacts: vec!["file".into()],
            usage: Some(json!({"tokens": 1})),
            error: None,
        }),
        requests: vec![AgentRequest {
            id: "request-1".into(),
            turn_id: "turn-1".into(),
            kind: AgentRequestKind::Permission {
                tool: "shell".into(),
                arguments: json!({"x": 1}),
            },
        }],
        steering: vec![AgentSteeringReceipt {
            id: "steer-1".into(),
            turn_id: "turn-1".into(),
            status: AgentSteeringStatus::Applied,
        }],
    }
}

#[test]
fn shared_enum_mappings_are_bidirectional_and_reject_unknown_values() {
    for value in [
        AgentSteeringStatus::Accepted,
        AgentSteeringStatus::Applied,
        AgentSteeringStatus::Unused,
        AgentSteeringStatus::Unknown,
    ] {
        assert_eq!(
            parse_steering_status(steering_status(value)).unwrap(),
            value
        );
    }
    for value in [AgentOutcome::Answer, AgentOutcome::Question] {
        assert_eq!(
            parse_outcome(serde_json::to_value(value).unwrap().as_str().unwrap()).unwrap(),
            value
        );
    }
    assert!(parse_agent_status("invalid").is_err());
    assert!(parse_turn_status("invalid").is_err());
    assert!(parse_steering_status("invalid").is_err());
    assert!(parse_outcome("invalid").is_err());
}

#[test]
fn shared_records_round_trip_turns_and_nested_values() {
    for status in [
        AgentTurnStatus::Queued,
        AgentTurnStatus::Running,
        AgentTurnStatus::WaitingInput,
        AgentTurnStatus::Interrupting,
        AgentTurnStatus::Completed,
        AgentTurnStatus::Cancelled,
        AgentTurnStatus::Failed,
        AgentTurnStatus::Unknown,
    ] {
        let original = sample_turn(status);
        let encoded = turn_state(&original);
        let decoded: AgentTurnState = serde_json::from_str::<Turn>(encoded.get())
            .unwrap()
            .try_into()
            .unwrap();
        assert_eq!(turn_state(&decoded).get(), encoded.get());
    }
}

#[test]
fn shared_records_round_trip_agent_states() {
    for status in [
        AgentStatus::Ready,
        AgentStatus::Busy,
        AgentStatus::Closing,
        AgentStatus::Closed,
        AgentStatus::Unknown,
    ] {
        let original = AgentState {
            id: "agent-1".into(),
            status,
            cursor: None,
            active_turn_id: Some("turn-1".into()),
            queued_turn_ids: vec!["turn-2".into()],
            requests: vec![AgentRequest {
                id: "request-1".into(),
                turn_id: "turn-1".into(),
                kind: AgentRequestKind::Question {
                    text: "Continue?".into(),
                    schema: Some(json!({"type":"string"})),
                },
            }],
            steering: vec![AgentSteeringReceipt {
                id: "steer-1".into(),
                turn_id: "turn-1".into(),
                status: AgentSteeringStatus::Unused,
            }],
        };
        let encoded = agent_state(&original);
        let decoded: AgentState = serde_json::from_value::<State>(encoded.clone())
            .unwrap()
            .try_into()
            .unwrap();
        assert_eq!(agent_state(&decoded), encoded);
    }
}

#[test]
fn turn_decoders_reject_invalid_enum_values() {
    for (path, field) in [
        ("/status", "turn status"),
        ("/result/status", "turn status"),
        ("/result/outcome", "outcome"),
        ("/steering/0/status", "steering status"),
    ] {
        let mut wire: Value =
            serde_json::from_str(turn_state(&sample_turn(AgentTurnStatus::Running)).get()).unwrap();
        *wire.pointer_mut(path).unwrap() = json!("not-an-enum-value");
        let decoded: BoxliteResult<AgentTurnState> =
            serde_json::from_str::<Turn>(&wire.to_string())
                .unwrap()
                .try_into();
        assert!(decoded.unwrap_err().to_string().contains(field), "{path}");
    }
}

#[test]
fn turn_decoders_reject_mismatched_child_ids() {
    for path in [
        "/result/turn_id",
        "/requests/0/turn_id",
        "/steering/0/turn_id",
    ] {
        let mut wire: Value =
            serde_json::from_str(turn_state(&sample_turn(AgentTurnStatus::Running)).get()).unwrap();
        *wire.pointer_mut(path).unwrap() = json!("another-turn");
        let decoded: BoxliteResult<AgentTurnState> =
            serde_json::from_str::<Turn>(&wire.to_string())
                .unwrap()
                .try_into();
        assert!(
            decoded
                .unwrap_err()
                .to_string()
                .contains("turn child identity"),
            "{path}"
        );
    }
}

#[test]
fn turn_decoders_accept_absent_result_and_empty_children() {
    let mut original = sample_turn(AgentTurnStatus::Queued);
    original.result = None;
    original.requests.clear();
    original.steering.clear();
    let wire = turn_state(&original);
    let decoded: AgentTurnState = serde_json::from_str::<Turn>(wire.get())
        .unwrap()
        .try_into()
        .unwrap();
    assert_eq!(turn_state(&decoded).get(), wire.get());
}

#[test]
fn state_decoders_reject_invalid_status_and_nested_receipts() {
    let original = AgentState {
        id: "agent-1".into(),
        status: AgentStatus::Ready,
        cursor: None,
        active_turn_id: None,
        queued_turn_ids: Vec::new(),
        requests: Vec::new(),
        steering: sample_turn(AgentTurnStatus::Running).steering,
    };
    for (path, field) in [
        ("/status", "status"),
        ("/steering/0/status", "steering status"),
    ] {
        let mut wire = agent_state(&original);
        *wire.pointer_mut(path).unwrap() = json!("not-an-enum-value");
        let decoded: BoxliteResult<AgentState> =
            serde_json::from_value::<State>(wire).unwrap().try_into();
        assert!(decoded.unwrap_err().to_string().contains(field), "{path}");
    }
}

#[test]
fn config_responses_round_trip_known_fields_and_ignore_extensions() {
    let original = AgentConfig {
        model: Some("provider/model".into()),
        reasoning: Some("high".into()),
        instructions: Some("be concise".into()),
        tools: vec!["shell".into()],
        mcp: vec!["docs".into()],
        permissions: Some(json!({"shell": false})),
        limits: Some(json!({"tokens": 100})),
        output_schema: Some(json!({"type": "object"})),
    };
    let expected = config(&original);
    assert_eq!(config(&parse_config(expected.clone()).unwrap()), expected);
    let mut wire = expected.clone();
    wire["provider_metadata"] = json!({"version": 2});
    assert!(parse_config(wire.clone()).is_err());
    let decoded: AgentConfig = serde_json::from_value::<Config>(wire).unwrap().into();
    assert_eq!(config(&decoded), expected);
    for path in ["/model", "/reasoning", "/tools", "/mcp"] {
        let mut wire = expected.clone();
        *wire.pointer_mut(path).unwrap() = json!(123);
        assert!(serde_json::from_value::<Config>(wire).is_err(), "{path}");
    }
}
