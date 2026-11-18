use super::*;
use std::time::Duration;

#[derive(Default)]
struct EventsSeen {
    opened: bool,
    handle: *mut CAgentEvents,
    open_error: Option<BoxliteErrorCode>,
    terminal: usize,
    terminal_error: Option<BoxliteErrorCode>,
    items: Vec<String>,
    queue: Option<Arc<EventQueue>>,
    fill_and_free: bool,
    wait_for_events_and_free: bool,
    order_violation: bool,
    rendezvous: Option<Arc<(std::sync::Mutex<usize>, std::sync::Condvar)>>,
    simultaneous: bool,
}

unsafe extern "C" fn opened(
    handle: *mut CAgentEvents,
    error: *const CBoxliteError,
    data: *mut c_void,
) {
    let seen = &mut *(data as *mut EventsSeen);
    seen.opened = true;
    seen.handle = handle;
    seen.open_error = error.as_ref().map(|e| e.code);
    if let Some(rendezvous) = &seen.rendezvous {
        let (lock, cv) = &**rendezvous;
        let mut count = lock.lock().unwrap();
        *count += 1;
        cv.notify_all();
        let (count, _) = cv
            .wait_timeout_while(count, Duration::from_secs(5), |n| *n < 2)
            .unwrap();
        seen.simultaneous = *count == 2;
    }
    if seen.fill_and_free {
        let queue = seen.queue.as_ref().unwrap();
        let mut pending = queue.inner.lock().unwrap();
        for _ in 0..crate::event_queue::QUEUE_CAPACITY {
            pending.push_back(RuntimeEvent::AgentCompletion(Box::new(|| {})));
        }
        drop(pending);
        boxlite_agent_events_free(handle);
        seen.handle = ptr::null_mut();
    }
    if seen.wait_for_events_and_free {
        let queue = seen.queue.as_ref().unwrap();
        let mut pending = queue.inner.lock().unwrap();
        while pending.len() < 2 {
            let (next, timeout) = queue
                .cv
                .wait_timeout(pending, Duration::from_secs(5))
                .unwrap();
            pending = next;
            if timeout.timed_out() {
                break;
            }
        }
        let two_queued = pending.len() >= 2;
        drop(pending);
        if two_queued {
            boxlite_agent_events_free(handle);
            seen.handle = ptr::null_mut();
        }
    }
}

unsafe extern "C" fn event(json: *const c_char, error: *const CBoxliteError, data: *mut c_void) {
    let seen = &mut *(data as *mut EventsSeen);
    if !seen.opened || seen.terminal != 0 {
        seen.order_violation = true;
    }
    if json.is_null() {
        seen.terminal += 1;
        seen.terminal_error = error.as_ref().map(|e| e.code);
    } else {
        let value: serde_json::Value =
            serde_json::from_slice(CStr::from_ptr(json).to_bytes()).unwrap();
        seen.items.push(value["kind"].as_str().unwrap().into());
    }
}

unsafe fn fixture() -> (*mut RuntimeHandle, *mut CAgent, Arc<EventQueue>) {
    let runtime =
        boxlite::BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new("http://127.0.0.1:1"))
            .unwrap();
    let tokio_rt = Arc::new(
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap(),
    );
    let queue = Arc::new(EventQueue::new());
    let rt = Box::into_raw(Box::new(RuntimeHandle {
        runtime,
        tokio_rt: tokio_rt.clone(),
        queue: queue.clone(),
        liveness: Arc::new(RuntimeLiveness::new()),
    }));
    let agent = Box::into_raw(Box::new(CAgent {
        core: boxlite::agents::Agent::for_test(),
        runtime: tokio_rt,
        queue: queue.clone(),
    }));
    (rt, agent, queue)
}

