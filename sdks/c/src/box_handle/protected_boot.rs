use super::*;
use boxlite::litebox::protected_boot::{ProtectedBootKey, ProtectedBootRequest};

/// Internal Runner ABI. Protected credential input is borrowed for this call.
/// Release the output JSON with boxlite_free_string. Operations are 0 (start),
/// 1 (receipt), 2 (retire) and 3 (check protection for legacy recovery).
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
            let encode = |receipt| {
                serde_json::to_string(&receipt).map_err(|_| {
                    BoxliteError::Internal("Failed to encode protected boot receipt".into())
                })
            };
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

unsafe fn parse<T: serde::de::DeserializeOwned>(input: *const c_char) -> Result<T, BoxliteError> {
    if input.is_null() {
        return Err(null_pointer_error("input_json"));
    }
    let bytes = unsafe { std::ffi::CStr::from_ptr(input) }.to_bytes();
    serde_json::from_slice(bytes)
        .map_err(|_| BoxliteError::InvalidArgument("Invalid protected boot request".into()))
}
