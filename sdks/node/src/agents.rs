//! Native bindings for agents and turns.

use boxlite::agents::{
    AgentControlOptions, AgentCreateOptions, AgentEventStream, AgentEventsOptions, AgentSendMode,
    AgentSendOptions, AgentWaitOptions, records,
};
use futures::StreamExt;
use napi::Result;
use napi_derive::napi;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{Mutex, watch};

use crate::util::map_err;

#[cfg(test)]
#[path = "agents/tests/forwarding.rs"]
mod forwarding_tests;

#[napi(js_name = "Agents")]
#[derive(Debug, Default)]
pub struct JsAgents {
    agents: Option<boxlite::Agents>,
}

#[napi(js_name = "Agent")]
#[derive(Debug)]
pub struct JsAgent {
    agent: boxlite::Agent,
}

#[napi(js_name = "AgentTurn")]
#[derive(Debug)]
pub struct JsAgentTurn {
    turn: boxlite::AgentTurn,
}

#[derive(Clone)]
enum StreamState {
    Opening,
    Open,
    Failed(String),
    Closed,
}

#[napi]
pub struct JsAgentEventStream {
    stream: Arc<Mutex<Option<AgentEventStream>>>,
    state: watch::Sender<StreamState>,
    closed: watch::Sender<bool>,
}

impl JsAgentEventStream {
    fn start(
        future: impl std::future::Future<Output = boxlite::BoxliteResult<AgentEventStream>>
        + Send
        + 'static,
    ) -> Self {
        let stream = Arc::new(Mutex::new(None));
        let (state, _) = watch::channel(StreamState::Opening);
        let (closed, mut close_receiver) = watch::channel(false);
        let target = Arc::clone(&stream);
        let state_sender = state.clone();
        napi::bindgen_prelude::spawn(async move {
            tokio::select! {
                result = future => match result {
                    Ok(value) => {
                        let mut guard = target.lock().await;
                        if !*close_receiver.borrow() {
                            *guard = Some(value);
                            state_sender.send_replace(StreamState::Open);
                        }
                    },
                    Err(error) => {
                        let _guard = target.lock().await;
                        if !*close_receiver.borrow() {
                            state_sender.send_replace(StreamState::Failed(error.to_string()));
                        }
                    },
                },
                _ = close_receiver.changed() => { state_sender.send_replace(StreamState::Closed); },
            }
        });
        Self {
            stream,
            state,
            closed,
        }
    }

    async fn ready(&self) -> Result<bool> {
        let mut receiver = self.state.subscribe();
        loop {
            let current = receiver.borrow_and_update().clone();
            match current {
                StreamState::Open => return Ok(true),
                StreamState::Closed => return Ok(false),
                StreamState::Failed(error) => return Err(napi::Error::from_reason(error)),
                StreamState::Opening => receiver
                    .changed()
                    .await
                    .map_err(|_| invalid("event stream closed"))?,
            }
        }
    }
}

impl Drop for JsAgentEventStream {
    fn drop(&mut self) {
        self.closed.send_replace(true);
    }
}

#[napi]
impl JsAgentEventStream {
    #[napi]
    pub async fn opened(&self) -> Result<()> {
        if self.ready().await? {
            Ok(())
        } else {
            Err(invalid("event stream closed"))
        }
    }

    #[napi]
    pub async fn next_event(&self) -> Result<Option<Value>> {
        if !self.ready().await? {
            return Ok(None);
        }
        let mut closed = self.closed.subscribe();
        let mut guard = self.stream.lock().await;
        if *closed.borrow() {
            return Ok(None);
        }
        let Some(stream) = guard.as_mut() else {
            if let StreamState::Failed(error) = &*self.state.borrow() {
                return Err(napi::Error::from_reason(error.clone()));
            }
            return Ok(None);
        };
        tokio::select! {
            item = stream.next() => match item {
                Some(Ok(event)) => match checked_record(records::event(&event)) {
                    Ok(record) => Ok(Some(record)),
                    Err(error) => {
                        *guard = None;
                        self.state.send_replace(StreamState::Failed(error.reason.clone()));
                        Err(error)
                    }
                },
                Some(Err(error)) => { *guard = None; Err(map_err(error)) },
                None => { *guard = None; Ok(None) },
            },
            _ = closed.changed() => { *guard = None; Ok(None) },
        }
    }

