// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

use super::*;
use crate::runtime::{RuntimeHandle, RuntimeLiveness, create_tokio_runtime};
use boxlite_test_utils::home::PerTestBoxHome;

type Delivery = (BoxliteErrorCode, bool, Option<String>);

extern "C" fn record_adoption(
    handle: *mut CBoxHandle,
    created: bool,
    error: *mut FFIError,
    user_data: *mut c_void,
) {
    unsafe {
        let id = handle.as_ref().map(|bx| bx.box_id.to_string());
        if !handle.is_null() {
            boxlite_box_free(handle);
        }
        *user_data.cast::<Option<Delivery>>() = Some(((*error).code, created, id));
    }
}

#[test]
fn adoption_returns_the_existing_identity_and_never_creates_on_a_miss() {
    let home = PerTestBoxHome::isolated();
    let mut runtime = RuntimeHandle {
        runtime: BoxliteRuntime::new_for_test(boxlite::BoxliteOptions {
            home_dir: home.path.clone(),
            ..Default::default()
        })
        .unwrap(),
        tokio_rt: create_tokio_runtime().unwrap(),
        liveness: Arc::new(RuntimeLiveness::new()),
        queue: Arc::new(crate::event_queue::EventQueue::new()),
    };

    let call =
        |runtime: &mut RuntimeHandle, name: Option<&CStr>, require_existing: bool| -> Delivery {
            let mut result = None;
            unsafe {
                let mut opts = ptr::null_mut();
                assert_eq!(
                    boxlite_options_new(c"alpine:latest".as_ptr(), &mut opts, ptr::null_mut()),
                    BoxliteErrorCode::Ok
                );
                if let Some(name) = name {
                    boxlite_options_set_name(opts, name.as_ptr());
                }
                let submit = if require_existing {
                    boxlite_adopt_box
                } else {
                    boxlite_get_or_create_box
                };
                assert_eq!(
                    submit(
                        runtime,
                        opts,
                        Some(record_adoption),
                        (&raw mut result).cast(),
                        ptr::null_mut()
                    ),
                    BoxliteErrorCode::Ok
                );
                for _ in 0..40 {
                    assert!(boxlite_runtime_drain(runtime, 250, ptr::null_mut()) >= 0);
                    if let Some(delivery) = result.take() {
                        return delivery;
                    }
                }
            }
            panic!("timed out waiting for adoption callback");
        };
    for name in [None, Some(c"")] {
        assert_eq!(
            call(&mut runtime, name, true),
            (BoxliteErrorCode::InvalidArgument, false, None)
        );
    }
    let name = Some(c"worker");
    assert_eq!(
        call(&mut runtime, name, true),
        (BoxliteErrorCode::NotFound, false, None)
    );
    let (code, created, id) = call(&mut runtime, name, false);
    assert_eq!(code, BoxliteErrorCode::Ok);
    assert!(created, "a failed adoption must leave the name available");
    assert!(id.is_some());
    assert_eq!(
        call(&mut runtime, name, true),
        (BoxliteErrorCode::Ok, false, id)
    );
    let info = runtime
        .tokio_rt
        .block_on(runtime.runtime.get_info("worker"))
        .unwrap()
        .unwrap();
    assert!(
        info.status.is_configured(),
        "adopting must not start the VM"
    );
    assert_eq!(
        info.effective_capabilities,
        Some(boxlite::ContainerCapabilities::default())
    );
    runtime
        .tokio_rt
        .block_on(runtime.runtime.remove("worker", false))
        .unwrap();
    assert_eq!(
        call(&mut runtime, name, true),
        (BoxliteErrorCode::NotFound, false, None)
    );
}
