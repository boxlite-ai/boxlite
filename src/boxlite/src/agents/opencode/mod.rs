//! OpenCode 2.2 adapter: the managed OpenCode service of the Box.
//!
//! ```text
//! host (this crate)                        Box
//! Server::attach ──exec──► sh: refuse remote access or a live service at another
//!                          address; else drop a stale registration, configure
//!                          0.0.0.0:47096 when different, print the password
//!                ──tunnel► GET  /api/info                  (version must be 2.2.2)
//!                ──exec──► opencode service start          (only when nothing runs)
//! Session::send  ──tunnel► POST /api/session/{id}/prompt   {id, delivery: "queue"}
//! Session::turn  ──tunnel► GET  inbox, history newest-first,
//!                          then pending requests while the turn runs
//! ```
//!
//! OpenCode owns sessions, history, execution and recovery: its managed service
//! resumes interrupted turns when it boots, at least once. BoxLite keeps no
//! transcript: it mints the native session and input IDs before each request,
//! so a lost response can be retried and reconciled, and every read goes to
//! the server.

mod http;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, PoisonError, Weak};
use std::time::Duration;

use futures::StreamExt;
use serde_json::{Map, Value, json};

use super::{
    AgentCapabilities, AgentConfig, AgentCreateOptions, AgentOutcome, AgentRequest,
    AgentRequestKind, AgentResult, AgentSendMode, AgentSendOptions, AgentTurnState,
    AgentTurnStatus,
};
use crate::litebox::BoxCommand;
use crate::runtime::backend::{BoxBackend, BoxNetworkBackend};
use crate::{BoxID, BoxliteError, BoxliteResult};
use http::Client;

/// Implementation name accepted by `agents.create`.
pub(super) const IMPLEMENTATION: &str = "opencode";
/// Adapter name used in errors for unsupported operations and options.
pub(super) const ADAPTER: &str = "OpenCode 2.2";
/// The only native version this adapter was verified against.
const SUPPORTED_VERSION: &str = "2.2.2";
/// Port of the managed service inside the Box. Tunnels dial the guest
/// address, so the service listens on all interfaces.
const PORT: u16 = 47096;
/// The registered address of that service.
const SERVICE_URL: &str = "http://0.0.0.0:47096";
/// Bound for the setup commands run in the Box.
const SETUP_TIMEOUT: Duration = Duration::from_secs(30);
/// Bound for `opencode service start`, which waits until the service answers.
const START_TIMEOUT: Duration = Duration::from_secs(150);
/// How long a started service may take to answer through the tunnel.
const READY_TIMEOUT: Duration = Duration::from_secs(10);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(100);
/// History page size, and how many pages `turn` reads before giving up.
const HISTORY_PAGE: usize = 50;
const HISTORY_MAX_PAGES: usize = 20;
/// Deepest subagent nesting searched for a pending request's owner.
const MAX_SUBAGENT_DEPTH: usize = 8;

/// One setup at a time per Box. The runtime lock admits one host process per
/// BoxLite home, so these locks order every setup a Box sees.
static SETUPS: LazyLock<std::sync::Mutex<HashMap<BoxID, Weak<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(Default::default);

/// The Box's OpenCode server, reachable over a Box tunnel.
#[derive(Debug)]
pub(super) struct Server {
    client: Client,
}

impl Server {
    /// Reach the Box's managed OpenCode service, starting it when none runs.
    /// BoxLite never stops or signals a service: one it cannot use is reported.
    pub(super) async fn attach(
        box_backend: Arc<dyn BoxBackend>,
        network: Arc<dyn BoxNetworkBackend>,
    ) -> BoxliteResult<Arc<Self>> {
        let lock = setup_lock(box_backend.id());
        let _setup = lock.lock().await;
        let (state, password) = setup(box_backend.as_ref()).await?;
        let server = Self::new(network, &password);
        match server.version().await {
            Ok(version) => check_version(&version)?,
            // 401: whatever holds the port does not know the service password.
            Err(BoxliteError::InvalidState(detail)) => {
                return Err(BoxliteError::InvalidState(format!(
                    "port {PORT} in the Box is held by another server: {detail}"
                )));
            }
            // Starting over a live service would replace it and end its turns.
            Err(error) if state == ServiceState::Live => {
                return Err(BoxliteError::InvalidState(format!(
                    "the OpenCode service in the Box is not responding: {error}"
                )));
            }
            Err(_) => server.start(box_backend.as_ref()).await?,
        }
        Ok(Arc::new(server))
    }

