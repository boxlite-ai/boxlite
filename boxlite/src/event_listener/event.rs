//! Audit event types for tracking box operations.

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::BoxID;

/// A single audit event recording an operation on a box.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEvent {
    /// When the event occurred.
    pub timestamp: DateTime<Utc>,
    /// Which box this event belongs to.
    pub box_id: BoxID,
    /// What happened.
    pub kind: AuditEventKind,
}

impl AuditEvent {
    /// Create a new audit event with the current timestamp.
    pub fn now(box_id: BoxID, kind: AuditEventKind) -> Self {
        Self {
            timestamp: Utc::now(),
            box_id,
            kind,
        }
    }
}

/// The kind of operation that was audited.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AuditEventKind {
    // ── Lifecycle ────────────────────────────────────────────────────────
    /// Box created.
    BoxCreated,

    /// Box VM started successfully.
    BoxStarted,

    /// Box VM stopped.
    BoxStopped { exit_code: Option<i32> },

    /// Box removed.
    BoxRemoved,

    // ── Execution ───────────────────────────────────────────────────────
    /// Command execution started.
    ExecStarted { command: String, args: Vec<String> },

    /// Command execution completed.
    ExecCompleted {
        command: String,
        exit_code: i32,
        duration: Duration,
    },

    // ── File operations ─────────────────────────────────────────────────
    /// File(s) copied from host into container.
    FileCopiedIn {
        host_src: String,
        container_dst: String,
    },

    /// File(s) copied from container to host.
    FileCopiedOut {
        container_src: String,
        host_dst: String,
    },
}
