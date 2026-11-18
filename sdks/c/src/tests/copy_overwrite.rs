use crate::box_handle::BoxHandle;
use crate::copy::{
    boxlite_copy_in_close, boxlite_copy_in_free, boxlite_copy_in_start,
    boxlite_copy_in_start_with_overwrite,
};
use crate::event_queue::{EventQueue, RuntimeEvent};
use crate::{BoxliteErrorCode, CBoxliteError};
use boxlite::{BoxliteError, BoxliteRestOptions, BoxliteRuntime};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

extern "C" fn copy_done(_error: *mut CBoxliteError, _data: *mut std::ffi::c_void) {}

#[test]
fn copy_in_entry_points_preserve_overwrite_policy() {
    let tokio_rt = Arc::new(tokio::runtime::Runtime::new().unwrap());
    let (runtime, lite) = tokio_rt.block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(&mut socket);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            assert_eq!(line, "GET /v1/boxes/copy-box HTTP/1.1\r\n");
            loop {
                line.clear();
                assert_ne!(reader.read_line(&mut line).await.unwrap(), 0);
                if line == "\r\n" {
                    break;
                }
            }
            let body = r#"{"box_id":"copy-box","status":"running","created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z","image":"alpine","cpus":1,"memory_mib":256}"#;
            socket.write_all(format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()
            ).as_bytes()).await.unwrap();
        });
        let runtime = BoxliteRuntime::rest(BoxliteRestOptions::new(format!("http://{address}"))).unwrap();
        let lite = tokio::time::timeout(Duration::from_secs(5), runtime.get("copy-box"))
            .await.unwrap().unwrap().unwrap();
        server.await.unwrap();
        (runtime, lite)
    });
    let queue = Arc::new(EventQueue::new());
    let mut handle = BoxHandle {
        box_id: lite.id().clone(),
        handle: Arc::new(lite),
        tokio_rt: Arc::clone(&tokio_rt),
        queue: Arc::clone(&queue),
    };

    // REST refuses false before contacting the server; true/default must reach
    // transport instead. The closed listener makes that distinction deterministic.
    for overwrite in [None, Some(true), Some(false)] {
        let mut error = CBoxliteError::default();
        let stream = unsafe {
            match overwrite {
                None => boxlite_copy_in_start(
                    &mut handle,
                    c"/root/config".as_ptr(),
                    Some(copy_done),
                    std::ptr::null_mut(),
                    &mut error,
                ),
                Some(value) => boxlite_copy_in_start_with_overwrite(
                    &mut handle,
                    c"/root/config".as_ptr(),
                    value,
                    Some(copy_done),
                    std::ptr::null_mut(),
                    &mut error,
                ),
            }
        };
        assert!(!stream.is_null());
        unsafe {
            assert_eq!(
                boxlite_copy_in_close(stream, &mut error),
                BoxliteErrorCode::Ok
            );
            boxlite_copy_in_free(stream);
        }
        let (mut events, _) = queue
            .cv
            .wait_timeout_while(
                queue.inner.lock().unwrap(),
                Duration::from_secs(5),
                |events| events.is_empty(),
            )
            .unwrap();
        let RuntimeEvent::Copy { result, .. } =
            events.pop_front().expect("copy completion within 5s")
        else {
            panic!("expected copy completion");
        };
        let error = result.unwrap_err();
        if overwrite == Some(false) {
            assert!(
                matches!(error, BoxliteError::Unsupported(ref message) if message.contains("overwrite=false")),
                "{error}"
            );
        } else {
            assert!(matches!(error, BoxliteError::Network(_)), "{error}");
        }
    }
    drop(handle);
    drop(runtime);
}
