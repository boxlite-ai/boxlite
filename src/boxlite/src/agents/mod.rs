//! Box-owned agents and turns.
//!
//! BoxLite forwards each operation to a coding agent's native interface inside
//! the Box. The agent owns its conversation, execution and recovery; BoxLite
//! owns the Box and the transport, and starts the agent's own service when
//! none runs. OpenCode 2.2 on a local runtime is the only implementation;
//! unsupported operations and options fail with `Unsupported` before reaching
//! the agent.
//!
//! Each implementation is one module whose agent type implements
//! [`AgentBackend`]; `Agents::create` maps the implementation name to it.

mod install;
mod opencode;
mod types;
pub use types::*;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;

use crate::litebox::box_impl::BoxImpl;
use crate::runtime::backend::{BoxBackend, BoxNetworkBackend};
use crate::{BoxliteError, BoxliteResult};

/// How often `turn.wait` re-reads native turn state.
const TURN_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// One agent implementation's native protocol behind `Agent` and `AgentTurn`.
///
/// An operation the native interface lacks keeps its default, which fails with
/// `Unsupported` naming the adapter before anything reaches the Box; supporting
/// it later means overriding that method and listing it in `capabilities`.
#[allow(
    clippy::double_must_use,
    reason = "async_trait generates a must-use boxed future"
)]
#[async_trait]
trait AgentBackend: Send + Sync + std::fmt::Debug {
    /// Implementation and version named in errors, such as `OpenCode 2.2`.
    fn adapter(&self) -> &str;

    /// The configuration the agent reported when this handle was obtained.
    fn config(&self) -> &AgentConfig;

    fn capabilities(&self) -> AgentCapabilities;

    async fn send(&self, text: &str, options: &AgentSendOptions) -> BoxliteResult<AgentTurnState>;

    async fn turn(&self, turn_id: &str) -> BoxliteResult<AgentTurnState>;

    async fn events(&self, options: &AgentEventsOptions) -> BoxliteResult<AgentEventStream>;

    async fn close(&self, _options: &AgentControlOptions) -> BoxliteResult<()> {
        unsupported(self.adapter(), "agent.close")
    }

    async fn requests(&self) -> BoxliteResult<Vec<AgentRequest>> {
        unsupported(self.adapter(), "agent.requests")
    }

    async fn respond(
        &self,
        _request_id: &str,
        _response: AgentResponse,
        _options: &AgentControlOptions,
    ) -> BoxliteResult<AgentTurnState> {
        unsupported(self.adapter(), "agent.respond")
    }

    fn state(&self) -> BoxliteResult<AgentState> {
        unsupported(self.adapter(), "agent.state")
    }

    async fn turn_events(
        &self,
        _turn_id: &str,
        _options: &AgentEventsOptions,
    ) -> BoxliteResult<AgentEventStream> {
        unsupported(self.adapter(), "turn.events")
    }

    async fn steer(
        &self,
        _turn_id: &str,
        _text: &str,
        _options: &AgentControlOptions,
    ) -> BoxliteResult<AgentSteeringReceipt> {
        unsupported(self.adapter(), "turn.steer")
    }

    async fn interrupt(&self, _turn_id: &str, _options: &AgentControlOptions) -> BoxliteResult<()> {
        unsupported(self.adapter(), "turn.interrupt")
    }
}

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
    backend: Arc<dyn AgentBackend>,
}

/// One submitted task.
#[derive(Debug, Clone)]
pub struct AgentTurn {
    backend: Arc<dyn AgentBackend>,
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
        match agent {
            opencode::IMPLEMENTATION => {
                self.require_local_runtime()?;
                let request = opencode::SessionRequest::new(&options)?;
                let server = self.opencode_server().await?;
                Ok(Agent::new(server.create_session(request).await?))
            }
            _ => Err(BoxliteError::Unsupported(format!(
                "agent implementation {agent:?} is not supported; supported: {}",
                opencode::IMPLEMENTATION
            ))),
        }
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

    /// Copy the agent binary at `host_file` into the Box and mount it, as the
    /// agent catalog will (design #2322). For tests until that catalog lands.
    #[cfg(feature = "test-support")]
    #[doc(hidden)]
    pub async fn install_from_host(
        &self,
        agent: &str,
        host_file: &std::path::Path,
    ) -> BoxliteResult<()> {
        let local = self.require_local_runtime()?;
        install::AgentInstaller::new(local)
            .install(agent, host_file)
            .await?;
        Ok(())
    }

