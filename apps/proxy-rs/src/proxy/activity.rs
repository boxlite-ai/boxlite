// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! Keeps a box alive for as long as someone is using it.
//!
//! The control plane stops boxes that look idle, and it only sees HTTP requests
//! it handles itself — not traffic the proxy relays. A single long-lived
//! connection (a terminal, a WebSocket, a large download) would otherwise look
//! like silence, so activity is reported for as long as the request is open, not
//! just when it arrives.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;

use crate::api::ApiClient;
use crate::cache::Cache;

const POLL_INTERVAL: Duration = Duration::from_secs(50);

/// Slightly shorter than the poll interval so the next poll always finds the
/// entry gone and reports again.
const REPORT_TTL: Duration = Duration::from_secs(45);

pub struct ActivityReporter {
    api: Arc<ApiClient>,
    /// Shared across replicas: one report per box per interval, not one per
    /// replica per interval.
    reported: Cache<bool>,
}

/// Keeps the reporter running. Dropping every clone stops it.
#[derive(Clone)]
pub struct ActivityHandle(#[allow(dead_code)] mpsc::Sender<()>);

impl ActivityReporter {
    pub fn new(api: Arc<ApiClient>, reported: Cache<bool>) -> Self {
        Self { api, reported }
    }

    pub fn start(self: &Arc<Self>, box_id: String) -> ActivityHandle {
        let (stop, mut stopped) = mpsc::channel::<()>(1);
        let reporter = self.clone();

        tokio::spawn(async move {
            loop {
                reporter.report(&box_id).await;

                tokio::select! {
                    _ = tokio::time::sleep(POLL_INTERVAL) => {}
                    // Resolves as soon as the last handle is dropped.
                    _ = stopped.recv() => break,
                }
            }
        });

        ActivityHandle(stop)
    }

    async fn report(&self, box_id: &str) {
        match self.reported.has(box_id).await {
            Ok(true) => return,
            Ok(false) => {}
            Err(err) => {
                tracing::error!(box_id, error = %err, "failed to check last-activity cache");
                return;
            }
        }

        if let Err(err) = self.api.update_last_activity(box_id).await {
            tracing::error!(box_id, error = %err, "failed to update last activity");
            return;
        }

        self.reported.set(box_id, true, REPORT_TTL).await;
    }
}
