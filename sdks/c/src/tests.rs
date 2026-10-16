use crate::error::error_to_c_error;
use crate::*;
use boxlite::BoxliteError;
use boxlite::runtime::BoxliteRuntime;
use std::ffi::{CStr, CString};
use std::mem::MaybeUninit;
use std::os::raw::{c_int, c_void};
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
fn test_box_network_null_pointer_validation() {
    unsafe {
        let mut error = FFIError::default();
        let mut network: *mut CBoxNetworkHandle = ptr::null_mut();
        let code = boxlite_box_network(ptr::null_mut(), &mut network, &mut error as *mut _);
        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        assert!(!error.message.is_null());
        boxlite_error_free(&mut error as *mut _);

        let handle = std::ptr::NonNull::<CBoxHandle>::dangling().as_ptr();
        let code = boxlite_box_network(handle, ptr::null_mut(), &mut error as *mut _);
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
        boxlite_free_image_detail(ptr::null_mut());
        boxlite_registry_free(ptr::null_mut());
        boxlite_free_registry_credential(ptr::null_mut());
        boxlite_free_registry_credential_list(ptr::null_mut());
        boxlite_box_free(ptr::null_mut());
        boxlite_network_free(ptr::null_mut());
        boxlite_tunnel_free(ptr::null_mut());
        boxlite_free_string(ptr::null_mut());
        boxlite_error_free(ptr::null_mut());
        boxlite_result_free(ptr::null_mut());
        boxlite_simple_free(ptr::null_mut());
        boxlite_execution_free(ptr::null_mut());
    }
}

extern "C" fn record_pull_code(
    result: *mut crate::images::CImagePullResult,
    err: *mut FFIError,
    ud: *mut c_void,
) {
    unsafe {
        crate::images::free_image_pull_result(result);
        *(ud as *mut Option<BoxliteErrorCode>) = Some((*err).code);
    }
}

