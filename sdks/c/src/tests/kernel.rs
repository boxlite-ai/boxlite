use super::*;

#[test]
fn kernel_path_setter_validates_and_copies_the_path() {
    unsafe {
        let path = unique_test_home("kernel-file");
        std::fs::write(&path, b"\x7fELFfixture").unwrap();
        let mut advanced = ptr::null_mut();
        let mut error = FFIError::default();
        assert_eq!(
            boxlite_advanced_options_new(&mut advanced, &mut error),
            BoxliteErrorCode::Ok
        );
        let input = CString::new(path.to_str().unwrap()).unwrap();
        assert_eq!(
            boxlite_advanced_options_set_kernel_path(advanced, input.as_ptr(), &mut error),
            BoxliteErrorCode::Ok
        );
        drop(input);
        assert_eq!((*advanced).options.kernel.as_ref().unwrap().path, path);
        for invalid in [
            ptr::null(),
            c"relative/kernel".as_ptr(),
            c"/missing/kernel.bin".as_ptr(),
        ] {
            assert_ne!(
                boxlite_advanced_options_set_kernel_path(advanced, invalid, &mut error),
                BoxliteErrorCode::Ok
            );
            boxlite_error_free(&mut error);
            assert_eq!((*advanced).options.kernel.as_ref().unwrap().path, path);
        }
        assert_ne!(
            boxlite_advanced_options_set_kernel_path(
                ptr::null_mut(),
                c"/missing".as_ptr(),
                &mut error
            ),
            BoxliteErrorCode::Ok
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
            let mut handle = ptr::null_mut();
            let mut error = FFIError::default();
            assert_eq!(
                boxlite_runtime_new_experimental(
                    c_home.as_ptr(),
                    ptr::null(),
                    0,
                    features.as_ptr(),
                    &mut handle,
                    &mut error
                ),
                BoxliteErrorCode::Ok
            );
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
    unsafe {
        let mut runtime = ptr::null_mut();
        let mut error = FFIError::default();
        assert_ne!(
            boxlite_runtime_new_experimental(
                ptr::null(),
                ptr::null(),
                0,
                c"custom-kernel,unknown".as_ptr(),
                &mut runtime,
                &mut error
            ),
            BoxliteErrorCode::Ok
        );
        assert!(runtime.is_null());
        assert!(
            CStr::from_ptr(error.message)
                .to_str()
                .unwrap()
                .contains("unknown feature")
        );
        boxlite_error_free(&mut error);
    }
}
