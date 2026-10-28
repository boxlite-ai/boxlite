//! Agent configuration, options, events, and results.

use std::pin::Pin;
use std::time::Duration;

use futures::Stream;
use serde_json::Value;

use crate::BoxliteResult;

/// A journal stream.
pub type AgentEventStream = Pin<Box<dyn Stream<Item = BoxliteResult<AgentEvent>> + Send + Sync>>;

/// Initial adapter configuration. Tools/MCP entries identify Box-managed resources.
#[derive(Debug, Clone, Default)]
pub struct AgentConfig {
    pub model: Option<String>,
    pub reasoning: Option<String>,
    pub instructions: Option<String>,
    pub tools: Vec<String>,
    pub mcp: Vec<String>,
    pub permissions: Option<Value>,
    pub limits: Option<Value>,
    pub output_schema: Option<Value>,
}

/// Creation options; no default working directory is assumed.
#[derive(Debug, Clone, Default)]
pub struct AgentCreateOptions {
    pub cwd: Option<String>,
    pub config: AgentConfig,
    pub idempotency_key: Option<String>,
}

/// Admission modes for submitted work.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum AgentSendMode {
    #[default]
    Queue,
    Reject,
}

/// Submit text with optional JSON data and a retry key.
#[derive(Debug, Clone, Default)]
pub struct AgentSendOptions {
    pub mode: AgentSendMode,
    pub data: Option<Value>,
    pub idempotency_key: Option<String>,
}

/// Deadline for waiting; None leaves waiting unbounded.
#[derive(Debug, Clone, Default)]
pub struct AgentWaitOptions {
    pub timeout: Option<Duration>,
}

/// Resume a journal view after an opaque cursor.
#[derive(Debug, Clone, Default)]
pub struct AgentEventsOptions {
    pub after: Option<String>,
}

/// Retry identity for close, reply, steering and interruption operations.
#[derive(Debug, Clone, Default)]
pub struct AgentControlOptions {
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentStatus {
    Ready,
    Busy,
    Closing,
    Closed,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentTurnStatus {
    Queued,
    Running,
    WaitingInput,
    Interrupting,
    Completed,
    Cancelled,
    Failed,
    Unknown,
}

/// Snapshot cursor and pending interaction state are retained together.
#[derive(Debug, Clone)]
pub struct AgentState {
    pub id: String,
    pub status: AgentStatus,
    pub cursor: String,
    pub active_turn_id: Option<String>,
    pub queued_turn_ids: Vec<String>,
    pub requests: Vec<AgentRequest>,
    pub steering: Vec<AgentSteeringReceipt>,
}

#[derive(Debug, Clone)]
pub struct AgentTurnState {
    pub id: String,
    pub agent_id: String,
    pub status: AgentTurnStatus,
    pub cursor: String,
    pub result: Option<AgentResult>,
    pub requests: Vec<AgentRequest>,
    pub steering: Vec<AgentSteeringReceipt>,
}

/// Advertised operations and bounds, never assumed from an adapter's name.
#[derive(Debug, Clone)]
pub struct AgentCapabilities {
    pub operations: Vec<String>,
    pub input_kinds: Vec<String>,
    pub max_queued_turns: usize,
    pub max_pending_steering: usize,
    pub idempotency_retention: Duration,
}

/// Agent-owned request with the turn that produced it.
#[derive(Debug, Clone)]
pub struct AgentRequest {
    pub id: String,
    pub turn_id: String,
    pub kind: AgentRequestKind,
}

#[derive(Debug, Clone)]
pub enum AgentRequestKind {
    Question { text: String, schema: Option<Value> },
    Permission { tool: String, arguments: Value },
}

/// Text can answer a question; only the Permission variant can grant authority.
#[derive(Debug, Clone)]
pub enum AgentResponse {
    Answer { text: String, data: Option<Value> },
    Permission { approved: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentSteeringStatus {
    Accepted,
    Applied,
    Unused,
    Unknown,
}

/// Applied means delivered to context, not guaranteed model compliance.
#[derive(Debug, Clone)]
pub struct AgentSteeringReceipt {
    pub id: String,
    pub turn_id: String,
    pub status: AgentSteeringStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentOutcome {
    Answer,
    Question,
}

/// Result provenance and optional adapter-reported usage; unavailable usage is not zero.
#[derive(Debug, Clone)]
pub struct AgentResult {
    pub turn_id: String,
    pub status: AgentTurnStatus,
    pub outcome: Option<AgentOutcome>,
    pub text: Option<String>,
    pub data: Option<Value>,
    pub artifacts: Vec<String>,
    pub usage: Option<Value>,
    pub error: Option<String>,
}

/// One journal entry. Cursor and IDs are opaque; data is adapter-reported JSON.
#[derive(Debug, Clone)]
pub struct AgentEvent {
    pub cursor: String,
    pub agent_id: String,
    pub turn_id: Option<String>,
    pub kind: String,
    pub data: Value,
}
