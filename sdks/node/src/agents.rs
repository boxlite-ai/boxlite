//! Native bindings for agents and turns.

use napi::Result;
use napi_derive::napi;
use serde_json::Value;

use crate::util::map_err;

#[napi(js_name = "Agents")]
#[derive(Debug, Default)]
pub struct JsAgents {}

#[napi(js_name = "Agent")]
#[derive(Debug)]
pub struct JsAgent {}

#[napi(js_name = "AgentTurn")]
#[derive(Debug)]
pub struct JsAgentTurn {}

#[napi]
impl JsAgents {
    /// Create a namespace without starting agent work.
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {}
    }

    #[napi]
    pub async fn create(&self, _agent: String, _options: Option<Value>) -> Result<JsAgent> {
        not_implemented("agents.create")
    }

    #[napi]
    pub async fn get(&self, _agent_id: String) -> Result<JsAgent> {
        not_implemented("agents.get")
    }
}

#[napi]
impl JsAgent {
    #[napi]
    pub async fn close(&self, _options: Option<Value>) -> Result<()> {
        not_implemented("agent.close")
    }

    #[napi]
    pub async fn send(&self, _text: String, _options: Option<Value>) -> Result<JsAgentTurn> {
        not_implemented("agent.send")
    }

    #[napi]
    pub async fn get_turn(&self, _turn_id: String) -> Result<JsAgentTurn> {
        not_implemented("agent.get_turn")
    }

    /// Open the agent journal after an opaque cursor.
    #[napi]
    pub fn events(&self, _options: Option<Value>) -> Result<Value> {
        not_implemented("agent.events")
    }

    #[napi]
    pub async fn requests(&self) -> Result<Vec<Value>> {
        not_implemented("agent.requests")
    }

    #[napi]
    pub async fn respond(
        &self,
        _request_id: String,
        _response: Value,
        _options: Option<Value>,
    ) -> Result<JsAgentTurn> {
        not_implemented("agent.respond")
    }

    #[napi(getter)]
    pub fn state(&self) -> Result<Value> {
        not_implemented("agent.state")
    }

    #[napi(getter)]
    pub fn config(&self) -> Result<Value> {
        not_implemented("agent.config")
    }

    #[napi(getter)]
    pub fn capabilities(&self) -> Result<Value> {
        not_implemented("agent.capabilities")
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
        let agents = JsAgents::new();
        unsupported(agents.create("agent".into(), None).await, "agents.create");
        unsupported(agents.get("agent".into()).await, "agents.get");
        let agent = JsAgent {};
        unsupported(agent.close(None).await, "agent.close");
        unsupported(agent.send("task".into(), None).await, "agent.send");
        unsupported(agent.get_turn("turn".into()).await, "agent.get_turn");
        unsupported(
            agent.events(Some(serde_json::json!({"after": "cursor"}))),
            "agent.events",
        );
        unsupported(agent.requests().await, "agent.requests");
        unsupported(
            agent
                .respond(
                    "request".into(),
                    serde_json::json!({"type": "permission", "approved": false}),
                    None,
                )
                .await,
            "agent.respond",
        );
        unsupported(agent.state(), "agent.state");
        unsupported(agent.config(), "agent.config");
        unsupported(agent.capabilities(), "agent.capabilities");
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
