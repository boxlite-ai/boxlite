use super::*;

extern "C" fn record_nested_state(
    state: BoxliteNestedVirtualizationState,
    error: *mut CBoxliteError,
    user_data: *mut c_void,
) {
    unsafe {
        let slot =
            &mut *(user_data as *mut Option<(BoxliteNestedVirtualizationState, BoxliteErrorCode)>);
        *slot = Some((state, error.as_ref().expect("borrowed callback error").code));
    }
}

unsafe fn drain_nested_state(
    runtime: *mut CBoxliteRuntime,
    slot: &mut Option<(BoxliteNestedVirtualizationState, BoxliteErrorCode)>,
) -> (BoxliteNestedVirtualizationState, BoxliteErrorCode) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while slot.is_none() {
        assert!(
            std::time::Instant::now() < deadline,
            "nesting callback did not complete"
        );
        let mut error = FFIError::default();
        assert!(unsafe { boxlite_runtime_drain(runtime, 500, &mut error) } >= 0);
        unsafe { boxlite_error_free(&mut error) };
    }
    slot.take().unwrap()
}

#[test]
fn nested_virtualization_id_getter_refuses_names_and_prefixes() {
    unsafe {
        let home = unique_test_home("nested-info-selectors");
        let c_home = CString::new(home.to_str().unwrap()).unwrap();
        let mut runtime = ptr::null_mut();
        let mut error = FFIError::default();
        assert_eq!(
            boxlite_runtime_new_experimental(
                c_home.as_ptr(),
                ptr::null(),
                0,
                c"nested-virtualization".as_ptr(),
                &mut runtime,
                &mut error
            ),
            BoxliteErrorCode::Ok
        );
        let selectors = {
            let runtime = runtime.as_ref().unwrap();
            runtime.tokio_rt.block_on(async {
                let mut options = boxlite::BoxOptions::default();
                options.advanced.nested_virtualization = true;
                let named = runtime
                    .runtime
                    .create(options, Some("safe-box-alias".into()))
                    .await
                    .unwrap();
                let id = named.info().await.unwrap().id;
                let selectors = ["safe-box-alias".to_string(), id.as_str()[..6].to_string()];
                for selector in &selectors {
                    assert_eq!(
                        runtime
                            .runtime
                            .get_info(selector)
                            .await
                            .unwrap()
                            .unwrap()
                            .id,
                        id
                    );
                }
                selectors.map(|selector| CString::new(selector).unwrap())
            })
        };
        let mut observed = Vec::new();
        for selector in selectors {
            let mut slot = None;
            assert_eq!(
                boxlite_get_nested_virtualization(
                    runtime,
                    selector.as_ptr(),
                    Some(record_nested_state),
                    (&mut slot
                        as *mut Option<(BoxliteNestedVirtualizationState, BoxliteErrorCode)>)
                        .cast(),
                    &mut error
                ),
                BoxliteErrorCode::Ok
            );
            observed.push(drain_nested_state(runtime, &mut slot).1);
        }
        boxlite_runtime_free(runtime);
        std::fs::remove_dir_all(home).unwrap();
        assert_eq!(
            observed,
            [BoxliteErrorCode::NotFound; 2],
            "the exact-ID getter must reject working name and prefix selectors"
        );
    }
}

#[test]
fn nested_virtualization_id_getter_does_not_follow_a_name_alias() {
    unsafe {
        let home = unique_test_home("nested-info-id");
        let c_home = CString::new(home.to_str().unwrap()).unwrap();
        let mut runtime = ptr::null_mut();
        let mut error = FFIError::default();
        assert_eq!(
            boxlite_runtime_new_experimental(
                c_home.as_ptr(),
                ptr::null(),
                0,
                c"nested-virtualization".as_ptr(),
                &mut runtime,
                &mut error
            ),
            BoxliteErrorCode::Ok
        );
        let missing_id = {
            let runtime = runtime.as_ref().unwrap();
            runtime.tokio_rt.block_on(async {
                let original = runtime
                    .runtime
                    .create(boxlite::BoxOptions::default(), None)
                    .await
                    .unwrap();
                let id = original.info().await.unwrap().id;
                drop(original);
                runtime.runtime.remove(id.as_str(), true).await.unwrap();
                let mut options = boxlite::BoxOptions::default();
                options.advanced.nested_virtualization = true;
                let named = runtime
                    .runtime
                    .create(options, Some(id.to_string()))
                    .await
                    .unwrap();
                let looked_up = runtime
                    .runtime
                    .get_info(id.as_str())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(looked_up.id, named.info().await.unwrap().id);
                assert_ne!(
                    looked_up.id, id,
                    "setup must exercise the core's name fallback"
                );
                CString::new(id.as_str()).unwrap()
            })
        };
        let mut slot = None;
        assert_eq!(
            boxlite_get_nested_virtualization(
                runtime,
                missing_id.as_ptr(),
                Some(record_nested_state),
                (&mut slot as *mut Option<(BoxliteNestedVirtualizationState, BoxliteErrorCode)>)
                    .cast(),
                &mut error
            ),
            BoxliteErrorCode::Ok
        );
        let result = drain_nested_state(runtime, &mut slot);
        boxlite_runtime_free(runtime);
        std::fs::remove_dir_all(home).unwrap();
        assert_eq!(
            result.1,
            BoxliteErrorCode::NotFound,
            "an ID-only getter must not return metadata from another box with that name"
        );
    }
}

