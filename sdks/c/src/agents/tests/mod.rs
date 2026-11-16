use super::*;
use crate::runtime::{RuntimeHandle, RuntimeLiveness};
use std::ffi::CString;

#[derive(Default)]
struct Seen {
    done: bool,
    agent: *mut CAgent,
    turn: *mut CAgentTurn,
    json: Option<serde_json::Value>,
}

unsafe extern "C" fn agent_cb(agent: *mut CAgent, error: *const CBoxliteError, data: *mut c_void) {
    assert!(error.is_null());
    let seen = &mut *(data as *mut Seen);
    seen.agent = agent;
    seen.done = true;
}
unsafe extern "C" fn turn_cb(
    turn: *mut CAgentTurn,
    error: *const CBoxliteError,
    data: *mut c_void,
) {
    assert!(error.is_null());
    let seen = &mut *(data as *mut Seen);
    seen.turn = turn;
    seen.done = true;
}
unsafe extern "C" fn json_cb(json: *const c_char, error: *const CBoxliteError, data: *mut c_void) {
    assert!(error.is_null());
    let seen = &mut *(data as *mut Seen);
    seen.json = Some(serde_json::from_slice(CStr::from_ptr(json).to_bytes()).unwrap());
    seen.done = true;
}
unsafe fn drain(runtime: *mut RuntimeHandle, seen: &mut Seen) {
    for _ in 0..100 {
        if seen.done {
            return;
        }
        assert!(crate::boxlite_runtime_drain(runtime, 100, ptr::null_mut()) >= 0);
    }
    panic!("callback not delivered");
}
unsafe fn read_getter(
    handle: *mut CAgent,
    getter: unsafe extern "C" fn(
        *mut CAgent,
        *mut *mut c_char,
        *mut CBoxliteError,
    ) -> BoxliteErrorCode,
) -> serde_json::Value {
    let mut json = ptr::null_mut();
    assert_eq!(
        getter(handle, &mut json, ptr::null_mut()),
        BoxliteErrorCode::Ok
    );
    let parsed = serde_json::from_slice(CStr::from_ptr(json).to_bytes()).unwrap();
    crate::boxlite_free_string(json);
    parsed
}
#[test]
fn c_calls_and_getters_reach_core_through_drain() {
    unsafe {
        let home = std::env::temp_dir().join(format!("boxlite-c-agents-{}", std::process::id()));
        let runtime = boxlite::BoxliteRuntime::new_for_test(boxlite::BoxliteOptions {
            home_dir: home.clone(),
            ..Default::default()
        })
        .unwrap();
        let tokio_rt = Arc::new(
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .unwrap(),
        );
        let sandbox = tokio_rt
            .block_on(runtime.create(
                boxlite::BoxOptions {
                    rootfs: boxlite::RootfsSpec::Image("alpine:latest".into()),
                    ..Default::default()
                },
                None,
            ))
            .unwrap();
        let queue = Arc::new(EventQueue::new());
        let runtime_ptr = Box::into_raw(Box::new(RuntimeHandle {
            runtime,
            tokio_rt: tokio_rt.clone(),
            queue: queue.clone(),
            liveness: Arc::new(RuntimeLiveness::new()),
        }));
        let agents = Box::into_raw(Box::new(CAgents {
            core: sandbox.agents().with_test_backend(),
            runtime: tokio_rt,
            queue,
        }));
        let mut seen = Seen::default();
        let data = &mut seen as *mut Seen as *mut c_void;
        let name = CString::new("test").unwrap();
        assert_eq!(
            boxlite_agents_create(
                agents,
                name.as_ptr(),
                ptr::null(),
                Some(agent_cb),
                data,
                ptr::null_mut()
            ),
            BoxliteErrorCode::Ok
        );
        assert!(!seen.done);
        drain(runtime_ptr, &mut seen);
        let agent = seen.agent;
        assert!(!agent.is_null());
        seen.done = false;
        let request_id = CString::new("request-1").unwrap();
        let malformed = CString::new("{invalid").unwrap();
        assert_eq!(
            boxlite_agent_respond(
                agent,
                request_id.as_ptr(),
                malformed.as_ptr(),
                ptr::null(),
                Some(turn_cb),
                data,
                ptr::null_mut()
            ),
            BoxliteErrorCode::InvalidArgument
        );
        assert_eq!(
            crate::boxlite_runtime_drain(runtime_ptr, 0, ptr::null_mut()),
            0
        );
        assert!(!seen.done);
        assert_eq!(read_getter(agent, boxlite_agent_state)["id"], "agent-1");
        assert_eq!(
            read_getter(agent, boxlite_agent_config)["tools"],
            serde_json::json!([])
        );
        assert_eq!(
            read_getter(agent, boxlite_agent_capabilities)["operations"],
            serde_json::json!(["agent.send"])
        );
        seen.done = false;
        let text = CString::new("hello").unwrap();
        #[repr(C)]
        struct RawSendOptions {
            mode: std::ffi::c_int,
            data_json: *const c_char,
            idempotency_key: *const c_char,
        }
        for mode in [-1, 2] {
            let invalid_options = RawSendOptions {
                mode,
                data_json: ptr::null(),
                idempotency_key: ptr::null(),
            };
            assert_eq!(
                boxlite_agent_send(
                    agent,
                    text.as_ptr(),
                    (&invalid_options as *const RawSendOptions).cast(),
                    Some(turn_cb),
                    data,
                    ptr::null_mut()
                ),
                BoxliteErrorCode::InvalidArgument
            );
            assert_eq!(
                crate::boxlite_runtime_drain(runtime_ptr, 0, ptr::null_mut()),
                0
            );
            assert!(!seen.done);
        }
        let reject_options = CAgentSendOptions {
            mode: 1,
            data_json: ptr::null(),
            idempotency_key: ptr::null(),
        };
        assert_eq!(
            boxlite_agent_send(
                agent,
                text.as_ptr(),
                &reject_options,
                Some(turn_cb),
                data,
                ptr::null_mut()
            ),
            BoxliteErrorCode::Ok
        );
        drain(runtime_ptr, &mut seen);
        boxlite_agent_turn_free(seen.turn);
        seen.done = false;
        assert_eq!(
            boxlite_agent_send(
                agent,
                text.as_ptr(),
                ptr::null(),
                Some(turn_cb),
                data,
                ptr::null_mut()
            ),
            BoxliteErrorCode::Ok
        );
        drain(runtime_ptr, &mut seen);
        let turn = seen.turn;
        assert!(!turn.is_null());
        let mut state = ptr::null_mut();
        assert_eq!(
            boxlite_agent_turn_state(turn, &mut state, ptr::null_mut()),
            BoxliteErrorCode::Ok
        );
        let state_json: serde_json::Value =
            serde_json::from_slice(CStr::from_ptr(state).to_bytes()).unwrap();
        assert_eq!(state_json["id"], "turn-1");
        crate::boxlite_free_string(state);
        seen.done = false;
        assert_eq!(
            boxlite_agent_turn_wait(turn, ptr::null(), Some(json_cb), data, ptr::null_mut()),
            BoxliteErrorCode::Ok
        );
        drain(runtime_ptr, &mut seen);
        assert_eq!(seen.json.take().unwrap()["text"], "hello");
        seen.done = false;
        let turn_id = CString::new("turn-1").unwrap();
        assert_eq!(
            boxlite_agent_get_turn(
                agent,
                turn_id.as_ptr(),
                Some(turn_cb),
                data,
                ptr::null_mut()
            ),
            BoxliteErrorCode::Ok
        );
        drain(runtime_ptr, &mut seen);
        boxlite_agent_turn_free(seen.turn);
        seen.done = false;
        assert_eq!(
            boxlite_agent_requests(agent, Some(json_cb), data, ptr::null_mut()),
            BoxliteErrorCode::Ok
        );
        drain(runtime_ptr, &mut seen);
        assert_eq!(seen.json.take().unwrap()[0]["id"], "request-1");
        seen.done = false;
        let request_id = CString::new("request-1").unwrap();
        let response = CString::new(r#"{"type":"answer","text":"yes"}"#).unwrap();
        assert_eq!(
            boxlite_agent_respond(
                agent,
                request_id.as_ptr(),
                response.as_ptr(),
                ptr::null(),
                Some(turn_cb),
                data,
                ptr::null_mut()
            ),
            BoxliteErrorCode::Ok
        );
        drain(runtime_ptr, &mut seen);
        boxlite_agent_turn_free(seen.turn);
        boxlite_agent_turn_free(turn);
        boxlite_agent_free(agent);
        boxlite_agents_free(agents);
        crate::boxlite_runtime_free(runtime_ptr);
        let _ = std::fs::remove_dir_all(home);
    }
}

mod subscriptions;

mod opencode_vm;
