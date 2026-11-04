use super::*;
use std::sync::mpsc;

extern "C" fn list_callback(
    list: *mut CCheckpointInfoList,
    error: *mut CBoxliteError,
    data: *mut c_void,
) {
    assert!(error.is_null() || unsafe { (*error).code } == BoxliteErrorCode::Ok);
    assert!(!list.is_null());
    let count = unsafe { (*list).count };
    unsafe {
        boxlite_free_checkpoint_info_list(list);
    }
    unsafe { &*(data as *const mpsc::Sender<usize>) }
        .send(count)
        .unwrap();
}

#[test]
fn checkpoint_c_callback_ownership_and_immediate_failure() {
    unsafe {
        let (runtime, home) = new_test_runtime_handle("checkpoint-callback");
        let mut error = FFIError::default();
        let mut catalog = ptr::null_mut();
        assert_eq!(
            boxlite_runtime_checkpoints(runtime, &mut catalog, &mut error),
            BoxliteErrorCode::Ok
        );
        assert_eq!(
            boxlite_checkpoint_list(catalog, None, ptr::null_mut(), &mut error),
            BoxliteErrorCode::InvalidArgument
        );
        boxlite_error_free(&mut error);
        let (send, recv) = mpsc::channel::<usize>();
        assert_eq!(
            boxlite_checkpoint_list(
                catalog,
                Some(list_callback),
                &send as *const _ as *mut c_void,
                &mut error
            ),
            BoxliteErrorCode::Ok
        );
        assert!(
            recv.try_recv().is_err(),
            "callback must wait for runtime_drain"
        );
        let mut received = false;
        for _ in 0..20 {
            boxlite_runtime_drain(runtime, 100, &mut error);
            if let Ok(count) = recv.try_recv() {
                assert_eq!(count, 0);
                received = true;
                break;
            }
        }
        assert!(received, "completion was never dispatched");
        assert!(recv.try_recv().is_err(), "completion fired more than once");
        assert_eq!(boxlite_runtime_drain(runtime, 0, &mut error), 0);
        boxlite_runtime_free(runtime);
        assert_eq!(
            boxlite_checkpoint_list(
                catalog,
                Some(list_callback),
                &send as *const _ as *mut c_void,
                &mut error
            ),
            BoxliteErrorCode::Stopped
        );
        boxlite_error_free(&mut error);
        boxlite_checkpoint_free(catalog);
        boxlite_free_checkpoint_info(ptr::null_mut());
        boxlite_free_checkpoint_info_list(ptr::null_mut());
        std::fs::remove_dir_all(home).unwrap();
    }
}

#[test]
fn checkpoint_c_inspection_preserves_native_error_origin() {
    let path = unique_test_home("checkpoint-errors");
    std::fs::create_dir_all(&path).unwrap();
    for member in ["snapshot.mem", "snapshot.qcow2"] {
        std::fs::write(path.join(member), b"bad").unwrap();
    }
    let cpath = CString::new(path.to_str().unwrap()).unwrap();
    let missing = CString::new(path.join("missing").to_str().unwrap()).unwrap();
    unsafe {
        let mut output = ptr::null_mut();
        let mut error = FFIError::default();
        assert_eq!(
            boxlite_inspect_cloud_upload(cpath.as_ptr(), &mut output, &mut error),
            BoxliteErrorCode::InvalidArgument
        );
        assert!(output.is_null());
        boxlite_error_free(&mut error);
        assert_eq!(
            boxlite_inspect_checkpoint(cpath.as_ptr(), &mut output, &mut error),
            BoxliteErrorCode::Storage
        );
        boxlite_error_free(&mut error);
        assert_eq!(
            boxlite_inspect_cloud_upload(missing.as_ptr(), &mut output, &mut error),
            BoxliteErrorCode::Storage
        );
        boxlite_error_free(&mut error);
    }
    std::fs::remove_dir_all(path).unwrap();
}
