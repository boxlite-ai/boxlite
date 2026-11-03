//! Checkpoint catalog requests; memory restore is submitted exactly once.

use super::client::ApiClient;
use super::litebox::RestBox;
use super::poll::OperationPoll;
use super::runtime::litebox_from_rest;
use super::types::BoxResponse;
use crate::runtime::checkpoints::{CheckpointBackend, CheckpointInfo, validate_name};
use crate::{BoxliteError, BoxliteResult, LiteBox};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub(crate) struct RestCheckpoints {
    client: ApiClient,
    source: Option<String>,
}
impl RestCheckpoints {
    pub(crate) fn new(client: ApiClient, source: Option<String>) -> Self {
        Self { client, source }
    }
    fn root(&self) -> String {
        self.source
            .as_ref()
            .map(|id| format!("/boxes/{}/checkpoints", urlencoding::encode(id)))
            .unwrap_or_else(|| "/checkpoints".into())
    }
    fn path(&self, key: &str) -> BoxliteResult<String> {
        validate_name(key)?;
        Ok(format!("{}/{}", self.root(), urlencoding::encode(key)))
    }
}

#[derive(Serialize)]
struct NameRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}
#[derive(Deserialize)]
struct ListResponse {
    checkpoints: Vec<CheckpointInfo>,
}

#[async_trait::async_trait]
impl CheckpointBackend for RestCheckpoints {
    async fn create(&self, name: Option<String>) -> BoxliteResult<CheckpointInfo> {
        if self.source.is_none() {
            return Err(BoxliteError::Unsupported(
                "capture requires a source box".into(),
            ));
        }
        self.client.require_checkpoint_management_enabled().await?;
        let mut info: CheckpointInfo = self
            .client
            .post_checkpoint_json(&self.root(), &NameRequest { name })
            .await?;
        let path = format!("{}/{}", self.root(), urlencoding::encode(&info.id));
        let mut poll = OperationPoll::new();
        loop {
            match info.status.as_str() {
                "ready" => return Ok(info),
                "creating" => {
                    poll.wait(&format!("checkpoint '{}' capture", info.id))
                        .await?
                }
                _ => {
                    return Err(BoxliteError::InvalidState(format!(
                        "checkpoint '{}' is {}: {}",
                        info.id,
                        info.status,
                        info.error.as_deref().unwrap_or("capture failed")
                    )));
                }
            }
            info = self.client.get(&path).await?;
        }
    }
    async fn list(&self) -> BoxliteResult<Vec<CheckpointInfo>> {
        self.client.require_checkpoint_management_enabled().await?;
        let response: ListResponse = self.client.get(&self.root()).await?;
        Ok(response.checkpoints)
    }
    async fn get(&self, key: &str) -> BoxliteResult<Option<CheckpointInfo>> {
        let path = self.path(key)?;
        self.client.require_checkpoint_management_enabled().await?;
        match self.client.get(&path).await {
            Err(BoxliteError::NotFound(_)) if self.source.is_some() => Ok(None),
            result => result.map(Some),
        }
    }
    async fn remove(&self, key: &str, force: bool) -> BoxliteResult<()> {
        let path = self.path(key)?;
        self.client.require_checkpoint_management_enabled().await?;
        match self.client.delete(&path).await {
            Err(BoxliteError::NotFound(_)) if force => Ok(()),
            result => result,
        }
    }
    async fn create_from(&self, key: &str, name: Option<String>) -> BoxliteResult<LiteBox> {
        validate_name(key)?;
        self.client.require_checkpoint_management_enabled().await?;
        let path = format!("/checkpoints/{}/boxes", urlencoding::encode(key));
        let mut response: BoxResponse = self
            .client
            .post_checkpoint_json(&path, &NameRequest { name })
            .await?;
        let poll_path = format!("/boxes/{}", urlencoding::encode(&response.box_id));
        let mut poll = OperationPoll::new();
        loop {
            match response.status.as_str() {
                "paused" => {
                    return Ok(litebox_from_rest(Arc::new(RestBox::new(
                        self.client.clone(),
                        response.to_box_info()?,
                    ))));
                }
                "configured" | "creating" | "restoring" => {
                    poll.wait(&format!("checkpoint box '{}' restore", response.box_id))
                        .await?
                }
                status => {
                    return Err(BoxliteError::InvalidState(format!(
                        "checkpoint box '{}' is {status}, expected paused",
                        response.box_id
                    )));
                }
            }
            response = self.client.get(&poll_path).await?;
        }
    }
}

#[cfg(test)]
mod tests;
