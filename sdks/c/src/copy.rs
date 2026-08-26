//! File copy operations for the BoxLite C SDK (async + callback variants).

use std::io;
use std::os::raw::{c_char, c_void};
use std::path::PathBuf;
use std::sync::Arc;

use boxlite::litebox::copy::CopyOptions;
use futures::StreamExt;
use tokio::runtime::Runtime as TokioRuntime;
use tokio::sync::mpsc;

use crate::box_handle::BoxHandle;
use crate::error::{BoxliteErrorCode, FFIError, null_pointer_error, write_error};
use crate::event_queue::{
    CBoxCopyCb, CBoxCopyDataCb, CBoxCopyMetaCb, CBoxCopyMetaFn, RuntimeEvent, push_event,
};
use crate::util::c_str_to_string;
use crate::{CBoxHandle, CBoxliteError};

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_copy_into(
    handle: *mut CBoxHandle,
    host_src: *const c_char,
    guest_dst: *const c_char,
    cb: CBoxCopyCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_copy_into(handle, host_src, guest_dst, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_copy_out(
    handle: *mut CBoxHandle,
    guest_src: *const c_char,
    host_dst: *const c_char,
    cb: CBoxCopyCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_copy_out(handle, guest_src, host_dst, cb, user_data, out_error)
}

fn default_copy_options() -> CopyOptions {
    CopyOptions {
        recursive: true,
        overwrite: true,
        follow_symlinks: false,
        include_parent: false,
    }
}

unsafe fn box_copy_into(
    handle: *mut BoxHandle,
    host_src: *const c_char,
    guest_dst: *const c_char,
    cb: CBoxCopyCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let src = match c_str_to_string(host_src) {
            Ok(s) => PathBuf::from(s),
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let dst = match c_str_to_string(guest_dst) {
            Ok(s) => s,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let handle_ref = &*handle;
        let lite = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = lite.copy_into(src, dst, default_copy_options()).await;
            push_event(
                &queue,
                RuntimeEvent::Copy {
                    cb,
                    user_data: user_data_addr,
                    result,
                },
            )
            .await;
        });

        BoxliteErrorCode::Ok
    }
}

unsafe fn box_copy_out(
    handle: *mut BoxHandle,
    guest_src: *const c_char,
    host_dst: *const c_char,
    cb: CBoxCopyCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let src = match c_str_to_string(guest_src) {
            Ok(s) => s,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let dst = match c_str_to_string(host_dst) {
            Ok(s) => PathBuf::from(s),
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let handle_ref = &*handle;
        let lite = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = lite.copy_out(src, dst, default_copy_options()).await;
            push_event(
                &queue,
                RuntimeEvent::Copy {
                    cb,
                    user_data: user_data_addr,
                    result,
                },
            )
            .await;
        });

        BoxliteErrorCode::Ok
    }
}

// ─── Streaming copy ────────────────────────────────────────────────────────

/// Opaque handle for a streaming copy-in (push raw tar bytes into the guest).
pub struct CBoxCopyInStream {
    tx: Option<mpsc::Sender<io::Result<Vec<u8>>>>,
    tokio_rt: Arc<TokioRuntime>,
}

/// Download `guest_src` as a tar byte stream.
///
/// The `data_cb` receives raw tar chunks; `meta_cb` (optional) fires exactly
/// once — before the first `data_cb` — with the archive-shape hint
/// (`source_is_dir`), and `copy_cb` fires strictly last with the completion
/// result. All callbacks share `user_data`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_copy_out_stream(
    handle: *mut CBoxHandle,
    guest_src: *const c_char,
    meta_cb: CBoxCopyMetaCb,
    data_cb: CBoxCopyDataCb,
    copy_cb: CBoxCopyCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let src = match c_str_to_string(guest_src) {
            Ok(s) => s,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let data_cb = crate::unwrap_cb_or_return!(data_cb, out_error);
        let copy_cb = crate::unwrap_cb_or_return!(copy_cb, out_error);
        let meta_cb = meta_cb.map(|cb| cb as CBoxCopyMetaFn);

        let handle_ref = &*handle;
        let lite = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            match lite
                .copy_out_tar(src.as_str(), default_copy_options())
                .await
            {
                Ok((mut tar, source_is_dir)) => {
                    if let (Some(mcb), Some(is_dir)) = (meta_cb, source_is_dir) {
                        push_event(
                            &queue,
                            RuntimeEvent::CopyMeta {
                                cb: mcb,
                                user_data: user_data_addr,
                                source_is_dir: is_dir,
                            },
                        )
                        .await;
                    }
                    while let Some(item) = tar.next().await {
                        match item {
                            Ok(data) => {
                                if data.is_empty() {
                                    continue;
                                }
                                push_event(
                                    &queue,
                                    RuntimeEvent::CopyData {
                                        cb: data_cb,
                                        user_data: user_data_addr,
                                        data,
                                    },
                                )
                                .await;
                            }
                            Err(e) => {
                                push_event(
                                    &queue,
                                    RuntimeEvent::Copy {
                                        cb: copy_cb,
                                        user_data: user_data_addr,
                                        result: Err(boxlite::BoxliteError::Internal(format!(
                                            "copy_out stream error: {}",
                                            e
                                        ))),
                                    },
                                )
                                .await;
                                return;
                            }
                        }
                    }
                    push_event(
                        &queue,
                        RuntimeEvent::Copy {
                            cb: copy_cb,
                            user_data: user_data_addr,
                            result: Ok(()),
                        },
                    )
                    .await;
                }
                Err(e) => {
                    push_event(
                        &queue,
                        RuntimeEvent::Copy {
                            cb: copy_cb,
                            user_data: user_data_addr,
                            result: Err(e),
                        },
                    )
                    .await;
                }
            }
        });

        BoxliteErrorCode::Ok
    }
}

