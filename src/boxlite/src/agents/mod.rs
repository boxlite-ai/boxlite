//! Box-owned agents and turns.
//!
//! BoxLite forwards each operation to a coding agent's native interface inside
//! the Box. The agent owns its conversation, execution and recovery; BoxLite
//! owns the Box and the transport, and starts the agent's own service when
//! none runs. OpenCode 2.2 on a local runtime is the only implementation;
//! unsupported operations and options fail with `Unsupported` before reaching
//! the agent.

mod opencode;
mod types;
pub use types::*;

use std::sync::Arc;
use std::time::Duration;

use crate::litebox::box_impl::BoxImpl;
use crate::runtime::backend::{BoxBackend, BoxNetworkBackend};
use crate::{BoxliteError, BoxliteResult};

/// How often `turn.wait` re-reads native turn state.
const TURN_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Box-owned agent namespace, obtained from [`crate::LiteBox::agents`].
#[derive(Clone)]
pub struct Agents {
    box_backend: Arc<dyn BoxBackend>,
    network_backend: Arc<dyn BoxNetworkBackend>,
}

impl std::fmt::Debug for Agents {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Agents")
            .field("box_id", self.box_backend.id())
            .finish_non_exhaustive()
    }
}

/// Box-owned agent instance with its conversation.
#[derive(Debug, Clone)]
pub struct Agent {
    session: Arc<opencode::Session>,
}

/// One submitted task.
#[derive(Debug, Clone)]
pub struct AgentTurn {
    session: Arc<opencode::Session>,
    state: AgentTurnState,
}

impl Agents {
    pub(crate) fn new(
        box_backend: Arc<dyn BoxBackend>,
        network_backend: Arc<dyn BoxNetworkBackend>,
    ) -> Self {
        Self {
            box_backend,
            network_backend,
        }
    }

    /// Create an agent with initial configuration.
    ///
    /// `agent` selects the implementation: only `"opencode"`, with OpenCode
    /// 2.2.2 already installed in the Box. Starts the Box and OpenCode's
    /// managed service on first use.
    pub async fn create(&self, agent: &str, options: AgentCreateOptions) -> BoxliteResult<Agent> {
        if agent != opencode::IMPLEMENTATION {
            return Err(BoxliteError::Unsupported(format!(
                "agent implementation {agent:?} is not supported; supported: {}",
                opencode::IMPLEMENTATION
            )));
        }
        self.require_local_runtime()?;
        let request = opencode::SessionRequest::new(&options)?;
        let server = self.opencode_server().await?;
        Ok(Agent::new(server.create_session(request).await?))
    }

    /// Look up an agent without replaying work.
    pub async fn get(&self, agent_id: &str) -> BoxliteResult<Agent> {
        self.require_local_runtime()?;
        if !opencode::is_session_id(agent_id) {
            return Err(BoxliteError::NotFound(format!(
                "agent {agent_id} not found"
            )));
        }
        let server = self.opencode_server().await?;
        Ok(Agent::new(server.get_session(agent_id).await?))
    }

    /// Checked before any validation, so remote runtimes always see `Unsupported`.
    /// A cloud tunnel can publish the agent's server; a local one stays on this host.
    fn require_local_runtime(&self) -> BoxliteResult<()> {
        let is_local = Arc::clone(&self.box_backend)
            .as_any_arc()
            .downcast::<BoxImpl>()
            .is_ok();
        if is_local {
            return Ok(());
        }
        Err(BoxliteError::Unsupported(
            "agents require a local runtime".into(),
        ))
    }

    async fn opencode_server(&self) -> BoxliteResult<Arc<opencode::Server>> {
        opencode::Server::attach(
            Arc::clone(&self.box_backend),
            Arc::clone(&self.network_backend),
        )
        .await
    }
}

impl Agent {
    fn new(session: opencode::Session) -> Self {
        Self {
            session: Arc::new(session),
        }
    }

    /// Stop admissions and close the agent loop.
    pub async fn close(&self, _options: AgentControlOptions) -> BoxliteResult<()> {
        unsupported("agent.close")
    }