unsafe fn open(agent: *mut CAgent, after: Option<&str>, seen: &mut EventsSeen) -> BoxliteErrorCode {
    let cursor = after.map(|s| CString::new(s).unwrap());
    let options = CAgentEventsOptions {
        after: cursor.as_ref().map_or(ptr::null(), |s| s.as_ptr()),
    };
    boxlite_agent_events(
        agent,
        &options,
        Some(opened),
        Some(event),
        seen as *mut _ as *mut c_void,
        ptr::null_mut(),
    )
}

unsafe fn drain_until(
    rt: *mut RuntimeHandle,
    seen: *mut EventsSeen,
    predicate: impl Fn(&EventsSeen) -> bool,
) {
    for _ in 0..100 {
        if predicate(&*seen) {
            return;
        }
        assert!(crate::boxlite_runtime_drain(rt, 100, ptr::null_mut()) >= 0);
    }
    panic!("subscription callback not delivered");
}

#[test]
fn subscription_open_and_natural_end() {
    unsafe {
        let (rt, agent, _) = fixture();
        let mut seen = EventsSeen::default();
        assert_eq!(open(agent, None, &mut seen), BoxliteErrorCode::Ok);
        assert!(!seen.opened);
        drain_until(rt, &mut seen, |s| s.terminal == 1);
        assert!(seen.opened && !seen.handle.is_null());
        assert!(seen.open_error.is_none() && seen.terminal_error.is_none());
        boxlite_agent_events_free(seen.handle);
        boxlite_agent_free(agent);
        crate::boxlite_runtime_free(rt);
    }
}

#[test]
fn subscription_open_failure_has_no_terminal_callback() {
    unsafe {
        let (rt, agent, _) = fixture();
        let mut seen = EventsSeen::default();
        assert_eq!(
            open(agent, Some("open-error"), &mut seen),
            BoxliteErrorCode::Ok
        );
        drain_until(rt, &mut seen, |s| s.opened);
        assert!(seen.handle.is_null());
        assert_eq!(seen.open_error, Some(BoxliteErrorCode::Network));
        assert_eq!(seen.terminal, 0);
        boxlite_agent_free(agent);
        crate::boxlite_runtime_free(rt);
    }
}

#[test]
fn subscription_read_error_follows_events_once() {
    unsafe {
        let (rt, agent, _) = fixture();
        let mut seen = EventsSeen::default();
        assert_eq!(
            open(agent, Some("read-error"), &mut seen),
            BoxliteErrorCode::Ok
        );
        drain_until(rt, &mut seen, |s| s.terminal == 1);
        assert_eq!(seen.items, ["first"]);
        assert_eq!(seen.terminal_error, Some(BoxliteErrorCode::Network));
        boxlite_agent_events_free(seen.handle);
        assert_eq!(crate::boxlite_runtime_drain(rt, 0, ptr::null_mut()), 0);
        assert_eq!(seen.terminal, 1);
        boxlite_agent_free(agent);
        crate::boxlite_runtime_free(rt);
    }
}

#[test]
fn subscription_free_on_drainer_does_not_wait_for_full_queue() {
    unsafe {
        let (rt, agent, queue) = fixture();
        let mut seen = EventsSeen {
            queue: Some(queue),
            fill_and_free: true,
            ..Default::default()
        };
        assert_eq!(
            open(agent, Some("pending"), &mut seen),
            BoxliteErrorCode::Ok
        );
        drain_until(rt, &mut seen, |s| s.terminal == 1);
        assert!(seen.opened && seen.handle.is_null());
        assert!(seen.terminal_error.is_none());
        assert_eq!(seen.terminal, 1);
        boxlite_agent_free(agent);
        crate::boxlite_runtime_free(rt);
    }
}

#[test]
fn subscription_queued_events_precede_terminal_after_free() {
    unsafe {
        let (rt, agent, queue) = fixture();
        let mut seen = EventsSeen {
            queue: Some(queue),
            wait_for_events_and_free: true,
            ..Default::default()
        };
        assert_eq!(open(agent, Some("events"), &mut seen), BoxliteErrorCode::Ok);
        drain_until(rt, &mut seen, |s| s.terminal == 1);
        assert!(seen.handle.is_null(), "events were not queued before free");
        assert_eq!(seen.items, ["first", "second"]);
        assert!(!seen.order_violation);
        assert!(seen.terminal_error.is_none());
        boxlite_agent_free(agent);
        crate::boxlite_runtime_free(rt);
    }
}

