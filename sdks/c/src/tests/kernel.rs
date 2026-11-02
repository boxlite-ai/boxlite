use super::*;

#[test]
fn kernel_path_setter_validates_and_copies_the_path() {
    unsafe {
        let path = unique_test_home("kernel-file");
        std::fs::write(&path, b"\x7fELFfixture").unwrap();
        let advanced = new_test_advanced_options();
        let mut error = FFIError::default();
        let input = CString::new(path.to_str().unwrap()).unwrap();
        assert_eq!(
            boxlite_advanced_options_set_kernel_path(advanced, input.as_ptr(), &mut error),
            BoxliteErrorCode::Ok
        );
        drop(input);
        assert_eq!((*advanced).options.kernel.as_ref().unwrap().path, path);
        for (invalid, expected) in [
            (ptr::null(), BoxliteErrorCode::InvalidArgument),
            (c"/kernel-\xff".as_ptr(), BoxliteErrorCode::InvalidArgument),
            (c"relative/kernel".as_ptr(), BoxliteErrorCode::Config),
            (c"/missing/kernel.bin".as_ptr(), BoxliteErrorCode::Config),
        ] {
            assert_eq!(
                boxlite_advanced_options_set_kernel_path(advanced, invalid, &mut error),
                expected
            );
            assert_eq!(error.code, expected);
            boxlite_error_free(&mut error);
            assert_eq!((*advanced).options.kernel.as_ref().unwrap().path, path);
        }
        assert_eq!(
            boxlite_advanced_options_set_kernel_path(
                ptr::null_mut(),
                c"/missing".as_ptr(),
                &mut error
            ),
            BoxliteErrorCode::InvalidArgument
        );
        boxlite_error_free(&mut error);
        boxlite_advanced_options_free(advanced);
        std::fs::remove_file(path).unwrap();
    }
}

#[test]
fn kernel_runtime_constructor_applies_the_feature_gate() {
    for features in [c"", c"custom-kernel"] {
        unsafe {
            let home = unique_test_home("kernel-runtime");
            let c_home = CString::new(home.to_str().unwrap()).unwrap();
            let mut handle = MaybeUninit::<*mut RuntimeHandle>::uninit();
            let mut error = FFIError::default();
            assert_eq!(
                boxlite_runtime_new_experimental(
                    c_home.as_ptr(),
                    ptr::null(),
                    0,
                    features.as_ptr(),
                    handle.as_mut_ptr(),
                    &mut error
                ),
                BoxliteErrorCode::Ok
            );
            let handle = handle.assume_init();
            assert!(!handle.is_null());
            let mut options = boxlite::BoxOptions::default();
            options.advanced.kernel = Some(
                boxlite::experimental::custom_kernel::KernelOptions::new("/missing/kernel.bin"),
            );
            let error = (*handle)
                .tokio_rt
                .block_on((*handle).runtime.create(options, None))
                .err()
                .unwrap();
            let expected = if features == c"" {
                "disabled"
            } else {
                "regular file"
            };
            assert!(error.to_string().contains(expected), "{error}");
            boxlite_runtime_free(handle);
            std::fs::remove_dir_all(home).unwrap();
        }
    }
}

#[test]
fn kernel_runtime_constructor_rejects_unknown_features_before_initializing() {
    assert_invalid_runtime_features(c"custom-kernel,unknown", "unknown feature");
}

#[test]
fn kernel_runtime_constructor_rejects_empty_features_before_initializing() {
    assert_invalid_runtime_features(c"custom-kernel,", "empty feature name");
}

fn assert_invalid_runtime_features(features: &CStr, expected: &str) {
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
                &mut error
            ),
            BoxliteErrorCode::Config
        );
        assert!(runtime.is_null());
        let message = CStr::from_ptr(error.message).to_str().unwrap().to_owned();
        boxlite_error_free(&mut error);
        assert!(message.contains(expected), "{message}");
        assert!(!message.contains("BOXLITE_EXPERIMENTAL"), "{message}");
    }
}
