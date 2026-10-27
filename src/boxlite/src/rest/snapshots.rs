//! Cloud organization snapshot operations over the existing portable REST routes.

use super::litebox::RestBox;
use super::poll::OperationPoll;
use super::runtime::{RestRuntime, litebox_from_rest};
use super::types::{BoxResponse, CreateBoxRequest, ListSnapshotsResponse, SnapshotResponse};
use crate::runtime::snapshots::RuntimeSnapshotBackend;
use crate::{BoxOptions, LiteBox, RootfsSpec, SnapshotInfo};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use serde::Serialize;
use std::sync::Arc;

fn snapshot_path(id_or_name: &str) -> BoxliteResult<String> {
    if id_or_name.is_empty() || matches!(id_or_name, "." | "..") {
        return Err(BoxliteError::InvalidArgument(
            "Snapshot ID or name must not be empty or a dot path".into(),
        ));
    }
    Ok(format!("/snapshots/{}", urlencoding::encode(id_or_name)))
}

#[derive(Serialize)]
struct SnapshotBoxRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    options: CreateBoxRequest,
}

#[async_trait::async_trait]
impl RuntimeSnapshotBackend for RestRuntime {
    async fn list_snapshots(&self) -> BoxliteResult<Vec<SnapshotInfo>> {
        self.client.require_snapshots_enabled().await?;
        let response: ListSnapshotsResponse = self.client.get("/snapshots").await?;
        Ok(response
            .snapshots
            .iter()
            .map(SnapshotResponse::to_snapshot_info)
            .collect())
    }

    async fn get_snapshot(&self, id_or_name: &str) -> BoxliteResult<SnapshotInfo> {
        let path = snapshot_path(id_or_name)?;
        self.client.require_snapshots_enabled().await?;
        let response: SnapshotResponse = self.client.get(&path).await?;
        Ok(response.to_snapshot_info())
    }

    async fn remove_snapshot(&self, id_or_name: &str, force: bool) -> BoxliteResult<()> {
        let path = snapshot_path(id_or_name)?;
        self.client.require_snapshots_enabled().await?;
        match self.client.delete(&path).await {
            Err(BoxliteError::NotFound(_)) if force => Ok(()),
            result => result,
        }
    }

    async fn create_from_snapshot(
        &self,
        snapshot: &str,
        options: BoxOptions,
        name: Option<String>,
    ) -> BoxliteResult<LiteBox> {
        let path = format!("{}/boxes", snapshot_path(snapshot)?);
        // BoxOptions has an implicit image default. The snapshot replaces that
        // source; another image or a host rootfs path would be ambiguous.
        match &options.rootfs {
            RootfsSpec::Image(image)
                if image.is_empty() || image == crate::runtime::constants::images::DEFAULT => {}
            _ => {
                return Err(BoxliteError::InvalidArgument(
                    "Snapshot creation cannot specify an image or rootfs path".into(),
                ));
            }
        }
        self.validate_create_options(&options).await?;
        self.client.require_create_from_snapshot_enabled().await?;
        let mut options = CreateBoxRequest::from_options(&options, None);
        options.image = None;
        options.rootfs_path = None;
        let request = SnapshotBoxRequest { name, options };
        let mut response: BoxResponse = self.client.post(&path, &request).await?;
        let box_id = response.box_id.clone();
        let poll_path = format!("/boxes/{}", urlencoding::encode(&box_id));
        let mut poll = OperationPoll::new();
        loop {
            match response.status.as_str() {
                "running" => {
                    return Ok(litebox_from_rest(Arc::new(RestBox::new(
                        self.client.clone(),
                        response.to_box_info()?,
                    ))));
                }
                "configured" => {
                    poll.wait(&format!("startup of snapshot box '{box_id}'"))
                        .await?
                }
                status => {
                    return Err(BoxliteError::InvalidState(format!(
                        "Snapshot box '{box_id}' did not start (status: {status})"
                    )));
                }
            }
            response = self.client.get(&poll_path).await?;
        }
    }
}

#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod tests;
