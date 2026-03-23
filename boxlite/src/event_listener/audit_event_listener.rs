//! AuditEventListener — built-in EventListener that records events for later query.
//!
//! This is a convenience implementation of EventListener that stores events
//! in a bounded ring buffer. Users who want to query event history attach
//! this listener to the runtime and call `events()` directly on it.
//!
//! # Example
//!
//! ```rust,ignore
//! use boxlite::event_listener::AuditEventListener;
//!
//! let recorder = Arc::new(AuditEventListener::new());
//! let runtime = BoxliteRuntime::new(BoxliteOptions {
//!     event_listeners: vec![recorder.clone()],
//!     ..Default::default()
//! });
//!
//! // ... use boxes ...
//!
//! let events = recorder.events();
//! ```

use std::collections::VecDeque;
use std::sync::Mutex;

use chrono::{DateTime, Utc};

use super::event::{AuditEvent, AuditEventKind};
use super::listener::EventListener;
use crate::BoxID;

/// Default maximum number of events retained.
const DEFAULT_MAX_EVENTS: usize = 1000;

/// Built-in EventListener that stores events in a bounded ring buffer.
pub struct AuditEventListener {
    events: Mutex<VecDeque<AuditEvent>>,
    max_events: usize,
}

impl AuditEventListener {
    /// Create with default capacity (1000 events).
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_MAX_EVENTS)
    }

    /// Create with specified maximum event count.
    pub fn with_capacity(max_events: usize) -> Self {
        let alloc_capacity = max_events.min(DEFAULT_MAX_EVENTS);
        Self {
            events: Mutex::new(VecDeque::with_capacity(alloc_capacity)),
            max_events,
        }
    }

    fn record(&self, event: AuditEvent) {
        let mut events = self.events.lock().expect("audit lock poisoned");
        if events.len() >= self.max_events {
            events.pop_front();
        }
        events.push_back(event);
    }

    /// Return a snapshot of all recorded events.
    pub fn events(&self) -> Vec<AuditEvent> {
        let events = self.events.lock().expect("audit lock poisoned");
        events.iter().cloned().collect()
    }

    /// Return events that occurred at or after the given timestamp.
    pub fn events_since(&self, since: DateTime<Utc>) -> Vec<AuditEvent> {
        let events = self.events.lock().expect("audit lock poisoned");
        events
            .iter()
            .filter(|e| e.timestamp >= since)
            .cloned()
            .collect()
    }

    /// Number of recorded events.
    pub fn len(&self) -> usize {
        self.events.lock().expect("audit lock poisoned").len()
    }

    /// Whether no events have been recorded.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Default for AuditEventListener {
    fn default() -> Self {
        Self::new()
    }
}

// Must be Send + Sync for EventListener
const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    let _ = assert_send_sync::<AuditEventListener>;
};

impl EventListener for AuditEventListener {
    fn on_box_created(&self, box_id: &BoxID) {
        self.record(AuditEvent::now(box_id.clone(), AuditEventKind::BoxCreated));
    }

    fn on_box_started(&self, box_id: &BoxID) {
        self.record(AuditEvent::now(box_id.clone(), AuditEventKind::BoxStarted));
    }

    fn on_box_stopped(&self, box_id: &BoxID, exit_code: Option<i32>) {
        self.record(AuditEvent::now(
            box_id.clone(),
            AuditEventKind::BoxStopped { exit_code },
        ));
    }

    fn on_box_removed(&self, box_id: &BoxID) {
        self.record(AuditEvent::now(box_id.clone(), AuditEventKind::BoxRemoved));
    }

    fn on_exec_started(&self, box_id: &BoxID, command: &str, args: &[String]) {
        self.record(AuditEvent::now(
            box_id.clone(),
            AuditEventKind::ExecStarted {
                command: command.to_string(),
                args: args.to_vec(),
            },
        ));
    }

    fn on_exec_completed(
        &self,
        box_id: &BoxID,
        command: &str,
        exit_code: i32,
        duration: std::time::Duration,
    ) {
        self.record(AuditEvent::now(
            box_id.clone(),
            AuditEventKind::ExecCompleted {
                command: command.to_string(),
                exit_code,
                duration,
            },
        ));
    }

    fn on_file_copied_in(&self, box_id: &BoxID, host_src: &str, container_dst: &str) {
        self.record(AuditEvent::now(
            box_id.clone(),
            AuditEventKind::FileCopiedIn {
                host_src: host_src.to_string(),
                container_dst: container_dst.to_string(),
            },
        ));
    }

    fn on_file_copied_out(&self, box_id: &BoxID, container_src: &str, host_dst: &str) {
        self.record(AuditEvent::now(
            box_id.clone(),
            AuditEventKind::FileCopiedOut {
                container_src: container_src.to_string(),
                host_dst: host_dst.to_string(),
            },
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_box_id() -> BoxID {
        crate::runtime::id::BoxIDMint::mint()
    }

    #[test]
    fn records_via_event_listener_trait() {
        let listener = AuditEventListener::new();
        let id = test_box_id();

        listener.on_box_started(&id);
        listener.on_exec_started(&id, "echo", &["hello".into()]);
        listener.on_box_stopped(&id, Some(0));

        let events = listener.events();
        assert_eq!(events.len(), 3);
        assert!(matches!(events[0].kind, AuditEventKind::BoxStarted));
        assert!(matches!(events[1].kind, AuditEventKind::ExecStarted { .. }));
        assert!(matches!(events[2].kind, AuditEventKind::BoxStopped { .. }));
    }

    #[test]
    fn bounded_capacity_evicts_oldest() {
        let listener = AuditEventListener::with_capacity(3);
        let id = test_box_id();

        for _ in 0..5 {
            listener.on_box_started(&id);
        }

        assert_eq!(listener.len(), 3);
    }

    #[test]
    fn thread_safe() {
        use std::sync::Arc;
        use std::thread;

        let listener = Arc::new(AuditEventListener::with_capacity(1000));
        let mut handles = vec![];

        for _ in 0..10 {
            let l = Arc::clone(&listener);
            let id = test_box_id();
            handles.push(thread::spawn(move || {
                for _ in 0..100 {
                    l.on_box_started(&id);
                }
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        assert_eq!(listener.len(), 1000);
    }

    #[test]
    fn events_since_filters() {
        let listener = AuditEventListener::new();
        let id = test_box_id();
        let before = Utc::now();

        listener.on_box_started(&id);
        std::thread::sleep(std::time::Duration::from_millis(2));
        let mid = Utc::now();
        std::thread::sleep(std::time::Duration::from_millis(2));
        listener.on_box_stopped(&id, None);

        assert_eq!(listener.events_since(before).len(), 2);
        assert_eq!(listener.events_since(mid).len(), 1);
    }
}
