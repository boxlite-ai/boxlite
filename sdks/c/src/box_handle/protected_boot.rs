use super::*;
use boxlite::litebox::protected_boot::{
    ProtectedBootKey, ProtectedBootRequest, ProtectedEpochRequest, ProtectedGateRequest,
    ProtectedRemoveRequest,
};
use boxlite::litebox::protected_outbound::ProtectedRouteRequest;

/// Internal Runner ABI. Protected credential input is borrowed for this call.
/// Release the output JSON with boxlite_free_string. Operations are 0 (start),
/// 1 (receipt), 2 (retire), 3 (check protection), 4 (release gate), 5 (seal gate),
/// 6 (managed route control), 8 (exact allocation identity), 9 (protected stop),
/// 10 (terminated epoch retirement), and 11 (released readiness).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runner_protected_boot(
    handle: *mut CBoxHandle,
    operation: u8,
    input_json: *const c_char,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let result =
        (|| -> Result<(), BoxliteError> {
            if out_json.is_null() {
                return Err(null_pointer_error("out_json"));
            }
            unsafe { *out_json = ptr::null_mut() };
            let handle = unsafe { handle.as_ref() }.ok_or_else(|| null_pointer_error("box"))?;
            let result =
                match operation {
                    0 => encode(handle.tokio_rt.block_on(handle.handle.bootstrap_protected(
                        unsafe { parse::<ProtectedBootRequest>(input_json) }?,
                    ))?),
                    1 => encode(
                        handle
                            .tokio_rt
                            .block_on(handle.handle.protected_boot_receipt(&unsafe {
                                parse::<ProtectedBootKey>(input_json)
                            }?))?,
                    ),
                    2 => encode(
                        handle
                            .tokio_rt
                            .block_on(handle.handle.retire_protected_boot(unsafe {
                                parse::<ProtectedBootKey>(input_json)
                            }?))?,
                    ),
                    3 => Ok(handle
                        .tokio_rt
                        .block_on(handle.handle.has_protected_boot())?
                        .to_string()),
                    4 | 5 => encode(handle.tokio_rt.block_on(
                        handle.handle.change_protected_boot_gate(
                            unsafe { parse::<ProtectedGateRequest>(input_json) }?,
                            operation == 5,
                        ),
                    )?),
                    6 => encode(handle.tokio_rt.block_on(handle.handle.protected_outbound(
                        unsafe { parse::<ProtectedRouteRequest>(input_json) }?,
                    ))?),
                    8 => encode(handle.handle.runner_allocation()),
                    9 => encode(
                        handle
                            .tokio_rt
                            .block_on(handle.handle.stop_protected_epoch(unsafe {
                                parse::<ProtectedEpochRequest>(input_json)
                            }?))?,
                    ),
                    10 => encode(handle.tokio_rt.block_on(
                        handle.handle.retire_terminated_protected_epoch(unsafe {
                            parse::<ProtectedEpochRequest>(input_json)
                        }?),
                    )?),
                    11 => encode(
                        handle
                            .tokio_rt
                            .block_on(handle.handle.protected_boot_ready(&unsafe {
                                parse::<ProtectedBootKey>(input_json)
                            }?))?,
                    ),
                    12 => encode(handle.handle.runner_migration()),
                    _ => Err(BoxliteError::InvalidArgument(
                        "Invalid protected boot operation".into(),
                    )),
                }?;
            let json = CString::new(result)
                .map_err(|_| BoxliteError::Internal("Invalid protected boot response".into()))?;
            unsafe { *out_json = json.into_raw() };
            Ok(())
        })();
    match result {
        Ok(()) => BoxliteErrorCode::Ok,
        Err(error) => {
            let code = crate::error::error_to_code(&error);
            unsafe { write_error(out_error, error) };
            code
        }
    }
}

fn encode(receipt: impl serde::Serialize) -> Result<String, BoxliteError> {
    serde_json::to_string(&receipt)
        .map_err(|_| BoxliteError::Internal("Failed to encode protected boot receipt".into()))
}

unsafe fn parse<T: serde::de::DeserializeOwned>(input: *const c_char) -> Result<T, BoxliteError> {
    if input.is_null() {
        return Err(null_pointer_error("input_json"));
    }
    let bytes = unsafe { std::ffi::CStr::from_ptr(input) }.to_bytes();
    serde_json::from_slice(bytes)
        .map_err(|_| BoxliteError::InvalidArgument("Invalid protected boot request".into()))
}

/// Internal Runner ABI. Atomically remove an exact retired local epoch.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runner_remove_retired(
    runtime: *mut crate::CBoxliteRuntime,
    box_id: *const c_char,
    input_json: *const c_char,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let result = (|| -> Result<(), BoxliteError> {
        if out_json.is_null() {
            return Err(null_pointer_error("out_json"));
        }
        unsafe { *out_json = ptr::null_mut() };
        let handle = unsafe { runtime.cast::<crate::runtime::RuntimeHandle>().as_ref() }
            .ok_or_else(|| null_pointer_error("runtime"))?;
        if box_id.is_null() {
            return Err(null_pointer_error("box_id"));
        }
        let id = unsafe { std::ffi::CStr::from_ptr(box_id) }
            .to_str()
            .map_err(|_| BoxliteError::InvalidArgument("Invalid Box ID".into()))?;
        let request = unsafe { parse::<ProtectedRemoveRequest>(input_json) }?;
        let receipt = handle
            .tokio_rt
            .block_on(handle.runtime.remove_retired_protected(id, &request))?;
        let json = CString::new(encode(receipt)?)
            .map_err(|_| BoxliteError::Internal("Invalid protected removal response".into()))?;
        unsafe { *out_json = json.into_raw() };
        Ok(())
    })();
    match result {
        Ok(()) => BoxliteErrorCode::Ok,
        Err(error) => {
            let code = crate::error::error_to_code(&error);
            unsafe { write_error(out_error, error) };
            code
        }
    }
}