#[test]
fn turn_subscription_opens_and_ends() {
    unsafe {
        let (rt, agent, queue) = fixture();
        let core = (*agent).core.clone();
        let turn_core = (*agent)
            .runtime
            .block_on(core.send("hello", Default::default()))
            .unwrap();
        let turn = Box::into_raw(Box::new(CAgentTurn {
            core: turn_core,
            runtime: (*agent).runtime.clone(),
            queue,
        }));
        let mut seen = EventsSeen::default();
        assert_eq!(
            boxlite_agent_turn_events(
                turn,
                ptr::null(),
                Some(opened),
                Some(event),
                &mut seen as *mut _ as *mut c_void,
                ptr::null_mut()
            ),
            BoxliteErrorCode::Ok
        );
        drain_until(rt, &mut seen, |s| s.terminal == 1);
        assert!(seen.opened && !seen.handle.is_null());
        assert!(!seen.order_violation);
        boxlite_agent_events_free(seen.handle);
        boxlite_agent_turn_free(turn);
        boxlite_agent_free(agent);
        crate::boxlite_runtime_free(rt);
    }
}

#[test]
fn subscription_rejects_invalid_arguments_without_queueing() {
    unsafe {
        let (rt, agent, _) = fixture();
        let mut seen = EventsSeen::default();
        let data = &mut seen as *mut _ as *mut c_void;
        assert_eq!(
            boxlite_agent_events(agent, ptr::null(), None, Some(event), data, ptr::null_mut()),
            BoxliteErrorCode::InvalidArgument
        );
        assert_eq!(
            boxlite_agent_events(
                agent,
                ptr::null(),
                Some(opened),
                None,
                data,
                ptr::null_mut()
            ),
            BoxliteErrorCode::InvalidArgument
        );
        let invalid = [0xff_u8, 0];
        let options = CAgentEventsOptions {
            after: invalid.as_ptr() as *const c_char,
        };
        assert_eq!(
            boxlite_agent_events(
                agent,
                &options,
                Some(opened),
                Some(event),
                data,
                ptr::null_mut()
            ),
            BoxliteErrorCode::InvalidArgument
        );
        assert_eq!(crate::boxlite_runtime_drain(rt, 0, ptr::null_mut()), 0);
        assert!(!seen.opened && seen.terminal == 0);
        boxlite_agent_free(agent);
        crate::boxlite_runtime_free(rt);
    }
}