    pub(super) fn new(network: Arc<dyn BoxNetworkBackend>, password: &str) -> Self {
        Self {
            client: Client::new(network, PORT, password),
        }
    }

    /// Start the service with OpenCode's own launcher, which spawns it
    /// detached and returns once it answers, then wait for the tunnel.
    async fn start(&self, box_backend: &dyn BoxBackend) -> BoxliteResult<()> {
        let command = BoxCommand::new("sh")
            .args(["-c", "opencode service start 2>&1"])
            .timeout(START_TIMEOUT);
        let (exit_code, output) = run(box_backend, command).await?;
        if exit_code != 0 {
            return Err(BoxliteError::Execution(format!(
                "opencode service start failed (exit code {exit_code}); the Box must provide OpenCode {SUPPORTED_VERSION}:\n{}",
                last_lines(&output, 20)
            )));
        }
        // The launcher reuses any healthy registered service, which can be a
        // user service registered after the setup check.
        let url = last_lines(&output, 1);
        if url != SERVICE_URL {
            return Err(BoxliteError::InvalidState(format!(
                "opencode service start reported {url:?}, not {SERVICE_URL}"
            )));
        }
        check_version(&self.wait_ready().await?)
    }

    async fn wait_ready(&self) -> BoxliteResult<String> {
        let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
        loop {
            match self.version().await {
                Ok(version) => return Ok(version),
                Err(error) if tokio::time::Instant::now() >= deadline => {
                    return Err(BoxliteError::Execution(format!(
                        "the OpenCode service did not answer within {READY_TIMEOUT:?}: {error}"
                    )));
                }
                Err(_) => tokio::time::sleep(READY_POLL_INTERVAL).await,
            }
        }
    }

    async fn version(&self) -> BoxliteResult<String> {
        let info = self.client.get("/api/info").await?;
        info["version"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| BoxliteError::Internal("OpenCode /api/info has no version".into()))
    }

    pub(super) async fn create_session(
        self: &Arc<Self>,
        request: SessionRequest,
    ) -> BoxliteResult<Session> {
        let info = self
            .client
            .post_idempotent("/api/session", &request.body)
            .await
            .map_err(|error| {
                uncertain(
                    error,
                    format!("creating agent {}", request.id),
                    format!(
                        "agents.get({:?}) reads it if OpenCode admitted it",
                        request.id
                    ),
                )
            })?;
        Session::new(Arc::clone(self), &info["data"])
    }

    pub(super) async fn get_session(self: &Arc<Self>, session_id: &str) -> BoxliteResult<Session> {
        let info = self
            .client
            .get(&format!("/api/session/{session_id}"))
            .await?;
        Session::new(Arc::clone(self), &info["data"])
    }
}

/// One native OpenCode session, the conversation behind an `Agent`.
#[derive(Debug)]
pub(super) struct Session {
    server: Arc<Server>,
    id: String,
    config: AgentConfig,
}

impl Session {
    pub(super) fn new(server: Arc<Server>, info: &Value) -> BoxliteResult<Self> {
        let id = info["id"]
            .as_str()
            .filter(|id| is_session_id(id))
            .ok_or_else(|| {
                BoxliteError::Internal(format!("OpenCode returned a session without an ID: {info}"))
            })?;
        let model = match (
            info["model"]["providerID"].as_str(),
            info["model"]["id"].as_str(),
        ) {
            (Some(provider), Some(model)) => Some(format!("{provider}/{model}")),
            _ => None,
        };
        Ok(Self {
            server,
            id: id.to_owned(),
            config: AgentConfig {
                model,
                ..AgentConfig::default()
            },
        })
    }

