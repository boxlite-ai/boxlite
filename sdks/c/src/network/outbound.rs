//! Additive revision control ABI; existing policy setters and error codes stay stable.
use super::*;
use boxlite::net::{
    OutboundReplaceOutcome, OutboundReplacement, OutboundRevision, OutboundSnapshot,
};

#[cfg(test)]
#[path = "../tests/outbound_revision.rs"]
mod tests;

/// Read persisted policy and revision as JSON, without claiming live confirmation.
/// On success, release *out_json with boxlite_free_string. On error it is NULL.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_network_outbound_snapshot(
    network: *mut CBoxNetworkHandle,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        read_json(network, out_json, out_error, |network| {
            network
                .tokio_rt
                .block_on(network.handle.outbound_snapshot())
        })
    }
}

/// Read durable/live status and pending evidence without changing policy or booting a VM.
/// On success, release *out_json with boxlite_free_string. On error it is NULL.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_network_outbound_status(
    network: *mut CBoxNetworkHandle,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        read_json(network, out_json, out_error, |network| {
            network.tokio_rt.block_on(network.handle.outbound_status())
        })
    }
}

/// Apply a trusted coordinator's complete policy and fresh candidate revision.
/// Inputs are borrowed UTF-8 strings for the call; revisions are outside policy JSON.
/// Ok with *out_applied=1 means applied; Ok with 0 means the precondition failed.
/// *out_applied is initialized to 0 before input validation. No legacy fallback occurs.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_network_replace_outbound_snapshot(
    network: *mut CBoxNetworkHandle,
    expected_revision: *const c_char,
    candidate_revision: *const c_char,
    policy_json: *const c_char,
    out_applied: *mut u8,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let result = (|| {
        if out_applied.is_null() {
            return Err(null_pointer_error("out_applied"));
        }
        unsafe {
            *out_applied = 0;
        }
        let network = unsafe { network.as_ref() }.ok_or_else(|| null_pointer_error("network"))?;
        let replacement = OutboundReplacement::new(
            unsafe { revision(expected_revision, "expected_revision") }?,
            OutboundSnapshot {
                policy: unsafe { parse_policy(policy_json) }?,
                revision: unsafe { revision(candidate_revision, "candidate_revision") }?,
            },
        )?;
        let outcome = network
            .tokio_rt
            .block_on(network.handle.replace_outbound_snapshot(replacement))?;
        unsafe {
            *out_applied = u8::from(outcome == OutboundReplaceOutcome::Applied);
        }
        Ok(())
    })();
    policy_result(result, out_error)
}

unsafe fn revision(value: *const c_char, name: &str) -> Result<OutboundRevision, BoxliteError> {
    if value.is_null() {
        return Err(null_pointer_error(name));
    }
    let value = unsafe { CStr::from_ptr(value) }
        .to_str()
        .map_err(|_| BoxliteError::InvalidArgument(format!("{name} must be UTF-8")))?;
    OutboundRevision::parse(value)
}

unsafe fn read_json<T: serde::Serialize>(
    network: *mut CBoxNetworkHandle,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
    read: impl FnOnce(&BoxNetworkHandle) -> Result<T, BoxliteError>,
) -> BoxliteErrorCode {
    let result = (|| {
        if out_json.is_null() {
            return Err(null_pointer_error("out_json"));
        }
        unsafe {
            *out_json = ptr::null_mut();
        }
        let network = unsafe { network.as_ref() }.ok_or_else(|| null_pointer_error("network"))?;
        let value = read(network)?;
        let json = serde_json::to_string(&value).map_err(|error| {
            BoxliteError::Internal(format!("serialize outbound response: {error}"))
        })?;
        let json = CString::new(json)
            .map_err(|_| BoxliteError::Internal("outbound response contains NUL".into()))?;
        unsafe {
            *out_json = json.into_raw();
        }
        Ok(())
    })();
    policy_result(result, out_error)
}
