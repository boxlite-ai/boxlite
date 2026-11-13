//! Deterministic backend for cross-crate FFI tests.

use super::*;
use std::sync::Mutex;

#[derive(Debug, Default)]
pub(super) struct TestBackend {
    config: AgentConfig,
    turn: Mutex<Option<AgentTurnState>>,
}

impl TestBackend {
    fn complete(&self, text: &str) -> AgentTurnState {
        let state = AgentTurnState {
            id: "turn-1".into(),
            agent_id: "agent-1".into(),
            status: AgentTurnStatus::Completed,
            cursor: None,
            result: Some(AgentResult {
                turn_id: "turn-1".into(),
                status: AgentTurnStatus::Completed,
                outcome: Some(AgentOutcome::Answer),
                text: Some(text.into()),
                data: None,
                artifacts: vec![],
                usage: None,
                error: None,
            }),
            requests: vec![],
            steering: vec![],
        };
        *self.turn.lock().unwrap() = Some(state.clone());
        state
    }
}

#[async_trait]
impl AgentBackend for TestBackend {
    fn adapter(&self) -> &str {
        "test"
    }
    fn id(&self) -> &str {
        "agent-1"
    }
    fn config(&self) -> &AgentConfig {
        &self.config
    }
    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities {
            operations: vec!["agent.send".into()],
            input_kinds: vec!["text".into()],
            max_queued_turns: None,
            max_pending_steering: None,
            idempotency_retention: None,
        }
    }
    fn state(&self) -> BoxliteResult<AgentState> {
        Ok(AgentState {
            id: self.id().into(),
            status: AgentStatus::Ready,
            cursor: None,
            active_turn_id: None,
            queued_turn_ids: vec![],
            requests: vec![],
            steering: vec![],
        })
    }
    async fn send(&self, text: &str, _: &AgentSendOptions) -> BoxliteResult<AgentTurnState> {
        Ok(self.complete(text))
    }
    async fn turn(&self, id: &str) -> BoxliteResult<AgentTurnState> {
        self.turn
            .lock()
            .unwrap()
            .clone()
            .filter(|t| t.id == id)
            .ok_or_else(|| BoxliteError::NotFound(id.into()))
    }
    async fn requests(&self) -> BoxliteResult<Vec<AgentRequest>> {
        Ok(vec![AgentRequest {
            id: "request-1".into(),
            turn_id: "turn-1".into(),
            kind: AgentRequestKind::Question {
                text: "continue?".into(),
                schema: None,
            },
        }])
    }
    async fn respond(
        &self,
        id: &str,
        response: AgentResponse,
        _: &AgentControlOptions,
    ) -> BoxliteResult<AgentTurnState> {
        match (id, response) {
            ("request-1", AgentResponse::Answer { text, .. }) => Ok(self.complete(&text)),
            _ => Err(BoxliteError::InvalidArgument(
                "expected answer to request-1".into(),
            )),
        }
    }
    async fn events(&self, _: &AgentEventsOptions) -> BoxliteResult<AgentEventStream> {
        Ok(Box::pin(futures::stream::empty()))
    }
}