#[test]
fn nested_virtualization_getters_read_real_saved_options_through_callbacks() {
    unsafe {
        let home = unique_test_home("nested-info");
        let c_home = CString::new(home.to_str().unwrap()).unwrap();
        let mut runtime = ptr::null_mut();
        let mut error = FFIError::default();
        assert_eq!(
            boxlite_runtime_new_experimental(
                c_home.as_ptr(),
                ptr::null(),
                0,
                c"nested-virtualization".as_ptr(),
                &mut runtime,
                &mut error
            ),
            BoxliteErrorCode::Ok
        );
        for enabled in [false, true] {
            let (handle, id) = {
                let runtime = runtime.as_ref().expect("live runtime");
                let mut options = boxlite::BoxOptions::default();
                options.advanced.nested_virtualization = enabled;
                let lite = runtime
                    .tokio_rt
                    .block_on(runtime.runtime.create(options, None))
                    .unwrap();
                let id = runtime.tokio_rt.block_on(lite.info()).unwrap().id;
                let handle = Box::into_raw(Box::new(crate::box_handle::BoxHandle {
                    handle: Arc::new(lite),
                    box_id: id.clone(),
                    tokio_rt: runtime.tokio_rt.clone(),
                    queue: runtime.queue.clone(),
                }));
                (handle, CString::new(id.as_str()).unwrap())
            };
            let expected = if enabled {
                BoxliteNestedVirtualizationState::BoxliteNestedEnabled
            } else {
                BoxliteNestedVirtualizationState::BoxliteNestedDisabled
            };
            let mut slot = None;
            let user_data = (&mut slot
                as *mut Option<(BoxliteNestedVirtualizationState, BoxliteErrorCode)>)
                .cast();
            assert_eq!(
                boxlite_box_nested_virtualization(
                    handle,
                    Some(record_nested_state),
                    user_data,
                    &mut error
                ),
                BoxliteErrorCode::Ok
            );
            assert_eq!(
                drain_nested_state(runtime, &mut slot),
                (expected, BoxliteErrorCode::Ok)
            );
            assert_eq!(
                boxlite_get_nested_virtualization(
                    runtime,
                    id.as_ptr(),
                    Some(record_nested_state),
                    user_data,
                    &mut error
                ),
                BoxliteErrorCode::Ok
            );
            assert_eq!(
                drain_nested_state(runtime, &mut slot),
                (expected, BoxliteErrorCode::Ok)
            );
            boxlite_box_free(handle);
        }
        let mut slot = None;
        assert_eq!(
            boxlite_get_nested_virtualization(
                runtime,
                c"missing-box".as_ptr(),
                Some(record_nested_state),
                (&mut slot as *mut Option<(BoxliteNestedVirtualizationState, BoxliteErrorCode)>)
                    .cast(),
                &mut error
            ),
            BoxliteErrorCode::Ok
        );
        assert_eq!(
            drain_nested_state(runtime, &mut slot).1,
            BoxliteErrorCode::NotFound
        );
        let invalid_utf8 = [0xff_u8, 0];
        for id in [
            c"../bad".as_ptr(),
            c"".as_ptr(),
            invalid_utf8.as_ptr().cast(),
        ] {
            assert_eq!(
                boxlite_get_nested_virtualization(
                    runtime,
                    id,
                    Some(record_nested_state),
                    ptr::null_mut(),
                    &mut error
                ),
                BoxliteErrorCode::InvalidArgument
            );
            assert_eq!(error.code, BoxliteErrorCode::InvalidArgument);
            boxlite_error_free(&mut error);
        }
        assert_eq!(
            boxlite_box_nested_virtualization(
                ptr::null_mut(),
                Some(record_nested_state),
                ptr::null_mut(),
                &mut error
            ),
            BoxliteErrorCode::InvalidArgument
        );
        boxlite_error_free(&mut error);
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
        assert!(
            !advanced
                .as_ref()
                .expect("successful construction returns a handle")
                .options
                .nested_virtualization
        );
        for value in [1, 0, -1] {
            assert_eq!(
                boxlite_advanced_options_set_nested_virtualization(advanced, value),
                BoxliteErrorCode::Ok
            );
            let options = &advanced
                .as_ref()
                .expect("the handle stays live until it is freed")
                .options;
            assert_eq!(options.nested_virtualization, value != 0);
            assert!(!options.privileged);
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
            let result = {
                let handle = runtime
                    .as_ref()
                    .expect("successful construction returns a runtime");
                handle
                    .tokio_rt
                    .block_on(handle.runtime.create(options, None))
            };
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
