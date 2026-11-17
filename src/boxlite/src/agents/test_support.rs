//! Deterministic backend for cross-crate FFI tests.

use super::*;
use std::sync::Mutex;

#[derive(Debug, Default)]
pub(super) struct TestBackend {
    config: AgentConfig,
    turn: Mutex<Option<AgentTurnState>>,
}

impl TestBackend {
    fn complete(&self, text: &str, data: Option<serde_json::Value>) -> AgentTurnState {
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
            cursor: None,
            active_turn_id: None,
            queued_turn_ids: vec![],
            requests: vec![],
            steering: vec![],
        })
    }
    async fn send(&self, text: &str, options: &AgentSendOptions) -> BoxliteResult<AgentTurnState> {
        Ok(self.complete(text, options.data.clone()))
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
            ("request-1", AgentResponse::Answer { text, data }) => Ok(self.complete(&text, data)),
            _ => Err(BoxliteError::InvalidArgument(
                "expected answer to request-1".into(),
            )),
        }
    }
    async fn events(&self, options: &AgentEventsOptions) -> BoxliteResult<AgentEventStream> {
        use futures::StreamExt;
        let event = |kind: String| AgentEvent {
            cursor: None,
            agent_id: self.id().into(),
            turn_id: None,
            kind,
            data: serde_json::json!({}),
        };
        if let Some(size) = options
            .after
            .as_deref()
            .and_then(|s| s.strip_prefix("bytes:"))
        {
            let mut items = Vec::new();
            for size in size.split(',') {
                let size: usize = size
                    .parse()
                    .map_err(|_| BoxliteError::InvalidArgument("invalid test size".into()))?;
                let mut item = event("sized".into());
                item.data = serde_json::json!("");
                let overhead = records::event(&item).to_string().len();
                let padding = size.checked_sub(overhead).ok_or_else(|| {
                    BoxliteError::InvalidArgument("test size below record overhead".into())
                })?;
                item.data = serde_json::json!("x".repeat(padding));
                items.push(Ok(item));
            }
            return Ok(Box::pin(futures::stream::iter(items)));
        }
        match options.after.as_deref() {
            Some("open-pending") => std::future::pending().await,
            Some("many") => Ok(Box::pin(futures::stream::iter(
                (0..128)
                    .map(|n| Ok(event(n.to_string())))
                    .collect::<Vec<_>>(),
            ))),
            Some("continuous") => {
                let item = event("tick".into());
                Ok(Box::pin(futures::stream::repeat_with(move || {
                    Ok(item.clone())
                })))
            }
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
