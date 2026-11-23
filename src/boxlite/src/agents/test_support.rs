//! Deterministic backend for cross-crate FFI tests.

use super::*;
use std::sync::Mutex;

#[derive(Debug, Default)]
pub(super) struct TestBackend {
    config: AgentConfig,
    wait_gate: tokio::sync::watch::Sender<bool>,
    turn: Mutex<Option<AgentTurnState>>,
}

impl TestBackend {
    fn complete(
        &self,
        text: &str,
        data: Option<Box<serde_json::value::RawValue>>,
    ) -> AgentTurnState {
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
                data,
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
            cursor: (*self.wait_gate.borrow()).then(|| self.wait_gate.receiver_count().to_string()),
            active_turn_id: None,
            queued_turn_ids: vec![],
            requests: vec![],
            steering: vec![],
        })
    }
    async fn send(&self, text: &str, options: &AgentSendOptions) -> BoxliteResult<AgentTurnState> {
        let mut state = self.complete(text, options.data.clone());
        if text == "hold wait observers" {
            state.status = AgentTurnStatus::Running;
            state.result = None;
            *self.turn.lock().unwrap() = Some(state.clone());
            self.wait_gate.send_replace(true);
        }
        Ok(state)
    }
    async fn turn(&self, id: &str) -> BoxliteResult<AgentTurnState> {
        let mut gate = self.wait_gate.subscribe();
        gate.wait_for(|held| !held)
            .await
            .expect("backend owns sender");
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
            ("request-1", AgentResponse::Answer { text, data }) => {
                let state = self.complete(&text, data);
                self.wait_gate.send_replace(false);
                Ok(state)
            }
            _ => Err(BoxliteError::InvalidArgument(
                "expected answer to request-1".into(),
            )),
        }
    }
    async fn events(&self, options: &AgentEventsOptions) -> BoxliteResult<AgentEventStream> {
        use futures::StreamExt;
        match options.after.as_deref() {
            Some("open-error") => Err(BoxliteError::Network("test open failed".into())),
            Some("pending") => Ok(Box::pin(futures::stream::pending())),
            Some("read-error") => Ok(Box::pin(futures::stream::iter(vec![
                Ok(AgentEvent {
                    cursor: None,
                    agent_id: self.id().into(),
                    turn_id: None,
                    kind: "first".into(),
                    data: serde_json::json!({}),
                }),
                Err(BoxliteError::Network("test read failed".into())),
            ]))),
            Some("events") => Ok(Box::pin(
                futures::stream::iter(vec![
                    Ok(AgentEvent {
                        cursor: None,
                        agent_id: self.id().into(),
                        turn_id: None,
                        kind: "first".into(),
                        data: serde_json::json!({}),
                    }),
                    Ok(AgentEvent {
                        cursor: None,
                        agent_id: self.id().into(),
                        turn_id: None,
                        kind: "second".into(),
                        data: serde_json::json!({}),
                    }),
                ])
                .chain(futures::stream::pending()),
            )),
            _ => Ok(Box::pin(futures::stream::empty())),
        }
    }
    async fn turn_events(
        &self,
        _: &str,
        options: &AgentEventsOptions,
    ) -> BoxliteResult<AgentEventStream> {
        self.events(options).await
    }
}