    pub(super) fn config(&self) -> &AgentConfig {
        &self.config
    }

    /// Durably admit `text` under a minted input ID; the snapshot reports the admission.
    pub(super) async fn send(
        &self,
        text: &str,
        options: &AgentSendOptions,
    ) -> BoxliteResult<AgentTurnState> {
        let turn_id = mint_id("msg_");
        let body = prompt_body(&turn_id, text, options)?;
        self.server
            .client
            .post_idempotent(&format!("/api/session/{}/prompt", self.id), &body)
            .await
            .map_err(|error| {
                uncertain(
                    error,
                    format!("admitting turn {turn_id}"),
                    format!("agent.get_turn({turn_id:?}) reads it if OpenCode admitted it"),
                )
            })?;
        Ok(self.turn_state(&turn_id, AgentTurnStatus::Queued, None))
    }

    /// Read the turn's native state.
    ///
    /// Reads go inbox, then history: delivery moves an input from the inbox
    /// into history, so the second read finds an input the first one missed.
    /// A turn without an outcome stays running, because the managed service
    /// resumes an interrupted turn when it boots.
    pub(super) async fn turn(&self, turn_id: &str) -> BoxliteResult<AgentTurnState> {
        if !is_message_id(turn_id) {
            return Err(self.missing_turn(turn_id));
        }
        let inbox = self
            .server
            .client
            .get(&format!("/api/session/{}/inbox", self.id))
            .await?;
        let queued = inbox["data"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["id"] == turn_id));
        if queued {
            return Ok(self.turn_state(turn_id, AgentTurnStatus::Queued, None));
        }
        let (input, later) = self.history_from(turn_id).await?;
        let observed = observe(turn_id, &later);
        match observed.status {
            AgentTurnStatus::Running => {
                let window = TurnWindow {
                    started: input["time"]["created"].as_f64().unwrap_or(f64::MAX),
                    next_input: observed.next_input,
                };
                let requests = self
                    .pending_requests(turn_id, &observed.steps, window)
                    .await?;
                let status = if requests.is_empty() {
                    AgentTurnStatus::Running
                } else {
                    AgentTurnStatus::WaitingInput
                };
                Ok(AgentTurnState {
                    requests,
                    ..self.turn_state(turn_id, status, None)
                })
            }
            status => Ok(self.turn_state(turn_id, status, observed.result)),
        }
    }

    /// The turn's input message and the history after it, oldest first. Pages
    /// are read newest-first and stop at the input, so recent turns cost one request.
    async fn history_from(&self, turn_id: &str) -> BoxliteResult<(Value, Vec<Value>)> {
        let mut newer = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..HISTORY_MAX_PAGES {
            let path = match &cursor {
                None => format!(
                    "/api/session/{}/message?order=desc&limit={HISTORY_PAGE}",
                    self.id
                ),
                // A cursor carries its page order, and OpenCode rejects a
                // request that also names `order`.
                Some(cursor) => format!(
                    "/api/session/{}/message?limit={HISTORY_PAGE}&cursor={cursor}",
                    self.id
                ),
            };
            let page = self.server.client.get(&path).await?;
            let messages = page["data"].as_array().cloned().unwrap_or_default();
            for message in &messages {
                if message["id"] == turn_id {
                    newer.reverse();
                    return Ok((message.clone(), newer));
                }
                newer.push(message.clone());
            }
            // Cursors are base64url; anything else must not reach the query string.
            match page["cursor"]["next"].as_str() {
                Some(next) if !messages.is_empty() && is_url_safe(next) => {
                    cursor = Some(next.to_owned())
                }
                _ => break,
            }
        }
        Err(self.missing_turn(turn_id))
    }

    /// Pending permissions and questions that block this turn: those naming
    /// one of its steps, and those in subagent sessions created inside its window.
    async fn pending_requests(
        &self,
        turn_id: &str,
        steps: &[String],
        window: TurnWindow,
    ) -> BoxliteResult<Vec<AgentRequest>> {
        let client = &self.server.client;
        let permissions = client.get("/api/permission/request").await?;
        let forms = client.get("/api/form").await?;
        let candidates = permissions["data"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|request| {
                (
                    request,
                    &request["sessionID"],
                    &request["source"]["messageID"],
                    RequestKind::Permission,
                )
            })
            .chain(forms["data"].as_array().into_iter().flatten().map(|form| {
                (
                    form,
                    &form["sessionID"],
                    &form["metadata"]["tool"]["messageID"],
                    RequestKind::Question,
                )
            }));
        let mut owners = SubagentOwners::default();
        let mut requests = Vec::new();
        for (native, session_id, message_id, kind) in candidates {
            let Some(session_id) = session_id.as_str() else {
                continue;
            };
            let blocks_turn = if session_id == self.id {
                message_id
                    .as_str()
                    .is_some_and(|id| steps.iter().any(|step| step == id))
            } else {
                owners.created_in(self, session_id, window).await?
            };
            if blocks_turn {
                requests.push(kind.request(turn_id, native));
            }
        }
        Ok(requests)
    }

    fn turn_state(
        &self,
        turn_id: &str,
        status: AgentTurnStatus,
        result: Option<AgentResult>,
    ) -> AgentTurnState {
        AgentTurnState {
            id: turn_id.to_owned(),
            agent_id: self.id.clone(),
            status,
            cursor: None,
            result,
            requests: Vec::new(),
            steering: Vec::new(),
        }
    }

    fn missing_turn(&self, turn_id: &str) -> BoxliteError {
        BoxliteError::NotFound(format!(
            "turn {turn_id} not found in the last {} messages of agent {}",
            HISTORY_PAGE * HISTORY_MAX_PAGES,
            self.id
        ))
    }
}

