//! Audit system for tracking box operations.
//!
//! Provides structured event recording for lifecycle, execution,
//! file transfer, network, and secret operations.

mod event;
mod recorder;

pub use event::{AuditEvent, AuditEventKind};
pub use recorder::AuditRecorder;