/// A REST runtime hands out the image handle; what it refuses is `pull`,
/// since the server pulls an image when a box is created from it.
#[test]
fn test_rest_runtime_images_refuses_pull() {
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
    assert_eq!(code, BoxliteErrorCode::Ok);
    assert!(!image_handle.is_null());

    let mut pull_code: Option<BoxliteErrorCode> = None;
    let pull_code_slot: *mut Option<BoxliteErrorCode> = &mut pull_code;
    let image_ref = CString::new("alpine:latest").expect("image ref cstring");
    let queued = unsafe {
        boxlite_image_pull(
            image_handle,
            image_ref.as_ptr(),
            Some(record_pull_code),
            pull_code_slot as *mut c_void,
            &mut error as *mut _,
        )
    };
    assert_eq!(queued, BoxliteErrorCode::Ok);
    for _ in 0..20 {
        if unsafe { *pull_code_slot }.is_some() {
            break;
        }
        unsafe { boxlite_runtime_drain(&mut runtime_handle as *mut _, 500, &mut error as *mut _) };
    }

    assert_eq!(
        unsafe { *pull_code_slot },
        Some(BoxliteErrorCode::Unsupported)
    );
    unsafe {
        boxlite_error_free(&mut error as *mut _);
        boxlite_image_free(image_handle);
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

    let opts = unsafe { new_test_options() };
    let mut error = FFIError::default();

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
#[allow(deprecated)]
fn auto_remove_and_auto_delete_use_last_call_wins() {
    let opts = unsafe { new_test_options() };
    unsafe {
        boxlite_options_set_auto_delete_interval(opts, 60);
        boxlite_options_set_auto_remove(opts, 0);
        assert!(!(*opts).options.auto_remove);
        assert_eq!((*opts).options.auto_delete, None);

        boxlite_options_set_auto_remove(opts, 1);
        assert!((*opts).options.auto_remove);
        assert_eq!((*opts).options.auto_delete, None);

        boxlite_options_set_auto_delete_interval(opts, 60);
        assert_eq!((*opts).options.auto_delete, Some(60));

        boxlite_options_free(opts);
    }
}

#[test]
fn capability_lists_default_empty_and_preserve_custom_values() {
    let opts = unsafe { new_test_options() };
    let advanced = unsafe { new_test_advanced_options() };

    unsafe {
        assert!((*advanced).options.capabilities().is_none());
    }

    let cap_add = [
        CString::new("NET_ADMIN").unwrap(),
        CString::new("SYS_PTRACE").unwrap(),
    ];
    let cap_add_ptrs: Vec<*const std::os::raw::c_char> =
        cap_add.iter().map(|cap| cap.as_ptr()).collect();
    let cap_drop = [
        CString::new("MKNOD").unwrap(),
        CString::new("NET_RAW").unwrap(),
    ];
    let cap_drop_ptrs: Vec<*const std::os::raw::c_char> =
        cap_drop.iter().map(|cap| cap.as_ptr()).collect();

    unsafe {
        assert_eq!(
            boxlite_advanced_options_set_capabilities_add(
                advanced,
                cap_add_ptrs.as_ptr(),
                cap_add_ptrs.len() as c_int,
            ),
            BoxliteErrorCode::Ok
        );
        assert_eq!(
            boxlite_advanced_options_set_capabilities_drop(
                advanced,
                cap_drop_ptrs.as_ptr(),
                cap_drop_ptrs.len() as c_int
            ),
            BoxliteErrorCode::Ok
        );
        boxlite_options_set_advanced(opts, advanced);

        let capabilities = (*opts)
            .options
            .advanced
            .capabilities()
            .expect("capabilities set");
        assert_eq!(capabilities.add, ["NET_ADMIN", "SYS_PTRACE"]);
        assert_eq!(capabilities.drop, ["MKNOD", "NET_RAW"]);
        boxlite_advanced_options_free(advanced);
        boxlite_options_free(opts);
    }
}

#[test]
fn null_capability_element_cannot_weaken_policy() {
    let opts = unsafe { new_test_options() };
    let advanced = unsafe { new_test_advanced_options() };

    let malformed = [ptr::null()];
    unsafe {
        assert_eq!(
            boxlite_advanced_options_set_capabilities_drop(advanced, malformed.as_ptr(), 1),
            BoxliteErrorCode::InvalidArgument
        );
        boxlite_options_set_advanced(opts, advanced);
        (*opts)
            .options
            .sanitize()
            .expect_err("a null cap_drop element must fail closed");
        boxlite_advanced_options_free(advanced);
        boxlite_options_free(opts);
    }
}

#[test]
fn invalid_utf8_capability_cannot_weaken_policy() {
    let opts = unsafe { new_test_options() };
    let advanced = unsafe { new_test_advanced_options() };

    let invalid_utf8 = [0xff_u8, 0];
    let malformed = [invalid_utf8.as_ptr().cast::<std::os::raw::c_char>()];
    unsafe {
        assert_eq!(
            boxlite_advanced_options_set_capabilities_add(advanced, malformed.as_ptr(), 1),
            BoxliteErrorCode::InvalidArgument
        );
        boxlite_options_set_advanced(opts, advanced);
        (*opts)
            .options
            .sanitize()
            .expect_err("invalid UTF-8 in cap_add must fail closed");
        boxlite_advanced_options_free(advanced);
        boxlite_options_free(opts);
    }
}

#[test]
fn invalid_capability_count_and_null_array_fail_closed() {
    let advanced = unsafe { new_test_advanced_options() };

    unsafe {
        assert_eq!(
            boxlite_advanced_options_set_capabilities_add(advanced, ptr::null(), -1),
            BoxliteErrorCode::InvalidArgument
        );
        assert_eq!(
            boxlite_advanced_options_set_capabilities_drop(advanced, ptr::null(), 1),
            BoxliteErrorCode::InvalidArgument
        );
        assert_eq!(
            boxlite_advanced_options_set_capabilities_add(ptr::null_mut(), ptr::null(), 0),
            BoxliteErrorCode::InvalidArgument
        );
        boxlite_advanced_options_free(advanced);
    }
}

// Security is toggled through the advanced layer:
// `boxlite_advanced_options_set_security_enabled` selects the enabled/disabled
// profile on a `CAdvancedBoxOptions`, then `boxlite_options_set_advanced`
// clones the advanced options (security included) onto the box. This pins that
// each toggle lands on `advanced.security` as the matching profile; reverting
// either setter to a no-op flips it red.
#[test]
fn set_advanced_applies_security_profile_to_options() {
    use boxlite::SecurityOptions;

    let opts = unsafe { new_test_options() };

    let handle = opts;

    let apply_security = |enabled: c_int| {
        let advanced = unsafe { new_test_advanced_options() };
        unsafe { boxlite_advanced_options_set_security_enabled(advanced, enabled) };
        unsafe { boxlite_options_set_advanced(opts, advanced) };
        unsafe { boxlite_advanced_options_free(advanced) };
    };

    apply_security(0);
    assert_eq!(
        unsafe { &(*handle).options.advanced.security },
        &SecurityOptions::disabled(),
        "set_security_enabled(0) must apply the disabled profile"
    );

    apply_security(1);
    assert_eq!(
        unsafe { &(*handle).options.advanced.security },
        &SecurityOptions::enabled(),
        "set_security_enabled(non-zero) must apply the enabled (full) profile"
    );

    unsafe { boxlite_options_free(opts) };
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

// The out-slot is MaybeUninit, not a pointer set to ptr::null_mut(). CodeQL's
// invalid-pointer query follows a null initialiser through the out-parameter
// into every test that reads the result, and no null check after the call
// stops it. Both constructors write the slot whenever they return Ok.
unsafe fn new_test_options() -> *mut CBoxliteOptions {
    let image = CString::new("alpine:latest").expect("image cstring");
    let mut slot = MaybeUninit::<*mut CBoxliteOptions>::uninit();
    let mut error = FFIError::default();
    let code = unsafe { boxlite_options_new(image.as_ptr(), slot.as_mut_ptr(), &mut error) };
    assert_eq!(code, BoxliteErrorCode::Ok);
    let opts = unsafe { slot.assume_init() };
    assert!(
        !opts.is_null(),
        "boxlite_options_new returned null options pointer"
    );
    opts
}

unsafe fn new_test_advanced_options() -> *mut CAdvancedBoxOptions {
    let mut slot = MaybeUninit::<*mut CAdvancedBoxOptions>::uninit();
    let mut error = FFIError::default();
    let code = unsafe { boxlite_advanced_options_new(slot.as_mut_ptr(), &mut error) };
    assert_eq!(code, BoxliteErrorCode::Ok);
    let advanced = unsafe { slot.assume_init() };
    assert!(
        !advanced.is_null(),
        "boxlite_advanced_options_new returned null options pointer"
    );
    advanced
}

#[test]
fn add_port_stores_full_spec() {
    use boxlite::runtime::options::PortProtocol;

    let opts = unsafe { new_test_options() };
    let host_ip = CString::new("127.0.0.1").expect("host ip cstring");

    let code = unsafe {
        boxlite_options_add_port(
            opts,
            8080,
            80,
            BoxlitePortProtocol::BoxlitePortProtocolUdp,
            host_ip.as_ptr(),
        )
    };

    assert_eq!(code, BoxliteErrorCode::Ok);
    let ports = unsafe { &(*opts).options.ports };
    assert_eq!(ports.len(), 1);
    assert_eq!(ports[0].host_port, Some(8080));
    assert_eq!(ports[0].guest_port, 80);
    assert!(matches!(ports[0].protocol, PortProtocol::Udp));
    assert_eq!(ports[0].host_ip.as_deref(), Some("127.0.0.1"));
    unsafe { boxlite_options_free(opts) };
}

#[test]
fn add_port_zero_host_and_empty_ip_mean_defaults() {
    let opts = unsafe { new_test_options() };
    let empty_ip = CString::new("").expect("empty cstring");

    let null_ip_code = unsafe {
        boxlite_options_add_port(
            opts,
            0,
            80,
            BoxlitePortProtocol::BoxlitePortProtocolTcp,
            ptr::null(),
        )
    };
    let empty_ip_code = unsafe {
        boxlite_options_add_port(
            opts,
            443,
            443,
            BoxlitePortProtocol::BoxlitePortProtocolTcp,
            empty_ip.as_ptr(),
        )
    };

    assert_eq!(null_ip_code, BoxliteErrorCode::Ok);
    assert_eq!(empty_ip_code, BoxliteErrorCode::Ok);
    unsafe { boxlite_options_free(opts) };
}

#[test]
fn add_port_rejects_zero_guest_port_and_null_options() {
    let opts = unsafe { new_test_options() };

    let zero_guest_code = unsafe {
        boxlite_options_add_port(
            opts,
            8080,
            0,
            BoxlitePortProtocol::BoxlitePortProtocolTcp,
            ptr::null(),
        )
    };
    let null_opts_code = unsafe {
        boxlite_options_add_port(
            ptr::null_mut(),
            8080,
            80,
            BoxlitePortProtocol::BoxlitePortProtocolTcp,
            ptr::null(),
        )
    };

    assert_eq!(zero_guest_code, BoxliteErrorCode::InvalidArgument);
    assert_eq!(null_opts_code, BoxliteErrorCode::InvalidArgument);
    let ports = unsafe { &(*opts).options.ports };
    assert!(ports.is_empty(), "rejected spec must not be stored");
    unsafe { boxlite_options_free(opts) };
}

// `boxlite_options_set_user` is the FFI hop the Go SDK's `WithUser` rides on,
// and the cloud runner is its only caller today. Crossing it here proves the
// C string actually lands on `BoxOptions.user` rather than being dropped —
// which is what `user` did for its whole life before this: accepted by the
// API, stored as `osUser`, and never applied.
#[test]
fn options_set_user_lands_on_box_options() {
    let user = CString::new("1000:1000").expect("user cstring");
    let opts = unsafe { new_test_options() };

    assert!(
        unsafe { (*opts).options.user.is_none() },
        "a fresh BoxOptions must leave the image's USER directive in force"
    );

    unsafe { boxlite_options_set_user(opts, user.as_ptr()) };

    assert_eq!(
        unsafe { (*opts).options.user.as_deref() },
        Some("1000:1000"),
        "the user spec must reach BoxOptions"
    );

    unsafe { boxlite_options_free(opts) };
}

// A null user is a no-op, not a panic or a silent overwrite of an already-set
// value — the same contract every other nullable string setter here keeps.
#[test]
fn options_set_user_ignores_a_null_pointer() {
    let user = CString::new("nobody").expect("user cstring");
    let opts = unsafe { new_test_options() };

    unsafe { boxlite_options_set_user(opts, user.as_ptr()) };
    unsafe { boxlite_options_set_user(opts, ptr::null()) };

    assert_eq!(
        unsafe { (*opts).options.user.as_deref() },
        Some("nobody"),
        "a null user must not clear an already-set value"
    );

    unsafe { boxlite_options_free(opts) };
}

// ─── Image catalog: get / remove / usage through the C entry points ────────
//
// A REST runtime here talks to a loopback server started by the test, so each
// value a callback sees crossed HTTP, the core client, the C conversion and
// the drain-thread dispatch. Callbacks only copy what they receive, because a
// panic cannot unwind out of an `extern "C" fn`; the tests assert afterwards.
mod image_catalog {
    use super::new_test_runtime_handle;
    use crate::images::ImageHandle;
    use crate::runtime::RuntimeHandle;
    use crate::*;
    use std::ffi::{CStr, CString};
    use std::io::{BufRead, BufReader, Write};
    use std::mem::MaybeUninit;
    use std::net::{TcpListener, TcpStream};
    use std::os::raw::{c_char, c_int, c_void};
    use std::path::PathBuf;
    use std::ptr;
    use std::sync::atomic::Ordering;
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::thread;
    use std::time::Duration;

    /// 2026-09-01T00:00:00Z and 2026-08-15T12:30:00Z in Unix seconds.
    const NEWER_RECORDED_AT: i64 = 1_788_220_800;
    const OLDER_RECORDED_AT: i64 = 1_786_797_000;

    /// The canned answer to one exact request line.
    struct Route {
        request_line: &'static str,
        status: &'static str,
        body: &'static str,
    }

    const APP_DETAIL: Route = Route {
        request_line: "GET /v1/images/quay.io%2Facme%2Fapp HTTP/1.1",
        status: "200 OK",
        body: r#"{"name":"quay.io/acme/app","aliases":["v1","v2"],"curated":true,"versions":[{"digest":"sha256:bb","size_bytes":4096,"source_ref":"quay.io/acme/app:v2","recorded_at":"2026-09-01T00:00:00Z"},{"digest":"sha256:aa","size_bytes":null,"source_ref":"quay.io/acme/app:v1","recorded_at":"2026-08-15T12:30:00Z"}]}"#,
    };
    const BARE_DETAIL: Route = Route {
        request_line: "GET /v1/images/docker.io%2Flibrary%2Fbusybox HTTP/1.1",
        status: "200 OK",
        body: r#"{"name":"docker.io/library/busybox","aliases":[],"curated":false,"versions":[]}"#,
    };
    const GONE_DETAIL: Route = Route {
        request_line: "GET /v1/images/quay.io%2Facme%2Fgone HTTP/1.1",
        status: "404 Not Found",
        body: r#"{"error":{"message":"no image named quay.io/acme/gone","type":"NotFoundError","code":"not_found"}}"#,
    };
    const APP_REMOVED: Route = Route {
        request_line: "DELETE /v1/images/quay.io%2Facme%2Fapp HTTP/1.1",
        status: "204 No Content",
        body: "",
    };
    const APP_IN_USE: Route = Route {
        request_line: "DELETE /v1/images/quay.io%2Facme%2Fapp HTTP/1.1",
        status: "409 Conflict",
        body: r#"{"error":{"message":"in use by box b1","type":"InvalidStateError","code":"invalid_state"}}"#,
    };
    const USAGE: Route = Route {
        request_line: "GET /v1/images/usage HTTP/1.1",
        status: "200 OK",
        body: r#"{"count":3,"limit":20,"known_bytes":8192}"#,
    };
    const NO_ROUTE_BODY: &str =
        r#"{"error":{"message":"no route for this request line","code":"not_found"}}"#;

    /// Answers one connection per route on a loopback port, then exits. A
    /// request line no route names gets a 404, so a name sent as three path
    /// segments instead of one fails. Each request line goes on the returned
    /// channel before its answer is written, so it is there by the time the
    /// callback for that request runs.
    fn serve(routes: &'static [Route]) -> (String, Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback listener");
        let address = listener.local_addr().expect("loopback listener address");
        let (seen, requests) = mpsc::channel();
        thread::spawn(move || {
            for stream in listener.incoming().take(routes.len()) {
                answer(stream.expect("accept connection"), routes, &seen);
            }
        });
        (format!("http://{address}"), requests)
    }

    fn answer(mut stream: TcpStream, routes: &[Route], seen: &Sender<String>) {
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .expect("set read timeout");
        let mut request_line = String::new();
        {
            let mut reader = BufReader::new(&stream);
            reader
                .read_line(&mut request_line)
                .expect("read request line");
            let mut header = String::new();
            // A bare "\r\n" ends the head; GET and DELETE carry no body.
            while reader.read_line(&mut header).expect("read header") > 2 {
                header.clear();
            }
        }
        let request_line = request_line.trim_end().to_owned();
        let (status, body) = routes
            .iter()
            .find(|route| route.request_line == request_line)
            .map_or(("404 Not Found", NO_ROUTE_BODY), |route| {
                (route.status, route.body)
            });
        let _ = seen.send(request_line);
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream
            .write_all(response.as_bytes())
            .expect("write response");
    }

    /// What one callback received, copied out before it returned.
    struct Delivery<T> {
        /// `None` until the callback runs.
        code: Option<BoxliteErrorCode>,
        message: String,
        value: Option<T>,
    }

    impl<T> Delivery<T> {
        fn pending() -> Self {
            Self {
                code: None,
                message: String::new(),
                value: None,
            }
        }

        unsafe fn record_error(&mut self, error: *const FFIError) {
            let error = unsafe { &*error };
            self.code = Some(error.code);
            self.message = unsafe { owned_string(error.message) };
        }
    }

    #[derive(Debug, PartialEq)]
    struct VersionSeen {
        digest: String,
        size_bytes: u64,
        has_size: c_int,
        source_ref: String,
        recorded_at: i64,
    }

    #[derive(Debug, PartialEq)]
    struct DetailSeen {
        name: String,
        aliases: Vec<String>,
        curated: c_int,
        versions: Vec<VersionSeen>,
        /// The documented contract: an array pointer is null exactly when its
        /// count is zero.
        arrays_null_iff_empty: bool,
        /// Strings `boxlite_free_image_detail` reclaimed.
        strings_freed: usize,
    }

    type UsageSeen = (u64, u64, u64);

    unsafe fn owned_string(s: *const c_char) -> String {
        if s.is_null() {
            return "<null>".to_owned();
        }
        unsafe { CStr::from_ptr(s) }.to_string_lossy().into_owned()
    }

    /// The `count` entries at `items`, or none when either says the array is
    /// empty.
    unsafe fn entries<'a, T>(items: *const T, count: c_int) -> &'a [T] {
        match usize::try_from(count) {
            Ok(len) if len > 0 && !items.is_null() => unsafe {
                std::slice::from_raw_parts(items, len)
            },
            _ => &[],
        }
    }

    extern "C" fn record_detail(
        detail: *mut CImageDetail,
        error: *mut FFIError,
        user_data: *mut c_void,
    ) {
        unsafe {
            let delivery = &mut *user_data.cast::<Delivery<DetailSeen>>();
            delivery.record_error(error);
            let Some(seen) = detail.as_ref() else {
                return;
            };
            let name = owned_string(seen.name);
            let aliases = entries(seen.aliases, seen.aliases_count)
                .iter()
                .map(|&tag| owned_string(tag))
                .collect();
            let versions = entries(seen.versions, seen.versions_count)
                .iter()
                .map(|version| VersionSeen {
                    digest: owned_string(version.digest),
                    size_bytes: version.size_bytes,
                    has_size: version.has_size,
                    source_ref: owned_string(version.source_ref),
                    recorded_at: version.recorded_at,
                })
                .collect();
            let arrays_null_iff_empty = seen.aliases.is_null() == (seen.aliases_count == 0)
                && seen.versions.is_null() == (seen.versions_count == 0);
            let curated = seen.curated;

            let before = FREE_STR_CALLS.load(Ordering::SeqCst);
            boxlite_free_image_detail(detail);
            let strings_freed = FREE_STR_CALLS.load(Ordering::SeqCst) - before;

            delivery.value = Some(DetailSeen {
                name,
                aliases,
                curated,
                versions,
                arrays_null_iff_empty,
                strings_freed,
            });
        }
    }

    extern "C" fn record_removal(error: *mut FFIError, user_data: *mut c_void) {
        unsafe { (*user_data.cast::<Delivery<()>>()).record_error(error) };
    }

    extern "C" fn record_usage(
        usage: *mut CImageUsage,
        error: *mut FFIError,
        user_data: *mut c_void,
    ) {
        unsafe {
            let delivery = &mut *user_data.cast::<Delivery<UsageSeen>>();
            delivery.record_error(error);
            if let Some(usage) = usage.as_ref() {
                delivery.value = Some((usage.count, usage.limit, usage.known_bytes));
            }
        }
    }

    /// Asserts a call returned `expected` and wrote an error naming
    /// `mention`, then frees that error.
    fn assert_refused(
        code: BoxliteErrorCode,
        expected: BoxliteErrorCode,
        error: &mut FFIError,
        mention: &str,
    ) {
        let message = unsafe { owned_string(error.message) };
        unsafe { boxlite_error_free(error) };
        assert_eq!(code, expected, "{message}");
        assert!(
            message.contains(mention),
            "expected {mention:?} in {message:?}"
        );
    }

    /// A runtime's image handle as a C caller holds it. Dropping it frees
    /// both handles.
    struct Images {
        runtime: *mut RuntimeHandle,
        handle: *mut ImageHandle,
        /// Request lines the loopback server received, for a REST runtime.
        requests: Option<Receiver<String>>,
        home_dir: Option<PathBuf>,
    }

    impl Images {
        fn on_rest_server(routes: &'static [Route]) -> Self {
            let (base_url, requests) = serve(routes);
            let base_url = CString::new(base_url).expect("base url cstring");
            let mut options = MaybeUninit::<*mut CBoxliteRestOptions>::uninit();
            let mut runtime = MaybeUninit::<*mut RuntimeHandle>::uninit();
            let mut error = FFIError::default();
            unsafe {
                let code =
                    boxlite_rest_options_new(base_url.as_ptr(), options.as_mut_ptr(), &mut error);
                assert_eq!(code, BoxliteErrorCode::Ok);
                let options = options.assume_init();
                let code = boxlite_rest_runtime_new_with_options(
                    options,
                    runtime.as_mut_ptr(),
                    &mut error,
                );
                boxlite_rest_options_free(options);
                assert_eq!(code, BoxliteErrorCode::Ok);
                Self::of(runtime.assume_init(), Some(requests), None)
            }
        }

        fn on_local_runtime(prefix: &str) -> Self {
            let (runtime, home_dir) = unsafe { new_test_runtime_handle(prefix) };
            Self::of(runtime, None, Some(home_dir))
        }

        fn of(
            runtime: *mut RuntimeHandle,
            requests: Option<Receiver<String>>,
            home_dir: Option<PathBuf>,
        ) -> Self {
            let mut handle = MaybeUninit::<*mut ImageHandle>::uninit();
            let mut error = FFIError::default();
            let code = unsafe { boxlite_runtime_images(runtime, handle.as_mut_ptr(), &mut error) };
            assert_eq!(code, BoxliteErrorCode::Ok);
            Self {
                runtime,
                handle: unsafe { handle.assume_init() },
                requests,
                home_dir,
            }
        }

        fn get(&self, name: &CStr) -> Delivery<DetailSeen> {
            // The callback counts the strings it frees; holding the lock keeps
            // other tests' frees out of that count.
            let _counting = FREE_STR_LOCK.lock().unwrap();
            let handle = self.handle;
            self.deliver(|user_data, error| unsafe {
                boxlite_image_get(handle, name.as_ptr(), Some(record_detail), user_data, error)
            })
        }

        fn remove(&self, name: &CStr) -> Delivery<()> {
            let handle = self.handle;
            self.deliver(|user_data, error| unsafe {
                boxlite_image_remove(
                    handle,
                    name.as_ptr(),
                    Some(record_removal),
                    user_data,
                    error,
                )
            })
        }

        fn usage(&self) -> Delivery<UsageSeen> {
            let handle = self.handle;
            self.deliver(|user_data, error| unsafe {
                boxlite_image_usage(handle, Some(record_usage), user_data, error)
            })
        }

        /// Queues one call with a fresh delivery slot, then drains until its
        /// callback has run.
        fn deliver<T>(
            &self,
            queue_call: impl FnOnce(*mut c_void, *mut FFIError) -> BoxliteErrorCode,
        ) -> Delivery<T> {
            let mut delivery = Delivery::pending();
            let slot: *mut Delivery<T> = &mut delivery;
            let mut error = FFIError::default();
            let code = queue_call(slot.cast(), &mut error);
            assert_eq!(code, BoxliteErrorCode::Ok, "{}", unsafe {
                owned_string(error.message)
            });
            for _ in 0..20 {
                if unsafe { (*slot).code.is_some() } {
                    break;
                }
                let dispatched = unsafe { boxlite_runtime_drain(self.runtime, 500, &mut error) };
                assert!(dispatched >= 0, "drain failed");
            }
            assert!(
                unsafe { (*slot).code.is_some() },
                "the callback did not run within 10s"
            );
            delivery
        }

        fn requests_received(&self) -> Vec<String> {
            let requests = self.requests.as_ref().expect("a REST runtime's server");
            requests.try_iter().collect()
        }

        fn free_runtime(&mut self) {
            unsafe { boxlite_runtime_free(self.runtime) };
            self.runtime = ptr::null_mut();
        }
    }

    impl Drop for Images {
        fn drop(&mut self) {
            unsafe {
                boxlite_image_free(self.handle);
                boxlite_runtime_free(self.runtime);
            }
            if let Some(home_dir) = &self.home_dir {
                let _ = std::fs::remove_dir_all(home_dir);
            }
        }
    }

    #[test]
    fn get_on_rest_runtime_hands_over_every_version_newest_first() {
        let images = Images::on_rest_server(&[APP_DETAIL]);

        let got = images.get(c"quay.io/acme/app");

        assert_eq!(images.requests_received(), [APP_DETAIL.request_line]);
        assert_eq!(got.code, Some(BoxliteErrorCode::Ok), "{}", got.message);
        let newer = VersionSeen {
            digest: "sha256:bb".into(),
            size_bytes: 4096,
            has_size: 1,
            source_ref: "quay.io/acme/app:v2".into(),
            recorded_at: NEWER_RECORDED_AT,
        };
        let older = VersionSeen {
            digest: "sha256:aa".into(),
            size_bytes: 0,
            has_size: 0,
            source_ref: "quay.io/acme/app:v1".into(),
            recorded_at: OLDER_RECORDED_AT,
        };
        let expected = DetailSeen {
            name: "quay.io/acme/app".into(),
            aliases: vec!["v1".into(), "v2".into()],
            curated: 1,
            versions: vec![newer, older],
            arrays_null_iff_empty: true,
            // The name, two aliases, and each version's digest and source_ref.
            strings_freed: 7,
        };
        assert_eq!(got.value, Some(expected));
    }

    #[test]
    fn get_of_a_name_with_no_aliases_or_versions_hands_over_null_arrays() {
        let images = Images::on_rest_server(&[BARE_DETAIL]);

        let got = images.get(c"docker.io/library/busybox");

        assert_eq!(images.requests_received(), [BARE_DETAIL.request_line]);
        assert_eq!(got.code, Some(BoxliteErrorCode::Ok), "{}", got.message);
        let expected = DetailSeen {
            name: "docker.io/library/busybox".into(),
            aliases: vec![],
            curated: 0,
            versions: vec![],
            arrays_null_iff_empty: true,
            strings_freed: 1,
        };
        assert_eq!(got.value, Some(expected));
    }

    #[test]
    fn get_of_a_name_the_server_does_not_hold_is_not_found_without_a_detail() {
        let images = Images::on_rest_server(&[GONE_DETAIL]);

        let got = images.get(c"quay.io/acme/gone");

        assert_eq!(images.requests_received(), [GONE_DETAIL.request_line]);
        assert_eq!(
            got.code,
            Some(BoxliteErrorCode::NotFound),
            "{}",
            got.message
        );
        assert!(
            got.message.contains("no image named quay.io/acme/gone"),
            "{}",
            got.message
        );
        assert_eq!(got.value, None);
    }

    #[test]
    fn remove_on_rest_runtime_deletes_the_name_as_one_segment() {
        let images = Images::on_rest_server(&[APP_REMOVED]);

        let removed = images.remove(c"quay.io/acme/app");

        assert_eq!(images.requests_received(), [APP_REMOVED.request_line]);
        assert_eq!(
            removed.code,
            Some(BoxliteErrorCode::Ok),
            "{}",
            removed.message
        );
    }

    #[test]
    fn remove_of_an_image_a_box_uses_is_invalid_state_naming_the_box() {
        let images = Images::on_rest_server(&[APP_IN_USE]);

        let removed = images.remove(c"quay.io/acme/app");

        assert_eq!(images.requests_received(), [APP_IN_USE.request_line]);
        assert_eq!(
            removed.code,
            Some(BoxliteErrorCode::InvalidState),
            "{}",
            removed.message
        );
        assert!(
            removed.message.contains("in use by box b1"),
            "{}",
            removed.message
        );
    }

    #[test]
    fn usage_on_rest_runtime_reads_count_limit_and_known_bytes() {
        let images = Images::on_rest_server(&[USAGE]);

        let usage = images.usage();

        assert_eq!(images.requests_received(), [USAGE.request_line]);
        assert_eq!(usage.code, Some(BoxliteErrorCode::Ok), "{}", usage.message);
        assert_eq!(usage.value, Some((3, 20, 8192)));
    }

    #[test]
    fn usage_on_a_local_runtime_is_unsupported_without_a_value() {
        let images = Images::on_local_runtime("images-usage");

        let usage = images.usage();

        assert_eq!(
            usage.code,
            Some(BoxliteErrorCode::Unsupported),
            "{}",
            usage.message
        );
        assert_eq!(usage.value, None);
    }

    #[test]
    fn a_tagged_reference_reaches_the_callback_as_invalid_argument() {
        let images = Images::on_local_runtime("images-tagged");

        let got = images.get(c"quay.io/acme/app:v1");
        let removed = images.remove(c"quay.io/acme/app:v1");

        assert_eq!(
            got.code,
            Some(BoxliteErrorCode::InvalidArgument),
            "{}",
            got.message
        );
        assert!(
            got.message.contains("such as 'quay.io/acme/app'"),
            "{}",
            got.message
        );
        assert_eq!(got.value, None);
        assert_eq!(
            removed.code,
            Some(BoxliteErrorCode::InvalidArgument),
            "{}",
            removed.message
        );
        assert!(
            removed.message.contains("such as 'quay.io/acme/app'"),
            "{}",
            removed.message
        );
    }

    #[test]
    fn bad_arguments_are_refused_before_the_call_is_queued() {
        use BoxliteErrorCode::InvalidArgument;

        let images = Images::on_local_runtime("images-bad-args");
        let handle = images.handle;
        let name = c"quay.io/acme/app".as_ptr();
        let not_utf8 = [0xff_u8, 0];
        let not_utf8 = not_utf8.as_ptr().cast::<c_char>();
        let no_data = ptr::null_mut();
        let mut error = FFIError::default();
        let e = &mut error as *mut FFIError;

        unsafe {
            let no_handle = ptr::null_mut();
            let code = boxlite_image_get(no_handle, name, Some(record_detail), no_data, e);
            assert_refused(code, InvalidArgument, &mut *e, "handle is null");
            let code = boxlite_image_remove(no_handle, name, Some(record_removal), no_data, e);
            assert_refused(code, InvalidArgument, &mut *e, "handle is null");
            let code = boxlite_image_usage(no_handle, Some(record_usage), no_data, e);
            assert_refused(code, InvalidArgument, &mut *e, "handle is null");

            let code = boxlite_image_get(handle, ptr::null(), Some(record_detail), no_data, e);
            assert_refused(code, InvalidArgument, &mut *e, "name is null");
            let code = boxlite_image_remove(handle, ptr::null(), Some(record_removal), no_data, e);
            assert_refused(code, InvalidArgument, &mut *e, "name is null");

            let code = boxlite_image_get(handle, not_utf8, Some(record_detail), no_data, e);
            assert_refused(code, InvalidArgument, &mut *e, "name is not UTF-8");
            let code = boxlite_image_remove(handle, not_utf8, Some(record_removal), no_data, e);
            assert_refused(code, InvalidArgument, &mut *e, "name is not UTF-8");

            let code = boxlite_image_get(handle, name, None, no_data, e);
            assert_refused(code, InvalidArgument, &mut *e, "cb is null");
            let code = boxlite_image_remove(handle, name, None, no_data, e);
            assert_refused(code, InvalidArgument, &mut *e, "cb is null");
            let code = boxlite_image_usage(handle, None, no_data, e);
            assert_refused(code, InvalidArgument, &mut *e, "cb is null");
        }
    }

    #[test]
    fn calls_after_the_runtime_is_freed_are_stopped_naming_the_action() {
        use BoxliteErrorCode::Stopped;

        let mut images = Images::on_local_runtime("images-freed");
        images.free_runtime();
        let handle = images.handle;
        let name = c"quay.io/acme/app".as_ptr();
        let no_data = ptr::null_mut();
        let mut error = FFIError::default();
        let e = &mut error as *mut FFIError;

        unsafe {
            let code = boxlite_image_get(handle, name, Some(record_detail), no_data, e);
            assert_refused(code, Stopped, &mut *e, "Cannot get image");
            let code = boxlite_image_remove(handle, name, Some(record_removal), no_data, e);
            assert_refused(code, Stopped, &mut *e, "Cannot remove image");
            let code = boxlite_image_usage(handle, Some(record_usage), no_data, e);
            assert_refused(code, Stopped, &mut *e, "Cannot read image usage");
        }
    }

    /// A detail that reached the queue but was never drained belongs to no
    /// one; freeing the runtime must free it, and must not call back.
    #[test]
    fn a_detail_never_drained_is_reclaimed_when_the_runtime_is_freed() {
        let mut images = Images::on_rest_server(&[APP_DETAIL]);
        let _counting = FREE_STR_LOCK.lock().unwrap();
        let mut delivery = Delivery::<DetailSeen>::pending();
        let slot: *mut Delivery<DetailSeen> = &mut delivery;
        let mut error = FFIError::default();

        let code = unsafe {
            boxlite_image_get(
                images.handle,
                c"quay.io/acme/app".as_ptr(),
                Some(record_detail),
                slot.cast(),
                &mut error,
            )
        };
        assert_eq!(code, BoxliteErrorCode::Ok);
        let queue = unsafe { (*images.runtime).queue.clone() };
        let pending = queue.inner.lock().unwrap();
        let (pending, waited) = queue
            .cv
            .wait_timeout_while(pending, Duration::from_secs(10), |events| events.is_empty())
            .unwrap();
        assert!(!waited.timed_out(), "the detail never reached the queue");
        drop(pending);

        let before = FREE_STR_CALLS.load(Ordering::SeqCst);
        images.free_runtime();
        let strings_freed = FREE_STR_CALLS.load(Ordering::SeqCst) - before;

        assert_eq!(images.requests_received(), [APP_DETAIL.request_line]);
        assert_eq!(
            strings_freed, 7,
            "the queued detail's strings were not freed"
        );
        assert!(
            delivery.code.is_none(),
            "a dropped event reached its callback"
        );
    }
}
