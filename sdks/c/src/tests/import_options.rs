use super::*;
use crate::archive::{CBoxImportOptions, boxlite_runtime_import_with_options};
use boxlite::{BoxArchive, BoxImportSource};

extern "C" fn imported(_: *mut CBoxHandle, _: *mut CBoxliteError, _: *mut c_void) {}

#[test]
fn checkpoint_import_options_validate_sources_before_queueing() {
    let runtime = ptr::NonNull::<crate::runtime::RuntimeHandle>::dangling().as_ptr();
    let archive = CString::new("archive.boxlite").unwrap();
    let key = CString::new("base").unwrap();
    let invalid = b"\xff\0";
    let null: *const std::os::raw::c_char = ptr::null();
    let mut error = FFIError::default();
    assert_eq!(
        unsafe {
            boxlite_runtime_import_with_options(
                runtime,
                ptr::null(),
                Some(imported),
                ptr::null_mut(),
                &mut error,
            )
        },
        BoxliteErrorCode::InvalidArgument
    );
    unsafe { boxlite_error_free(&mut error) };
    for options in [
        CBoxImportOptions {
            archive_path: null,
            name: null,
            checkpoint_id: null,
            box_id: null,
        },
        CBoxImportOptions {
            archive_path: archive.as_ptr(),
            name: null,
            checkpoint_id: key.as_ptr(),
            box_id: null,
        },
        CBoxImportOptions {
            archive_path: archive.as_ptr(),
            name: null,
            checkpoint_id: null,
            box_id: key.as_ptr(),
        },
        CBoxImportOptions {
            archive_path: null,
            name: null,
            checkpoint_id: invalid.as_ptr().cast(),
            box_id: null,
        },
        CBoxImportOptions {
            archive_path: null,
            name: null,
            checkpoint_id: key.as_ptr(),
            box_id: invalid.as_ptr().cast(),
        },
    ] {
        assert_eq!(
            unsafe {
                boxlite_runtime_import_with_options(
                    runtime,
                    &options,
                    Some(imported),
                    ptr::null_mut(),
                    &mut error,
                )
            },
            BoxliteErrorCode::InvalidArgument
        );
        unsafe { boxlite_error_free(&mut error) };
    }
}

#[test]
fn checkpoint_runtime_import_rejects_invalid_parameters_before_local_capability() {
    let home = unique_test_home("checkpoint-import-validation");
    let runtime = BoxliteRuntime::new_for_test(boxlite::BoxliteOptions {
        home_dir: home.clone(),
        ..Default::default()
    })
    .unwrap();
    let tokio = crate::runtime::create_tokio_runtime().unwrap();
    for (key, name, target) in [
        ("", None, None),
        ("bad/key", None, None),
        ("base", Some("worker"), Some("target")),
        ("base", Some("bad/name"), None),
        ("base", None, Some("")),
        ("base", None, Some("target\0suffix")),
    ] {
        let source = BoxImportSource::Checkpoint {
            checkpoint_id: key.into(),
            box_id: target.map(str::to_owned),
        };
        assert!(matches!(
            tokio.block_on(source.import_box(&runtime, name.map(str::to_owned))),
            Err(BoxliteError::InvalidArgument(_))
        ));
    }
    // The unchanged archive call compiles and reaches the existing importer.
    assert!(
        tokio
            .block_on(runtime.import_box(BoxArchive::new(home.join("missing.boxlite")), None))
            .is_err()
    );
    drop(runtime);
    drop(tokio);
    std::fs::remove_dir_all(home).unwrap();
}

#[test]
fn checkpoint_import_options_reject_a_closed_runtime_before_submission() {
    let mut runtime = crate::runtime::RuntimeHandle {
        runtime: BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new("http://127.0.0.1:1"))
            .unwrap(),
        tokio_rt: crate::runtime::create_tokio_runtime().unwrap(),
        liveness: Arc::new(crate::runtime::RuntimeLiveness::new()),
        queue: Arc::new(crate::event_queue::EventQueue::new()),
    };
    runtime.liveness.mark_closed();
    let key = CString::new("base").unwrap();
    let options = CBoxImportOptions {
        archive_path: ptr::null(),
        name: ptr::null(),
        checkpoint_id: key.as_ptr(),
        box_id: ptr::null(),
    };
    let mut error = FFIError::default();
    let code = unsafe {
        boxlite_runtime_import_with_options(
            &mut runtime,
            &options,
            Some(imported),
            ptr::null_mut(),
            &mut error,
        )
    };
    assert_ne!(code, BoxliteErrorCode::Ok);
    assert!(
        unsafe { CStr::from_ptr(error.message) }
            .to_string_lossy()
            .contains("closed")
    );
    unsafe { boxlite_error_free(&mut error) };
}
