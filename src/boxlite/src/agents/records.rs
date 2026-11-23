//! Shared JSON records for agent API consumers.
//!
//! Field names and enum spellings follow the C JSON contract in
//! `docs/reference/agents.md`.

use super::{
    AgentCapabilities, AgentConfig, AgentEvent, AgentRequest, AgentRequestKind, AgentResponse,
    AgentResult, AgentState, AgentStatus, AgentSteeringReceipt, AgentSteeringStatus,
    AgentTurnState, AgentTurnStatus,
};
use crate::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use serde_json::{Value, json};

pub fn agent_state(state: &AgentState) -> Value {
    json!({
        "id": state.id,
        "status": agent_status(state.status),
        "cursor": state.cursor,
        "active_turn_id": state.active_turn_id,
        "queued_turn_ids": state.queued_turn_ids,
        "requests": requests(&state.requests),
        "steering": state.steering.iter().map(receipt).collect::<Vec<_>>(),
    })
}

pub fn turn_state(state: &AgentTurnState) -> Box<RawValue> {
    #[derive(Serialize)]
    struct Record<'a> {
        id: &'a str,
        agent_id: &'a str,
        status: AgentTurnStatus,
        cursor: Option<&'a str>,
        result: Option<&'a AgentResult>,
        requests: Value,
        steering: Vec<Value>,
    }
    to_raw_value(&Record {
        id: &state.id,
        agent_id: &state.agent_id,
        status: state.status,
        cursor: state.cursor.as_deref(),
        result: state.result.as_ref(),
        requests: requests(&state.requests),
        steering: state.steering.iter().map(receipt).collect(),
    })
    .expect("agent turn fields are JSON-serializable")
}

pub fn result(result: &AgentResult) -> Box<RawValue> {
    to_raw_value(result).expect("agent result fields are JSON-serializable")
}

pub fn receipt(receipt: &AgentSteeringReceipt) -> Value {
    let status = match receipt.status {
        AgentSteeringStatus::Accepted => "accepted",
        AgentSteeringStatus::Applied => "applied",
        AgentSteeringStatus::Unused => "unused",
        AgentSteeringStatus::Unknown => "unknown",
    };
    json!({ "id": receipt.id, "turn_id": receipt.turn_id, "status": status })
}

pub fn requests(requests: &[AgentRequest]) -> Value {
    let records = requests.iter().map(|request| {
        let kind = match &request.kind {
            AgentRequestKind::Question { text, schema } => {
                json!({ "type": "question", "text": text, "schema": schema })
            }
            AgentRequestKind::Permission { tool, arguments } => {
                json!({ "type": "permission", "tool": tool, "arguments": arguments })
            }
        };
        json!({ "id": request.id, "turn_id": request.turn_id, "kind": kind })
    });
    Value::Array(records.collect())
}

pub fn config(config: &AgentConfig) -> Value {
    let mut record = json!({ "tools": config.tools, "mcp": config.mcp });
    let optional = [
        ("model", config.model.clone().map(Value::String)),
        ("reasoning", config.reasoning.clone().map(Value::String)),
        (
            "instructions",
            config.instructions.clone().map(Value::String),
        ),
        ("permissions", config.permissions.clone()),
        ("limits", config.limits.clone()),
        ("output_schema", config.output_schema.clone()),
    ];
    for (name, value) in optional {
        if let Some(value) = value {
            record[name] = value;
        }
    }
    record
}

pub fn capabilities(capabilities: &AgentCapabilities) -> Value {
    json!({
        "operations": capabilities.operations,
        "input_kinds": capabilities.input_kinds,
        "max_queued_turns": capabilities.max_queued_turns,
        "max_pending_steering": capabilities.max_pending_steering,
        "idempotency_retention_seconds":
            capabilities.idempotency_retention.map(|retention| {
                // Keep nanoseconds exact even beyond f64's integer precision.
                let seconds = format!("{}.{:09}", retention.as_secs(), retention.subsec_nanos());
                seconds.trim_end_matches('0').trim_end_matches('.')
                    .parse::<serde_json::Number>()
                    .expect("integer seconds and nanoseconds form a valid JSON number")
            }),
    })
}

pub fn event(event: &AgentEvent) -> Value {
    json!({
        "cursor": event.cursor,
        "agent_id": event.agent_id,
        "turn_id": event.turn_id,
        "kind": event.kind,
        "data": event.data,
    })
}

/// Parse `--agent-config`; unknown fields are rejected rather than ignored.
pub fn parse_config(value: Value) -> BoxliteResult<AgentConfig> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ConfigRecord {
        model: Option<String>,
        reasoning: Option<String>,
        instructions: Option<String>,
        #[serde(default)]
        tools: Vec<String>,
        #[serde(default)]
        mcp: Vec<String>,
        permissions: Option<Value>,
        limits: Option<Value>,
        output_schema: Option<Value>,
    }
    let record: ConfigRecord = serde_json::from_value(value)
        .map_err(|error| BoxliteError::InvalidArgument(format!("--agent-config: {error}")))?;
    Ok(AgentConfig {
        model: record.model,
        reasoning: record.reasoning,
        instructions: record.instructions,
        tools: record.tools,
        mcp: record.mcp,
        permissions: record.permissions,
        limits: record.limits,
        output_schema: record.output_schema,
    })
}

/// Parse the `respond` argument: an answer or a permission decision.
pub fn parse_response(json: &str) -> BoxliteResult<AgentResponse> {
    #[derive(Deserialize)]
    #[serde(rename_all = "snake_case")]
    enum Kind {
        Answer,
        Permission,
    }
    #[derive(Deserialize)]
    struct Tag {
        #[serde(rename = "type")]
        kind: Kind,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Answer {
        #[serde(rename = "type")]
        _kind: Kind,
        text: String,
        data: Option<Box<RawValue>>,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Permission {
        #[serde(rename = "type")]
        _kind: Kind,
        approved: bool,
    }
    let invalid = |e| BoxliteError::InvalidArgument(format!("response: {e}"));
    // Internally tagged enums buffer the payload before selecting the variant.
    // Read the tag first so the selected record can borrow its original JSON input.
    match serde_json::from_str::<Tag>(json).map_err(invalid)?.kind {
        Kind::Answer => {
            let Answer { text, data, .. } = serde_json::from_str(json).map_err(invalid)?;
            Ok(AgentResponse::Answer { text, data })
        }
        Kind::Permission => {
            let Permission { approved, .. } = serde_json::from_str(json).map_err(invalid)?;
            Ok(AgentResponse::Permission { approved })
        }
    }
}

fn agent_status(status: AgentStatus) -> &'static str {
    match status {
        AgentStatus::Ready => "ready",
        AgentStatus::Busy => "busy",
        AgentStatus::Closing => "closing",
        AgentStatus::Closed => "closed",
        AgentStatus::Unknown => "unknown",
    }
}