/// When a turn owned the session: from its input until the next input.
#[derive(Clone, Copy, Debug)]
struct TurnWindow {
    started: f64,
    next_input: Option<f64>,
}

/// Resolves which child session of the agent a subagent request came from,
/// and whether that child was created inside a turn's window.
#[derive(Default)]
struct SubagentOwners {
    sessions: HashMap<String, Value>,
}

impl SubagentOwners {
    async fn created_in(
        &mut self,
        agent: &Session,
        session_id: &str,
        window: TurnWindow,
    ) -> BoxliteResult<bool> {
        let mut current = session_id.to_owned();
        for _ in 0..MAX_SUBAGENT_DEPTH {
            let info = self.info(agent, &current).await?;
            let Some(parent) = info["parentID"].as_str() else {
                return Ok(false);
            };
            if parent == agent.id {
                let created = info["time"]["created"].as_f64().unwrap_or(f64::MIN);
                return Ok(created >= window.started
                    && window.next_input.is_none_or(|next| created < next));
            }
            current = parent.to_owned();
        }
        Ok(false)
    }

    async fn info(&mut self, agent: &Session, session_id: &str) -> BoxliteResult<Value> {
        // These IDs come from server JSON and end up in a request path.
        if !is_session_id(session_id) {
            return Ok(Value::Null);
        }
        if let Some(info) = self.sessions.get(session_id) {
            return Ok(info.clone());
        }
        let info = agent
            .server
            .client
            .get(&format!("/api/session/{session_id}"))
            .await?["data"]
            .take();
        self.sessions.insert(session_id.to_owned(), info.clone());
        Ok(info)
    }
}

#[derive(Clone, Copy, Debug)]
enum RequestKind {
    Permission,
    Question,
}

