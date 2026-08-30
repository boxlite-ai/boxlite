//! File copy operations for the BoxLite C SDK.

use std::io;
use std::os::raw::{c_char, c_void};
use std::path::PathBuf;
use std::sync::Arc;

use boxlite::litebox::copy::CopyOptions;
use boxlite::{BoxTarStream, BoxliteError};
use futures::StreamExt;
use tokio::runtime::Runtime as TokioRuntime;
use tokio::sync::mpsc;

use crate::box_handle::BoxHandle;
use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::event_queue::{CBoxCopyCb, RuntimeEvent, push_event};
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

/// Streaming-copy source shape. For copy-in, `Unknown` means the caller
/// cannot tell and the guest peeks at the archive. For copy-out, `Unknown`
/// means the peer omitted the hint. Mirrors the guest protocol's
/// `optional bool source_is_dir`: `File` = Some(false), `Dir` = Some(true),
/// `Unknown` = None.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoxliteCopySourceKind {
    Unknown = 0,
    File = 1,
    Dir = 2,
}

fn source_hint_to_kind(source_is_dir: Option<bool>) -> i32 {
    match source_is_dir {
        None => BoxliteCopySourceKind::Unknown as i32,
        Some(false) => BoxliteCopySourceKind::File as i32,
        Some(true) => BoxliteCopySourceKind::Dir as i32,
    }
}

/// Maps the C tri-state to the guest protocol's optional bool. Takes the raw
/// integer because C callers can pass any value, and unrecognized values
/// must behave as Unknown rather than guess.
fn source_kind_to_hint(kind: i32) -> Option<bool> {
    match kind {
        1 => Some(false),
        2 => Some(true),
        _ => None,
    }
}

/// Opaque handle for a streaming copy-in (push raw tar bytes into the guest).
pub struct CBoxCopyInStream {
    tx: Option<mpsc::Sender<io::Result<Vec<u8>>>>,
    tokio_rt: Arc<TokioRuntime>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CopyOutStreamState {
    Open,
    Eof,
    Failed,
}

/// Opaque handle for a streaming copy-out (pull raw tar bytes from the guest).
pub struct CBoxCopyOutStream {
    tar: BoxTarStream,
    tokio_rt: Arc<TokioRuntime>,
    pending: Vec<u8>,
    pending_offset: usize,
    state: CopyOutStreamState,
}

impl CBoxCopyOutStream {
    fn new(tar: BoxTarStream, tokio_rt: Arc<TokioRuntime>) -> Self {
        Self {
            tar,
            tokio_rt,
            pending: Vec::new(),
            pending_offset: 0,
            state: CopyOutStreamState::Open,
        }
    }

    fn copy_pending(&mut self, dst: &mut [u8]) -> Option<usize> {
        if self.pending_offset == self.pending.len() {
            self.pending.clear();
            self.pending_offset = 0;
            return None;
        }

        let count = dst
            .len()
            .min(self.pending.len().saturating_sub(self.pending_offset));
        let end = self.pending_offset + count;
        dst[..count].copy_from_slice(&self.pending[self.pending_offset..end]);
        self.pending_offset = end;
        if self.pending_offset == self.pending.len() {
            self.pending.clear();
            self.pending_offset = 0;
        }
        Some(count)
    }

