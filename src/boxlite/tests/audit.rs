//! Integration tests for EventListener and AuditEventListener.

use std::sync::Arc;

use boxlite::event_listener::{AuditEventKind, AuditEventListener, EventListener};
use boxlite::runtime::id::BoxIDMint;

#[test]
fn audit_event_listener_records_via_trait() {
    let listener = AuditEventListener::new();
    let id = BoxIDMint::mint();

    // Call via EventListener trait methods
    listener.on_box_created(&id);
    listener.on_box_started(&id);
    listener.on_exec_started(&id, "echo", &["hello".into()]);
    listener.on_box_stopped(&id, Some(0));

    let events = listener.events();
    assert_eq!(events.len(), 4);
    assert!(matches!(events[0].kind, AuditEventKind::BoxCreated));
    assert!(matches!(events[1].kind, AuditEventKind::BoxStarted));
    assert!(matches!(events[2].kind, AuditEventKind::ExecStarted { .. }));
    assert!(matches!(
        events[3].kind,
        AuditEventKind::BoxStopped { exit_code: Some(0) }
    ));
}

#[test]
fn event_listener_trait_is_object_safe() {
    // Verify EventListener can be used as dyn trait object
    let listener: Arc<dyn EventListener> = Arc::new(AuditEventListener::new());
    let id = BoxIDMint::mint();
    listener.on_box_started(&id);
}

#[test]
fn multiple_listeners_all_receive_events() {
    let l1 = Arc::new(AuditEventListener::new());
    let l2 = Arc::new(AuditEventListener::new());
    let listeners: Vec<Arc<dyn EventListener>> = vec![l1.clone(), l2.clone()];

    let id = BoxIDMint::mint();
    for listener in &listeners {
        listener.on_box_started(&id);
    }

    assert_eq!(l1.events().len(), 1);
    assert_eq!(l2.events().len(), 1);
}
