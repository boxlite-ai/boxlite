//! RestRuntime — implements RuntimeBackend for the REST API.

use std::sync::Arc;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::metrics::RuntimeMetrics;
use crate::runtime::backend::RuntimeBackend;
use crate::runtime::options::{BoxArchive, BoxOptions};
use crate::{BoxInfo, LiteBox};

use super::client::ApiClient;
use super::litebox::RestBox;
use super::options::BoxliteRestOptions;
use super::types::{BoxResponse, CreateBoxRequest, ListBoxesResponse, RuntimeMetricsResponse};

pub(crate) struct RestRuntime {
    client: ApiClient,
}

impl RestRuntime {
    pub fn new(config: &BoxliteRestOptions) -> BoxliteResult<Self> {
        let client = ApiClient::new(config)?;
        Ok(Self { client })
    }
}

fn litebox_from_rest(rest_box: Arc<RestBox>) -> LiteBox {
    let box_backend: Arc<dyn crate::runtime::backend::BoxBackend> = rest_box.clone();
    let snapshot_backend: Arc<dyn crate::runtime::backend::SnapshotBackend> = rest_box;
    LiteBox::new(box_backend, snapshot_backend)
}

#[async_trait::async_trait]
impl RuntimeBackend for RestRuntime {
    async fn create(&self, options: BoxOptions, name: Option<String>) -> BoxliteResult<LiteBox> {
        let req = CreateBoxRequest::from_options(&options, name);
        let resp: BoxResponse = self.client.post("/boxes", &req).await?;
        let info = resp.to_box_info();
        let rest_box = Arc::new(RestBox::new(self.client.clone(), info));
        Ok(litebox_from_rest(rest_box))
    }

    async fn get_or_create(
        &self,
        options: BoxOptions,
        name: Option<String>,
    ) -> BoxliteResult<(LiteBox, bool)> {
        // Try to get existing box by name first
        if let Some(ref box_name) = name
            && let Some(litebox) = self.get(box_name).await?
        {
            return Ok((litebox, false));
        }
        // Create new box
        let litebox = self.create(options, name).await?;
        Ok((litebox, true))
    }

    async fn get(&self, id_or_name: &str) -> BoxliteResult<Option<LiteBox>> {
        let path = format!("/boxes/{}", id_or_name);
        match self.client.get::<BoxResponse>(&path).await {
            Ok(resp) => {
                let info = resp.to_box_info();
                let rest_box = Arc::new(RestBox::new(self.client.clone(), info));
                Ok(Some(litebox_from_rest(rest_box)))
            }
            Err(BoxliteError::NotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn get_info(&self, id_or_name: &str) -> BoxliteResult<Option<BoxInfo>> {
        let path = format!("/boxes/{}", id_or_name);
        match self.client.get::<BoxResponse>(&path).await {
            Ok(resp) => Ok(Some(resp.to_box_info())),
            Err(BoxliteError::NotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn list_info(&self) -> BoxliteResult<Vec<BoxInfo>> {
        let resp: ListBoxesResponse = self.client.get("/boxes").await?;
        Ok(resp.boxes.iter().map(|b| b.to_box_info()).collect())
    }

    async fn exists(&self, id_or_name: &str) -> BoxliteResult<bool> {
        let path = format!("/boxes/{}", id_or_name);
        self.client.head_exists(&path).await
    }

    async fn metrics(&self) -> BoxliteResult<RuntimeMetrics> {
        let resp: RuntimeMetricsResponse = self.client.get("/metrics").await?;
        Ok(runtime_metrics_from_response(&resp))
    }

    async fn remove(&self, id_or_name: &str, force: bool) -> BoxliteResult<()> {
        let path = format!("/boxes/{}", id_or_name);
        if force {
            self.client
                .delete_with_query(&path, &[("force", "true")])
                .await
        } else {
            self.client.delete(&path).await
        }
    }

    async fn shutdown(&self, _timeout: Option<i32>) -> BoxliteResult<()> {
        // REST client doesn't own the server — shutdown is a no-op.
        // The server manages its own lifecycle.
        Ok(())
    }

    async fn import_box(
        &self,
        archive: BoxArchive,
        name: Option<String>,
    ) -> BoxliteResult<LiteBox> {
        self.client.require_import_enabled().await?;

        let archive_bytes = std::fs::read(archive.path()).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to read archive {}: {}",
                archive.path().display(),
                e
            ))
        })?;

        let query: Vec<(&str, &str)> = name
            .as_deref()
            .map(|n| vec![("name", n)])
            .unwrap_or_default();

        let resp: BoxResponse = self
            .client
            .post_bytes_for_json("/boxes/import", archive_bytes, &query)
            .await?;

        let info = resp.to_box_info();
        let rest_box = Arc::new(RestBox::new(self.client.clone(), info));
        Ok(litebox_from_rest(rest_box))
    }
}

/// Convert REST metrics response to core RuntimeMetrics.
fn runtime_metrics_from_response(resp: &RuntimeMetricsResponse) -> RuntimeMetrics {
    use crate::metrics::RuntimeMetricsStorage;
    use std::sync::atomic::Ordering;

    let storage = RuntimeMetricsStorage::new();
    storage
        .boxes_created
        .store(resp.boxes_created_total, Ordering::Relaxed);
    storage
        .boxes_failed
        .store(resp.boxes_failed_total, Ordering::Relaxed);
    storage
        .boxes_stopped
        .store(resp.boxes_stopped_total, Ordering::Relaxed);
    storage
        .total_commands
        .store(resp.total_commands_executed, Ordering::Relaxed);
    storage
        .total_exec_errors
        .store(resp.total_exec_errors, Ordering::Relaxed);

    RuntimeMetrics::new(storage)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_import_box_requires_capability() {
        // Without a running server, import_box should fail with a connection error
        // (it tries to check capabilities first). This verifies the code path is wired up.
        let options = BoxliteRestOptions::new("http://localhost:1"); // unreachable port
        let runtime = RestRuntime::new(&options).expect("failed to create REST runtime");

        let result = RuntimeBackend::import_box(
            &runtime,
            BoxArchive::new("/tmp/ignored.boxlite"),
            Some("x".to_string()),
        )
        .await;

        // Should fail trying to reach the server for capability check
        assert!(result.is_err(), "Expected error when server is unreachable");
    }
}
