use crate::error::error_to_c_error;
use crate::*;
use boxlite::BoxliteError;
use boxlite::runtime::BoxliteRuntime;
use std::ffi::{CStr, CString};
use std::os::raw::c_void;
use std::path::PathBuf;
use std::ptr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

extern "C" fn noop_shutdown_cb(_err: *mut FFIError, _ud: *mut c_void) {}
extern "C" fn noop_image_pull_cb(
    _r: *mut crate::images::CImagePullResult,
    _err: *mut FFIError,
    _ud: *mut c_void,
) {
}

fn unique_test_home(prefix: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time before unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("boxlite-c-{prefix}-{unique}"))
}

unsafe fn new_test_runtime_handle(prefix: &str) -> (*mut crate::runtime::RuntimeHandle, PathBuf) {
    let home_dir = unique_test_home(prefix);
    let home_dir_c = CString::new(home_dir.display().to_string()).expect("home dir cstring");
    let mut runtime: *mut crate::runtime::RuntimeHandle = ptr::null_mut();
    let mut error = FFIError::default();

    let code = unsafe {
        boxlite_runtime_new(
            home_dir_c.as_ptr(),
            ptr::null(),
            0,
            &mut runtime as *mut _,
            &mut error as *mut _,
        )
    };

    if code != BoxliteErrorCode::Ok {
        let err_msg = if error.message.is_null() {
            String::new()
        } else {
            unsafe { CStr::from_ptr(error.message) }
                .to_string_lossy()
                .into_owned()
        };
        unsafe { boxlite_error_free(&mut error as *mut _) };
        panic!("runtime_new failed with {code:?}: {err_msg}");
    }

    (runtime, home_dir)
}

#[test]
fn test_version_string() {
    let ver = boxlite_version();
    assert!(!ver.is_null());
    let ver_str = unsafe { CStr::from_ptr(ver) }.to_str().unwrap();
    assert!(!ver_str.is_empty());
    assert!(ver_str.contains('.'));
}

#[test]
fn test_error_code_mapping() {
    assert_eq!(
        error_to_code(&BoxliteError::NotFound("test".into())),
        BoxliteErrorCode::NotFound
    );
    assert_eq!(
        error_to_code(&BoxliteError::AlreadyExists("test".into())),
        BoxliteErrorCode::AlreadyExists
    );
    assert_eq!(
        error_to_code(&BoxliteError::InvalidState("test".into())),
        BoxliteErrorCode::InvalidState
    );
    assert_eq!(
        error_to_code(&BoxliteError::InvalidArgument("test".into())),
        BoxliteErrorCode::InvalidArgument
    );
    assert_eq!(
        error_to_code(&BoxliteError::Internal("test".into())),
        BoxliteErrorCode::Internal
    );
    assert_eq!(
        error_to_code(&BoxliteError::Config("test".into())),
        BoxliteErrorCode::Config
    );
    assert_eq!(
        error_to_code(&BoxliteError::Storage("test".into())),
        BoxliteErrorCode::Storage
    );
    assert_eq!(
        error_to_code(&BoxliteError::Image("test".into())),
        BoxliteErrorCode::Image
    );
    assert_eq!(
        error_to_code(&BoxliteError::Network("test".into())),
        BoxliteErrorCode::Network
    );
    assert_eq!(
        error_to_code(&BoxliteError::Execution("test".into())),
        BoxliteErrorCode::Execution
    );
}

#[test]
fn test_error_struct_creation() {
    let err = BoxliteError::NotFound("box123".into());
    let mut c_err = error_to_c_error(err);
    assert_eq!(c_err.code, BoxliteErrorCode::NotFound);
    assert!(!c_err.message.is_null());
    unsafe {
        boxlite_error_free(&mut c_err as *mut _);
    }
    assert!(c_err.message.is_null());
    assert_eq!(c_err.code, BoxliteErrorCode::Ok);
}

#[test]
fn test_null_pointer_validation() {
    unsafe {
        let mut error = FFIError::default();
        // runtime_new with null out_runtime should return InvalidArgument
        let code = boxlite_runtime_new(
            ptr::null(),
            ptr::null(),
            0,
            ptr::null_mut(),
            &mut error as *mut _,
        );
        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        assert!(!error.message.is_null());
        boxlite_error_free(&mut error as *mut _);
    }
}

