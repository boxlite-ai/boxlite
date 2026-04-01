//! Event listener system for box operations.
//!
//! Provides a push-based callback interface inspired by RocksDB's EventListener.
//! Register listeners at runtime level via `BoxliteOptions::event_listeners`.
//!
//! Built-in implementations:
//! - [`AuditEventListener`] — records events in a bounded ring buffer for later query

mod audit_event_listener;
mod event;
mod listener;

pub use audit_event_listener::AuditEventListener;
pub use event::{AuditEvent, AuditEventKind};
pub use listener::EventListener;
