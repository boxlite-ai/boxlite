//! REST execution control — implements ExecBackend for remote command control.

use async_trait::async_trait;

use boxlite_shared::errors::BoxliteResult;

use crate::runtime::backend::ExecBackend;

use super::client::ApiClient;
use super::types::{ResizeRequestBody, SignalRequestBody};

/// REST-backed execution control.
///
/// Sends HTTP requests for kill/resize operations on a remote execution.
pub(crate) struct RestExecControl {
    client: ApiClient,
    box_id: String,
}

impl RestExecControl {
    pub fn new(client: ApiClient, box_id: String) -> Self {
        Self { client, box_id }
    }
}

#[async_trait]
impl ExecBackend for RestExecControl {
    async fn kill(&mut self, execution_id: &str, signal: i32) -> BoxliteResult<()> {
        let path = format!("/boxes/{}/executions/{}/signal", self.box_id, execution_id);
        let body = SignalRequestBody { signal };
        self.client.post_no_content(&path, &body).await
    }

    async fn resize_tty(
        &mut self,
        execution_id: &str,
        rows: u32,
        cols: u32,
        _x_pixels: u32,
        _y_pixels: u32,
    ) -> BoxliteResult<()> {
        let path = format!("/boxes/{}/executions/{}/resize", self.box_id, execution_id);
        let body = ResizeRequestBody { cols, rows };
        self.client.post_no_content(&path, &body).await
    }
}