    #[napi]
    pub async fn close(&self) {
        self.closed.send_replace(true);
        *self.stream.lock().await = None;
        self.state.send_replace(StreamState::Closed);
    }
}

#[napi]
impl JsAgents {
    /// Create a namespace without starting agent work.
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { agents: None }
    }

    #[napi]
    pub async fn create(&self, agent: String, options: Option<Value>) -> Result<JsAgent> {
        let Some(agents) = &self.agents else {
            return Err(invalid("agent namespace requires a Box"));
        };
        let options = create_options(options)?;
        let agent = agents.create(&agent, options).await.map_err(map_err)?;
        Ok(JsAgent { agent })
    }

    #[napi]
    pub async fn get(&self, agent_id: String) -> Result<JsAgent> {
        let Some(agents) = &self.agents else {
            return Err(invalid("agent namespace requires a Box"));
        };
        let agent = agents.get(&agent_id).await.map_err(map_err)?;
        Ok(JsAgent { agent })
    }
}

impl JsAgents {
    pub(crate) fn from_core(agents: boxlite::Agents) -> Self {
        Self {
            agents: Some(agents),
        }
    }
}

fn create_options(options: Option<Value>) -> Result<AgentCreateOptions> {
    let mut object = match options {
        None | Some(Value::Null) => serde_json::Map::new(),
        Some(Value::Object(object)) => object,
        Some(_) => {
            return Err(map_err(boxlite::BoxliteError::InvalidArgument(
                "agent create options must be an object".into(),
            )));
        }
    };
    let cwd = optional_string(object.remove("cwd"), "cwd")?;
    let idempotency_key = optional_string(object.remove("idempotencyKey"), "idempotencyKey")?;
    let config = object
        .remove("config")
        .unwrap_or_else(|| serde_json::json!({}));
    if !object.is_empty() {
        return Err(map_err(boxlite::BoxliteError::InvalidArgument(
            "unknown agent create option".into(),
        )));
    }
    let config = records::parse_config(config).map_err(map_err)?;
    Ok(AgentCreateOptions {
        cwd,
        config,
        idempotency_key,
    })
}

fn optional_string(value: Option<Value>, name: &str) -> Result<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        _ => Err(map_err(boxlite::BoxliteError::InvalidArgument(format!(
            "{name} must be a string"
        )))),
    }
}

#[napi]
impl JsAgent {
    #[napi]
    pub async fn close(&self, options: Option<Value>) -> Result<()> {
        self.agent
            .close(control_options(options)?)
            .await
            .map_err(map_err)
    }

    #[napi]
    pub async fn send(&self, text: String, options: Option<Value>) -> Result<JsAgentTurn> {
        let mut options = object(options)?;
        let mode = match optional_string(options.remove("mode"), "mode")?.as_deref() {
            None | Some("queue") => AgentSendMode::Queue,
            Some("reject") => AgentSendMode::Reject,
            Some(_) => return Err(invalid("unknown send mode")),
        };
        let data = options
            .remove("data")
            .filter(|value| !value.is_null())
            .map(|value| serde_json::value::to_raw_value(&value))
            .transpose()
            .map_err(|e| invalid(&e.to_string()))?;
        let idempotency_key = optional_string(options.remove("idempotencyKey"), "idempotencyKey")?;
        no_unknown(options)?;
        let turn = self
            .agent
            .send(
                &text,
                AgentSendOptions {
                    mode,
                    data,
                    idempotency_key,
                },
            )
            .await
            .map_err(map_err)?;
        Ok(JsAgentTurn { turn })
    }

