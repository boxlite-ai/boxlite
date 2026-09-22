//! SSH control through the runtime's completion queue.
use crate::error::{BoxliteErrorCode, error_to_code, null_pointer_error, write_error};
use crate::event_queue::{CSshCb, EventQueue, OwnedFfiPtr, RuntimeEvent, push_event};
use crate::{CBoxHandle, CBoxliteError, CSshHandle};
use boxlite::{BoxliteError, SshConfig, SshHandle, SshStatus};
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_void};
use std::sync::Arc;

pub struct SshControl {
    handle: SshHandle,
    tokio_rt: Arc<tokio::runtime::Runtime>,
    queue: Arc<EventQueue>,
}

/// Owned result. Release with boxlite_ssh_status_free; strings are read-only.
#[repr(C)]
pub struct CSshStatus {
    pub enabled: bool,
    pub generation: u64,
    pub listen_address: *mut c_char,
    pub host_public_key: *mut c_char,
    pub host_key_fingerprint: *mut c_char,
}

impl Drop for CSshStatus {
    fn drop(&mut self) {
        unsafe {
            for p in [
                self.listen_address,
                self.host_public_key,
                self.host_key_fingerprint,
            ] {
                if !p.is_null() {
                    drop(CString::from_raw(p));
                }
            }
        }
    }
}

fn status_to_c(status: SshStatus) -> Result<OwnedFfiPtr<CSshStatus>, BoxliteError> {
    let strings = [
        status.listen_address,
        status.host_public_key,
        status.host_key_fingerprint,
    ]
    .map(CString::new);
    let [address, key, fingerprint] = strings;
    let invalid = |_| BoxliteError::Internal("SSH status contains NUL".into());
    let address = address.map_err(invalid)?;
    let key = key.map_err(invalid)?;
    let fingerprint = fingerprint.map_err(invalid)?;
    Ok(OwnedFfiPtr::new(Box::new(CSshStatus {
        enabled: status.enabled,
        generation: status.generation,
        listen_address: address.into_raw(),
        host_public_key: key.into_raw(),
        host_key_fingerprint: fingerprint.into_raw(),
    })))
}

/// Acquire an owned handle without starting the box. Free with boxlite_ssh_free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_ssh(
    handle: *mut CBoxHandle,
    out_ssh: *mut *mut CSshHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if out_ssh.is_null() || handle.is_null() {
        write_error(out_error, null_pointer_error("box or out_ssh"));
        return BoxliteErrorCode::InvalidArgument;
    }
    let owner = &*handle;
    *out_ssh = Box::into_raw(Box::new(SshControl {
        handle: owner.handle.ssh(),
        tokio_rt: owner.tokio_rt.clone(),
        queue: owner.queue.clone(),
    }));
    BoxliteErrorCode::Ok
}

/// Parse and copy a snake_case SshConfig JSON string before returning.
/// The caller may release config_json immediately. Invalid JSON never echoes input.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_ssh_configure(
    handle: *mut CSshHandle,
    config_json: *const c_char,
    cb: CSshCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let config = match parse_config(config_json) {
        Ok(config) => config,
        Err(error) => {
            let code = error_to_code(&error);
            write_error(out_error, error);
            return code;
        }
    };
    submit(
        handle,
        Operation::Configure(config),
        cb,
        user_data,
        out_error,
    )
}

unsafe fn parse_config(config: *const c_char) -> Result<SshConfig, BoxliteError> {
    if config.is_null() {
        return Err(null_pointer_error("config_json"));
    }
    serde_json::from_slice(CStr::from_ptr(config).to_bytes())
        .map_err(|_| BoxliteError::InvalidArgument("invalid SSH configuration JSON".into()))
}

enum Operation {
    Configure(SshConfig),
    Status,
    Disable,
}

unsafe fn submit(
    handle: *mut CSshHandle,
    operation: Operation,
    cb: CSshCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if handle.is_null() {
        write_error(out_error, null_pointer_error("ssh"));
        return BoxliteErrorCode::InvalidArgument;
    }
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let owner = &*handle;
    let ssh = owner.handle.clone();
    let queue = owner.queue.clone();
    let user_data = user_data as usize;
    owner.tokio_rt.spawn(async move {
        let result = match operation {
            Operation::Configure(config) => ssh.configure(config).await,
            Operation::Status => ssh.status().await,
            Operation::Disable => ssh.disable().await,
        }
        .and_then(status_to_c);
        push_event(
            &queue,
            RuntimeEvent::Ssh {
                cb,
                user_data,
                result,
            },
        )
        .await;
    });
    BoxliteErrorCode::Ok
}

/// Query status asynchronously; may start the box.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_ssh_status(
    handle: *mut CSshHandle,
    cb: CSshCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    submit(handle, Operation::Status, cb, user_data, out_error)
}

/// Disable SSH asynchronously and disconnect sessions; may start the box.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_ssh_disable(
    handle: *mut CSshHandle,
    cb: CSshCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    submit(handle, Operation::Disable, cb, user_data, out_error)
}

/// Free the handle; submitted operations retain their own references.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_ssh_free(handle: *mut CSshHandle) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_ssh_status_free(status: *mut CSshStatus) {
    if !status.is_null() {
        drop(Box::from_raw(status));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ssh_config_copies_nested_credentials_and_sanitizes_invalid_json() {
        let json = CString::new(r#"{"listen_address":"0.0.0.0:2222","host_private_key":"sentinel-private","accounts":[{"login":"alice","authorized_keys":["sentinel-public"],"ca":{"public_key":"sentinel-ca","principal":"alice"}}]}"#).unwrap();
        let config = unsafe { parse_config(json.as_ptr()) }.unwrap();
        drop(json);
        assert_eq!(
            config.accounts[0].ca.as_ref().unwrap().public_key,
            "sentinel-ca"
        );
        assert_eq!(config.host_private_key, "sentinel-private");
        let invalid = CString::new(
            r#"{"host_private_key": "sentinel-private", "accounts":"sentinel-secret"}"#,
        )
        .unwrap();
        let error = unsafe { parse_config(invalid.as_ptr()) }.unwrap_err();
        assert!(!error.to_string().contains("sentinel"));
        assert!(unsafe { parse_config(std::ptr::null()) }.is_err());
    }
    #[test]
    fn ssh_status_preserves_unsigned_generation_and_rejects_nul() {
        let status = SshStatus {
            enabled: true,
            generation: u64::MAX,
            listen_address: "addr".into(),
            host_public_key: "public".into(),
            host_key_fingerprint: "fingerprint".into(),
        };
        let owned = status_to_c(status.clone()).unwrap();
        let raw = owned.take();
        unsafe {
            assert_eq!((*raw).generation, u64::MAX);
            assert_eq!(
                CStr::from_ptr((*raw).host_public_key).to_str().unwrap(),
                "public"
            );
            boxlite_ssh_status_free(raw);
        }
        assert!(
            status_to_c(SshStatus {
                host_public_key: "bad\0key".into(),
                ..status
            })
            .is_err()
        );
    }
    #[test]
    fn ssh_null_handles_and_callbacks_are_rejected() {
        let mut error = crate::error::FFIError::default();
        unsafe {
            assert_eq!(
                boxlite_ssh_status(std::ptr::null_mut(), None, std::ptr::null_mut(), &mut error),
                BoxliteErrorCode::InvalidArgument
            );
            crate::boxlite_error_free(&mut error);
            boxlite_ssh_free(std::ptr::null_mut());
            boxlite_ssh_status_free(std::ptr::null_mut());
        }
    }
}
