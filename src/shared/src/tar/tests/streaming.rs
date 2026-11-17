use super::*;
use std::time::Duration;
use tokio::sync::oneshot;

#[tokio::test]
async fn cancelled_unpack_releases_an_idle_source() {
    let tmp = TempDir::new().unwrap();
    let (entered_tx, entered_rx) = oneshot::channel();
    let (dropped_tx, dropped_rx) = oneshot::channel::<()>();
    let (extractor_tx, extractor_rx) = oneshot::channel::<()>();
    let source = futures::stream::once(async move {
        let _lifetime = dropped_tx;
        entered_tx.send(()).unwrap();
        std::future::pending::<std::io::Result<Vec<u8>>>().await
    });
    let unpack = tokio::spawn(unpack_stream_refusing(
        Box::pin(source),
        tmp.path().join("out"),
        default_unpack(true),
        None,
        move |_| {
            let _ = &extractor_tx;
            Ok(())
        },
    ));
    entered_rx.await.unwrap();
    unpack.abort();
    assert!(unpack.await.unwrap_err().is_cancelled());
    assert!(
        tokio::time::timeout(Duration::from_secs(2), dropped_rx)
            .await
            .is_ok(),
        "cancelling extraction must drop an idle source, not detach its forwarder"
    );
    assert!(
        tokio::time::timeout(Duration::from_secs(2), extractor_rx)
            .await
            .is_ok(),
        "closing the reader channel must release the blocking extractor"
    );
}

#[tokio::test]
async fn slow_extraction_bounds_source_read_ahead() {
    let tmp = TempDir::new().unwrap();
    let src = tmp.path().join("large");
    // Use allocated data: tar-rs can encode a sparse file in one small chunk.
    let mut file = std::fs::File::create(&src).unwrap();
    for _ in 0..512 {
        file.write_all(&[42; 64 << 10]).unwrap();
    }
    drop(file);
    let source = pack_stream(src, default_pack()).await.unwrap();
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::unbounded_channel();
    let source = source.inspect(move |chunk| {
        progress_tx.send(chunk.as_ref().unwrap().len()).unwrap();
    });
    let (blocked_tx, blocked_rx) = oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let blocked = std::sync::Mutex::new(Some(blocked_tx));
    let release = std::sync::Mutex::new(release_rx);
    let unpack = tokio::spawn(unpack_stream_refusing(
        Box::pin(source),
        tmp.path().join("out"),
        default_unpack(true),
        None,
        move |_| {
            if let Some(signal) = blocked.lock().unwrap().take() {
                signal.send(()).unwrap();
                release.lock().unwrap().recv().unwrap();
            }
            Ok(())
        },
    ));
    blocked_rx.await.unwrap();
    // One chunk is in PipeReader, four are queued, and one send is pending.
    for _ in 0..COPY_CHUNKS_IN_FLIGHT + 2 {
        let bytes = tokio::time::timeout(Duration::from_secs(2), progress_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(bytes <= COPY_CHUNK_SIZE);
    }
    let extra = tokio::time::timeout(Duration::from_millis(100), progress_rx.recv()).await;
    release_tx.send(()).unwrap();
    let result = unpack.await.unwrap();
    assert!(
        extra.is_err(),
        "a blocked extractor allowed more than six chunks of read-ahead"
    );
    result.unwrap();
    assert_eq!(
        std::fs::metadata(tmp.path().join("out")).unwrap().len(),
        32 << 20
    );
}