    #[napi]
    pub async fn get_turn(&self, turn_id: String) -> Result<JsAgentTurn> {
        Ok(JsAgentTurn {
            turn: self.agent.get_turn(&turn_id).await.map_err(map_err)?,
        })
    }

    /// Open the agent's events, after an opaque cursor where the adapter supports it.
    #[napi]
    pub fn events(&self, options: Option<Value>) -> Result<JsAgentEventStream> {
        let options = event_options(options)?;
        let agent = self.agent.clone();
        Ok(JsAgentEventStream::start(async move {
            agent.events(options).await
        }))
    }

    #[napi]
    pub async fn requests(&self) -> Result<Vec<Value>> {
        let requests = self.agent.requests().await.map_err(map_err)?;
        Ok(checked_record(records::requests(&requests))?
            .as_array()
            .cloned()
            .unwrap_or_default())
    }

    #[napi]
    pub async fn respond(
        &self,
        request_id: String,
        response: Value,
        options: Option<Value>,
    ) -> Result<JsAgentTurn> {
        let response = records::parse_response(&response.to_string()).map_err(map_err)?;
        let turn = self
            .agent
            .respond(&request_id, response, control_options(options)?)
            .await
            .map_err(map_err)?;
        Ok(JsAgentTurn { turn })
    }

    #[napi(getter)]
    pub fn state(&self) -> Result<Value> {
        checked_record(records::agent_state(&self.agent.state().map_err(map_err)?))
    }

    #[napi(getter)]
    pub fn config(&self) -> Result<Value> {
        checked_record(records::config(&self.agent.config().map_err(map_err)?))
    }

    #[napi(getter)]
    pub fn capabilities(&self) -> Result<Value> {
        checked_record(records::capabilities(
            &self.agent.capabilities().map_err(map_err)?,
        ))
    }
}

#[napi]
impl JsAgentTurn {
    #[napi]
    pub async fn wait(&self, options: Option<Value>) -> Result<Value> {
        let mut options = object(options)?;
        let timeout = match options.remove("timeoutSeconds") {
            None | Some(Value::Null) => None,
            Some(Value::Number(value)) => Some(
                std::time::Duration::try_from_secs_f64(
                    value.as_f64().ok_or_else(|| invalid("invalid timeout"))?,
                )
                .map_err(|_| invalid("invalid timeout"))?,
            ),
            _ => return Err(invalid("invalid timeout")),
        };
        no_unknown(options)?;
        let result = records::result(
            &self
                .turn
                .wait(AgentWaitOptions { timeout })
                .await
                .map_err(map_err)?,
        );
        native_json_record(&result, 0).and_then(checked_record)
    }

    #[napi]
    pub fn events(&self, options: Option<Value>) -> Result<JsAgentEventStream> {
        let options = event_options(options)?;
        let turn = self.turn.clone();
        Ok(JsAgentEventStream::start(async move {
            turn.events(options).await
        }))
    }

    #[napi]
    pub async fn steer(&self, text: String, options: Option<Value>) -> Result<Value> {
        checked_record(records::receipt(
            &self
                .turn
                .steer(&text, control_options(options)?)
                .await
                .map_err(map_err)?,
        ))
    }

    #[napi]
    pub async fn interrupt(&self, options: Option<Value>) -> Result<()> {
        self.turn
            .interrupt(control_options(options)?)
            .await
            .map_err(map_err)
    }

    #[napi(getter)]
    pub fn state(&self) -> Result<Value> {
        let state = records::turn_state(&self.turn.state().map_err(map_err)?);
        native_json_record(&state, 0).and_then(checked_record)
    }
}

