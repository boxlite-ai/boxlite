//! Agents, turns, and event subscriptions.

use std::ffi::{CStr, c_char, c_void};
use std::future::Future;
use std::ptr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::StreamExt;

use boxlite::BoxliteError;

use crate::error::{BoxliteErrorCode, error_to_code, null_pointer_error, write_error};
use crate::event_queue::{EventQueue, RuntimeEvent, push_event};
use crate::{CBoxHandle, CBoxliteError};
use tokio::runtime::Runtime as TokioRuntime;

#[cfg(feature = "test-support")]
#[path = "agents/tests/go_support.rs"]
mod go_test_support;

/// Box-owned namespace; release with boxlite_agents_free.
pub struct CAgents {
    core: boxlite::Agents,
    runtime: Arc<TokioRuntime>,
    queue: Arc<EventQueue>,
}
/// Agent instance handle.
pub struct CAgent {
    core: boxlite::agents::Agent,
    runtime: Arc<TokioRuntime>,
    queue: Arc<EventQueue>,
}
/// Agent turn handle.
pub struct CAgentTurn {
    core: boxlite::agents::AgentTurn,
    runtime: Arc<TokioRuntime>,
    queue: Arc<EventQueue>,
}
/// Event subscription. Freeing it does not cancel agent work.
pub struct CAgentEvents {
    cancel: Arc<SubscriptionCancel>,
}

struct SubscriptionCancel {
    cancelled: AtomicBool,
    notify: tokio::sync::Notify,
}

impl Drop for CAgentEvents {
    fn drop(&mut self) {
        self.cancel.cancelled.store(true, Ordering::Release);
        self.cancel.notify.notify_one();
    }
}

/// Initial agent settings. Null strings mean omitted; config_json uses the
/// AgentConfig keys documented in docs/reference/agents.md.
#[repr(C)]
#[derive(Debug)]
pub struct CAgentCreateOptions {
    pub cwd: *const c_char,
    pub config_json: *const c_char,
    pub idempotency_key: *const c_char,
}

/// Admission modes; zero-initialized options select queue.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub enum CAgentSendMode {
    AgentSendQueue = 0,
    AgentSendReject = 1,
}

/// Optional JSON accompanies positional message text.
#[repr(C)]
#[derive(Debug)]
pub struct CAgentSendOptions {
    pub mode: i32,
    pub data_json: *const c_char,
    pub idempotency_key: *const c_char,
}

/// Shared retry identity for close, reply, steering and interruption.
#[repr(C)]
#[derive(Debug)]
pub struct CAgentControlOptions {
    pub idempotency_key: *const c_char,
}

/// Timeout in seconds; negative or a null options pointer means no deadline.
#[repr(C)]
#[derive(Debug)]
pub struct CAgentWaitOptions {
    pub timeout_seconds: f64,
}

/// Resume after an opaque cursor; null means no cursor.
#[repr(C)]
#[derive(Debug)]
pub struct CAgentEventsOptions {
    pub after: *const c_char,
}

/// On success, receives an owned agent; release it with boxlite_agent_free.
/// The error pointer is borrowed for callback dispatch only.
pub type CAgentCb = Option<unsafe extern "C" fn(*mut CAgent, *const CBoxliteError, *mut c_void)>;
/// On success, receives an owned turn; release it with boxlite_agent_turn_free.
/// The error pointer is borrowed for callback dispatch only.
pub type CAgentTurnCb =
    Option<unsafe extern "C" fn(*mut CAgentTurn, *const CBoxliteError, *mut c_void)>;
/// JSON and error pointers are borrowed for callback dispatch only.
/// For event subscriptions, a null JSON pointer ends the stream exactly once.
/// Copy their contents to retain them after the callback returns.
pub type CAgentJsonCb =
    Option<unsafe extern "C" fn(*const c_char, *const CBoxliteError, *mut c_void)>;
/// The error pointer is borrowed for callback dispatch only.
pub type CAgentDoneCb = Option<unsafe extern "C" fn(*const CBoxliteError, *mut c_void)>;
/// On success, receives an owned subscription; release it with boxlite_agent_events_free.
pub type CAgentEventsOpenCb =
    Option<unsafe extern "C" fn(*mut CAgentEvents, *const CBoxliteError, *mut c_void)>;

