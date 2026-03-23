//! Audit event recorder — bounded, thread-safe ring buffer.

use std::collections::VecDeque;
use std::sync::Mutex;

use chrono::{DateTime, Utc};

use super::event::AuditEvent;

/// Default maximum number of audit events retained per box.
const DEFAULT_MAX_EVENTS: usize = 1000;

/// Thread-safe, bounded audit event recorder.
///
/// Stores events in a ring buffer (oldest evicted when full).
/// Uses `std::sync::Mutex` (not `tokio::sync::Mutex`) because
/// operations are fast in-memory pushes with no async I/O.
pub struct AuditRecorder {
    events: Mutex<VecDeque<AuditEvent>>,
    max_events: usize,
}

impl AuditRecorder {
    /// Create a new recorder with the default capacity.
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_MAX_EVENTS)
    }

    /// Create a new recorder with the specified maximum event count.
    pub fn with_capacity(max_events: usize) -> Self {
        // Pre-allocate up to DEFAULT_MAX_EVENTS to avoid unbounded allocation
        let alloc_capacity = max_events.min(DEFAULT_MAX_EVENTS);
        Self {
            events: Mutex::new(VecDeque::with_capacity(alloc_capacity)),
            max_events,
        }
    }

    /// Record an audit event.
    ///
    /// If the buffer is full, the oldest event is evicted.
    pub fn record(&self, event: AuditEvent) {
        let mut events = self.events.lock().expect("audit recorder lock poisoned");
        if events.len() >= self.max_events {
            events.pop_front();
        }
        events.push_back(event);
    }

    /// Return a snapshot of all recorded events.
    pub fn events(&self) -> Vec<AuditEvent> {
        let events = self.events.lock().expect("audit recorder lock poisoned");
        events.iter().cloned().collect()
    }

    /// Return events that occurred at or after the given timestamp.
    pub fn events_since(&self, since: DateTime<Utc>) -> Vec<AuditEvent> {
        let events = self.events.lock().expect("audit recorder lock poisoned");
        events
            .iter()
            .filter(|e| e.timestamp >= since)
            .cloned()
            .collect()
    }

    /// Return the number of recorded events.
    pub fn len(&self) -> usize {
        let events = self.events.lock().expect("audit recorder lock poisoned");
        events.len()
    }

    /// Whether the recorder has no events.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Default for AuditRecorder {
    fn default() -> Self {
        Self::new()
    }
}

// AuditRecorder must be Send + Sync for use in BoxImpl
const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    let _ = assert_send_sync::<AuditRecorder>;
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::AuditEventKind;
    use crate::runtime::id::BoxIDMint;

    fn test_box_id() -> crate::BoxID {
        BoxIDMint::mint()
    }

    fn make_event(kind: AuditEventKind) -> AuditEvent {
        AuditEvent::now(test_box_id(), kind)
    }

    #[test]
    fn test_record_and_retrieve() {
        let recorder = AuditRecorder::new();
        assert!(recorder.is_empty());

        recorder.record(make_event(AuditEventKind::BoxStarted));
        assert_eq!(recorder.len(), 1);

        let events = recorder.events();
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0].kind, AuditEventKind::BoxStarted));
    }

    #[test]
    fn test_bounded_capacity() {
        let recorder = AuditRecorder::with_capacity(3);

        for i in 0..5 {
            recorder.record(make_event(AuditEventKind::ExecStarted {
                command: format!("cmd-{i}"),
                args: vec![],
            }));
        }

        // Should only retain the last 3
        assert_eq!(recorder.len(), 3);

        let events = recorder.events();
        // First event should be cmd-2 (0 and 1 were evicted)
        if let AuditEventKind::ExecStarted { command, .. } = &events[0].kind {
            assert_eq!(command, "cmd-2");
        } else {
            panic!("expected ExecStarted");
        }
    }

    #[test]
    fn test_events_since() {
        let recorder = AuditRecorder::new();
        let before = Utc::now();

        recorder.record(make_event(AuditEventKind::BoxStarted));

        // Small delay to ensure timestamp difference
        std::thread::sleep(std::time::Duration::from_millis(2));
        let midpoint = Utc::now();
        std::thread::sleep(std::time::Duration::from_millis(2));

        recorder.record(make_event(AuditEventKind::BoxStopped {
            exit_code: Some(0),
        }));

        // All events since before
        assert_eq!(recorder.events_since(before).len(), 2);

        // Only the second event since midpoint
        let since_mid = recorder.events_since(midpoint);
        assert_eq!(since_mid.len(), 1);
        assert!(matches!(
            since_mid[0].kind,
            AuditEventKind::BoxStopped { .. }
        ));
    }

    #[test]
    fn test_thread_safety() {
        use std::sync::Arc;
        use std::thread;

        let recorder = Arc::new(AuditRecorder::with_capacity(1000));
        let mut handles = vec![];

        for i in 0..10 {
            let rec = Arc::clone(&recorder);
            handles.push(thread::spawn(move || {
                for j in 0..100 {
                    rec.record(make_event(AuditEventKind::ExecStarted {
                        command: format!("thread-{i}-cmd-{j}"),
                        args: vec![],
                    }));
                }
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        assert_eq!(recorder.len(), 1000);
    }

    #[test]
    fn test_default_capacity() {
        let recorder = AuditRecorder::new();

        for i in 0..1500 {
            recorder.record(make_event(AuditEventKind::ExecStarted {
                command: format!("cmd-{i}"),
                args: vec![],
            }));
        }

        // Default capacity is 1000
        assert_eq!(recorder.len(), 1000);

        // Oldest should be cmd-500 (0..499 evicted)
        let events = recorder.events();
        if let AuditEventKind::ExecStarted { command, .. } = &events[0].kind {
            assert_eq!(command, "cmd-500");
        } else {
            panic!("expected ExecStarted");
        }
    }

    #[test]
    fn test_empty_recorder() {
        let recorder = AuditRecorder::new();
        assert!(recorder.is_empty());
        assert_eq!(recorder.len(), 0);
        assert!(recorder.events().is_empty());
        assert!(recorder.events_since(Utc::now()).is_empty());
    }

    #[test]
    fn test_serde_roundtrip() {
        let event = make_event(AuditEventKind::ExecCompleted {
            command: "echo".into(),
            exit_code: 0,
            duration: std::time::Duration::from_secs(1),
        });

        let json = serde_json::to_string(&event).unwrap();
        let deserialized: AuditEvent = serde_json::from_str(&json).unwrap();

        assert_eq!(event.box_id, deserialized.box_id);
        if let AuditEventKind::ExecCompleted { exit_code, .. } = deserialized.kind {
            assert_eq!(exit_code, 0);
        } else {
            panic!("expected ExecCompleted");
        }
    }
}
