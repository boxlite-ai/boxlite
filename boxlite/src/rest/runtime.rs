//! RestRuntime — implements RuntimeBackend for the REST API.

use std::sync::Arc;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::metrics::RuntimeMetrics;
use crate::runtime::backend::RuntimeBackend;
use crate::runtime::options::BoxOptions;
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

#[async_trait::async_trait]
impl RuntimeBackend for RestRuntime {
    async fn create(&self, options: BoxOptions, name: Option<String>) -> BoxliteResult<LiteBox> {
        let req = CreateBoxRequest::from_options(&options, name);
        let resp: BoxResponse = self.client.post("/boxes", &req).await?;
        let info = resp.to_box_info();
        let rest_box = RestBox::new(self.client.clone(), info);
        Ok(LiteBox::new(Arc::new(rest_box)))
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
                let rest_box = RestBox::new(self.client.clone(), info);
                Ok(Some(LiteBox::new(Arc::new(rest_box))))
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