macro_rules! checked {
    ($result:expr, $out_error:expr) => {
        match $result {
            Ok(value) => value,
            Err(error) => {
                let code = error_to_code(&error);
                write_error($out_error, error);
                return code;
            }
        }
    };
}

unsafe fn required_string(value: *const c_char, name: &str) -> Result<String, BoxliteError> {
    if value.is_null() {
        return Err(null_pointer_error(name));
    }
    CStr::from_ptr(value)
        .to_str()
        .map(str::to_owned)
        .map_err(|_| BoxliteError::InvalidArgument(format!("{name} is not valid UTF-8")))
}

unsafe fn optional_string(
    value: *const c_char,
    name: &str,
) -> Result<Option<String>, BoxliteError> {
    if value.is_null() {
        Ok(None)
    } else {
        required_string(value, name).map(Some)
    }
}

unsafe fn control_options(
    options: *const CAgentControlOptions,
) -> Result<boxlite::agents::AgentControlOptions, BoxliteError> {
    Ok(boxlite::agents::AgentControlOptions {
        idempotency_key: match options.as_ref() {
            Some(options) => optional_string(options.idempotency_key, "idempotency_key")?,
            None => None,
        },
    })
}

fn schedule<T: Send + 'static>(
    runtime: Arc<TokioRuntime>,
    queue: Arc<EventQueue>,
    task: impl Future<Output = Result<T, BoxliteError>> + Send + 'static,
    callback: impl FnOnce(Result<T, BoxliteError>) + Send + 'static,
) {
    let task_runtime = runtime.clone();
    runtime.spawn(async move {
        let _guard = crate::archive::TokioRuntimeDropGuard::new(task_runtime);
        let result = task.await;
        push_event(
            &queue,
            RuntimeEvent::AgentCompletion(Box::new(move || callback(result))),
        )
        .await;
    });
}

unsafe fn deliver<T>(
    result: Result<T, BoxliteError>,
    callback: impl FnOnce(Option<T>, *const CBoxliteError),
) {
    match result {
        Ok(value) => callback(Some(value), ptr::null()),
        Err(error) => {
            let mut error = crate::error::error_to_c_error(error);
            callback(None, &error);
            crate::boxlite_error_free(&mut error);
        }
    }
}

unsafe fn deliver_json(
    result: Result<impl std::fmt::Display, BoxliteError>,
    callback: unsafe extern "C" fn(*const c_char, *const CBoxliteError, *mut c_void),
    data: usize,
) {
    deliver(result, |value, error| {
        let json =
            value.map(|value| std::ffi::CString::new(value.to_string()).expect("JSON escapes NUL"));
        callback(
            json.as_ref().map_or(ptr::null(), |value| value.as_ptr()),
            error,
            data as *mut c_void,
        );
    });
}

/// Obtain a namespace without starting the Box.
/// handle must be live; out must be writable; out_error may be null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_agents(
    handle: *mut CBoxHandle,
    out: *mut *mut CAgents,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if !out.is_null() {
        unsafe {
            *out = ptr::null_mut();
        }
    }
    if handle.is_null() || out.is_null() {
        unsafe {
            write_error(out_error, null_pointer_error("handle or out"));
        }
        return BoxliteErrorCode::InvalidArgument;
    }
    unsafe {
        *out = Box::into_raw(Box::new(CAgents {
            core: (*handle).handle.agents(),
            runtime: (*handle).tokio_rt.clone(),
            queue: (*handle).queue.clone(),
        }));
    }
    BoxliteErrorCode::Ok
}

