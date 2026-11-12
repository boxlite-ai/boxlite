use super::*;

#[test]
fn memory_setter_preserves_presence_and_rejects_invalid_values() {
    unsafe {
        for memory in [
            None,
            Some(256),
            Some(257),
            Some(513),
            Some(1536),
            Some(i32::MAX),
            Some(0),
            Some(-1),
            Some(255),
        ] {
            let mut options = ptr::null_mut();
            assert_eq!(
                boxlite_options_new(c"alpine".as_ptr(), &mut options, ptr::null_mut()),
                BoxliteErrorCode::Ok
            );
            if let Some(memory) = memory {
                boxlite_options_set_memory(options, memory);
            }
            let result = (*options).options.sanitize();
            assert_eq!(
                result.is_ok(),
                memory.is_none_or(|m| m >= 256),
                "{memory:?}: {result:?}"
            );
            if memory.is_none_or(|m| m >= 256) {
                assert_eq!((*options).options.memory_mib, memory.map(|m| m as u32));
            }
            boxlite_options_free(options);
        }
    }
}

#[test]
fn memory_simple_api_rejects_zero_before_runtime_creation() {
    for memory in [-1, 0, 255] {
        let mut handle = ptr::null_mut();
        let mut error = FFIError::default();
        unsafe {
            assert_eq!(
                boxlite_simple_new(c"alpine".as_ptr(), 1.0, memory, &mut handle, &mut error),
                BoxliteErrorCode::InvalidArgument
            );
            assert!(handle.is_null());
            assert!(
                CStr::from_ptr(error.message)
                    .to_str()
                    .unwrap()
                    .contains("256 MiB")
            );
            boxlite_error_free(&mut error);
        }
    }
}