// napi 3.16 converts JSON numbers through i64, finite f64, or u64. Its
// last branch unwraps the u64, so reject unsupported tokens before dispatch.
fn checked_record(record: Value) -> Result<Value> {
    fn check(value: &Value, depth: usize) -> Result<()> {
        if depth > 128 {
            return Err(invalid("agent record exceeds the N-API JSON depth limit"));
        }
        match value {
            Value::Number(n) if !(n.is_i64() || n.is_f64() || n.is_u64()) => {
                Err(napi::Error::from_reason(
                    "agent JSON number exceeds the Node binding's numeric range",
                ))
            }
            Value::Number(n) if n.is_f64() && n.as_f64() == Some(0.0) => {
                let token = n.to_string();
                let mantissa = token.split(['e', 'E']).next().unwrap_or_default();
                if mantissa.bytes().any(|b| matches!(b, b'1'..=b'9')) {
                    return Err(napi::Error::from_reason(
                        "nonzero agent JSON number underflows the Node binding's numeric range",
                    ));
                }
                Ok(())
            }
            Value::Array(items) => items.iter().try_for_each(|item| check(item, depth + 1)),
            Value::Object(fields) => fields.values().try_for_each(|item| check(item, depth + 1)),
            _ => Ok(()),
        }
    }
    check(&record, 0)?;
    Ok(record)
}

// N-API requires a value tree. Decode JSON objects as literal maps so user keys
// cannot be mistaken for the arbitrary-precision number marker.
fn native_json_record(raw: &serde_json::value::RawValue, depth: usize) -> Result<Value> {
    use serde_json::value::RawValue;
    if depth > 128 {
        return Err(invalid("agent record exceeds the N-API JSON depth limit"));
    }
    let json = raw.get();
    let parse_error = |e: serde_json::Error| invalid(&e.to_string());
    match json.as_bytes()[0] {
        b'{' => {
            let fields: std::collections::BTreeMap<String, &RawValue> =
                serde_json::from_str(json).map_err(parse_error)?;
            fields
                .into_iter()
                .map(|(key, value)| Ok((key, native_json_record(value, depth + 1)?)))
                .collect::<Result<_>>()
                .map(Value::Object)
        }
        b'[' => {
            let items: Vec<&RawValue> = serde_json::from_str(json).map_err(parse_error)?;
            items
                .into_iter()
                .map(|item| native_json_record(item, depth + 1))
                .collect::<Result<_>>()
                .map(Value::Array)
        }
        _ => serde_json::from_str(json).map_err(parse_error),
    }
}

fn invalid(message: &str) -> napi::Error {
    map_err(boxlite::BoxliteError::InvalidArgument(message.into()))
}

fn object(value: Option<Value>) -> Result<serde_json::Map<String, Value>> {
    match value {
        None | Some(Value::Null) => Ok(serde_json::Map::new()),
        Some(Value::Object(value)) => Ok(value),
        _ => Err(invalid("options must be an object")),
    }
}

fn no_unknown(options: serde_json::Map<String, Value>) -> Result<()> {
    if options.is_empty() {
        Ok(())
    } else {
        Err(invalid("unknown option"))
    }
}

fn control_options(value: Option<Value>) -> Result<AgentControlOptions> {
    let mut options = object(value)?;
    let idempotency_key = optional_string(options.remove("idempotencyKey"), "idempotencyKey")?;
    no_unknown(options)?;
    Ok(AgentControlOptions { idempotency_key })
}

fn event_options(value: Option<Value>) -> Result<AgentEventsOptions> {
    let mut options = object(value)?;
    let after = optional_string(options.remove("after"), "after")?;
    no_unknown(options)?;
    Ok(AgentEventsOptions { after })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_options_validate_fields() {
        let options = create_options(Some(
            serde_json::json!({"cwd": "/work", "config": {"model": "provider/model"}}),
        ))
        .unwrap();
        assert_eq!(options.cwd.as_deref(), Some("/work"));
        assert_eq!(options.config.model.as_deref(), Some("provider/model"));
        assert!(create_options(Some(serde_json::json!({"unknown": true}))).is_err());
        assert!(create_options(Some(serde_json::json!({"cwd": 7}))).is_err());
    }
}
