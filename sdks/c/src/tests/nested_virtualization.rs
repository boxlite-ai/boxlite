use super::*;

#[test]
fn nested_virtualization_setter_updates_options_and_rejects_null() {
    unsafe {
        let mut advanced = ptr::null_mut();
        let mut error = FFIError::default();
        assert_eq!(
            boxlite_advanced_options_new(&mut advanced, &mut error),
            BoxliteErrorCode::Ok
        );
        assert!(!(*advanced).options.nested_virtualization);
        for value in [1, 0, -1] {
            assert_eq!(
                boxlite_advanced_options_set_nested_virtualization(advanced, value),
                BoxliteErrorCode::Ok
            );
            assert_eq!((*advanced).options.nested_virtualization, value != 0);
            assert!(!(*advanced).options.privileged);
        }
        boxlite_advanced_options_free(advanced);
        assert_eq!(
            boxlite_advanced_options_set_nested_virtualization(ptr::null_mut(), 1),
            BoxliteErrorCode::InvalidArgument
        );
    }
}

#[test]
fn nested_virtualization_runtime_constructors_preserve_explicit_authorization() {
    // Legacy, null and empty inputs enable nothing; the named feature must
    // cross the FFI/runtime boundary.
    for (legacy, features) in [
        (true, None),
        (false, None),
        (false, Some(c"")),
        (false, Some(c"nested-virtualization")),
    ] {
        unsafe {
            let home = unique_test_home("nested-runtime");
            let c_home = CString::new(home.to_str().unwrap()).unwrap();
            let mut runtime = ptr::null_mut();
            let mut error = FFIError::default();
            let code = if legacy {
                boxlite_runtime_new(c_home.as_ptr(), ptr::null(), 0, &mut runtime, &mut error)
            } else {
                boxlite_runtime_new_experimental(
                    c_home.as_ptr(),
                    ptr::null(),
                    0,
                    features.map_or(ptr::null(), CStr::as_ptr),
                    &mut runtime,
                    &mut error,
                )
            };
            assert_eq!(code, BoxliteErrorCode::Ok);
            let mut options = boxlite::BoxOptions::default();
            options.advanced.nested_virtualization = true;
            let result = (*runtime)
                .tokio_rt
                .block_on((*runtime).runtime.create(options, None));
            if features == Some(c"nested-virtualization") {
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