/// Begin a streaming copy-in, returning an opaque transfer handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_copy_in_start(
    handle: *mut CBoxHandle,
    guest_dst: *const c_char,
    source_is_dir: bool,
    copy_cb: CBoxCopyCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> *mut CBoxCopyInStream {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return std::ptr::null_mut();
        }
        let dst = match c_str_to_string(guest_dst) {
            Ok(s) => s,
            Err(e) => {
                write_error(out_error, e);
                return std::ptr::null_mut();
            }
        };
        let Some(copy_cb) = copy_cb else {
            write_error(out_error, null_pointer_error("copy_cb"));
            return std::ptr::null_mut();
        };

        let handle_ref = &*handle;
        let lite = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        let (tx, rx) = mpsc::channel::<io::Result<Vec<u8>>>(4);
        let tar = futures::stream::unfold(rx, |mut rx| async move {
            rx.recv().await.map(|item| (item, rx))
        });

        handle_ref.tokio_rt.spawn(async move {
            let result = lite
                .copy_in_tar_stream(tar, dst.as_str(), source_is_dir, default_copy_options())
                .await;
            push_event(
                &queue,
                RuntimeEvent::Copy {
                    cb: copy_cb,
                    user_data: user_data_addr,
                    result,
                },
            )
            .await;
        });

        Box::into_raw(Box::new(CBoxCopyInStream {
            tx: Some(tx),
            tokio_rt: handle_ref.tokio_rt.clone(),
        }))
    }
}

/// Push a chunk of raw tar bytes into the guest. Blocks when the guest is slow
/// (bounded-channel backpressure).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_copy_in_write(
    stream: *mut CBoxCopyInStream,
    data: *const u8,
    len: usize,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if stream.is_null() {
            write_error(out_error, null_pointer_error("stream"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if data.is_null() && len > 0 {
            write_error(out_error, null_pointer_error("data"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if len == 0 {
            return BoxliteErrorCode::Ok;
        }

        let stream_ref = &*stream;
        let Some(tx) = stream_ref.tx.as_ref() else {
            write_error(
                out_error,
                boxlite::BoxliteError::InvalidState("copy-in stream is closed".to_string()),
            );
            return BoxliteErrorCode::InvalidState;
        };

        let bytes = std::slice::from_raw_parts(data, len).to_vec();
        match stream_ref.tokio_rt.block_on(tx.send(Ok(bytes))) {
            Ok(()) => BoxliteErrorCode::Ok,
            Err(_) => {
                write_error(
                    out_error,
                    boxlite::BoxliteError::Internal("guest upload aborted".to_string()),
                );
                BoxliteErrorCode::Internal
            }
        }
    }
}

/// Close the copy-in stream, signalling EOF to the guest. Idempotent.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_copy_in_close(
    stream: *mut CBoxCopyInStream,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if stream.is_null() {
            write_error(out_error, null_pointer_error("stream"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let stream_ref = &mut *stream;
        // Dropping the sender closes the channel, which ends the tar stream and
        // signals EOF to the guest unpacker.
        stream_ref.tx.take();
        BoxliteErrorCode::Ok
    }
}

/// Reclaim a copy-in stream handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_copy_in_free(stream: *mut CBoxCopyInStream) {
    unsafe {
        if !stream.is_null() {
            drop(Box::from_raw(stream));
        }
    }
}
