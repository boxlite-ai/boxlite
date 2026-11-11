use super::*;

#[test]
fn nested_create_setter_reaches_existing_runtime_authorization() {
    unsafe {
        assert_eq!(
            boxlite_advanced_options_set_nested_virtualization(ptr::null_mut(), 1),
            BoxliteErrorCode::InvalidArgument
        );
        let advanced = new_test_advanced_options();
        let (runtime, home) = new_test_runtime_handle("nested-create");
        let owner = runtime
            .as_ref()
            .expect("runtime_new returned null runtime pointer");
        for enabled in [true, false] {
            assert_eq!(
                boxlite_advanced_options_set_nested_virtualization(advanced, i32::from(enabled)),
                BoxliteErrorCode::Ok
            );
            let mut options = boxlite::BoxOptions::default();
            options.advanced = (*advanced).options.clone();
            let result = owner.tokio_rt.block_on(owner.runtime.create(options, None));
            if enabled {
                let error = result.err().expect("nested create requires authorization");
                assert!(
                    error.to_string().contains("nested-virtualization"),
                    "{error}"
                );
            } else {
                result.expect("ordinary create needs no nested authorization");
            }
        }
        boxlite_advanced_options_free(advanced);
        boxlite_runtime_free(runtime);
        std::fs::remove_dir_all(home).unwrap();
    }
}
