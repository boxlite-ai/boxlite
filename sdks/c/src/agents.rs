//! Agents, turns, and journal subscriptions.

use std::ffi::{c_char, c_void};
use std::ptr;

use boxlite::BoxliteError;

use crate::error::{BoxliteErrorCode, null_pointer_error, write_error};
use crate::{CBoxHandle, CBoxliteError};

/// Box-owned namespace; release with boxlite_agents_free.
#[derive(Debug)]
pub struct CAgents {
    _core: boxlite::Agents,
}
/// Agent instance handle.
#[derive(Debug)]
pub struct CAgent {
    _private: (),
}
/// Agent turn handle.
#[derive(Debug)]
pub struct CAgentTurn {
    _private: (),
}
/// Journal subscription. Freeing it does not cancel agent work.
#[derive(Debug)]
pub struct CAgentEvents {
    _private: (),
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
    pub mode: CAgentSendMode,
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
/// Copy their contents to retain them after the callback returns.
pub type CAgentJsonCb =
    Option<unsafe extern "C" fn(*const c_char, *const CBoxliteError, *mut c_void)>;
/// The error pointer is borrowed for callback dispatch only.
pub type CAgentDoneCb = Option<unsafe extern "C" fn(*const CBoxliteError, *mut c_void)>;

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
            _core: (*handle).handle.agents(),
        }));
    }
    BoxliteErrorCode::Ok
}

/// Create an agent with initial configuration.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agents_create(
    _handle: *mut CAgents,
    _agent: *const c_char,
    _options: *const CAgentCreateOptions,
    _cb: CAgentCb,
    _user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { not_implemented("agents.create", out_error) }
}

/// Look up an agent without replaying work.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agents_get(
    _handle: *mut CAgents,
    _agent_id: *const c_char,
    _cb: CAgentCb,
    _user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { not_implemented("agents.get", out_error) }
}

/// Stop admissions and close the agent loop.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_close(
    _agent: *mut CAgent,
    _options: *const CAgentControlOptions,
    _cb: CAgentDoneCb,
    _user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { not_implemented("agent.close", out_error) }
}

/// Submit text with optional JSON data.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_send(
    _agent: *mut CAgent,
    _text: *const c_char,
    _options: *const CAgentSendOptions,
    _cb: CAgentTurnCb,
    _user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { not_implemented("agent.send", out_error) }
}

/// Look up a turn without executing it.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_get_turn(
    _agent: *mut CAgent,
    _turn_id: *const c_char,
    _cb: CAgentTurnCb,
    _user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { not_implemented("agent.get_turn", out_error) }
}

/// Read outstanding questions and permissions.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_requests(
    _agent: *mut CAgent,
    _cb: CAgentJsonCb,
    _user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { not_implemented("agent.requests", out_error) }
}

/// Answer a typed request.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_respond(
    _agent: *mut CAgent,
    _request_id: *const c_char,
    _response_json: *const c_char,
    _options: *const CAgentControlOptions,
    _cb: CAgentTurnCb,
    _user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { not_implemented("agent.respond", out_error) }
}

/// Wait for a turn result; timeout does not imply cancellation.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_turn_wait(
    _turn: *mut CAgentTurn,
    _options: *const CAgentWaitOptions,
    _cb: CAgentJsonCb,
    _user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { not_implemented("turn.wait", out_error) }
}

/// Steer this turn without submitting another turn.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_turn_steer(
    _turn: *mut CAgentTurn,
    _text: *const c_char,
    _options: *const CAgentControlOptions,
    _cb: CAgentJsonCb,
    _user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { not_implemented("turn.steer", out_error) }
}

/// Interrupt the agent loop for this turn.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_turn_interrupt(
    _turn: *mut CAgentTurn,
    _options: *const CAgentControlOptions,
    _cb: CAgentDoneCb,
    _user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { not_implemented("turn.interrupt", out_error) }
}

/// Open the agent journal after an opaque cursor.
/// out and out_error may be null or writable. out is cleared on error.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_events(
    _handle: *mut CAgent,
    _options: *const CAgentEventsOptions,
    _cb: CAgentJsonCb,
    _user_data: *mut c_void,
    out: *mut *mut CAgentEvents,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if !out.is_null() {
        unsafe {
            *out = ptr::null_mut();
        }
    }
    unsafe { not_implemented("agent.events", out_error) }
}

/// Open this turn's view of the agent journal.
/// out and out_error may be null or writable. out is cleared on error.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_turn_events(
    _handle: *mut CAgentTurn,
    _options: *const CAgentEventsOptions,
    _cb: CAgentJsonCb,
    _user_data: *mut c_void,
    out: *mut *mut CAgentEvents,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if !out.is_null() {
        unsafe {
            *out = ptr::null_mut();
        }
    }
    unsafe { not_implemented("turn.events", out_error) }
}

/// Read a consistent agent state snapshot.
/// Release a returned JSON string with boxlite_free_string.
/// out_json and out_error may be null or writable. out_json is cleared on error.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_state(
    _handle: *mut CAgent,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if !out_json.is_null() {
        unsafe {
            *out_json = ptr::null_mut();
        }
    }
    unsafe { not_implemented("agent.state", out_error) }
}

/// Read effective agent configuration.
/// Release a returned JSON string with boxlite_free_string.
/// out_json and out_error may be null or writable. out_json is cleared on error.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_config(
    _handle: *mut CAgent,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if !out_json.is_null() {
        unsafe {
            *out_json = ptr::null_mut();
        }
    }
    unsafe { not_implemented("agent.config", out_error) }
}

/// Read adapter guarantees and limits.
/// Release a returned JSON string with boxlite_free_string.
/// out_json and out_error may be null or writable. out_json is cleared on error.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_capabilities(
    _handle: *mut CAgent,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if !out_json.is_null() {
        unsafe {
            *out_json = ptr::null_mut();
        }
    }
    unsafe { not_implemented("agent.capabilities", out_error) }
}

/// Read a consistent turn state snapshot.
/// Release a returned JSON string with boxlite_free_string.
/// out_json and out_error may be null or writable. out_json is cleared on error.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_turn_state(
    _handle: *mut CAgentTurn,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if !out_json.is_null() {
        unsafe {
            *out_json = ptr::null_mut();
        }
    }
    unsafe { not_implemented("turn.state", out_error) }
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
        unsafe {
            drop(Box::from_raw(handle));
        }
    }
}

/// Release only the local handle. Does not close an agent or interrupt a turn.
/// handle must be null or a live, uniquely owned pointer returned by this SDK.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_events_free(handle: *mut CAgentEvents) {
    if !handle.is_null() {
        unsafe {
            drop(Box::from_raw(handle));
        }
    }
}

unsafe fn not_implemented(operation: &str, out_error: *mut CBoxliteError) -> BoxliteErrorCode {
    unsafe {
        write_error(
            out_error,
            BoxliteError::Unsupported(format!("{operation} is not implemented")),
        );
    }
    BoxliteErrorCode::Unsupported
}