    /// Submit text. The default `queue` mode waits until the agent is idle.
    pub async fn send(&self, text: &str, options: AgentSendOptions) -> BoxliteResult<AgentTurn> {
        let state = self.session.send(text, &options).await?;
        Ok(self.turn(state))
    }

    /// Look up a turn without executing it.
    pub async fn get_turn(&self, turn_id: &str) -> BoxliteResult<AgentTurn> {
        let state = self.session.turn(turn_id).await?;
        Ok(self.turn(state))
    }

    /// Open the agent's events, after an opaque cursor where the adapter supports it.
    pub async fn events(&self, _options: AgentEventsOptions) -> BoxliteResult<AgentEventStream> {
        unsupported("agent.events")
    }

    /// Read outstanding questions and permissions.
    pub async fn requests(&self) -> BoxliteResult<Vec<AgentRequest>> {
        unsupported("agent.requests")
    }

    /// Answer a typed request; a terminal question may create an answering turn.
    pub async fn respond(
        &self,
        _request_id: &str,
        _response: AgentResponse,
        _options: AgentControlOptions,
    ) -> BoxliteResult<AgentTurn> {
        unsupported("agent.respond")
    }

    /// Read a consistent snapshot.
    pub fn state(&self) -> BoxliteResult<AgentState> {
        unsupported("agent.state")
    }

    /// Read the configuration the agent reported when this handle was obtained.
    pub fn config(&self) -> BoxliteResult<AgentConfig> {
        Ok(self.session.config().clone())
    }

    /// Read adapter guarantees and limits.
    pub fn capabilities(&self) -> BoxliteResult<AgentCapabilities> {
        Ok(opencode::capabilities())
    }

    fn turn(&self, state: AgentTurnState) -> AgentTurn {
        AgentTurn {
            session: Arc::clone(&self.session),
            state,
        }
    }
}

impl AgentTurn {
    /// Wait for a terminal result. An expired timeout returns `InvalidState`
    /// and leaves the turn running. A turn whose execution ended without a
    /// recorded outcome, such as one cut off and never resumed, also returns
    /// `InvalidState`: whether its work took effect is unknown.
    pub async fn wait(&self, options: AgentWaitOptions) -> BoxliteResult<AgentResult> {
        let observe = async {
            loop {
                let state = self.session.turn(&self.state.id).await?;
                if let Some(result) = state.result {
                    return Ok(result);
                }
                if state.status == AgentTurnStatus::Unknown {
                    return Err(BoxliteError::InvalidState(format!(
                        "turn {} ended without a recorded outcome",
                        self.state.id
                    )));
                }
                tokio::time::sleep(TURN_POLL_INTERVAL).await;
            }
        };
        let Some(timeout) = options.timeout else {
            return observe.await;
        };
        tokio::time::timeout(timeout, observe)
            .await
            .unwrap_or_else(|_| {
                Err(BoxliteError::InvalidState(format!(
                    "turn {} did not finish within {timeout:?}; it keeps running",
                    self.state.id
                )))
            })
    }

    /// Open this turn's view of the agent's events.
    pub async fn events(&self, _options: AgentEventsOptions) -> BoxliteResult<AgentEventStream> {
        unsupported("turn.events")
    }

    /// Steer this turn, never silently queue a new one.
    pub async fn steer(
        &self,
        _text: &str,
        _options: AgentControlOptions,
    ) -> BoxliteResult<AgentSteeringReceipt> {
        unsupported("turn.steer")
    }

    /// Confirm interruption of this agent loop, not background processes in the Box.
    pub async fn interrupt(&self, _options: AgentControlOptions) -> BoxliteResult<()> {
        unsupported("turn.interrupt")
    }

    /// Read the snapshot taken when this handle was obtained.
    pub fn state(&self) -> BoxliteResult<AgentTurnState> {
        Ok(self.state.clone())
    }
}

fn unsupported<T>(operation: &str) -> BoxliteResult<T> {
    Err(BoxliteError::Unsupported(format!(
        "{operation} is not supported by {}",
        opencode::ADAPTER
    )))
}

#[cfg(test)]
mod tests;
