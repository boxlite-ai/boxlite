// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! Which runner currently holds a box.

use std::sync::Arc;
use std::time::Duration;

use crate::api::{ApiClient, RunnerInfo};
use crate::cache::Cache;
use crate::error::Result;

/// Placement changes when a box is rescheduled, so entries are short-lived; the
/// cache exists to keep every request off the control plane, not to be correct
/// forever.
const CACHE_TTL: Duration = Duration::from_secs(120);

pub struct RunnerDirectory {
    api: Arc<ApiClient>,
    cache: Cache<RunnerInfo>,
}

impl RunnerDirectory {
    pub fn new(api: Arc<ApiClient>, cache: Cache<RunnerInfo>) -> Self {
        Self { api, cache }
    }

    pub async fn for_box(&self, box_id: &str) -> Result<RunnerInfo> {
        if let Some(cached) = self.cache.get(box_id).await {
            return Ok(cached);
        }

        let runner = self.api.get_runner_for_box(box_id).await?;
        self.cache.set(box_id, runner.clone(), CACHE_TTL).await;
        Ok(runner)
    }
}