/// Create an agent with initial configuration.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agents_create(
    handle_arg: *mut CAgents,
    agent_arg: *const c_char,
    options_arg: *const CAgentCreateOptions,
    callback_arg: CAgentCb,
    user_data_arg: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if handle_arg.is_null() || agent_arg.is_null() || callback_arg.is_none() {
            write_error(out_error, null_pointer_error("handle, agent or callback"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let parse = |value: *const c_char| -> Result<Option<String>, BoxliteError> {
            if value.is_null() {
                return Ok(None);
            }
            CStr::from_ptr(value)
                .to_str()
                .map(|s| Some(s.to_owned()))
                .map_err(|_| BoxliteError::InvalidArgument("string is not valid UTF-8".into()))
        };
        let inputs = (|| {
            let agent = parse(agent_arg)?.expect("agent checked above");
            let mut options = boxlite::agents::AgentCreateOptions::default();
            if let Some(input) = options_arg.as_ref() {
                options.cwd = parse(input.cwd)?;
                options.idempotency_key = parse(input.idempotency_key)?;
                if let Some(json) = parse(input.config_json)? {
                    let value = serde_json::from_str(&json)
                        .map_err(|e| BoxliteError::InvalidArgument(e.to_string()))?;
                    options.config = boxlite::agents::records::parse_config(value)?;
                }
            }
            Ok::<_, BoxliteError>((agent, options))
        })();
        let (agent, options) = match inputs {
            Ok(inputs) => inputs,
            Err(error) => {
                let code = error_to_code(&error);
                write_error(out_error, error);
                return code;
            }
        };
        let namespace = &*handle_arg;
        let core = namespace.core.clone();
        let runtime = namespace.runtime.clone();
        let queue = namespace.queue.clone();
        let result_runtime = runtime.clone();
        let result_queue = queue.clone();
        let callback = callback_arg.unwrap();
        let user_data = user_data_arg as usize;
        runtime.spawn(async move {
            let guard = crate::archive::TokioRuntimeDropGuard::new(result_runtime.clone());
            let result = core.create(&agent, options).await.map(|core| CAgent {
                core,
                runtime: result_runtime,
                queue: result_queue,
            });
            push_event(
                &queue,
                RuntimeEvent::AgentCreate {
                    callback,
                    user_data,
                    result,
                },
            )
            .await;
            drop(guard);
        });
        BoxliteErrorCode::Ok
    }
}

/// Look up an agent without replaying work.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agents_get(
    handle_arg: *mut CAgents,
    agent_id_arg: *const c_char,
    callback_arg: CAgentCb,
    user_data_arg: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if handle_arg.is_null() || callback_arg.is_none() {
            write_error(out_error, null_pointer_error("handle or callback"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let id = checked!(required_string(agent_id_arg, "agent_id"), out_error);
        let handle = &*handle_arg;
        let core = handle.core.clone();
        let runtime = handle.runtime.clone();
        let queue = handle.queue.clone();
        let callback_runtime = runtime.clone();
        let callback_queue = queue.clone();
        let callback = callback_arg.unwrap();
        let data = user_data_arg as usize;
        schedule(
            runtime,
            queue,
            async move { core.get(&id).await },
            move |result| {
                deliver(result, |agent, error| {
                    let agent = agent
                        .map(|core| {
                            Box::into_raw(Box::new(CAgent {
                                core,
                                runtime: callback_runtime,
                                queue: callback_queue,
                            }))
                        })
                        .unwrap_or(ptr::null_mut());
                    callback(agent, error, data as *mut c_void);
                });
            },
        );
        BoxliteErrorCode::Ok
    }
}

/// Stop admissions and close the agent loop.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_close(
    agent_arg: *mut CAgent,
    options_arg: *const CAgentControlOptions,
    callback_arg: CAgentDoneCb,
    user_data_arg: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if agent_arg.is_null() || callback_arg.is_none() {
            write_error(out_error, null_pointer_error("agent or callback"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let options = checked!(control_options(options_arg), out_error);
        let handle = &*agent_arg;
        let core = handle.core.clone();
        let callback = callback_arg.unwrap();
        let data = user_data_arg as usize;
        schedule(
            handle.runtime.clone(),
            handle.queue.clone(),
            async move { core.close(options).await },
            move |result| {
                deliver(result, |_, error| callback(error, data as *mut c_void));
            },
        );
        BoxliteErrorCode::Ok
    }
}

/// Submit text with optional JSON data.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_send(
    agent_arg: *mut CAgent,
    text_arg: *const c_char,
    options_arg: *const CAgentSendOptions,
    callback_arg: CAgentTurnCb,
    user_data_arg: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if agent_arg.is_null() || callback_arg.is_none() {
            write_error(out_error, null_pointer_error("agent or callback"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let text = checked!(required_string(text_arg, "text"), out_error);
        let mut options = boxlite::agents::AgentSendOptions::default();
        if let Some(input) = options_arg.as_ref() {
            options.mode = checked!(
                match input.mode {
                    0 => Ok(boxlite::agents::AgentSendMode::Queue),
                    1 => Ok(boxlite::agents::AgentSendMode::Reject),
                    _ => Err(BoxliteError::InvalidArgument("invalid send mode".into())),
                },
                out_error
            );
            options.idempotency_key = checked!(
                optional_string(input.idempotency_key, "idempotency_key"),
                out_error
            );
            if let Some(json) = checked!(optional_string(input.data_json, "data_json"), out_error) {
                options.data = Some(checked!(
                    serde_json::from_str(&json)
                        .map_err(|e| BoxliteError::InvalidArgument(e.to_string())),
                    out_error
                ));
            }
        }
        let handle = &*agent_arg;
        let core = handle.core.clone();
        let runtime = handle.runtime.clone();
        let queue = handle.queue.clone();
        let callback_runtime = runtime.clone();
        let callback_queue = queue.clone();
        let callback = callback_arg.unwrap();
        let data = user_data_arg as usize;
        schedule(
            runtime,
            queue,
            async move { core.send(&text, options).await },
            move |result| {
                deliver(result, |turn, error| {
                    let turn = turn
                        .map(|core| {
                            Box::into_raw(Box::new(CAgentTurn {
                                core,
                                runtime: callback_runtime,
                                queue: callback_queue,
                            }))
                        })
                        .unwrap_or(ptr::null_mut());
                    callback(turn, error, data as *mut c_void);
                });
            },
        );
        BoxliteErrorCode::Ok
    }
}

/// Look up a turn without executing it.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_get_turn(
    agent_arg: *mut CAgent,
    turn_id_arg: *const c_char,
    callback_arg: CAgentTurnCb,
    user_data_arg: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if agent_arg.is_null() || callback_arg.is_none() {
            write_error(out_error, null_pointer_error("agent or callback"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let id = checked!(required_string(turn_id_arg, "turn_id"), out_error);
        let handle = &*agent_arg;
        let core = handle.core.clone();
        let runtime = handle.runtime.clone();
        let queue = handle.queue.clone();
        let callback_runtime = runtime.clone();
        let callback_queue = queue.clone();
        let callback = callback_arg.unwrap();
        let data = user_data_arg as usize;
        schedule(
            runtime,
            queue,
            async move { core.get_turn(&id).await },
            move |result| {
                deliver(result, |turn, error| {
                    let turn = turn
                        .map(|core| {
                            Box::into_raw(Box::new(CAgentTurn {
                                core,
                                runtime: callback_runtime,
                                queue: callback_queue,
                            }))
                        })
                        .unwrap_or(ptr::null_mut());
                    callback(turn, error, data as *mut c_void);
                });
            },
        );
        BoxliteErrorCode::Ok
    }
}

/// Read outstanding questions and permissions.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_requests(
    agent_arg: *mut CAgent,
    callback_arg: CAgentJsonCb,
    user_data_arg: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if agent_arg.is_null() || callback_arg.is_none() {
            write_error(out_error, null_pointer_error("agent or callback"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let handle = &*agent_arg;
        let core = handle.core.clone();
        let callback = callback_arg.unwrap();
        let data = user_data_arg as usize;
        schedule(
            handle.runtime.clone(),
            handle.queue.clone(),
            async move {
                core.requests()
                    .await
                    .map(|v| boxlite::agents::records::requests(&v))
            },
            move |result| {
                deliver_json(result, callback, data);
            },
        );
        BoxliteErrorCode::Ok
    }
}

/// Answer a typed request.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_respond(
    agent_arg: *mut CAgent,
    request_id_arg: *const c_char,
    response_json_arg: *const c_char,
    options_arg: *const CAgentControlOptions,
    callback_arg: CAgentTurnCb,
    user_data_arg: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if agent_arg.is_null() || callback_arg.is_none() {
            write_error(out_error, null_pointer_error("agent or callback"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let id = checked!(required_string(request_id_arg, "request_id"), out_error);
        let json = checked!(
            required_string(response_json_arg, "response_json"),
            out_error
        );
        let response = checked!(boxlite::agents::records::parse_response(&json), out_error);
        let options = checked!(control_options(options_arg), out_error);
        let handle = &*agent_arg;
        let core = handle.core.clone();
        let runtime = handle.runtime.clone();
        let queue = handle.queue.clone();
        let callback_runtime = runtime.clone();
        let callback_queue = queue.clone();
        let callback = callback_arg.unwrap();
        let data = user_data_arg as usize;
        schedule(
            runtime,
            queue,
            async move { core.respond(&id, response, options).await },
            move |result| {
                deliver(result, |turn, error| {
                    let turn = turn
                        .map(|core| {
                            Box::into_raw(Box::new(CAgentTurn {
                                core,
                                runtime: callback_runtime,
                                queue: callback_queue,
                            }))
                        })
                        .unwrap_or(ptr::null_mut());
                    callback(turn, error, data as *mut c_void);
                });
            },
        );
        BoxliteErrorCode::Ok
    }
}

/// Wait for a turn result; timeout does not imply cancellation.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_turn_wait(
    turn_arg: *mut CAgentTurn,
    options_arg: *const CAgentWaitOptions,
    callback_arg: CAgentJsonCb,
    user_data_arg: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if turn_arg.is_null() || callback_arg.is_none() {
            write_error(out_error, null_pointer_error("turn or callback"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let mut options = boxlite::agents::AgentWaitOptions::default();
        if let Some(input) = options_arg.as_ref() {
            if input.timeout_seconds >= 0.0 {
                options.timeout = Some(checked!(
                    std::time::Duration::try_from_secs_f64(input.timeout_seconds)
                        .map_err(|e| BoxliteError::InvalidArgument(e.to_string())),
                    out_error
                ));
            } else if input.timeout_seconds.is_nan() {
                write_error(
                    out_error,
                    BoxliteError::InvalidArgument("timeout is NaN".into()),
                );
                return BoxliteErrorCode::InvalidArgument;
            }
        }
        let handle = &*turn_arg;
        let core = handle.core.clone();
        let callback = callback_arg.unwrap();
        let data = user_data_arg as usize;
        schedule(
            handle.runtime.clone(),
            handle.queue.clone(),
            async move {
                core.wait(options)
                    .await
                    .map(|v| boxlite::agents::records::result(&v))
            },
            move |result| deliver_json(result, callback, data),
        );
        BoxliteErrorCode::Ok
    }
}

/// Steer this turn without submitting another turn.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_turn_steer(
    turn_arg: *mut CAgentTurn,
    text_arg: *const c_char,
    options_arg: *const CAgentControlOptions,
    callback_arg: CAgentJsonCb,
    user_data_arg: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if turn_arg.is_null() || callback_arg.is_none() {
            write_error(out_error, null_pointer_error("turn or callback"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let text = checked!(required_string(text_arg, "text"), out_error);
        let options = checked!(control_options(options_arg), out_error);
        let handle = &*turn_arg;
        let core = handle.core.clone();
        let callback = callback_arg.unwrap();
        let data = user_data_arg as usize;
        schedule(
            handle.runtime.clone(),
            handle.queue.clone(),
            async move {
                core.steer(&text, options)
                    .await
                    .map(|v| boxlite::agents::records::receipt(&v))
            },
            move |result| deliver_json(result, callback, data),
        );
        BoxliteErrorCode::Ok
    }
}

/// Interrupt the agent loop for this turn.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_turn_interrupt(
    turn_arg: *mut CAgentTurn,
    options_arg: *const CAgentControlOptions,
    callback_arg: CAgentDoneCb,
    user_data_arg: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if turn_arg.is_null() || callback_arg.is_none() {
            write_error(out_error, null_pointer_error("turn or callback"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let options = checked!(control_options(options_arg), out_error);
        let handle = &*turn_arg;
        let core = handle.core.clone();
        let callback = callback_arg.unwrap();
        let data = user_data_arg as usize;
        schedule(
            handle.runtime.clone(),
            handle.queue.clone(),
            async move { core.interrupt(options).await },
            move |result| deliver(result, |_, error| callback(error, data as *mut c_void)),
        );
        BoxliteErrorCode::Ok
    }
}

/// Open events; on_open receives the handle after the stream is connected.
/// Keep user_data alive until the terminal on_event returns, or on_open on failure.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_events(
    handle: *mut CAgent,
    options: *const CAgentEventsOptions,
    on_open: CAgentEventsOpenCb,
    on_event: CAgentJsonCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() || on_open.is_none() || on_event.is_none() {
            write_error(out_error, null_pointer_error("handle, on_open or on_event"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let options = checked!(events_options(options), out_error);
        let handle = &*handle;
        let core = handle.core.clone();
        open_subscription(
            handle.runtime.clone(),
            handle.queue.clone(),
            async move { core.events(options).await },
            on_open.unwrap(),
            on_event.unwrap(),
            user_data as usize,
        );
        BoxliteErrorCode::Ok
    }
}

/// Open this turn's events; on_open receives the handle after connection.
/// Keep user_data alive until the terminal on_event returns, or on_open on failure.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_turn_events(
    handle: *mut CAgentTurn,
    options: *const CAgentEventsOptions,
    on_open: CAgentEventsOpenCb,
    on_event: CAgentJsonCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() || on_open.is_none() || on_event.is_none() {
            write_error(out_error, null_pointer_error("handle, on_open or on_event"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let options = checked!(events_options(options), out_error);
        let handle = &*handle;
        let core = handle.core.clone();
        open_subscription(
            handle.runtime.clone(),
            handle.queue.clone(),
            async move { core.events(options).await },
            on_open.unwrap(),
            on_event.unwrap(),
            user_data as usize,
        );
        BoxliteErrorCode::Ok
    }
}

unsafe fn events_options(
    options: *const CAgentEventsOptions,
) -> Result<boxlite::agents::AgentEventsOptions, BoxliteError> {
    Ok(boxlite::agents::AgentEventsOptions {
        after: match options.as_ref() {
            Some(options) => optional_string(options.after, "after")?,
            None => None,
        },
    })
}

fn open_subscription(
    runtime: Arc<TokioRuntime>,
    queue: Arc<EventQueue>,
    open: impl Future<Output = Result<boxlite::agents::AgentEventStream, BoxliteError>> + Send + 'static,
    on_open: unsafe extern "C" fn(*mut CAgentEvents, *const CBoxliteError, *mut c_void),
    on_event: unsafe extern "C" fn(*const c_char, *const CBoxliteError, *mut c_void),
    data: usize,
) {
    let task_runtime = runtime.clone();
    let mut closed = queue.close_signal.subscribe();
    runtime.spawn(async move {
        let _guard = crate::archive::TokioRuntimeDropGuard::new(task_runtime);
        if *closed.borrow() {
            return;
        }
        let result = tokio::select! {
            result = open => result,
            _ = closed.changed() => return,
        };
        let mut stream = match result {
            Ok(stream) => stream,
            Err(error) => {
                push_event(
                    &queue,
                    RuntimeEvent::AgentCompletion(Box::new(move || unsafe {
                        deliver::<()>(Err(error), |_, error| {
                            on_open(ptr::null_mut(), error, data as *mut c_void)
                        });
                    })),
                )
                .await;
                return;
            }
        };
        let cancel = Arc::new(SubscriptionCancel {
            cancelled: AtomicBool::new(false),
            notify: tokio::sync::Notify::new(),
        });
        let handle = Box::new(CAgentEvents {
            cancel: cancel.clone(),
        });
        push_event(
            &queue,
            RuntimeEvent::AgentCompletion(Box::new(move || unsafe {
                on_open(Box::into_raw(handle), ptr::null(), data as *mut c_void);
            })),
        )
        .await;

        // One producer owns the stream and posts the terminal callback after
        // all earlier pushes finish; free only wakes it, even on a full queue.
        let terminal = loop {
            if cancel.cancelled.load(Ordering::Acquire) {
                break None;
            }
            if *closed.borrow() {
                return;
            }
            tokio::select! {
                _ = closed.changed() => return,
                _ = cancel.notify.notified() => break None,
                item = stream.next() => match item {
                    Some(Ok(event)) => {
                        let value = boxlite::agents::records::event(&event);
                        push_event(&queue, RuntimeEvent::AgentCompletion(Box::new(move || unsafe {
                            deliver_json(Ok(value), on_event, data);
                        }))).await;
                    }
                    Some(Err(error)) => break Some(error),
                    None => break None,
                }
            }
        };
        push_event(
            &queue,
            RuntimeEvent::AgentCompletion(Box::new(move || unsafe {
                match terminal {
                    Some(error) => deliver::<()>(Err(error), |_, error| {
                        on_event(ptr::null(), error, data as *mut c_void)
                    }),
                    None => on_event(ptr::null(), ptr::null(), data as *mut c_void),
                }
            })),
        )
        .await;
    });
}

/// Read a consistent agent state snapshot.
/// Release a returned JSON string with boxlite_free_string.
/// out_json and out_error may be null or writable. out_json is cleared on error.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_state(
    handle_arg: *mut CAgent,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        agent_getter(handle_arg, out_json, out_error, |agent| {
            agent
                .state()
                .map(|v| boxlite::agents::records::agent_state(&v))
        })
    }
}

/// Read effective agent configuration.
/// Release a returned JSON string with boxlite_free_string.
/// out_json and out_error may be null or writable. out_json is cleared on error.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_config(
    handle_arg: *mut CAgent,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        agent_getter(handle_arg, out_json, out_error, |agent| {
            agent.config().map(|v| boxlite::agents::records::config(&v))
        })
    }
}

/// Read adapter guarantees and limits.
/// Release a returned JSON string with boxlite_free_string.
/// out_json and out_error may be null or writable. out_json is cleared on error.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_capabilities(
    handle_arg: *mut CAgent,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        agent_getter(handle_arg, out_json, out_error, |agent| {
            agent
                .capabilities()
                .map(|v| boxlite::agents::records::capabilities(&v))
        })
    }
}

/// Read a consistent turn state snapshot.
/// Release a returned JSON string with boxlite_free_string.
/// out_json and out_error may be null or writable. out_json is cleared on error.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_turn_state(
    handle_arg: *mut CAgentTurn,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if !out_json.is_null() {
            *out_json = ptr::null_mut();
        }
        if handle_arg.is_null() || out_json.is_null() {
            write_error(out_error, null_pointer_error("handle or out_json"));
            return BoxliteErrorCode::InvalidArgument;
        }
        write_json(
            out_json,
            out_error,
            (*handle_arg)
                .core
                .state()
                .map(|v| boxlite::agents::records::turn_state(&v)),
        )
    }
}

unsafe fn agent_getter(
    handle: *mut CAgent,
    out: *mut *mut c_char,
    out_error: *mut CBoxliteError,
    get: impl FnOnce(&boxlite::agents::Agent) -> Result<serde_json::Value, BoxliteError>,
) -> BoxliteErrorCode {
    if !out.is_null() {
        *out = ptr::null_mut();
    }
    if handle.is_null() || out.is_null() {
        write_error(out_error, null_pointer_error("handle or out_json"));
        return BoxliteErrorCode::InvalidArgument;
    }
    write_json(out, out_error, get(&(*handle).core))
}

unsafe fn write_json(
    out: *mut *mut c_char,
    out_error: *mut CBoxliteError,
    value: Result<impl std::fmt::Display, BoxliteError>,
) -> BoxliteErrorCode {
    match value {
        Ok(value) => {
            *out = std::ffi::CString::new(value.to_string())
                .expect("JSON escapes NUL")
                .into_raw();
            BoxliteErrorCode::Ok
        }
        Err(error) => {
            let code = error_to_code(&error);
            write_error(out_error, error);
            code
        }
    }
}

/// Release only the local handle. Does not close an agent or interrupt a turn.
/// handle must be null or a live, uniquely owned pointer returned by this SDK.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agents_free(handle: *mut CAgents) {
    if !handle.is_null() {
        unsafe {
            drop(Box::from_raw(handle));
        }
    }
}

/// Release only the local handle. Does not close an agent or interrupt a turn.
/// handle must be null or a live, uniquely owned pointer returned by this SDK.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_free(handle: *mut CAgent) {
    if !handle.is_null() {
        #[cfg(feature = "test-support")]
        go_test_support::record_free(false);
        unsafe {
            drop(Box::from_raw(handle));
        }
    }
}

/// Release only the local handle. Does not close an agent or interrupt a turn.
/// handle must be null or a live, uniquely owned pointer returned by this SDK.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_turn_free(handle: *mut CAgentTurn) {
    if !handle.is_null() {
        #[cfg(feature = "test-support")]
        go_test_support::record_free(true);
        unsafe {
            drop(Box::from_raw(handle));
        }
    }
}

/// Signal cancellation without waiting. Queued events precede the terminal callback.
/// Keep user_data alive until that callback returns. Never interrupts agent work.
/// handle must be null or a live, uniquely owned pointer returned by this SDK.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_events_free(handle: *mut CAgentEvents) {
    if !handle.is_null() {
        unsafe {
            drop(Box::from_raw(handle));
        }
    }
}

#[cfg(test)]
mod tests;
