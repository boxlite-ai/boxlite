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
    let status = steering_status(receipt.status);
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
    if !value.is_object() {
        return Err(BoxliteError::InvalidArgument(
            "--agent-config must be an object".into(),
        ));
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
    fn present_raw<'de, D: serde::Deserializer<'de>>(
        d: D,
    ) -> Result<Option<Box<RawValue>>, D::Error> {
        Box::<RawValue>::deserialize(d).map(Some)
    }
    if !json.trim_start().starts_with('{') {
        return Err(BoxliteError::InvalidArgument(
            "response must be a JSON object".into(),
        ));
    }
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
        #[serde(default, deserialize_with = "present_raw")]
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

macro_rules! record_enum {
    ($encode:ident, $decode:ident, $ty:ty, $field:literal, { $($variant:path => $wire:literal),+ $(,)? }) => {
        fn $encode(value: $ty) -> &'static str {
            match value { $($variant => $wire),+ }
        }
        #[cfg(feature = "rest")]
        fn $decode(value: &str) -> BoxliteResult<$ty> {
            match value { $($wire => Ok($variant),)+ other => Err(invalid($field, other)) }
        }
    };
}

record_enum!(agent_status, parse_agent_status, AgentStatus, "status", {
    AgentStatus::Ready => "ready", AgentStatus::Busy => "busy", AgentStatus::Closing => "closing",
    AgentStatus::Closed => "closed", AgentStatus::Unknown => "unknown",
});
#[cfg(feature = "rest")]
fn parse_turn_status(value: &str) -> BoxliteResult<super::AgentTurnStatus> {
    super::AgentTurnStatus::deserialize(
        serde::de::value::StrDeserializer::<serde::de::value::Error>::new(value),
    )
    .map_err(|_| invalid("turn status", value))
}
record_enum!(steering_status, parse_steering_status, AgentSteeringStatus, "steering status", {
    AgentSteeringStatus::Accepted => "accepted", AgentSteeringStatus::Applied => "applied",
    AgentSteeringStatus::Unused => "unused", AgentSteeringStatus::Unknown => "unknown",
});
#[cfg(feature = "rest")]
fn parse_outcome(value: &str) -> BoxliteResult<super::AgentOutcome> {
    super::AgentOutcome::deserialize(
        serde::de::value::StrDeserializer::<serde::de::value::Error>::new(value),
    )
    .map_err(|_| invalid("outcome", value))
}

#[cfg(feature = "rest")]
#[derive(Deserialize)]
pub(super) struct Resource {
    pub(super) id: String,
    pub(super) agent: String,
    pub(super) state: Option<State>,
    pub(super) config: Config,
    pub(super) capabilities: Capabilities,
}

#[cfg(feature = "rest")]
#[derive(Deserialize)]
pub(super) struct Config {
    model: Option<String>,
    reasoning: Option<String>,
    instructions: Option<String>,
    tools: Vec<String>,
    mcp: Vec<String>,
    permissions: Option<Value>,
    limits: Option<Value>,
    output_schema: Option<Value>,
}

#[cfg(feature = "rest")]
impl From<Config> for AgentConfig {
    fn from(value: Config) -> Self {
        Self {
            model: value.model,
            reasoning: value.reasoning,
            instructions: value.instructions,
            tools: value.tools,
            mcp: value.mcp,
            permissions: value.permissions,
            limits: value.limits,
            output_schema: value.output_schema,
        }
    }
}

#[cfg(feature = "rest")]
#[derive(Deserialize)]
pub(super) struct Capabilities {
    pub(super) operations: Vec<String>,
    pub(super) input_kinds: Vec<String>,
    pub(super) max_queued_turns: Option<usize>,
    pub(super) max_pending_steering: Option<usize>,
    pub(super) idempotency_retention_seconds: Option<f64>,
}

#[cfg(feature = "rest")]
#[derive(Deserialize)]
pub(super) struct State {
    pub(super) id: String,
    pub(super) status: String,
    pub(super) cursor: Option<String>,
    pub(super) active_turn_id: Option<String>,
    pub(super) queued_turn_ids: Vec<String>,
    pub(super) requests: Vec<Request>,
    pub(super) steering: Vec<Receipt>,
}

#[cfg(feature = "rest")]
#[derive(Deserialize)]
pub(super) struct Request {
    pub(super) id: String,
    pub(super) turn_id: String,
    pub(super) kind: RequestKind,
}