impl RequestKind {
    /// A pending permission (e.g. `read` of `.env`) or form (e.g. the question tool).
    fn request(self, turn_id: &str, native: &Value) -> AgentRequest {
        let kind = match self {
            Self::Permission => AgentRequestKind::Permission {
                tool: native["action"].as_str().unwrap_or_default().to_owned(),
                arguments: json!({ "resources": native["resources"] }),
            },
            Self::Question => {
                let fields = native["fields"].as_array().cloned().unwrap_or_default();
                let prompts: Vec<&str> = fields
                    .iter()
                    .filter_map(|field| field["description"].as_str().or(field["title"].as_str()))
                    .collect();
                let text = if prompts.is_empty() {
                    native["title"].as_str().unwrap_or_default().to_owned()
                } else {
                    prompts.join("\n")
                };
                AgentRequestKind::Question {
                    text,
                    schema: Some(Value::Array(fields)),
                }
            }
        };
        AgentRequest {
            id: native["id"].as_str().unwrap_or_default().to_owned(),
            turn_id: turn_id.to_owned(),
            kind,
        }
    }
}

/// Validated `agents.create` options as the native session body.
#[derive(Debug)]
pub(super) struct SessionRequest {
    id: String,
    body: Value,
}

impl SessionRequest {
    /// Reject options OpenCode 2.2 cannot honor before anything touches the Box.
    pub(super) fn new(options: &AgentCreateOptions) -> BoxliteResult<Self> {
        let config = &options.config;
        reject_unsupported(
            "agents.create",
            &[
                ("idempotency_key", options.idempotency_key.is_some()),
                ("config.reasoning", config.reasoning.is_some()),
                ("config.instructions", config.instructions.is_some()),
                ("config.tools", !config.tools.is_empty()),
                ("config.mcp", !config.mcp.is_empty()),
                ("config.permissions", is_present(&config.permissions)),
                ("config.limits", is_present(&config.limits)),
                ("config.output_schema", is_present(&config.output_schema)),
            ],
        )?;
        let id = mint_id("ses_");
        let mut body = Map::new();
        body.insert("id".into(), json!(id));
        if let Some(model) = &config.model {
            body.insert("model".into(), model_ref(model)?);
        }
        if let Some(cwd) = &options.cwd {
            body.insert("location".into(), json!({ "directory": cwd }));
        }
        body.insert("permissions".into(), session_rules());
        Ok(Self {
            id,
            body: Value::Object(body),
        })
    }
}

/// Rules appended after OpenCode's own, so they win. Its defaults ask before
/// reading `.env` files, and the question tool asks the user; nobody can
/// answer through BoxLite yet, and a pending ask keeps the session busy, so
/// every later input would wait behind it. Denied, the tool call fails fast.
fn session_rules() -> Value {
    json!([
        { "action": "read", "resource": "*.env", "effect": "deny" },
        { "action": "read", "resource": "*.env.*", "effect": "deny" },
        { "action": "read", "resource": "*.env.example", "effect": "allow" },
        { "action": "question", "resource": "*", "effect": "deny" },
    ])
}

/// What the history after a turn's input says about that turn.
#[derive(Debug)]
struct Observed {
    status: AgentTurnStatus,
    /// Present once `status` is terminal.
    result: Option<AgentResult>,
    /// Assistant messages the turn produced before any later input.
    steps: Vec<String>,
    /// Creation time of the next input that ended the turn's own output.
    next_input: Option<f64>,
}

