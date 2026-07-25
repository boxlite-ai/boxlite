//! SSH access-set control facade for the BoxLite C SDK.
//!
//! Internal Runner-facing control plane only: apply/query which temporary
//! SSH credentials the guest's russh listener authenticates. SSH bytes
//! themselves still flow over `boxlite_network_tunnel`, unrelated to this
//! module.

use std::os::raw::c_char;
use std::ptr;
use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::BoxliteError;
use boxlite::litebox::{
    SshAccessEntry as CoreSshAccessEntry, SshAccessSetRequest as CoreSshAccessSetRequest,
    SshHandle as CoreSshHandle, SshIdentityStatus as CoreSshIdentityStatus,
    SshStatus as CoreSshStatus,
};

use crate::error::{BoxliteErrorCode, error_to_code, null_pointer_error, write_error};
use crate::util::{alloc_c_string, c_str_to_string};
use crate::{CBoxHandle, CBoxSshHandle, CBoxliteError};

/// Opaque handle for SSH access-set operations on a box.
pub struct BoxSshHandle {
    handle: CoreSshHandle,
    tokio_rt: Arc<TokioRuntime>,
}

/// One box-scoped temporary SSH credential to authorize. Mirrors
/// `boxlite::litebox::SshAccessEntry` at the FFI boundary.
#[repr(C)]
pub struct CBoxliteSshAccessEntry {
    pub credential_id: *const c_char,
    pub grant_id: *const c_char,
    /// Canonical OpenSSH public-key line.
    pub public_key: *const c_char,
    pub fingerprint: *const c_char,
    pub unix_user: *const c_char,
    pub expires_at_unix_seconds: i64,
}

/// Guest-observed SSH host identity health.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CBoxliteSshIdentityStatus {
    Unknown = 0,
    Ready = 1,
    Degraded = 2,
}

/// Applied generation, listener readiness, and host identity, as last
/// observed from the guest. Heap-allocated; free with `boxlite_ssh_status_free`.
#[repr(C)]
pub struct CBoxliteSshStatus {
    pub applied_generation: u64,
    pub listener_ready: bool,
    pub host_public_key: *mut c_char,
    pub host_fingerprint: *mut c_char,
    pub identity_status: CBoxliteSshIdentityStatus,
}

fn status_to_c(status: CoreSshStatus) -> CBoxliteSshStatus {
    CBoxliteSshStatus {
        applied_generation: status.applied_generation,
        listener_ready: status.listener_ready,
        host_public_key: alloc_c_string(&status.host_public_key),
        host_fingerprint: alloc_c_string(&status.host_fingerprint),
        identity_status: match status.identity_status {
            CoreSshIdentityStatus::Unknown => CBoxliteSshIdentityStatus::Unknown,
            CoreSshIdentityStatus::Ready => CBoxliteSshIdentityStatus::Ready,
            CoreSshIdentityStatus::Degraded => CBoxliteSshIdentityStatus::Degraded,
        },
    }
}

/// # Safety
/// `entry` and every non-null string field inside it must be valid for the
/// duration of this call (they are copied out, never retained by pointer).
unsafe fn entry_from_c(entry: &CBoxliteSshAccessEntry) -> Result<CoreSshAccessEntry, BoxliteError> {
    unsafe {
        Ok(CoreSshAccessEntry {
            credential_id: c_str_to_string(entry.credential_id)?,
            grant_id: c_str_to_string(entry.grant_id)?,
            public_key: c_str_to_string(entry.public_key)?,
            fingerprint: c_str_to_string(entry.fingerprint)?,
            unix_user: c_str_to_string(entry.unix_user)?,
            expires_at: std::time::UNIX_EPOCH
                + std::time::Duration::from_secs(entry.expires_at_unix_seconds.max(0) as u64),
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_ssh(
    handle: *mut CBoxHandle,
    out_ssh: *mut *mut CBoxSshHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_ssh.is_null() {
            write_error(out_error, null_pointer_error("out_ssh"));
            return BoxliteErrorCode::InvalidArgument;
        }

        *out_ssh = ptr::null_mut();
        let handle_ref = &*handle;
        *out_ssh = Box::into_raw(Box::new(BoxSshHandle {
            handle: handle_ref.handle.ssh(),
            tokio_rt: handle_ref.tokio_rt.clone(),
        }));
        BoxliteErrorCode::Ok
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_ssh_free(ssh: *mut CBoxSshHandle) {
    if !ssh.is_null() {
        unsafe { drop(Box::from_raw(ssh)) };
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_ssh_replace_access_set(
    ssh: *mut CBoxSshHandle,
    generation: u64,
    accesses: *const CBoxliteSshAccessEntry,
    accesses_count: usize,
    out_status: *mut *mut CBoxliteSshStatus,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if ssh.is_null() {
            write_error(out_error, null_pointer_error("ssh"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_status.is_null() {
            write_error(out_error, null_pointer_error("out_status"));
            return BoxliteErrorCode::InvalidArgument;
        }
        *out_status = ptr::null_mut();
        if accesses_count > 0 && accesses.is_null() {
            write_error(out_error, null_pointer_error("accesses"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let mut entries = Vec::with_capacity(accesses_count);
        for i in 0..accesses_count {
            let entry = &*accesses.add(i);
            match entry_from_c(entry) {
                Ok(entry) => entries.push(entry),
                Err(error) => {
                    let code = error_to_code(&error);
                    write_error(out_error, error);
                    return code;
                }
            }
        }

        let ssh_ref = &*ssh;
        let request = CoreSshAccessSetRequest {
            generation,
            accesses: entries,
        };
        match ssh_ref
            .tokio_rt
            .block_on(ssh_ref.handle.replace_access_set(request))
        {
            Ok(status) => {
                *out_status = Box::into_raw(Box::new(status_to_c(status)));
                BoxliteErrorCode::Ok
            }
            Err(error) => {
                let code = error_to_code(&error);
                write_error(out_error, error);
                code
            }
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_ssh_status(
    ssh: *mut CBoxSshHandle,
    out_status: *mut *mut CBoxliteSshStatus,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if ssh.is_null() {
            write_error(out_error, null_pointer_error("ssh"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_status.is_null() {
            write_error(out_error, null_pointer_error("out_status"));
            return BoxliteErrorCode::InvalidArgument;
        }
        *out_status = ptr::null_mut();

        let ssh_ref = &*ssh;
        match ssh_ref.tokio_rt.block_on(ssh_ref.handle.status()) {
            Ok(status) => {
                *out_status = Box::into_raw(Box::new(status_to_c(status)));
                BoxliteErrorCode::Ok
            }
            Err(error) => {
                let code = error_to_code(&error);
                write_error(out_error, error);
                code
            }
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_ssh_status_free(status: *mut CBoxliteSshStatus) {
    unsafe {
        if status.is_null() {
            return;
        }
        let status = Box::from_raw(status);
        crate::util::free_c_string(status.host_public_key);
        crate::util::free_c_string(status.host_fingerprint);
    }
}