#[test]
fn test_runtime_accepts_image_registry_config() {
    let home_dir = unique_test_home("registry-config");
    let home_dir_c = CString::new(home_dir.display().to_string()).expect("home dir cstring");
    let host = CString::new("registry.local:5000").unwrap();
    let username = CString::new("alice").unwrap();
    let password = CString::new("secret").unwrap();
    let registry = crate::runtime::BoxliteImageRegistry {
        host: host.as_ptr(),
        transport: crate::runtime::BoxliteRegistryTransport::BoxliteRegistryTransportHttp,
        skip_verify: 0,
        search: 1,
        username: username.as_ptr(),
        password: password.as_ptr(),
        bearer_token: ptr::null(),
    };
    let mut runtime: *mut crate::runtime::RuntimeHandle = ptr::null_mut();
    let mut error = FFIError::default();

    let code = unsafe {
        boxlite_runtime_new(
            home_dir_c.as_ptr(),
            &registry as *const _,
            1,
            &mut runtime as *mut _,
            &mut error as *mut _,
        )
    };

    assert_eq!(code, BoxliteErrorCode::Ok);
    assert!(!runtime.is_null());
    unsafe {
        boxlite_runtime_free(runtime);
    }
}

#[test]
fn test_runtime_images_null_pointer_validation() {
    unsafe {
        let mut error = FFIError::default();
        let code = boxlite_runtime_images(ptr::null_mut(), ptr::null_mut(), &mut error as *mut _);
        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        assert!(!error.message.is_null());
        boxlite_error_free(&mut error as *mut _);
    }
}

#[test]
fn test_c_string_conversion_logic() {
    let test_str = CString::new("hello").unwrap();
    unsafe {
        let result = crate::util::c_str_to_string(test_str.as_ptr());
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "hello");
    }
}

#[test]
fn test_free_functions_null_safe() {
    unsafe {
        boxlite_runtime_free(ptr::null_mut());
        boxlite_image_free(ptr::null_mut());
        boxlite_box_free(ptr::null_mut());
        boxlite_free_string(ptr::null_mut());
        boxlite_error_free(ptr::null_mut());
        boxlite_result_free(ptr::null_mut());
        boxlite_simple_free(ptr::null_mut());
        boxlite_execution_free(ptr::null_mut());
    }
}

#[test]
fn test_runtime_images_unsupported_on_rest_runtime() {
    let tokio_rt = crate::runtime::create_tokio_runtime().expect("create tokio runtime");
    let runtime = BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new("http://localhost:1"))
        .expect("create rest runtime");
    let mut runtime_handle = crate::runtime::RuntimeHandle {
        runtime,
        tokio_rt,
        liveness: Arc::new(crate::runtime::RuntimeLiveness::new()),
        queue: Arc::new(crate::event_queue::EventQueue::new()),
    };
    let mut image_handle: *mut crate::images::ImageHandle = ptr::null_mut();
    let mut error = FFIError::default();

    let code = unsafe {
        boxlite_runtime_images(
            &mut runtime_handle as *mut _,
            &mut image_handle as *mut _,
            &mut error as *mut _,
        )
    };

    assert_eq!(code, BoxliteErrorCode::Unsupported);
    assert!(image_handle.is_null());
    assert!(!error.message.is_null());

    unsafe {
        boxlite_error_free(&mut error as *mut _);
    }
}

#[test]
fn test_runtime_images_rejected_after_shutdown() {
    let (runtime, home_dir) = unsafe { new_test_runtime_handle("images-shutdown") };
    let mut error = FFIError::default();
    let mut image_handle: *mut crate::images::ImageHandle = ptr::null_mut();

    let shutdown_code = unsafe {
        boxlite_runtime_shutdown(
            runtime,
            0,
            Some(noop_shutdown_cb),
            ptr::null_mut(),
            &mut error as *mut _,
        )
    };
    assert_eq!(shutdown_code, BoxliteErrorCode::Ok);
    // Drain the shutdown completion event so the spawned task isn't leaked
    // when the runtime is freed below.
    let _ = unsafe { boxlite_runtime_drain(runtime, 1000, &mut error as *mut _) };
    unsafe { boxlite_error_free(&mut error as *mut _) };

    let code = unsafe {
        boxlite_runtime_images(runtime, &mut image_handle as *mut _, &mut error as *mut _)
    };
    assert_eq!(code, BoxliteErrorCode::Stopped);
    assert!(image_handle.is_null());
    assert!(!error.message.is_null());
    let message = unsafe { CStr::from_ptr(error.message) }
        .to_string_lossy()
        .into_owned();
    assert!(
        message.contains("shut down") || message.contains("closed"),
        "error should mention shutdown or closed: {message}"
    );

    unsafe {
        boxlite_error_free(&mut error as *mut _);
        boxlite_runtime_free(runtime);
    }
    let _ = std::fs::remove_dir_all(home_dir);
}

