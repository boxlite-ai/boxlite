use super::*;

extern "C" fn record_start(err: *mut FFIError, data: *mut c_void) {
    unsafe {
        *(data as *mut Option<BoxliteErrorCode>) = Some(if err.is_null() {
            BoxliteErrorCode::Ok
        } else {
            (*err).code
        });
    }
}

#[test]
fn runner_start_delivers_completion_without_booting_a_vm() {
    for requested in [0, 1] {
        unsafe {
            let (runtime, home) = new_test_runtime_handle("runner-start");
            let owner = &*runtime;
            let lite = owner.tokio_rt.block_on(async {
                let lite = owner
                    .runtime
                    .create(boxlite::BoxOptions::default(), None)
                    .await
                    .unwrap();
                lite.stop().await.unwrap();
                lite
            });
            let mut handle = crate::box_handle::BoxHandle {
                box_id: lite.id().clone(),
                handle: Arc::new(lite),
                tokio_rt: owner.tokio_rt.clone(),
                queue: owner.queue.clone(),
            };
            let mut outcome: Option<BoxliteErrorCode> = None;
            let slot: *mut Option<BoxliteErrorCode> = &mut outcome;
            let mut error = FFIError::default();
            assert_eq!(
                boxlite_internal_runner_start_box(
                    &mut handle,
                    requested,
                    Some(record_start),
                    slot.cast(),
                    &mut error
                ),
                BoxliteErrorCode::Ok
            );
            for _ in 0..10 {
                if (*slot).is_some() {
                    break;
                }
                assert!(boxlite_runtime_drain(runtime, 500, &mut error) >= 0);
            }
            assert_eq!(outcome, Some(BoxliteErrorCode::Stopped));
            assert_eq!(
                boxlite_internal_runner_start_box(
                    &mut handle,
                    requested,
                    None,
                    ptr::null_mut(),
                    &mut error
                ),
                BoxliteErrorCode::InvalidArgument
            );
            boxlite_error_free(&mut error);
            assert_eq!(
                boxlite_internal_runner_start_box(
                    ptr::null_mut(),
                    requested,
                    Some(record_start),
                    slot.cast(),
                    &mut error
                ),
                BoxliteErrorCode::InvalidArgument
            );
            boxlite_error_free(&mut error);
            drop(handle);
            boxlite_runtime_free(runtime);
            std::fs::remove_dir_all(home).unwrap();
        }
    }
}
