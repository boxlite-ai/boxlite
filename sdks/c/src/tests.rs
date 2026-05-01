use crate::error::error_to_c_error;
use crate::images::CImagePullResult;
use crate::*;
use boxlite::BoxliteError;
use boxlite::runtime::BoxliteRuntime;
use std::ffi::{CStr, CString};
use std::path::PathBuf;
use std::ptr;
use std::time::{SystemTime, UNIX_EPOCH};

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
        liveness: std::sync::Arc::new(crate::runtime::RuntimeLiveness::new()),
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

    let shutdown_code = unsafe { boxlite_runtime_shutdown(runtime, 0, &mut error as *mut _) };
    assert_eq!(shutdown_code, BoxliteErrorCode::Ok);
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
    let mut pull_result: *mut CImagePullResult = ptr::null_mut();
    let pull_code = unsafe {
        boxlite_image_pull(
            image_handle,
            image_ref.as_ptr(),
            &mut pull_result as *mut _,
            &mut error as *mut _,
        )
    };
    assert_eq!(pull_code, BoxliteErrorCode::Stopped);
    assert!(pull_result.is_null());
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