/// Map the history after a turn's input, oldest first, to its status.
///
/// OpenCode drains queued inputs inside one busy period and writes a single
/// idle marker when the period ends, so a turn also ends where the next input
/// follows a step that finished. Two shapes keep the run going instead: a step
/// that finished with `tool-calls`, and a `synthetic` message, which OpenCode
/// adds to resume a cut-off stream, an output limit or a restart, and to
/// deliver a background subagent's report. An input after either was steered
/// in or delivered with the resumed run, and the turn continues to the idle
/// marker without claiming the later output. An input after a step that never
/// finished means the execution was cut off.
///
/// ```text
/// T, assistant{stop}, U, …                            ⇒ completed at U
/// T, assistant{error}, idle{failed}                   ⇒ failed
/// T, assistant{tool-calls}, U, assistant, idle{s}     ⇒ completed at idle, text before U
/// T, assistant{unfinished}, synthetic, U, …, idle{s}  ⇒ completed at idle, text before U
/// T, assistant{unfinished}, U, …                      ⇒ unknown
/// T, assistant{unfinished}                            ⇒ running
/// ```
fn observe(turn_id: &str, later: &[Value]) -> Observed {
    let mut steps = Vec::new();
    let mut text = String::new();
    let mut usage = Vec::new();
    let mut step_error = None;
    let mut idle_error = None;
    let mut last_finish: Option<&str> = None;
    let mut continuing = false;
    let mut next_input = None;
    let mut outcome = None;
    for message in later {
        match message["type"].as_str() {
            Some("assistant") if next_input.is_none() => {
                for part in message["content"].as_array().into_iter().flatten() {
                    if part["type"] == "text" {
                        text.push_str(part["text"].as_str().unwrap_or_default());
                    }
                }
                steps.push(message["id"].as_str().unwrap_or_default().to_owned());
                usage.push(json!({ "message_id": message["id"], "tokens": message["tokens"], "cost": message["cost"] }));
                if let Some(failure) = error_text(&message["error"]) {
                    step_error = Some(failure);
                }
                last_finish = message["finish"].as_str();
                continuing = false;
            }
            Some("synthetic") if next_input.is_none() => continuing = true,
            Some("user") if next_input.is_none() => {
                next_input = Some(message["time"]["created"].as_f64().unwrap_or(f64::MAX));
                // Delivered with the turn, steered in mid-run, or delivered
                // with a resumed run.
                if steps.is_empty() || continuing || last_finish == Some("tool-calls") {
                    continue;
                }
                outcome = Some(match last_finish {
                    None => AgentTurnStatus::Unknown,
                    Some("error") => AgentTurnStatus::Failed,
                    Some(_) => AgentTurnStatus::Completed,
                });
                break;
            }
            Some("idle") => {
                outcome = Some(match message["outcome"].as_str() {
                    Some("succeeded") => AgentTurnStatus::Completed,
                    Some("failed") => AgentTurnStatus::Failed,
                    Some("interrupted") => AgentTurnStatus::Cancelled,
                    _ => AgentTurnStatus::Unknown,
                });
                idle_error = error_text(&message["error"]);
                break;
            }
            _ => {}
        }
    }
    let status = outcome.unwrap_or(AgentTurnStatus::Running);
    let is_terminal = matches!(
        status,
        AgentTurnStatus::Completed | AgentTurnStatus::Failed | AgentTurnStatus::Cancelled
    );
    // A step error that a continuation recovered from is not the turn's error.
    let error = (status == AgentTurnStatus::Failed).then(|| {
        idle_error
            .or(step_error)
            .unwrap_or_else(|| "OpenCode reported a failed execution".into())
    });
    let result = is_terminal.then(|| AgentResult {
        turn_id: turn_id.to_owned(),
        status,
        outcome: (status == AgentTurnStatus::Completed).then_some(AgentOutcome::Answer),
        text: (!text.is_empty()).then_some(text),
        data: None,
        artifacts: Vec::new(),
        usage: (!usage.is_empty()).then_some(Value::Array(usage)),
        error,
    });
    Observed {
        status,
        result,
        steps,
        next_input,
    }
}

/// A native error's message, or its JSON when it has none.
fn error_text(error: &Value) -> Option<String> {
    match error {
        Value::Null => None,
        error => Some(
            error["message"]
                .as_str()
                .map_or_else(|| error.to_string(), str::to_owned),
        ),
    }
}

