//! P0 agent API declarations. No agent backend is implemented yet.
//!
//! All operations, including read-only accessors and opening event streams,
//! return [`BoxliteError::Unsupported`]. Obtaining [`AgentHandle`] is inert.

mod types;
pub use types::*;

use crate::{BoxliteError, BoxliteResult};

/// Box-owned agent namespace, obtained from [`crate::LiteBox::agents`].
#[derive(Debug, Clone)]
pub struct AgentHandle {
    pub(crate) _private: (),
}

/// Conversation handle. Creation and lookup are currently unimplemented.
#[derive(Debug, Clone)]
pub struct AgentSession {
    _private: (),
}

/// One submitted task. No turn can currently be started or restored.
#[derive(Debug, Clone)]
pub struct AgentTurn {
    _private: (),
}

impl AgentHandle {
    /// Create a session with initial configuration. Currently unimplemented.
    pub async fn create(
        &self,
        _agent: &str,
        _options: AgentCreateOptions,
    ) -> BoxliteResult<AgentSession> {
        not_implemented("agents.create")
    }

    /// Look up a session without replaying work. Currently unimplemented.
    pub async fn get(&self, _session_id: &str) -> BoxliteResult<AgentSession> {
        not_implemented("agents.get")
    }
}

impl AgentSession {
    /// Stop admissions and close the agent loop. Currently unimplemented.
    pub async fn close(&self, _options: AgentControlOptions) -> BoxliteResult<()> {
        not_implemented("session.close")
    }

    /// Submit text with optional JSON data; queue is the proposed default.
    pub async fn send(&self, _text: &str, _options: AgentSendOptions) -> BoxliteResult<AgentTurn> {
        not_implemented("session.send")
    }

    /// Look up a turn without executing it. Currently unimplemented.
    pub async fn get_turn(&self, _turn_id: &str) -> BoxliteResult<AgentTurn> {
        not_implemented("session.get_turn")
    }

    /// Open the session journal after an opaque cursor. Returns an error, not an empty stream.
    pub async fn events(&self, _options: AgentEventsOptions) -> BoxliteResult<AgentEventStream> {
        not_implemented("session.events")
    }

    /// Read outstanding questions and permissions. Currently unimplemented.
    pub async fn requests(&self) -> BoxliteResult<Vec<AgentRequest>> {
        not_implemented("session.requests")
    }

    /// Answer a typed request; a terminal question may create an answering turn.
    pub async fn respond(
        &self,
        _request_id: &str,
        _response: AgentResponse,
        _options: AgentControlOptions,
    ) -> BoxliteResult<AgentTurn> {
        not_implemented("session.respond")
    }

    /// Read a consistent snapshot. No fabricated state is returned by this stub.
    pub fn state(&self) -> BoxliteResult<AgentSessionState> {
        not_implemented("session.state")
    }

    /// Read effective configuration. Currently unimplemented.
    pub fn config(&self) -> BoxliteResult<AgentConfig> {
        not_implemented("session.config")
    }

    /// Read adapter guarantees and limits. Currently unimplemented.
    pub fn capabilities(&self) -> BoxliteResult<AgentCapabilities> {
        not_implemented("session.capabilities")
    }
}

impl AgentTurn {
    /// Wait for a result; timeout does not imply cancellation. Currently unimplemented.
    pub async fn wait(&self, _options: AgentWaitOptions) -> BoxliteResult<AgentResult> {
        not_implemented("turn.wait")
    }

    /// Open this turn's view of the session journal. Currently unimplemented.
    pub async fn events(&self, _options: AgentEventsOptions) -> BoxliteResult<AgentEventStream> {
        not_implemented("turn.events")
    }

    /// Steer this turn, never silently queue a new one. Currently unimplemented.
    pub async fn steer(
        &self,
        _text: &str,
        _options: AgentControlOptions,
    ) -> BoxliteResult<AgentSteeringReceipt> {
        not_implemented("turn.steer")
    }

    /// Confirm interruption of this agent loop, not background processes in the Box.
    pub async fn interrupt(&self, _options: AgentControlOptions) -> BoxliteResult<()> {
        not_implemented("turn.interrupt")
    }

    /// Read a consistent snapshot. Currently unimplemented.
    pub fn state(&self) -> BoxliteResult<AgentTurnState> {
        not_implemented("turn.state")
    }
}

fn not_implemented<T>(operation: &str) -> BoxliteResult<T> {
    Err(BoxliteError::Unsupported(format!(
        "{operation} is not implemented"
    )))
}

#[cfg(test)]
mod tests;