    /// Checked before any validation, so remote runtimes always see `Unsupported`.
    /// A cloud tunnel can publish the agent's server; a local one stays on this host.
    fn require_local_runtime(&self) -> BoxliteResult<Arc<BoxImpl>> {
        Arc::clone(&self.box_backend)
            .as_any_arc()
            .downcast::<BoxImpl>()
            .map_err(|_| BoxliteError::Unsupported("agents require a local runtime".into()))
    }

    /// Reach OpenCode, using the installed copy when one is recorded and the
    /// image's `opencode` otherwise.
    async fn opencode_server(&self) -> BoxliteResult<Arc<opencode::Server>> {
        let local = self.require_local_runtime()?;
        let bin_dir = install::AgentInstaller::new(local)
            .installed(opencode::IMPLEMENTATION)
            .await?;
        opencode::Server::attach(
            Arc::clone(&self.box_backend),
            Arc::clone(&self.network_backend),
            bin_dir.as_deref(),
        )
        .await
    }
}

impl Agent {
    fn new(backend: impl AgentBackend + 'static) -> Self {
        Self {
            backend: Arc::new(backend),
        }
    }

    /// Stop admissions and close the agent loop.
    pub async fn close(&self, options: AgentControlOptions) -> BoxliteResult<()> {
        self.backend.close(&options).await
    }

    /// Submit text. The default `queue` mode waits until the agent is idle.
    pub async fn send(&self, text: &str, options: AgentSendOptions) -> BoxliteResult<AgentTurn> {
        let state = self.backend.send(text, &options).await?;
        Ok(self.turn(state))
    }

    /// Look up a turn without executing it.
    pub async fn get_turn(&self, turn_id: &str) -> BoxliteResult<AgentTurn> {
        let state = self.backend.turn(turn_id).await?;
        Ok(self.turn(state))
    }

    /// Open the agent's live events; events emitted before opening are not replayed.
    pub async fn events(&self, options: AgentEventsOptions) -> BoxliteResult<AgentEventStream> {
        self.backend.events(&options).await
    }

    /// Read outstanding questions and permissions.
    pub async fn requests(&self) -> BoxliteResult<Vec<AgentRequest>> {
        self.backend.requests().await
    }

    /// Answer a typed request; a terminal question may create an answering turn.
    pub async fn respond(
        &self,
        request_id: &str,
        response: AgentResponse,
        options: AgentControlOptions,
    ) -> BoxliteResult<AgentTurn> {
        let state = self.backend.respond(request_id, response, &options).await?;
        Ok(self.turn(state))
    }

    /// Read a consistent snapshot.
    pub fn state(&self) -> BoxliteResult<AgentState> {
        self.backend.state()
    }

    /// Read the configuration the agent reported when this handle was obtained.
    pub fn config(&self) -> BoxliteResult<AgentConfig> {
        Ok(self.backend.config().clone())
    }

    /// Read adapter guarantees and limits.
    pub fn capabilities(&self) -> BoxliteResult<AgentCapabilities> {
        Ok(self.backend.capabilities())
    }

    fn turn(&self, state: AgentTurnState) -> AgentTurn {
        AgentTurn {
            backend: Arc::clone(&self.backend),
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
                let state = self.backend.turn(&self.state.id).await?;
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
    pub async fn events(&self, options: AgentEventsOptions) -> BoxliteResult<AgentEventStream> {
        self.backend.turn_events(&self.state.id, &options).await
    }

    /// Steer this turn, never silently queue a new one.
    pub async fn steer(
        &self,
        text: &str,
        options: AgentControlOptions,
    ) -> BoxliteResult<AgentSteeringReceipt> {
        self.backend.steer(&self.state.id, text, &options).await
    }

    /// Confirm interruption of this agent loop, not background processes in the Box.
    pub async fn interrupt(&self, options: AgentControlOptions) -> BoxliteResult<()> {
        self.backend.interrupt(&self.state.id, &options).await
    }

    /// Read the snapshot taken when this handle was obtained.
    pub fn state(&self) -> BoxliteResult<AgentTurnState> {
        Ok(self.state.clone())
    }
}

fn unsupported<T>(adapter: &str, operation: &str) -> BoxliteResult<T> {
    Err(BoxliteError::Unsupported(format!(
        "{operation} is not supported by {adapter}"
    )))
}

#[cfg(test)]
mod tests;
