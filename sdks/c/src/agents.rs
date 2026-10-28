//! Agent sessions, turns, and journal subscriptions.
//! JSON callback payloads are borrowed for the callback; getter strings use
//! boxlite_free_string. Error pointers use boxlite_error_free.

use std::ffi::{c_char, c_void};
use std::ptr;

use boxlite::BoxliteError;

use crate::error::{BoxliteErrorCode, null_pointer_error, write_error};
use crate::{CBoxHandle, CBoxliteError};

/// Box-owned namespace; release with boxlite_agent_free.
pub struct CAgentHandle {
    _core: boxlite::AgentHandle,
}
/// Agent session handle.
pub struct CAgentSession {
    _private: (),
}
/// Agent turn handle.
pub struct CAgentTurn {
    _private: (),
}
/// Journal subscription. Freeing it does not cancel agent work.
pub struct CAgentEvents {
    _private: (),
}

/// Initial session settings. Null strings mean omitted; config_json uses the
/// AgentConfig keys documented in docs/reference/agents.md.
#[repr(C)]
pub struct CAgentCreateOptions {
    pub cwd: *const c_char,
    pub config_json: *const c_char,
    pub idempotency_key: *const c_char,
}

/// Admission modes; zero-initialized options select queue.
#[repr(C)]
#[derive(Clone, Copy)]
pub enum CAgentSendMode {
    AgentSendQueue = 0,
    AgentSendReject = 1,
}

/// Optional JSON accompanies positional message text.
#[repr(C)]
pub struct CAgentSendOptions {
    pub mode: CAgentSendMode,
    pub data_json: *const c_char,
    pub idempotency_key: *const c_char,
}

/// Shared retry identity for close, reply, steering and interruption.
#[repr(C)]
pub struct CAgentControlOptions {
    pub idempotency_key: *const c_char,
}

/// Timeout in seconds; negative or a null options pointer means no deadline.
#[repr(C)]
pub struct CAgentWaitOptions {
    pub timeout_seconds: f64,
}

/// Resume after an opaque cursor; null means no cursor.
#[repr(C)]
pub struct CAgentEventsOptions {
    pub after: *const c_char,
}

pub type CAgentSessionCb =
    Option<unsafe extern "C" fn(*mut CAgentSession, *const CBoxliteError, *mut c_void)>;
pub type CAgentTurnCb =
    Option<unsafe extern "C" fn(*mut CAgentTurn, *const CBoxliteError, *mut c_void)>;
pub type CAgentJsonCb =
    Option<unsafe extern "C" fn(*const c_char, *const CBoxliteError, *mut c_void)>;
pub type CAgentDoneCb = Option<unsafe extern "C" fn(*const CBoxliteError, *mut c_void)>;

/// Obtain a namespace without starting the Box.
/// handle must be live; out must be writable; out_error may be null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_agents(
    handle: *mut CBoxHandle,
    out: *mut *mut CAgentHandle,
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
        *out = Box::into_raw(Box::new(CAgentHandle {
            _core: (*handle).handle.agents(),
        }));
    }
    BoxliteErrorCode::Ok
}

/// Create a session with initial configuration.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_create(
    _handle: *mut CAgentHandle,
    _agent: *const c_char,
    _options: *const CAgentCreateOptions,
    _cb: CAgentSessionCb,
    _user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { not_implemented("agents.create", out_error) }
}

/// Look up a session without replaying work.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_get(
    _handle: *mut CAgentHandle,
    _session_id: *const c_char,
    _cb: CAgentSessionCb,
    _user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { not_implemented("agents.get", out_error) }
}

/// Stop admissions and close the agent loop.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_session_close(
    _session: *mut CAgentSession,
    _options: *const CAgentControlOptions,
    _cb: CAgentDoneCb,
    _user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { not_implemented("session.close", out_error) }
}

/// Submit text with optional JSON data.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_session_send(
    _session: *mut CAgentSession,
    _text: *const c_char,
    _options: *const CAgentSendOptions,
    _cb: CAgentTurnCb,
    _user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { not_implemented("session.send", out_error) }
}

/// Look up a turn without executing it.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_session_get_turn(
    _session: *mut CAgentSession,
    _turn_id: *const c_char,
    _cb: CAgentTurnCb,
    _user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { not_implemented("session.get_turn", out_error) }
}

/// Read outstanding questions and permissions.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_session_requests(
    _session: *mut CAgentSession,
    _cb: CAgentJsonCb,
    _user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { not_implemented("session.requests", out_error) }
}

/// Answer a typed request.
/// out_error may be null or writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_session_respond(
    _session: *mut CAgentSession,
    _request_id: *const c_char,
    _response_json: *const c_char,
    _options: *const CAgentControlOptions,
    _cb: CAgentTurnCb,
    _user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { not_implemented("session.respond", out_error) }
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

/// Open the session journal after an opaque cursor.
/// out and out_error may be null or writable. out is cleared on error.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_session_events(
    _handle: *mut CAgentSession,
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
    unsafe { not_implemented("session.events", out_error) }
}

/// Open this turn's view of the session journal.
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

/// Read a consistent session state snapshot.
/// out_json and out_error may be null or writable. out_json is cleared on error.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_session_state(
    _handle: *mut CAgentSession,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if !out_json.is_null() {
        unsafe {
            *out_json = ptr::null_mut();
        }
    }
    unsafe { not_implemented("session.state", out_error) }
}

/// Read effective agent configuration.
/// out_json and out_error may be null or writable. out_json is cleared on error.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_session_config(
    _handle: *mut CAgentSession,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if !out_json.is_null() {
        unsafe {
            *out_json = ptr::null_mut();
        }
    }
    unsafe { not_implemented("session.config", out_error) }
}

/// Read adapter guarantees and limits.
/// out_json and out_error may be null or writable. out_json is cleared on error.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_session_capabilities(
    _handle: *mut CAgentSession,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if !out_json.is_null() {
        unsafe {
            *out_json = ptr::null_mut();
        }
    }
    unsafe { not_implemented("session.capabilities", out_error) }
}

/// Read a consistent turn state snapshot.
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

/// Release only the local handle. Does not close a session or interrupt a turn.
/// handle must be null or a live, uniquely owned pointer returned by this SDK.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_free(handle: *mut CAgentHandle) {
    if !handle.is_null() {
        unsafe {
            drop(Box::from_raw(handle));
        }
    }
}

/// Release only the local handle. Does not close a session or interrupt a turn.
/// handle must be null or a live, uniquely owned pointer returned by this SDK.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_session_free(handle: *mut CAgentSession) {
    if !handle.is_null() {
        unsafe {
            drop(Box::from_raw(handle));
        }
    }
}

/// Release only the local handle. Does not close a session or interrupt a turn.
/// handle must be null or a live, uniquely owned pointer returned by this SDK.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_agent_turn_free(handle: *mut CAgentTurn) {
    if !handle.is_null() {
        unsafe {
            drop(Box::from_raw(handle));
        }
    }
}

/// Release only the local handle. Does not close a session or interrupt a turn.
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