/// Operations this adapter performs; everything else returns `Unsupported`.
pub(super) fn capabilities() -> AgentCapabilities {
    AgentCapabilities {
        operations: [
            "agents.create",
            "agents.get",
            "agent.send",
            "agent.get_turn",
            "agent.config",
            "agent.capabilities",
            "turn.wait",
            "turn.state",
        ]
        .map(String::from)
        .to_vec(),
        input_kinds: vec!["text".into()],
        max_queued_turns: None,
        max_pending_steering: None,
        idempotency_retention: None,
    }
}

/// OpenCode IDs are a fixed prefix plus ASCII letters, digits and `_`.
/// Checking the shape also keeps arbitrary strings out of request paths.
pub(super) fn is_session_id(id: &str) -> bool {
    has_native_shape(id, "ses_")
}

fn is_message_id(id: &str) -> bool {
    has_native_shape(id, "msg_")
}

fn has_native_shape(id: &str, prefix: &str) -> bool {
    id.len() > prefix.len()
        && id.starts_with(prefix)
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// A native-shaped ID chosen before the request, so a retry repeats it.
fn mint_id(prefix: &str) -> String {
    format!("{prefix}{}", ulid::Ulid::new())
}

fn is_url_safe(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// Omitted and JSON-null options both mean "not provided".
fn is_present(value: &Option<Value>) -> bool {
    !matches!(value, None | Some(Value::Null))
}

fn reject_unsupported(operation: &str, options: &[(&str, bool)]) -> BoxliteResult<()> {
    match options.iter().find(|(_, present)| *present) {
        Some((name, _)) => Err(BoxliteError::Unsupported(format!(
            "{operation} option {name} is not supported by {ADAPTER}"
        ))),
        None => Ok(()),
    }
}

/// A mutation whose retried request still failed may or may not have been
/// admitted; `remedy` says how to reconcile it instead of submitting again.
fn uncertain(error: BoxliteError, action: String, remedy: String) -> BoxliteError {
    match error {
        BoxliteError::Network(detail) => {
            BoxliteError::Network(format!("{action} is uncertain ({detail}); {remedy}"))
        }
        other => other,
    }
}

/// `provider/model` is OpenCode's model reference syntax.
fn model_ref(model: &str) -> BoxliteResult<Value> {
    match model.split_once('/') {
        Some((provider, id)) if !provider.is_empty() && !id.is_empty() => {
            Ok(json!({ "providerID": provider, "id": id }))
        }
        _ => Err(BoxliteError::InvalidArgument(format!(
            "OpenCode model {model:?} must be written provider/model"
        ))),
    }
}

/// `queue` waits for an idle boundary instead of OpenCode's default `steer`,
/// which would merge the input into the running execution.
fn prompt_body(turn_id: &str, text: &str, options: &AgentSendOptions) -> BoxliteResult<Value> {
    reject_unsupported(
        "agent.send",
        &[
            ("idempotency_key", options.idempotency_key.is_some()),
            ("mode reject", options.mode == AgentSendMode::Reject),
            ("data", is_present(&options.data)),
        ],
    )?;
    Ok(json!({ "id": turn_id, "text": text, "delivery": "queue" }))
}

fn check_version(version: &str) -> BoxliteResult<()> {
    if version == SUPPORTED_VERSION {
        return Ok(());
    }
    Err(BoxliteError::Unsupported(format!(
        "OpenCode {version} is not supported; install OpenCode {SUPPORTED_VERSION} in the Box"
    )))
}

/// The setup lock of one Box, shared while any setup holds it.
fn setup_lock(box_id: &BoxID) -> Arc<tokio::sync::Mutex<()>> {
    let mut setups = SETUPS.lock().unwrap_or_else(PoisonError::into_inner);
    setups.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = setups.get(box_id).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    setups.insert(box_id.clone(), Arc::downgrade(&lock));
    lock
}

/// Whether the setup found a live service at [`SERVICE_URL`].
#[derive(Clone, Copy, Debug, PartialEq)]
enum ServiceState {
    Live,
    Stopped,
}

/// Prepare the Box's OpenCode service and read its password.
///
/// A registration (URL, pid) outlives an unclean exit, and after a restart its
/// pid can belong to another process, which `opencode service set` would
/// signal. So a pid counts only while it runs `opencode serve --service`, and a
/// stale registration is deleted before any setting changes. A live service at
/// another address is left alone and reported.
async fn setup(box_backend: &dyn BoxBackend) -> BoxliteResult<(ServiceState, String)> {
    // Assignments let `set -e` stop on a failing `opencode`; a pid that exits
    // before its cmdline is read counts as not running.
    let script = format!(
        r#"set -eu
remote="$(opencode service get remote)"
if [ "$remote" != false ]; then echo remote; exit 0; fi
record="${{XDG_STATE_HOME:-$HOME/.local/state}}/opencode/service.json"
pid=""
url=""
if [ -f "$record" ]; then
  pid="$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$record")"
  url="$(sed -n 's/.*"url":"\([^"]*\)".*/\1/p' "$record")"
fi
running=""
if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ]; then
  case "$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null)" in
    *opencode*" serve "*--service*) running=1 ;;
  esac
fi
if [ -n "$running" ]; then
  if [ "$url" != "{SERVICE_URL}" ]; then echo "foreign $url"; exit 0; fi
  echo live
else
  rm -f "$record"
  [ "$(opencode service get hostname)" = 0.0.0.0 ] || opencode service set hostname 0.0.0.0
  [ "$(opencode service get port)" = {PORT} ] || opencode service set port {PORT}
  echo stopped
fi
opencode service get password"#
    );
    let command = BoxCommand::new("sh")
        .args(["-c", script.as_str()])
        .timeout(SETUP_TIMEOUT);
    let (exit_code, reply) = run(box_backend, command).await?;
    if exit_code != 0 {
        return Err(BoxliteError::Execution(format!(
            "could not prepare the OpenCode service (exit code {exit_code}); the Box must provide OpenCode {SUPPORTED_VERSION} and sh"
        )));
    }
    parse_setup(&reply)
}

/// Read the setup reply: a state line, then the service password.
fn parse_setup(reply: &str) -> BoxliteResult<(ServiceState, String)> {
    let mut lines = reply.lines().map(str::trim);
    let state = match lines.next() {
        Some("live") => ServiceState::Live,
        Some("stopped") => ServiceState::Stopped,
        Some("remote") => {
            return Err(BoxliteError::InvalidState(
                "OpenCode remote access is on in this Box and would publish the agent server; \
                 turn it off with `opencode service unset remote`"
                    .into(),
            ));
        }
        Some(line) if line.starts_with("foreign ") => {
            let url: String = line["foreign ".len()..].chars().take(200).collect();
            return Err(BoxliteError::InvalidState(format!(
                "an OpenCode service started outside BoxLite runs at {url} in this Box; \
                 stop it with `opencode service stop`"
            )));
        }
        _ => {
            return Err(BoxliteError::Internal(
                "unexpected reply from the OpenCode setup command".into(),
            ));
        }
    };
    match lines.next() {
        Some(password) if !password.is_empty() => Ok((state, password.to_owned())),
        _ => Err(BoxliteError::Internal(
            "the OpenCode setup command printed no password".into(),
        )),
    }
}

/// The last `count` non-empty lines of command output.
fn last_lines(output: &str, count: usize) -> String {
    let lines: Vec<&str> = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    lines[lines.len().saturating_sub(count)..].join("\n")
}

/// Run a short command in the Box and return its exit code and stdout.
async fn run(box_backend: &dyn BoxBackend, command: BoxCommand) -> BoxliteResult<(i32, String)> {
    let mut execution = box_backend.exec(command).await?;
    let stdout = match execution.stdout() {
        Some(stream) => stream.collect::<Vec<String>>().await.concat(),
        None => String::new(),
    };
    Ok((execution.wait().await?.exit_code, stdout))
}