#[test]
fn test_image_pull_rejected_after_boxlite_runtime_free() {
    let (runtime, home_dir) = unsafe { new_test_runtime_handle("images-free") };
    let mut error = FFIError::default();
    let mut image_handle: *mut crate::images::ImageHandle = ptr::null_mut();

    let code = unsafe {
        boxlite_runtime_images(runtime, &mut image_handle as *mut _, &mut error as *mut _)
    };
    assert_eq!(code, BoxliteErrorCode::Ok);
    assert!(!image_handle.is_null());

    unsafe {
        boxlite_error_free(&mut error as *mut _);
        boxlite_runtime_free(runtime);
    }

    let image_ref = CString::new("alpine:latest").expect("image ref cstring");
    let pull_code = unsafe {
        boxlite_image_pull(
            image_handle,
            image_ref.as_ptr(),
            Some(noop_image_pull_cb),
            ptr::null_mut(),
            &mut error as *mut _,
        )
    };
    assert_eq!(pull_code, BoxliteErrorCode::Stopped);
    assert!(!error.message.is_null());
    let message = unsafe { CStr::from_ptr(error.message) }
        .to_string_lossy()
        .into_owned();
    assert!(
        message.contains("shut down") || message.contains("closed"),
        "error should mention shutdown or closed: {message}"
    );

    unsafe {
        boxlite_error_free(&mut error as *mut _);
        boxlite_image_free(image_handle);
    }
    let _ = std::fs::remove_dir_all(home_dir);
}

// ─── NULL-callback rejection (Rust side) ───────────────────────────────────
//
// Each test passes `None` (cbindgen's encoding for a NULL function pointer
// from C) and asserts the entrypoint synchronously returns InvalidArgument
// without spawning a Tokio task that would later try to invoke a NULL fn.
//
// The actual UB-on-NULL repro lives in the C-side test
// (sdks/c/tests/test_null_callback.c) where C semantics allow NULL. Here we
// rely on `Option<extern "C" fn(...)>` typedefs so the Rust side can express
// and reject NULL synchronously.

fn assert_null_cb_rejected(code: BoxliteErrorCode, error: &mut FFIError) {
    assert_eq!(code, BoxliteErrorCode::InvalidArgument);
    assert!(!error.message.is_null());
    let msg = unsafe { CStr::from_ptr(error.message) }
        .to_string_lossy()
        .into_owned();
    assert!(
        msg.contains("cb"),
        "error should mention the callback parameter: {msg}"
    );
    unsafe { boxlite_error_free(error as *mut _) };
}

#[test]
fn create_box_rejects_null_callback() {
    let (runtime, home_dir) = unsafe { new_test_runtime_handle("null-cb-create") };

    let image = CString::new("alpine:latest").expect("image cstring");
    let mut opts: *mut CBoxliteOptions = ptr::null_mut();
    let mut error = FFIError::default();
    let opts_code =
        unsafe { boxlite_options_new(image.as_ptr(), &mut opts as *mut _, &mut error as *mut _) };
    assert_eq!(opts_code, BoxliteErrorCode::Ok);

    let code =
        unsafe { boxlite_create_box(runtime, opts, None, ptr::null_mut(), &mut error as *mut _) };
    assert_null_cb_rejected(code, &mut error);

    // boxlite_create_box only consumes opts on success; on this error path
    // we still own them and must free.
    unsafe {
        boxlite_options_free(opts);
        boxlite_runtime_free(runtime);
    }
    let _ = std::fs::remove_dir_all(home_dir);
}

#[test]
fn runtime_metrics_rejects_null_callback() {
    let (runtime, home_dir) = unsafe { new_test_runtime_handle("null-cb-rtmet") };
    let mut error = FFIError::default();
    let code =
        unsafe { boxlite_runtime_metrics(runtime, None, ptr::null_mut(), &mut error as *mut _) };
    assert_null_cb_rejected(code, &mut error);
    unsafe { boxlite_runtime_free(runtime) };
    let _ = std::fs::remove_dir_all(home_dir);
}

#[test]
fn list_info_rejects_null_callback() {
    let (runtime, home_dir) = unsafe { new_test_runtime_handle("null-cb-listinfo") };
    let mut error = FFIError::default();
    let code = unsafe { boxlite_list_info(runtime, None, ptr::null_mut(), &mut error as *mut _) };
    assert_null_cb_rejected(code, &mut error);
    unsafe { boxlite_runtime_free(runtime) };
    let _ = std::fs::remove_dir_all(home_dir);
}

#[test]
fn shutdown_rejects_null_callback() {
    let (runtime, home_dir) = unsafe { new_test_runtime_handle("null-cb-shutdown") };
    let mut error = FFIError::default();
    let code = unsafe {
        boxlite_runtime_shutdown(runtime, 0, None, ptr::null_mut(), &mut error as *mut _)
    };
    assert_null_cb_rejected(code, &mut error);
    unsafe { boxlite_runtime_free(runtime) };
    let _ = std::fs::remove_dir_all(home_dir);
}