#[cfg(feature = "rest")]
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum RequestKind {
    Question { text: String, schema: Option<Value> },
    Permission { tool: String, arguments: Value },
}

#[cfg(feature = "rest")]
#[derive(Deserialize)]
pub(super) struct Receipt {
    pub(super) id: String,
    pub(super) turn_id: String,
    pub(super) status: String,
}

#[cfg(feature = "rest")]
#[derive(Deserialize)]
pub(super) struct Turn {
    pub(super) id: String,
    pub(super) agent_id: String,
    pub(super) status: String,
    pub(super) cursor: Option<String>,
    pub(super) result: Option<ResultRecord>,
    pub(super) requests: Vec<Request>,
    pub(super) steering: Vec<Receipt>,
}

#[cfg(feature = "rest")]
#[derive(Deserialize)]
pub(super) struct ResultRecord {
    pub(super) turn_id: String,
    pub(super) status: String,
    pub(super) outcome: Option<String>,
    pub(super) text: Option<String>,
    pub(super) data: Option<Box<RawValue>>,
    pub(super) artifacts: Vec<String>,
    pub(super) usage: Option<Value>,
    pub(super) error: Option<String>,
}

#[cfg(feature = "rest")]
pub(super) fn invalid(field: &str, value: &str) -> BoxliteError {
    BoxliteError::Internal(format!("invalid REST agent {field}: {value}"))
}

#[cfg(feature = "rest")]
impl TryFrom<ResultRecord> for AgentResult {
    type Error = BoxliteError;
    fn try_from(value: ResultRecord) -> BoxliteResult<Self> {
        let outcome = value.outcome.as_deref().map(parse_outcome).transpose()?;
        Ok(Self {
            turn_id: value.turn_id,
            status: parse_turn_status(&value.status)?,
            outcome,
            text: value.text,
            data: value.data,
            artifacts: value.artifacts,
            usage: value.usage,
            error: value.error,
        })
    }
}

#[cfg(feature = "rest")]
impl TryFrom<Turn> for AgentTurnState {
    type Error = BoxliteError;
    fn try_from(value: Turn) -> BoxliteResult<Self> {
        if value
            .result
            .as_ref()
            .is_some_and(|result| result.turn_id != value.id)
            || value
                .requests
                .iter()
                .any(|request| request.turn_id != value.id)
            || value
                .steering
                .iter()
                .any(|receipt| receipt.turn_id != value.id)
        {
            return Err(invalid("turn child identity", &value.id));
        }
        Ok(Self {
            id: value.id,
            agent_id: value.agent_id,
            status: parse_turn_status(&value.status)?,
            cursor: value.cursor,
            result: value.result.map(TryInto::try_into).transpose()?,
            requests: value.requests.into_iter().map(Into::into).collect(),
            steering: value
                .steering
                .into_iter()
                .map(TryInto::try_into)
                .collect::<BoxliteResult<_>>()?,
        })
    }
}

#[cfg(feature = "rest")]
impl TryFrom<Receipt> for AgentSteeringReceipt {
    type Error = BoxliteError;

    fn try_from(value: Receipt) -> BoxliteResult<Self> {
        let status = parse_steering_status(&value.status)?;
        Ok(Self {
            id: value.id,
            turn_id: value.turn_id,
            status,
        })
    }
}

#[cfg(feature = "rest")]
impl From<Request> for AgentRequest {
    fn from(value: Request) -> Self {
        let kind = match value.kind {
            RequestKind::Question { text, schema } => AgentRequestKind::Question { text, schema },
            RequestKind::Permission { tool, arguments } => {
                AgentRequestKind::Permission { tool, arguments }
            }
        };
        Self {
            id: value.id,
            turn_id: value.turn_id,
            kind,
        }
    }
}

#[cfg(feature = "rest")]
impl TryFrom<State> for AgentState {
    type Error = BoxliteError;

    fn try_from(value: State) -> BoxliteResult<Self> {
        let status = parse_agent_status(&value.status)?;
        Ok(Self {
            id: value.id,
            status,
            cursor: value.cursor,
            active_turn_id: value.active_turn_id,
            queued_turn_ids: value.queued_turn_ids,
            requests: value.requests.into_iter().map(Into::into).collect(),
            steering: value
                .steering
                .into_iter()
                .map(TryInto::try_into)
                .collect::<BoxliteResult<_>>()?,
        })
    }
}

#[cfg(all(test, feature = "rest"))]
#[path = "records/tests/rest.rs"]
mod rest;