    fn read_into(&mut self, dst: &mut [u8]) -> Result<usize, BoxliteError> {
        debug_assert!(!dst.is_empty());
        match self.state {
            CopyOutStreamState::Eof => return Ok(0),
            CopyOutStreamState::Failed => {
                return Err(BoxliteError::InvalidState(
                    "copy-out stream has failed".to_string(),
                ));
            }
            CopyOutStreamState::Open => {}
        }

        loop {
            if let Some(count) = self.copy_pending(dst) {
                return Ok(count);
            }

            let tokio_rt = Arc::clone(&self.tokio_rt);
            match tokio_rt.block_on(self.tar.next()) {
                Some(Ok(bytes)) if bytes.is_empty() => continue,
                Some(Ok(bytes)) => {
                    self.pending = bytes;
                    self.pending_offset = 0;
                }
                Some(Err(error)) => {
                    self.state = CopyOutStreamState::Failed;
                    return Err(BoxliteError::Internal(format!(
                        "copy_out stream error: {error}"
                    )));
                }
                None => {
                    self.state = CopyOutStreamState::Eof;
                    return Ok(0);
                }
            }
        }
    }
}

/// Begin downloading `guest_src` as a pull-based raw tar stream.
///
/// This call blocks until the stream and its optional source-shape hint are
/// ready. On success the returned handle must be released with
/// [`boxlite_copy_out_free`]. A non-null `out_source_kind` is initialized to
/// `Unknown` and updated to `File` or `Dir` when the peer supplies the hint.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_copy_out_start(
    handle: *mut CBoxHandle,
    guest_src: *const c_char,
    out_source_kind: *mut i32,
    out_error: *mut CBoxliteError,
) -> *mut CBoxCopyOutStream {
    unsafe {
        if !out_source_kind.is_null() {
            *out_source_kind = BoxliteCopySourceKind::Unknown as i32;
        }
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return std::ptr::null_mut();
        }
        if guest_src.is_null() {
            write_error(out_error, null_pointer_error("guest_src"));
            return std::ptr::null_mut();
        }
        let src = match c_str_to_string(guest_src) {
            Ok(s) => s,
            Err(e) => {
                write_error(out_error, e);
                return std::ptr::null_mut();
            }
        };

        let handle_ref = &*handle;
        let lite = handle_ref.handle.clone();
        match handle_ref
            .tokio_rt
            .block_on(lite.copy_out_tar(src.as_str(), default_copy_options()))
        {
            Ok((tar, source_is_dir)) => {
                if !out_source_kind.is_null() {
                    *out_source_kind = source_hint_to_kind(source_is_dir);
                }
                Box::into_raw(Box::new(CBoxCopyOutStream::new(
                    tar,
                    handle_ref.tokio_rt.clone(),
                )))
            }
            Err(error) => {
                write_error(out_error, error);
                std::ptr::null_mut()
            }
        }
    }
}

