use super::*;

extern "C" fn unused_create_callback(
    _box: *mut CBoxHandle,
    _error: *mut FFIError,
    _data: *mut c_void,
) {
}
extern "C" fn unused_get_or_create_callback(
    _box: *mut CBoxHandle,
    _created: bool,
    _error: *mut FFIError,
    _data: *mut c_void,
) {
}

fn rest_runtime() -> crate::runtime::RuntimeHandle {
    crate::runtime::RuntimeHandle {
        runtime: BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new("http://127.0.0.1:1"))
            .unwrap(),
        tokio_rt: crate::runtime::create_tokio_runtime().unwrap(),
        liveness: Arc::new(crate::runtime::RuntimeLiveness::new()),
        queue: Arc::new(crate::event_queue::EventQueue::new()),
    }
}

unsafe fn options() -> *mut CBoxliteOptions {
    let mut options = ptr::null_mut();
    assert_eq!(
        unsafe { boxlite_options_new(c"alpine:latest".as_ptr(), &mut options, ptr::null_mut()) },
        BoxliteErrorCode::Ok
    );
    options
}

#[test]
fn checkpoint_setter_invalid_input_never_falls_back_to_image() {
    let mut runtime = rest_runtime();
    let invalid = [0xffu8, 0];
    let mut accepted = Vec::new();
    for (index, value) in [ptr::null(), invalid.as_ptr().cast(), c"".as_ptr()]
        .into_iter()
        .enumerate()
    {
        unsafe {
            let opts = options();
            boxlite_options_set_checkpoint(opts, value);
            let code = boxlite_create_box(
                &mut runtime,
                opts,
                Some(unused_create_callback),
                ptr::null_mut(),
                ptr::null_mut(),
            );
            if code != BoxliteErrorCode::Ok {
                boxlite_options_free(opts);
            }
            if code != BoxliteErrorCode::InvalidArgument {
                accepted.push(index);
            }
        }
    }
    assert!(
        accepted.is_empty(),
        "invalid checkpoint inputs accepted: {accepted:?}"
    );
}

#[test]
fn checkpoint_setters_reject_explicit_defaults_in_either_order() {
    let mut runtime = rest_runtime();
    let mut accepted = Vec::new();
    for checkpoint_first in [false, true] {
        for variant in 0..24 {
            unsafe {
                let opts = options();
                if checkpoint_first {
                    boxlite_options_set_checkpoint(opts, c"base".as_ptr());
                }
                match variant {
                    0 => boxlite_options_set_detach(opts, 0),
                    1 => boxlite_options_set_network_enabled(opts),
                    2 => boxlite_options_set_entrypoint(opts, ptr::null(), 0),
                    3 => boxlite_options_set_rootfs_path(opts, c"/tmp/rootfs".as_ptr()),
                    4 => boxlite_options_set_cpus(opts, 1.0),
                    5 => boxlite_options_set_memory(opts, 0),
                    6 => boxlite_options_set_disk_size_gb(opts, 0),
                    7 => boxlite_options_set_workdir(opts, c"".as_ptr()),
                    8 => boxlite_options_set_user(opts, c"".as_ptr()),
                    9 => boxlite_options_add_env(opts, c"A".as_ptr(), c"B".as_ptr()),
                    10 => {
                        boxlite_options_add_bind_mount(opts, c"/tmp".as_ptr(), c"/data".as_ptr(), 0)
                    }
                    11 => boxlite_options_add_managed_volume(
                        opts,
                        c"vol".as_ptr(),
                        c"/data".as_ptr(),
                        0,
                    ),
                    12 => {
                        let _ = boxlite_options_add_port(
                            opts,
                            0,
                            80,
                            crate::options::BoxlitePortProtocol::BoxlitePortProtocolTcp,
                            ptr::null(),
                        );
                    }
                    13 => boxlite_options_set_network_disabled(opts),
                    14 => boxlite_options_add_network_allow(opts, c"example.com".as_ptr()),
                    15 => boxlite_options_set_network_inbound_enabled(opts),
                    16 => boxlite_options_set_network_inbound_disabled(opts),
                    17 => boxlite_options_add_secret(
                        opts,
                        c"secret".as_ptr(),
                        c"value".as_ptr(),
                        ptr::null(),
                        ptr::null(),
                        0,
                    ),
                    18 => boxlite_options_set_auto_remove(opts, 1),
                    19 => boxlite_options_set_auto_stop_interval(opts, 0),
                    20 => boxlite_options_set_auto_delete_interval(opts, 0),
                    21 => boxlite_options_set_auto_resume_enabled(opts, 1),
                    22 => boxlite_options_set_cmd(opts, ptr::null(), 0),
                    _ => {
                        let mut advanced = ptr::null_mut();
                        assert_eq!(
                            boxlite_advanced_options_new(&mut advanced, ptr::null_mut()),
                            BoxliteErrorCode::Ok
                        );
                        boxlite_options_set_advanced(opts, advanced);
                        boxlite_advanced_options_free(advanced);
                    }
                }
                if !checkpoint_first {
                    boxlite_options_set_checkpoint(opts, c"base".as_ptr());
                }
                let code = boxlite_create_box(
                    &mut runtime,
                    opts,
                    Some(unused_create_callback),
                    ptr::null_mut(),
                    ptr::null_mut(),
                );
                if code != BoxliteErrorCode::Ok {
                    boxlite_options_free(opts);
                }
                if code != BoxliteErrorCode::InvalidArgument {
                    accepted.push((checkpoint_first, variant));
                }
            }
        }
    }
    assert!(
        accepted.is_empty(),
        "explicit checkpoint defaults accepted: {accepted:?}"
    );
}

#[test]
fn checkpoint_get_or_create_checks_overrides_before_transferring_options() {
    let mut runtime = rest_runtime();
    unsafe {
        let opts = options();
        boxlite_options_set_checkpoint(opts, c"base".as_ptr());
        boxlite_options_set_detach(opts, 0);
        let code = boxlite_get_or_create_box(
            &mut runtime,
            opts,
            Some(unused_get_or_create_callback),
            ptr::null_mut(),
            ptr::null_mut(),
        );
        if code != BoxliteErrorCode::Ok {
            boxlite_options_free(opts);
        }
        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
    }
}

#[test]
fn checkpoint_validation_keeps_ordinary_and_checkpoint_only_creates() {
    let mut runtime = rest_runtime();
    for checkpoint in [false, true] {
        unsafe {
            let opts = options();
            boxlite_options_set_name(opts, c"worker".as_ptr());
            if checkpoint {
                boxlite_options_set_checkpoint(opts, c"base".as_ptr());
            } else {
                boxlite_options_set_detach(opts, 0);
            }
            assert_eq!(
                boxlite_create_box(
                    &mut runtime,
                    opts,
                    Some(unused_create_callback),
                    ptr::null_mut(),
                    ptr::null_mut()
                ),
                BoxliteErrorCode::Ok
            );
        }
    }
}
