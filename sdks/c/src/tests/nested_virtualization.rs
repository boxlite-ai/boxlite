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
        }
        boxlite_advanced_options_free(advanced);
        assert_eq!(
            boxlite_advanced_options_set_nested_virtualization(ptr::null_mut(), 1),
            BoxliteErrorCode::InvalidArgument
        );
    }
}
