//! Box-owned agents and turns.

mod types;
pub use types::*;

use crate::{BoxliteError, BoxliteResult};

/// Box-owned agent namespace, obtained from [`crate::LiteBox::agents`].
#[derive(Debug, Clone)]
pub struct Agents {
    pub(crate) _private: (),
}

/// Box-owned agent instance with its conversation.
#[derive(Debug, Clone)]
pub struct Agent {
    _private: (),
}

/// One submitted task.
#[derive(Debug, Clone)]
pub struct AgentTurn {
    _private: (),
}

impl Agents {
    /// Create an agent with initial configuration.
    pub async fn create(&self, _agent: &str, _options: AgentCreateOptions) -> BoxliteResult<Agent> {
        not_implemented("agents.create")
    }

    /// Look up an agent without replaying work.
    pub async fn get(&self, _agent_id: &str) -> BoxliteResult<Agent> {
        not_implemented("agents.get")
    }
}

impl Agent {
    /// Stop admissions and close the agent loop.
    pub async fn close(&self, _options: AgentControlOptions) -> BoxliteResult<()> {
        not_implemented("agent.close")
    }

    /// Submit text with optional JSON data; queue is the default admission mode.
    pub async fn send(&self, _text: &str, _options: AgentSendOptions) -> BoxliteResult<AgentTurn> {
        not_implemented("agent.send")
    }

    /// Look up a turn without executing it.
    pub async fn get_turn(&self, _turn_id: &str) -> BoxliteResult<AgentTurn> {
        not_implemented("agent.get_turn")
    }

    /// Open the agent journal after an opaque cursor.
    pub async fn events(&self, _options: AgentEventsOptions) -> BoxliteResult<AgentEventStream> {
        not_implemented("agent.events")
    }

    /// Read outstanding questions and permissions.
    pub async fn requests(&self) -> BoxliteResult<Vec<AgentRequest>> {
        not_implemented("agent.requests")
    }

    /// Answer a typed request; a terminal question may create an answering turn.
    pub async fn respond(
        &self,
        _request_id: &str,
        _response: AgentResponse,
        _options: AgentControlOptions,
    ) -> BoxliteResult<AgentTurn> {
        not_implemented("agent.respond")
    }

    /// Read a consistent snapshot.
    pub fn state(&self) -> BoxliteResult<AgentState> {
        not_implemented("agent.state")
    }

    /// Read effective configuration.
    pub fn config(&self) -> BoxliteResult<AgentConfig> {
        not_implemented("agent.config")
    }

    /// Read adapter guarantees and limits.
    pub fn capabilities(&self) -> BoxliteResult<AgentCapabilities> {
        not_implemented("agent.capabilities")
    }
}

impl AgentTurn {
    /// Wait for a result; timeout does not imply cancellation.
    pub async fn wait(&self, _options: AgentWaitOptions) -> BoxliteResult<AgentResult> {
        not_implemented("turn.wait")
    }

    /// Open this turn's view of the agent journal.
    pub async fn events(&self, _options: AgentEventsOptions) -> BoxliteResult<AgentEventStream> {
        not_implemented("turn.events")
    }

    /// Steer this turn, never silently queue a new one.
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

    /// Read a consistent snapshot.
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
