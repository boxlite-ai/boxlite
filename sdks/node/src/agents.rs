//! Native bindings for agent sessions and turns.

use napi::Result;
use napi_derive::napi;
use serde_json::Value;

use crate::util::map_err;

#[napi(js_name = "AgentHandle")]
#[derive(Default)]
pub struct JsAgentHandle {}

#[napi(js_name = "AgentSession")]
pub struct JsAgentSession {}

#[napi(js_name = "AgentTurn")]
pub struct JsAgentTurn {}

#[napi]
impl JsAgentHandle {
    /// Create a namespace without starting agent work.
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {}
    }

    #[napi]
    pub async fn create(&self, _agent: String, _options: Option<Value>) -> Result<JsAgentSession> {
        not_implemented("agents.create")
    }

    #[napi]
    pub async fn get(&self, _session_id: String) -> Result<JsAgentSession> {
        not_implemented("agents.get")
    }
}

#[napi]
impl JsAgentSession {
    #[napi]
    pub async fn close(&self, _options: Option<Value>) -> Result<()> {
        not_implemented("session.close")
    }

    #[napi]
    pub async fn send(&self, _text: String, _options: Option<Value>) -> Result<JsAgentTurn> {
        not_implemented("session.send")
    }

    #[napi]
    pub async fn get_turn(&self, _turn_id: String) -> Result<JsAgentTurn> {
        not_implemented("session.get_turn")
    }

    /// Open the session journal after an opaque cursor.
    #[napi]
    pub fn events(&self, _options: Option<Value>) -> Result<Value> {
        not_implemented("session.events")
    }

    #[napi]
    pub async fn requests(&self) -> Result<Vec<Value>> {
        not_implemented("session.requests")
    }

    #[napi]
    pub async fn respond(
        &self,
        _request_id: String,
        _response: Value,
        _options: Option<Value>,
    ) -> Result<JsAgentTurn> {
        not_implemented("session.respond")
    }

    #[napi(getter)]
    pub fn state(&self) -> Result<Value> {
        not_implemented("session.state")
    }

    #[napi(getter)]
    pub fn config(&self) -> Result<Value> {
        not_implemented("session.config")
    }

    #[napi(getter)]
    pub fn capabilities(&self) -> Result<Value> {
        not_implemented("session.capabilities")
    }
}

#[napi]
impl JsAgentTurn {
    #[napi]
    pub async fn wait(&self, _options: Option<Value>) -> Result<Value> {
        not_implemented("turn.wait")
    }

    #[napi]
    pub fn events(&self, _options: Option<Value>) -> Result<Value> {
        not_implemented("turn.events")
    }

    #[napi]
    pub async fn steer(&self, _text: String, _options: Option<Value>) -> Result<Value> {
        not_implemented("turn.steer")
    }

    #[napi]
    pub async fn interrupt(&self, _options: Option<Value>) -> Result<()> {
        not_implemented("turn.interrupt")
    }

    #[napi(getter)]
    pub fn state(&self) -> Result<Value> {
        not_implemented("turn.state")
    }
}

fn not_implemented<T>(operation: &str) -> Result<T> {
    Err(map_err(boxlite::BoxliteError::Unsupported(format!(
        "{operation} is not implemented"
    ))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unsupported<T>(result: Result<T>, operation: &str) {
        let error = result.err().expect("operation must return Unsupported");
        assert!(
            error
                .reason
                .ends_with(&format!("{operation} is not implemented")),
            "{error}"
        );
    }

    #[tokio::test]
    async fn agents_return_unsupported() {
        let agents = JsAgentHandle::new();
        unsupported(agents.create("agent".into(), None).await, "agents.create");
        unsupported(agents.get("session".into()).await, "agents.get");
        let session = JsAgentSession {};
        unsupported(session.close(None).await, "session.close");
        unsupported(session.send("task".into(), None).await, "session.send");
        unsupported(session.get_turn("turn".into()).await, "session.get_turn");
        unsupported(
            session.events(Some(serde_json::json!({"after": "cursor"}))),
            "session.events",
        );
        unsupported(session.requests().await, "session.requests");
        unsupported(
            session
                .respond(
                    "request".into(),
                    serde_json::json!({"type": "permission", "approved": false}),
                    None,
                )
                .await,
            "session.respond",
        );
        unsupported(session.state(), "session.state");
        unsupported(session.config(), "session.config");
        unsupported(session.capabilities(), "session.capabilities");
        let turn = JsAgentTurn {};
        unsupported(
            turn.wait(Some(serde_json::json!({"timeoutSeconds": 1.0})))
                .await,
            "turn.wait",
        );
        unsupported(turn.events(None), "turn.events");
        unsupported(turn.steer("direction".into(), None).await, "turn.steer");
        unsupported(turn.interrupt(None).await, "turn.interrupt");
        unsupported(turn.state(), "turn.state");
    }
}
