//! Agent handles backed by the Box REST API.

use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use super::{
    Agent, AgentBackend, AgentCapabilities, AgentConfig, AgentControlOptions, AgentCreateOptions,
    AgentEventStream, AgentEventsOptions, AgentResponse, AgentSendMode, AgentSendOptions,
    AgentState, AgentSteeringReceipt, AgentTurnState,
};
use crate::rest::client::ApiClient;
use crate::rest::litebox::RestBox;
use crate::runtime::backend::BoxBackend;
use crate::{BoxliteError, BoxliteResult};

mod events;

use super::records::{Receipt, Resource, Turn, invalid};

fn segment(value: &str) -> BoxliteResult<String> {
    if value.is_empty() || value == "." || value == ".." {
        return Err(BoxliteError::InvalidArgument(
            "agent path identifier is empty or a dot segment".into(),
        ));
    }
    Ok(urlencoding::encode(value).into_owned())
}

struct RestAgent {
    client: ApiClient,
    path: String,
    id: String,
    adapter: String,
    state: Option<AgentState>,
    config: AgentConfig,
    capabilities: AgentCapabilities,
}

impl std::fmt::Debug for RestAgent {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RestAgent")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

fn from_resource(remote: &RestBox, path: String, resource: Resource) -> BoxliteResult<Agent> {
    if resource
        .state
        .as_ref()
        .is_some_and(|state| state.id != resource.id)
    {
        return Err(invalid("state id", &resource.id));
    }
    let retention = resource
        .capabilities
        .idempotency_retention_seconds
        .map(|seconds| {
            Duration::try_from_secs_f64(seconds)
                .map_err(|_| invalid("retention", &seconds.to_string()))
        })
        .transpose()?;
    let capabilities = AgentCapabilities {
        operations: resource.capabilities.operations,
        input_kinds: resource.capabilities.input_kinds,
        max_queued_turns: resource.capabilities.max_queued_turns,
        max_pending_steering: resource.capabilities.max_pending_steering,
        idempotency_retention: retention,
    };
    Ok(Agent::new(RestAgent {
        client: remote.agent_client().clone(),
        path,
        id: resource.id,
        adapter: resource.agent,
        state: resource.state.map(TryInto::try_into).transpose()?,
        config: super::records::parse_config(resource.config)?,
        capabilities,
    }))
}

pub(super) async fn get(remote: &RestBox, agent_id: &str) -> BoxliteResult<Agent> {
    let path = format!(
        "/boxes/{}/agents/{}",
        urlencoding::encode(remote.id().as_ref()),
        segment(agent_id)?
    );
    let resource: Resource = remote.agent_client().get_agent(&path).await?;
    if resource.id != agent_id {
        return Err(invalid("id", &resource.id));
    }
    from_resource(remote, path, resource)
}

pub(super) async fn create(
    remote: &RestBox,
    agent: &str,
    options: &AgentCreateOptions,
) -> BoxliteResult<Agent> {
    let path = format!(
        "/boxes/{}/agents",
        urlencoding::encode(remote.id().as_ref())
    );
    let config = &options.config;
    let has_config = config.model.is_some()
        || config.reasoning.is_some()
        || config.instructions.is_some()
        || !config.tools.is_empty()
        || !config.mcp.is_empty()
        || config.permissions.is_some()
        || config.limits.is_some()
        || config.output_schema.is_some();
    let mut create_options = serde_json::Map::new();
    if let Some(cwd) = &options.cwd {
        create_options.insert("cwd".into(), Value::String(cwd.clone()));
    }
    if has_config {
        create_options.insert("config".into(), super::records::config(config));
    }
    let mut body = serde_json::json!({"agent": agent});
    if !create_options.is_empty() {
        body["options"] = Value::Object(create_options);
    }
    let resource: Resource = remote
        .agent_client()
        .post_agent(&path, &body, options.idempotency_key.as_deref())
        .await?;
    if resource.agent != agent {
        return Err(invalid("implementation", &resource.agent));
    }
    let resource_path = format!("{path}/{}", segment(&resource.id)?);
    from_resource(remote, resource_path, resource)
}

#[async_trait]
impl AgentBackend for RestAgent {
    fn adapter(&self) -> &str {
        &self.adapter
    }
    fn implementation(&self) -> &str {
        &self.adapter
    }
    fn id(&self) -> &str {
        &self.id
    }
    fn config(&self) -> &AgentConfig {
        &self.config
    }
    fn capabilities(&self) -> AgentCapabilities {
        self.capabilities.clone()
    }
    fn state(&self) -> BoxliteResult<AgentState> {
        self.state
            .clone()
            .ok_or_else(|| BoxliteError::Unsupported("agent.state is not supported".into()))
    }
    async fn send(&self, text: &str, options: &AgentSendOptions) -> BoxliteResult<AgentTurnState> {
        let mut send_options = serde_json::Map::new();
        if options.mode == AgentSendMode::Reject {
            send_options.insert("mode".into(), Value::String("reject".into()));
        }
        if let Some(data) = &options.data {
            send_options.insert("data".into(), data.clone());
        }
        let mut body = serde_json::json!({"text": text});
        if !send_options.is_empty() {
            body["options"] = Value::Object(send_options);
        }
        let result: Turn = self
            .client
            .post_agent(
                &format!("{}/turns", self.path),
                &body,
                options.idempotency_key.as_deref(),
            )
            .await?;
        if result.agent_id != self.id {
            return Err(invalid("turn agent_id", &result.agent_id));
        }
        result.try_into()
    }
    async fn turn(&self, turn_id: &str) -> BoxliteResult<AgentTurnState> {
        let result: Turn = self
            .client
            .get_agent(&format!("{}/turns/{}", self.path, segment(turn_id)?))
            .await?;
        if result.agent_id != self.id {
            return Err(invalid("turn agent_id", &result.agent_id));
        }
        if result.id != turn_id {
            return Err(invalid("turn id", &result.id));
        }
        result.try_into()
    }
    async fn close(&self, options: &AgentControlOptions) -> BoxliteResult<()> {
        self.client
            .post_agent_no_content(
                &format!("{}/close", self.path),
                options.idempotency_key.as_deref(),
            )
            .await
    }
    async fn respond(
        &self,
        request_id: &str,
        response: AgentResponse,
        options: &AgentControlOptions,
    ) -> BoxliteResult<AgentTurnState> {
        let response = match response {
            AgentResponse::Answer { text, data } => {
                let mut value = serde_json::json!({"type": "answer", "text": text});
                if let Some(data) = data {
                    value["data"] = data;
                }
                value
            }
            AgentResponse::Permission { approved } => {
                serde_json::json!({"type": "permission", "approved": approved})
            }
        };
        let path = format!("{}/requests/{}/respond", self.path, segment(request_id)?);
        let result: Turn = self
            .client
            .post_agent(
                &path,
                &serde_json::json!({"response": response}),
                options.idempotency_key.as_deref(),
            )
            .await?;
        if result.agent_id != self.id {
            return Err(invalid("turn agent_id", &result.agent_id));
        }
        result.try_into()
    }
    async fn steer(
        &self,
        turn_id: &str,
        text: &str,
        options: &AgentControlOptions,
    ) -> BoxliteResult<AgentSteeringReceipt> {
        let path = format!("{}/turns/{}/steer", self.path, segment(turn_id)?);
        let result: Receipt = self
            .client
            .post_agent(
                &path,
                &serde_json::json!({"text": text}),
                options.idempotency_key.as_deref(),
            )
            .await?;
        if result.turn_id != turn_id {
            return Err(invalid("receipt turn_id", &result.turn_id));
        }
        result.try_into()
    }
    async fn interrupt(&self, turn_id: &str, options: &AgentControlOptions) -> BoxliteResult<()> {
        let path = format!("{}/turns/{}/interrupt", self.path, segment(turn_id)?);
        self.client
            .post_agent_no_content(&path, options.idempotency_key.as_deref())
            .await
    }
    async fn events(&self, options: &AgentEventsOptions) -> BoxliteResult<AgentEventStream> {
        events::open(&self.client, &self.path, &self.id, None, options).await
    }
    async fn turn_events(
        &self,
        turn_id: &str,
        options: &AgentEventsOptions,
    ) -> BoxliteResult<AgentEventStream> {
        events::open(&self.client, &self.path, &self.id, Some(turn_id), options).await
    }
}
