use super::*;

#[test]
fn nested_virtualization_environment_allows_ffi_creation_and_reuse() {
    const CHILD: &str = "BOXLITE_NESTED_FFI_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tests::nested_virtualization::nested_virtualization_environment_allows_ffi_creation_and_reuse", "--nocapture"])
            .env(CHILD, "1")
            .env("BOXLITE_EXPERIMENTAL", "nested-virtualization")
            .output().unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    unsafe {
        let (runtime, home) = new_test_runtime_handle("nested-env");
        let handle = runtime.as_ref().unwrap();
        handle.tokio_rt.block_on(async {
            let first = handle
                .runtime
                .create(boxlite::BoxOptions::default(), Some("env-box".into()))
                .await
                .unwrap();
            let (reused, created) = handle
                .runtime
                .get_or_create(boxlite::BoxOptions::default(), Some("env-box".into()))
                .await
                .expect("ENV-enabled runtime must reuse the saved box");
            assert!(!created);
            assert_eq!(first.id(), reused.id());
        });
        boxlite_runtime_free(runtime);
        std::fs::remove_dir_all(home).unwrap();
    }
}

#[test]
fn nested_virtualization_setter_updates_options_and_rejects_null() {
    unsafe {
        let mut advanced = ptr::null_mut();
        let mut error = FFIError::default();
        assert_eq!(
            boxlite_advanced_options_new(&mut advanced, &mut error),
            BoxliteErrorCode::Ok
        );
        for value in [1, 0, -1] {
            assert_eq!(
                boxlite_internal_advanced_options_set_nested_virtualization(advanced, value),
                BoxliteErrorCode::Ok
            );
            let options = &advanced
                .as_ref()
                .expect("the handle stays live until it is freed")
                .options;
            assert_eq!(
                serde_json::to_value(options).unwrap()["nested_virtualization"],
                value != 0
            );
            assert!(!options.privileged);
        }
        boxlite_advanced_options_free(advanced);
        assert_eq!(
            boxlite_internal_advanced_options_set_nested_virtualization(ptr::null_mut(), 1),
            BoxliteErrorCode::InvalidArgument
        );
    }
}

#[test]
fn nested_virtualization_managed_runtime_preserves_explicit_authorization() {
    for enabled in [false, true] {
        unsafe {
            let home = unique_test_home("nested-managed");
            let c_home = CString::new(home.to_str().unwrap()).unwrap();
            let mut runtime = ptr::null_mut();
            let mut error = FFIError::default();
            assert_eq!(
                boxlite_internal_runtime_new_runner(
                    c_home.as_ptr(),
                    ptr::null(),
                    0,
                    if enabled {
                        c"nested-virtualization".as_ptr()
                    } else {
                        ptr::null()
                    },
                    &mut runtime,
                    &mut error
                ),
                BoxliteErrorCode::Ok
            );
            let options: boxlite::BoxOptions = serde_json::from_value(
                serde_json::json!({"advanced":{"nested_virtualization":true}}),
            )
            .unwrap();
            let handle = runtime.as_ref().unwrap();
            let result = handle
                .tokio_rt
                .block_on(handle.runtime.create(options, None));
            if enabled {
                assert!(result.is_ok(), "{:?}", result.err());
            } else {
                assert!(result.err().unwrap().to_string().contains("disabled"));
            }
            boxlite_runtime_free(runtime);
            std::fs::remove_dir_all(home).unwrap();
        }
    }
}

#[test]
fn nested_virtualization_runtime_rejects_null_output() {
    unsafe {
        let mut error = FFIError::default();
        assert_eq!(
            boxlite_runtime_new_experimental(
                ptr::null(),
                ptr::null(),
                0,
                c"nested-virtualization".as_ptr(),
                ptr::null_mut(),
                &mut error,
            ),
            BoxliteErrorCode::InvalidArgument
        );
        assert!(
            CStr::from_ptr(error.message)
                .to_str()
                .unwrap()
                .contains("out_runtime")
        );
        boxlite_error_free(&mut error);
    }
}

#[test]
fn nested_virtualization_runtime_rejects_invalid_features_before_initializing() {
    for features in [
        c"unknown",
        c"nested-virtualization,",
        c",nested-virtualization",
    ] {
        unsafe {
            let mut runtime = ptr::null_mut();
            let mut error = FFIError::default();
            assert_eq!(
                boxlite_runtime_new_experimental(
                    ptr::null(),
                    ptr::null(),
                    0,
                    features.as_ptr(),
                    &mut runtime,
                    &mut error,
                ),
                BoxliteErrorCode::Config
            );
            assert!(runtime.is_null());
            assert!(
                CStr::from_ptr(error.message)
                    .to_str()
                    .unwrap()
                    .contains("feature")
            );
            boxlite_error_free(&mut error);
        }
    }
}

#[test]
fn nested_virtualization_runtime_rejects_invalid_utf8_as_invalid_argument() {
    unsafe {
        let invalid = [0xffu8, 0];
        let mut runtime = ptr::null_mut();
        let mut error = FFIError::default();
        assert_eq!(
            boxlite_runtime_new_experimental(
                ptr::null(),
                ptr::null(),
                0,
                invalid.as_ptr().cast(),
                &mut runtime,
                &mut error,
            ),
            BoxliteErrorCode::InvalidArgument
        );
        assert!(runtime.is_null());
        assert!(!error.message.is_null());
        assert!(
            CStr::from_ptr(error.message)
                .to_str()
                .unwrap()
                .contains("UTF-8")
        );
        boxlite_error_free(&mut error);
    }
}