/// Read the next raw tar bytes from a copy-out stream.
///
/// This call blocks while the upstream stream is pending. `Ok` with a
/// positive `out_read` returns data; `Ok` with zero length is sticky EOF. A
/// stream item error is terminal: its first read reports the stream error and
/// later reads return `InvalidState` without polling upstream again.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_copy_out_read(
    stream: *mut CBoxCopyOutStream,
    buffer: *mut u8,
    capacity: usize,
    out_read: *mut usize,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if stream.is_null() {
            write_error(out_error, null_pointer_error("stream"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_read.is_null() {
            write_error(out_error, null_pointer_error("out_read"));
            return BoxliteErrorCode::InvalidArgument;
        }
        *out_read = 0;
        if capacity == 0 {
            let error =
                BoxliteError::InvalidArgument("capacity must be greater than zero".to_string());
            let code = error_to_code(&error);
            write_error(out_error, error);
            return code;
        }
        if buffer.is_null() {
            write_error(out_error, null_pointer_error("buffer"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let dst = std::slice::from_raw_parts_mut(buffer, capacity);
        match (&mut *stream).read_into(dst) {
            Ok(count) => {
                *out_read = count;
                BoxliteErrorCode::Ok
            }
            Err(error) => {
                let code = error_to_code(&error);
                write_error(out_error, error);
                code
            }
        }
    }
}

/// Reclaim a copy-out stream handle. A null handle is a no-op.
///
/// The caller must not invoke [`boxlite_copy_out_read`] concurrently or race
/// a read with this function.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_copy_out_free(stream: *mut CBoxCopyOutStream) {
    unsafe {
        if !stream.is_null() {
            drop(Box::from_raw(stream));
        }
    }
}

/// Begin a streaming copy-in, returning an opaque transfer handle.
///
/// `source_kind` describes the archive shape: `BoxliteCopySourceKind`'s
/// discriminant (`Unknown`=0, `File`=1, `Dir`=2), or 0 when the caller
/// cannot tell (older clients) — the guest then peeks the archive to decide.
/// Taken as an integer because C callers can pass any value, and
/// out-of-range discriminants must behave as Unknown rather than as an
/// invalid Rust enum.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_copy_in_start(
    handle: *mut CBoxHandle,
    guest_dst: *const c_char,
    source_kind: i32,
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

        let source_is_dir = source_kind_to_hint(source_kind);

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

/// Abort the copy-in stream: deliver a terminal error to the guest and then
/// close the channel. Unlike [`boxlite_copy_in_close`], the guest sees a
/// failed stream — a truncated upload can never pass as a clean EOF. Call
/// this when the source read failed mid-transfer. Idempotent: after the
/// first call (abort or close) the stream reports InvalidState.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_copy_in_abort(
    stream: *mut CBoxCopyInStream,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if stream.is_null() {
            write_error(out_error, null_pointer_error("stream"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let stream_ref = &mut *stream;
        let Some(tx) = stream_ref.tx.as_ref() else {
            write_error(
                out_error,
                boxlite::BoxliteError::InvalidState("copy-in stream is closed".to_string()),
            );
            return BoxliteErrorCode::InvalidState;
        };

        let send = stream_ref
            .tokio_rt
            .block_on(tx.send(Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "copy-in aborted",
            ))));
        // Drop the sender either way: the terminal error (if the consumer is
        // still alive) precedes EOF, and no further writes are accepted.
        stream_ref.tx.take();
        match send {
            Ok(()) => BoxliteErrorCode::Ok,
            Err(_) => {
                // The guest consumer is already gone; nothing to signal.
                write_error(
                    out_error,
                    boxlite::BoxliteError::Internal("guest upload aborted".to_string()),
                );
                BoxliteErrorCode::Internal
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CStr;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    fn copy_out_stream(items: Vec<io::Result<Vec<u8>>>) -> CBoxCopyOutStream {
        let tar: BoxTarStream = Box::pin(futures::stream::iter(items));
        CBoxCopyOutStream::new(tar, Arc::new(tokio::runtime::Runtime::new().unwrap()))
    }

    fn assert_error_contains(
        error: &CBoxliteError,
        expected_code: BoxliteErrorCode,
        expected_message: &str,
    ) {
        assert_eq!(error.code, expected_code);
        assert!(!error.message.is_null());
        let message = unsafe { CStr::from_ptr(error.message) }.to_string_lossy();
        assert!(
            message.contains(expected_message),
            "expected {message:?} to contain {expected_message:?}"
        );
    }

    struct DropProbe(Arc<AtomicBool>);

    impl Drop for DropProbe {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn copy_out_start_null_handle_resets_source_kind_and_reports_error() {
        let mut source_kind = BoxliteCopySourceKind::Dir as i32;
        let mut error = CBoxliteError::default();

        let stream = unsafe {
            boxlite_copy_out_start(
                std::ptr::null_mut(),
                std::ptr::null(),
                &mut source_kind,
                &mut error,
            )
        };
        assert!(stream.is_null());
        assert_eq!(source_kind, BoxliteCopySourceKind::Unknown as i32);
        assert_error_contains(&error, BoxliteErrorCode::InvalidArgument, "handle is null");
        unsafe { crate::error::boxlite_error_free(&mut error) };

        source_kind = BoxliteCopySourceKind::Dir as i32;
        let stream = unsafe {
            boxlite_copy_out_start(
                std::ptr::null_mut(),
                std::ptr::null(),
                &mut source_kind,
                std::ptr::null_mut(),
            )
        };
        assert!(stream.is_null());
        assert_eq!(source_kind, BoxliteCopySourceKind::Unknown as i32);

        let stream = unsafe {
            boxlite_copy_out_start(
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                &mut error,
            )
        };
        assert!(stream.is_null());
        assert_error_contains(&error, BoxliteErrorCode::InvalidArgument, "handle is null");
        unsafe { crate::error::boxlite_error_free(&mut error) };

        let stream = unsafe {
            boxlite_copy_out_start(
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        assert!(stream.is_null());
    }

    #[test]
    fn source_kind_maps_to_guest_hint() {
        assert_eq!(
            source_kind_to_hint(BoxliteCopySourceKind::Unknown as i32),
            None
        );
        assert_eq!(
            source_kind_to_hint(BoxliteCopySourceKind::File as i32),
            Some(false)
        );
        assert_eq!(
            source_kind_to_hint(BoxliteCopySourceKind::Dir as i32),
            Some(true)
        );
        assert_eq!(
            source_hint_to_kind(None),
            BoxliteCopySourceKind::Unknown as i32
        );
        assert_eq!(
            source_hint_to_kind(Some(false)),
            BoxliteCopySourceKind::File as i32
        );
        assert_eq!(
            source_hint_to_kind(Some(true)),
            BoxliteCopySourceKind::Dir as i32
        );
    }

    #[test]
    fn copy_out_splits_chunks_skips_empty_items_and_sticks_eof() {
        let mut stream =
            copy_out_stream(vec![Ok(Vec::new()), Ok(b"abcde".to_vec()), Ok(Vec::new())]);
        let mut dst = [0_u8; 2];

        assert_eq!(stream.read_into(&mut dst).unwrap(), 2);
        assert_eq!(&dst, b"ab");
        assert_eq!(stream.read_into(&mut dst).unwrap(), 2);
        assert_eq!(&dst, b"cd");
        assert_eq!(stream.read_into(&mut dst).unwrap(), 1);
        assert_eq!(dst[0], b'e');
        assert_eq!(stream.read_into(&mut dst).unwrap(), 0);
        assert_eq!(stream.read_into(&mut dst).unwrap(), 0);
    }

    #[test]
    fn copy_out_stream_error_is_terminal() {
        let mut stream = copy_out_stream(vec![
            Ok(vec![7]),
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "guest gone")),
            Ok(vec![8]),
        ]);
        let mut dst = [0_u8; 1];

        assert_eq!(stream.read_into(&mut dst).unwrap(), 1);
        assert_eq!(dst[0], 7);
        let error = stream.read_into(&mut dst).unwrap_err();
        assert!(matches!(error, BoxliteError::Internal(message) if message.contains("guest gone")));
        assert!(matches!(
            stream.read_into(&mut dst).unwrap_err(),
            BoxliteError::InvalidState(message) if message == "copy-out stream has failed"
        ));
    }

    #[test]
    fn copy_out_polls_upstream_only_when_read_needs_data() {
        let polls = Arc::new(AtomicUsize::new(0));
        let stream_polls = Arc::clone(&polls);
        let tar: BoxTarStream = Box::pin(futures::stream::unfold(0_u8, move |step| {
            let stream_polls = Arc::clone(&stream_polls);
            async move {
                stream_polls.fetch_add(1, Ordering::SeqCst);
                match step {
                    0 => Some((Ok(vec![1, 2, 3]), 1)),
                    _ => None,
                }
            }
        }));
        let mut stream =
            CBoxCopyOutStream::new(tar, Arc::new(tokio::runtime::Runtime::new().unwrap()));
        let mut dst = [0_u8; 1];

        assert_eq!(polls.load(Ordering::SeqCst), 0);
        assert_eq!(stream.read_into(&mut dst).unwrap(), 1);
        assert_eq!(polls.load(Ordering::SeqCst), 1);
        assert_eq!(stream.read_into(&mut dst).unwrap(), 1);
        assert_eq!(stream.read_into(&mut dst).unwrap(), 1);
        assert_eq!(polls.load(Ordering::SeqCst), 1);
        assert_eq!(stream.read_into(&mut dst).unwrap(), 0);
        assert_eq!(polls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn copy_out_ffi_validates_read_arguments_and_frees_null() {
        let mut stream = copy_out_stream(vec![Ok(vec![1])]);
        let mut dst = [0_u8; 1];
        let mut out_len = usize::MAX;
        let mut error = CBoxliteError::default();

        let code = unsafe {
            boxlite_copy_out_read(&mut stream, dst.as_mut_ptr(), 0, &mut out_len, &mut error)
        };
        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        assert_eq!(out_len, 0);
        assert_error_contains(&error, BoxliteErrorCode::InvalidArgument, "capacity");
        unsafe { crate::error::boxlite_error_free(&mut error) };

        let code = unsafe {
            boxlite_copy_out_read(
                &mut stream,
                std::ptr::null_mut(),
                dst.len(),
                &mut out_len,
                &mut error,
            )
        };
        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        assert_eq!(out_len, 0);
        assert_error_contains(&error, BoxliteErrorCode::InvalidArgument, "buffer is null");
        unsafe { crate::error::boxlite_error_free(&mut error) };

        let code = unsafe {
            boxlite_copy_out_read(
                &mut stream,
                dst.as_mut_ptr(),
                dst.len(),
                std::ptr::null_mut(),
                &mut error,
            )
        };
        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        assert_error_contains(
            &error,
            BoxliteErrorCode::InvalidArgument,
            "out_read is null",
        );
        unsafe { crate::error::boxlite_error_free(&mut error) };

        let code = unsafe {
            boxlite_copy_out_read(
                std::ptr::null_mut(),
                dst.as_mut_ptr(),
                dst.len(),
                &mut out_len,
                &mut error,
            )
        };
        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        assert_error_contains(&error, BoxliteErrorCode::InvalidArgument, "stream is null");
        unsafe { crate::error::boxlite_error_free(&mut error) };

        let code = unsafe {
            boxlite_copy_out_read(
                &mut stream,
                dst.as_mut_ptr(),
                dst.len(),
                &mut out_len,
                &mut error,
            )
        };
        assert_eq!(code, BoxliteErrorCode::Ok);
        assert_eq!(out_len, 1);
        assert_eq!(dst[0], 1);

        let owned = Box::into_raw(Box::new(copy_out_stream(Vec::new())));
        unsafe {
            boxlite_copy_out_free(owned);
            boxlite_copy_out_free(std::ptr::null_mut());
        }
    }

    #[test]
    fn copy_out_free_drops_active_tar_stream() {
        let dropped = Arc::new(AtomicBool::new(false));
        let probe = DropProbe(Arc::clone(&dropped));
        let tar: BoxTarStream = Box::pin(futures::stream::poll_fn(move |_cx| {
            let _keep_alive = &probe;
            std::task::Poll::<Option<io::Result<Vec<u8>>>>::Pending
        }));
        let stream = Box::into_raw(Box::new(CBoxCopyOutStream::new(
            tar,
            Arc::new(tokio::runtime::Runtime::new().unwrap()),
        )));

        assert!(!dropped.load(Ordering::SeqCst));
        unsafe { boxlite_copy_out_free(stream) };
        assert!(dropped.load(Ordering::SeqCst));
    }

    /// The abort entrypoint must deliver a terminal error followed by EOF,
    /// and the spent stream must reject further writes and a second abort.
    #[test]
    fn copy_in_abort_delivers_terminal_error_then_eof() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (tx, mut rx) = mpsc::channel(4);
        let mut stream = CBoxCopyInStream {
            tx: Some(tx),
            tokio_rt: Arc::new(rt),
        };
        let mut err = CBoxliteError::default();

        let code = unsafe { boxlite_copy_in_abort(&mut stream, &mut err) };
        assert_eq!(code, BoxliteErrorCode::Ok);

        // First item is the terminal error, then EOF (channel closed).
        let first = stream.tokio_rt.block_on(rx.recv()).expect("item");
        assert_eq!(first.unwrap_err().kind(), io::ErrorKind::BrokenPipe);
        assert!(
            stream.tokio_rt.block_on(rx.recv()).is_none(),
            "must signal EOF after the error"
        );

        // A spent stream rejects both writes and a second abort.
        let mut err2 = CBoxliteError::default();
        let data = [1u8; 4];
        let code =
            unsafe { boxlite_copy_in_write(&mut stream, data.as_ptr(), data.len(), &mut err2) };
        assert_eq!(code, BoxliteErrorCode::InvalidState);
        let mut err3 = CBoxliteError::default();
        let code = unsafe { boxlite_copy_in_abort(&mut stream, &mut err3) };
        assert_eq!(code, BoxliteErrorCode::InvalidState);
    }

    #[test]
    fn unrecognized_kind_behaves_as_unknown() {
        // C callers can cast any integer to the enum; out-of-range values
        // must not be guessed into a shape.
        assert_eq!(source_kind_to_hint(7), None);
        assert_eq!(source_kind_to_hint(-1), None);
    }
}