#[test]
fn runtime_free_discards_queued_open_callback() {
    unsafe {
        let (rt, agent, queue) = fixture();
        let mut seen = EventsSeen::default();
        struct DropProbe(std::sync::mpsc::Sender<()>);
        impl Drop for DropProbe {
            fn drop(&mut self) {
                let _ = self.0.send(());
            }
        }
        impl futures::Stream for DropProbe {
            type Item = Result<boxlite::agents::AgentEvent, BoxliteError>;
            fn poll_next(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Option<Self::Item>> {
                std::task::Poll::Pending
            }
        }
        let (dropped, observed) = std::sync::mpsc::channel();
        let data = &mut seen as *mut EventsSeen as usize;
        open_subscription(
            (*agent).runtime.clone(),
            queue.clone(),
            async move { Ok(Box::pin(DropProbe(dropped)) as boxlite::agents::AgentEventStream) },
            opened,
            event,
            data,
        );
        let mut pending = queue.inner.lock().unwrap();
        while pending.is_empty() {
            let (next, timeout) = queue
                .cv
                .wait_timeout(pending, Duration::from_secs(5))
                .unwrap();
            pending = next;
            assert!(!timeout.timed_out(), "open callback was not queued");
        }
        drop(pending);
        crate::boxlite_runtime_free(rt);
        assert!(!seen.opened && seen.terminal == 0);
        assert!(queue.is_closed());
        observed
            .recv_timeout(Duration::from_secs(5))
            .expect("stream must be dropped");
        boxlite_agent_free(agent);
    }
}

#[test]
fn runtime_free_cancels_pending_open_without_callback() {
    unsafe {
        struct OpenDrop(std::sync::mpsc::Sender<()>);
        impl Drop for OpenDrop {
            fn drop(&mut self) {
                let _ = self.0.send(());
            }
        }
        let (rt, agent, queue) = fixture();
        let mut seen = EventsSeen::default();
        let data = &mut seen as *mut EventsSeen as usize;
        let (started, did_start) = std::sync::mpsc::channel();
        let (dropped, observed_drop) = std::sync::mpsc::channel();
        let (release, wait) = tokio::sync::oneshot::channel::<()>();
        open_subscription(
            (*agent).runtime.clone(),
            queue,
            async move {
                let _drop = OpenDrop(dropped);
                started.send(()).unwrap();
                let _ = wait.await;
                Ok(Box::pin(futures::stream::empty()) as boxlite::agents::AgentEventStream)
            },
            opened,
            event,
            data,
        );
        did_start
            .recv_timeout(Duration::from_secs(5))
            .expect("open must start");
        crate::boxlite_runtime_free(rt);
        observed_drop
            .recv_timeout(Duration::from_secs(5))
            .expect("open future must be dropped");
        assert!(release.send(()).is_err());
        assert!(!seen.opened && seen.terminal == 0);
        boxlite_agent_free(agent);
    }
}

#[test]
fn subscription_free_after_queued_read_error_does_not_duplicate_terminal() {
    unsafe {
        let (rt, agent, queue) = fixture();
        let mut seen = EventsSeen {
            queue: Some(queue),
            wait_for_events_and_free: true,
            ..Default::default()
        };
        assert_eq!(
            open(agent, Some("read-error"), &mut seen),
            BoxliteErrorCode::Ok
        );
        drain_until(rt, &mut seen, |s| s.terminal == 1);
        assert!(
            seen.handle.is_null(),
            "read error was not queued before free"
        );
        assert_eq!(seen.items, ["first"]);
        assert_eq!(seen.terminal_error, Some(BoxliteErrorCode::Network));
        assert_eq!(crate::boxlite_runtime_drain(rt, 0, ptr::null_mut()), 0);
        assert_eq!(seen.terminal, 1);
        boxlite_agent_free(agent);
        crate::boxlite_runtime_free(rt);
    }
}

#[test]
fn separate_runtimes_can_dispatch_callbacks_concurrently() {
    let rendezvous = Arc::new((std::sync::Mutex::new(0), std::sync::Condvar::new()));
    let threads: Vec<_> = (0..2)
        .map(|_| {
            let rendezvous = rendezvous.clone();
            std::thread::spawn(move || unsafe {
                let (rt, agent, _) = fixture();
                let mut seen = EventsSeen {
                    rendezvous: Some(rendezvous),
                    ..Default::default()
                };
                assert_eq!(
                    open(agent, Some("pending"), &mut seen),
                    BoxliteErrorCode::Ok
                );
                drain_until(rt, &mut seen, |s| s.opened);
                assert!(
                    seen.simultaneous,
                    "other runtime callback did not run concurrently"
                );
                boxlite_agent_events_free(seen.handle);
                drain_until(rt, &mut seen, |s| s.terminal == 1);
                boxlite_agent_free(agent);
                crate::boxlite_runtime_free(rt);
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
}

#[test]
fn single_drainer_serializes_open_events_and_terminal() {
    use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};

    struct OrderProbe {
        queue: Arc<EventQueue>,
        callback_active: AtomicBool,
        overlap: AtomicBool,
        wrong_thread: AtomicBool,
        owner: std::thread::ThreadId,
        two_queued: AtomicBool,
        order: std::sync::Mutex<Vec<&'static str>>,
        handle: AtomicPtr<CAgentEvents>,
    }
    unsafe extern "C" fn open_callback(
        handle: *mut CAgentEvents,
        error: *const CBoxliteError,
        data: *mut c_void,
    ) {
        let probe = &*(data as *const OrderProbe);
        let owns_slot = !probe.callback_active.swap(true, Ordering::SeqCst);
        if !owns_slot {
            probe.overlap.store(true, Ordering::SeqCst);
        }
        if std::thread::current().id() != probe.owner {
            probe.wrong_thread.store(true, Ordering::SeqCst);
        }
        probe.order.lock().unwrap().push("open-enter");
        probe.handle.store(handle, Ordering::SeqCst);
        if !error.is_null() {
            probe.order.lock().unwrap().push("open-error");
        }
        let pending = probe.queue.inner.lock().unwrap();
        let (pending, _) = probe
            .queue
            .cv
            .wait_timeout_while(pending, Duration::from_secs(5), |q| q.len() < 2)
            .unwrap();
        probe.two_queued.store(pending.len() >= 2, Ordering::SeqCst);
        drop(pending);
        probe.order.lock().unwrap().push("open-exit");
        if owns_slot {
            probe.callback_active.store(false, Ordering::SeqCst);
        }
    }
    unsafe extern "C" fn event_callback(
        json: *const c_char,
        error: *const CBoxliteError,
        data: *mut c_void,
    ) {
        let probe = &*(data as *const OrderProbe);
        let owns_slot = !probe.callback_active.swap(true, Ordering::SeqCst);
        if !owns_slot {
            probe.overlap.store(true, Ordering::SeqCst);
        }
        if std::thread::current().id() != probe.owner {
            probe.wrong_thread.store(true, Ordering::SeqCst);
        }
        let mut order = probe.order.lock().unwrap();
        if json.is_null() {
            order.push("terminal-enter");
            if error.is_null() {
                order.push("missing-read-error");
            }
            order.push("terminal-exit");
        } else {
            order.push("event-enter");
            order.push("event-exit");
        }
        if owns_slot {
            probe.callback_active.store(false, Ordering::SeqCst);
        }
    }

    unsafe {
        let (runtime, agent, queue) = fixture();
        let cursor = CString::new("read-error").unwrap();
        let options = CAgentEventsOptions {
            after: cursor.as_ptr(),
        };
        let probe = OrderProbe {
            queue,
            callback_active: AtomicBool::new(false),
            overlap: AtomicBool::new(false),
            wrong_thread: AtomicBool::new(false),
            owner: std::thread::current().id(),
            two_queued: AtomicBool::new(false),
            order: std::sync::Mutex::new(Vec::new()),
            handle: AtomicPtr::new(ptr::null_mut()),
        };
        assert_eq!(
            boxlite_agent_events(
                agent,
                &options,
                Some(open_callback),
                Some(event_callback),
                &probe as *const _ as *mut c_void,
                ptr::null_mut()
            ),
            BoxliteErrorCode::Ok
        );
        for _ in 0..100 {
            if probe.order.lock().unwrap().last() == Some(&"terminal-exit") {
                break;
            }
            assert!(crate::boxlite_runtime_drain(runtime, 100, ptr::null_mut()) >= 0);
        }
        assert!(
            probe.two_queued.load(Ordering::SeqCst),
            "event and terminal must be queued while on_open is active"
        );
        assert!(
            !probe.overlap.load(Ordering::SeqCst) && !probe.wrong_thread.load(Ordering::SeqCst)
        );
        assert_eq!(
            *probe.order.lock().unwrap(),
            [
                "open-enter",
                "open-exit",
                "event-enter",
                "event-exit",
                "terminal-enter",
                "terminal-exit"
            ]
        );
        boxlite_agent_events_free(probe.handle.load(Ordering::SeqCst));
        boxlite_agent_free(agent);
        crate::boxlite_runtime_free(runtime);
    }
}
