//! JSON records for `boxlite agent`, in the shapes documented under "C JSON
//! fields" in `docs/reference/agents.md`.
//!
//! The CLI owns these shapes so the public `boxlite::agents` types stay free of
//! serialization contracts; enum names are the documented snake_case strings.

use boxlite::agents::{
    AgentCapabilities, AgentConfig, AgentEvent, AgentOutcome, AgentRequest, AgentRequestKind,
    AgentResponse, AgentResult, AgentState, AgentStatus, AgentSteeringReceipt, AgentSteeringStatus,
    AgentTurnState, AgentTurnStatus,
};
use boxlite::{BoxliteError, BoxliteResult};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;

pub(super) fn agent_state(state: &AgentState) -> Value {
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

pub(super) fn turn_state(state: &AgentTurnState) -> Value {
    json!({
        "id": state.id,
        "agent_id": state.agent_id,
        "status": turn_status(state.status),
        "cursor": state.cursor,
        "result": state.result.as_ref().map(result),
        "requests": requests(&state.requests),
        "steering": state.steering.iter().map(receipt).collect::<Vec<_>>(),
    })
}

pub(super) fn result(result: &AgentResult) -> Value {
    json!({
        "turn_id": result.turn_id,
        "status": turn_status(result.status),
        "outcome": result.outcome.map(|outcome| match outcome {
            AgentOutcome::Answer => "answer",
            AgentOutcome::Question => "question",
        }),
        "text": result.text,
        "data": result.data,
        "artifacts": result.artifacts,
        "usage": result.usage,
        "error": result.error,
    })
}

pub(super) fn receipt(receipt: &AgentSteeringReceipt) -> Value {
    let status = match receipt.status {
        AgentSteeringStatus::Accepted => "accepted",
        AgentSteeringStatus::Applied => "applied",
        AgentSteeringStatus::Unused => "unused",
        AgentSteeringStatus::Unknown => "unknown",
    };
    json!({ "id": receipt.id, "turn_id": receipt.turn_id, "status": status })
}

pub(super) fn requests(requests: &[AgentRequest]) -> Value {
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

pub(super) fn config(config: &AgentConfig) -> Value {
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

pub(super) fn capabilities(capabilities: &AgentCapabilities) -> Value {
    json!({
        "operations": capabilities.operations,
        "input_kinds": capabilities.input_kinds,
        "max_queued_turns": capabilities.max_queued_turns,
        "max_pending_steering": capabilities.max_pending_steering,
        "idempotency_retention_seconds":
            capabilities.idempotency_retention.map(|retention| retention.as_secs_f64()),
    })
}

pub(super) fn event(event: &AgentEvent) -> Value {
    json!({
        "cursor": event.cursor,
        "agent_id": event.agent_id,
        "turn_id": event.turn_id,
        "kind": event.kind,
        "data": event.data,
    })
}

/// Human text for a streamed turn: each finished text block, and one line per
/// tool call. OpenCode names a tool when its input starts and calls it later
/// by ID, so names are remembered per call.
#[derive(Default)]
pub(super) struct TextPrinter {
    tools: HashMap<String, String>,
}

impl TextPrinter {
    pub(super) fn line(&mut self, event: &AgentEvent) -> Option<String> {
        let data = &event.data["data"];
        match event.kind.as_str() {
            "session.tool.input.started" => {
                if let (Some(id), Some(name)) = (data["id"].as_str(), data["name"].as_str()) {
                    self.tools.insert(id.to_owned(), name.to_owned());
                }
                None
            }
            "session.tool.called" => {
                let name = data["id"]
                    .as_str()
                    .and_then(|id| self.tools.get(id))
                    .map_or("tool", String::as_str);
                Some(format!("[{name}] {}", data["input"]))
            }
            "session.text.ended" => data["text"].as_str().map(str::to_owned),
            _ => None,
        }
    }
}

/// Parse `--agent-config`; unknown fields are rejected rather than ignored.
pub(super) fn parse_config(value: Value) -> BoxliteResult<AgentConfig> {
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
pub(super) fn parse_response(value: Value) -> BoxliteResult<AgentResponse> {
    #[derive(Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
    enum ResponseRecord {
        Answer { text: String, data: Option<Value> },
        Permission { approved: bool },
    }
    let record: ResponseRecord = serde_json::from_value(value)
        .map_err(|error| BoxliteError::InvalidArgument(format!("response: {error}")))?;
    Ok(match record {
        ResponseRecord::Answer { text, data } => AgentResponse::Answer { text, data },
        ResponseRecord::Permission { approved } => AgentResponse::Permission { approved },
    })
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

pub(super) fn turn_status(status: AgentTurnStatus) -> &'static str {
    match status {
        AgentTurnStatus::Queued => "queued",
        AgentTurnStatus::Running => "running",
        AgentTurnStatus::WaitingInput => "waiting_input",
        AgentTurnStatus::Interrupting => "interrupting",
        AgentTurnStatus::Completed => "completed",
        AgentTurnStatus::Cancelled => "cancelled",
        AgentTurnStatus::Failed => "failed",
        AgentTurnStatus::Unknown => "unknown",
    }
}
