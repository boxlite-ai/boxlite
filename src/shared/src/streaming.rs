//! Channel-backed `std::io` adapters bridging blocking `tar` I/O with async
//! streams.
//!
//! The `tar` crate is blocking (`std::io::Read`/`Write`). The host↔guest file
//! transfer runs over async gRPC/HTTP streams. These adapters connect the two
//! through a bounded channel so neither side ever buffers a whole archive in
//! memory:
//!
//! - [`PipeWriter`] is a blocking `Write` whose bytes land on a channel; used
//!   to stream a `tar::Builder` (pack side) into an async consumer.
//! - [`PipeReader`] is a blocking `Read` that drains a channel; used to stream
//!   an async producer into a `tar::Archive` (unpack side).
//!
//! Both block the calling thread on the channel, so they must only be used
//! from a `spawn_blocking` thread (never from inside an async task).

use std::io;
use tokio::runtime::Handle;
use tokio::sync::mpsc;

/// One channel element: a data chunk or a terminal I/O error.
pub type Chunk = io::Result<Vec<u8>>;

/// Bounded in-flight chunks (backpressure).
pub const PIPE_CHUNKS: usize = 4;

/// Chunk size emitted by the pack side. Matches the historical 1 MiB
/// transfer chunk size.
pub const PIPE_CHUNK_SIZE: usize = 1 << 20;

/// Blocking `std::io::Write` feeding an async channel.
///
/// Writes are buffered and coalesced into full [`PIPE_CHUNK_SIZE`] messages;
/// each `flush` (or a full buffer) blocks until the async side accepts the
/// pending bytes. When the receiver is dropped (consumer aborted), writes
/// return [`io::ErrorKind::BrokenPipe`] so a `tar::Builder` aborts cleanly.
pub struct PipeWriter {
    tx: mpsc::Sender<Chunk>,
    handle: Handle,
    pending: Vec<u8>,
}

/// Blocking `std::io::Read` draining an async channel.
///
/// `read` blocks for the next chunk: `None` → `Ok(0)` (EOF), `Some(Err(e))` →
/// the error, `Some(Ok(buf))` → served across one or more `read` calls.
pub struct PipeReader {
    rx: mpsc::Receiver<Chunk>,
    handle: Handle,
    pending: Option<(Vec<u8>, usize)>,
}

/// Write-side pipe: a blocking writer feeding an async receiver.
///
/// Captures [`Handle::current`], so it must be called from within a Tokio
/// runtime context (the async side); the returned writer is then moved onto a
/// `spawn_blocking` thread.
pub fn pack_pipe() -> (PipeWriter, mpsc::Receiver<Chunk>) {
    let handle = Handle::current();
    let (tx, rx) = mpsc::channel(PIPE_CHUNKS);
    (
        PipeWriter {
            tx,
            handle,
            pending: Vec::with_capacity(PIPE_CHUNK_SIZE),
        },
        rx,
    )
}

/// Read-side pipe: an async sender feeding a blocking reader.
///
/// Captures [`Handle::current`]; call from within a Tokio runtime context.
pub fn unpack_pipe() -> (mpsc::Sender<Chunk>, PipeReader) {
    let handle = Handle::current();
    let (tx, rx) = mpsc::channel(PIPE_CHUNKS);
    (
        tx,
        PipeReader {
            rx,
            handle,
            pending: None,
        },
    )
}

impl io::Write for PipeWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if self.tx.is_closed() {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "stream consumer dropped",
            ));
        }
        self.pending.extend_from_slice(buf);
        if self.pending.len() >= PIPE_CHUNK_SIZE {
            self.flush_pending()?;
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.flush_pending()
    }
}

impl PipeWriter {
    /// Send the pending buffer as one channel message.
    fn flush_pending(&mut self) -> io::Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let data = std::mem::take(&mut self.pending);
        match self.handle.block_on(self.tx.send(Ok(data))) {
            Ok(()) => Ok(()),
            Err(_) => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "stream consumer dropped",
            )),
        }
    }
}

impl Drop for PipeWriter {
    fn drop(&mut self) {
        // Best-effort flush so a writer dropped without an explicit `flush()`
        // (e.g. a panic mid-pack) doesn't silently lose its trailing bytes.
        if !self.pending.is_empty() {
            let data = std::mem::take(&mut self.pending);
            let _ = self.handle.block_on(self.tx.send(Ok(data)));
        }
    }
}

impl io::Read for PipeReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        loop {
            // Serve any bytes held over from the previous chunk first.
            if let Some((data, off)) = self.pending.take() {
                let n = (data.len() - off).min(buf.len());
                buf[..n].copy_from_slice(&data[off..off + n]);
                if off + n < data.len() {
                    self.pending = Some((data, off + n));
                }
                return Ok(n);
            }

            match self.handle.block_on(self.rx.recv()) {
                None => return Ok(0), // channel closed → EOF
                Some(Err(e)) => return Err(e),
                Some(Ok(data)) => {
                    // Skip zero-length chunks: Ok(0) reads as EOF to `tar`,
                    // which would truncate the archive.
                    if data.is_empty() {
                        continue;
                    }
                    let n = data.len().min(buf.len());
                    buf[..n].copy_from_slice(&data[..n]);
                    if n < data.len() {
                        self.pending = Some((data, n));
                    }
                    return Ok(n);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    // The adapters call `Handle::block_on` per chunk, which requires a
    // multi-thread runtime (a single-thread runtime would deadlock: the one
    // worker is parked awaiting the test body while a blocking thread waits
    // for it to drive the channel future).

    #[tokio::test(flavor = "multi_thread")]
    async fn writer_feeds_receiver() {
        let (mut writer, mut rx) = pack_pipe();
        let task = tokio::task::spawn_blocking(move || {
            writer.write_all(b"hello").unwrap();
            writer.write_all(b" world").unwrap();
            drop(writer); // close channel → EOF
        });
        let mut got = Vec::new();
        while let Some(chunk) = rx.recv().await {
            got.extend_from_slice(&chunk.unwrap());
        }
        task.await.unwrap();
        assert_eq!(got, b"hello world");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reader_drains_sender_across_chunk_boundaries() {
        let (tx, mut reader) = unpack_pipe();
        tx.send(Ok(b"hello".to_vec())).await.unwrap();
        tx.send(Ok(b" wor".to_vec())).await.unwrap();
        tx.send(Ok(b"ld".to_vec())).await.unwrap();
        drop(tx);
        let out = tokio::task::spawn_blocking(move || {
            let mut out = Vec::new();
            let mut buf = [0u8; 3]; // smaller than chunks → exercises `pending`
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => out.extend_from_slice(&buf[..n]),
                    Err(e) => panic!("{e}"),
                }
            }
            out
        })
        .await
        .unwrap();
        assert_eq!(out, b"hello world");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reader_sees_eof_when_sender_dropped() {
        let (tx, mut reader) = unpack_pipe();
        drop(tx);
        let n = tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 4];
            reader.read(&mut buf).unwrap()
        })
        .await
        .unwrap();
        assert_eq!(n, 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reader_surfaces_producer_error() {
        let (tx, mut reader) = unpack_pipe();
        tx.send(Err(io::Error::other("boom"))).await.unwrap();
        drop(tx);
        let err = tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 4];
            reader.read(&mut buf).unwrap_err()
        })
        .await
        .unwrap();
        assert_eq!(err.kind(), io::ErrorKind::Other);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn writer_sees_broken_pipe_when_receiver_dropped() {
        let (mut writer, rx) = pack_pipe();
        drop(rx);
        let err = tokio::task::spawn_blocking(move || writer.write_all(b"x").unwrap_err())
            .await
            .unwrap();
        assert_eq!(err.kind(), io::ErrorKind::BrokenPipe);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reader_skips_empty_chunks() {
        let (tx, mut reader) = unpack_pipe();
        tx.send(Ok(Vec::new())).await.unwrap();
        tx.send(Ok(b"data".to_vec())).await.unwrap();
        drop(tx);
        let (n, buf) = tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 4];
            let n = reader.read(&mut buf).unwrap();
            (n, buf)
        })
        .await
        .unwrap();
        assert_eq!(n, 4);
        assert_eq!(&buf, b"data");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn writer_blocks_when_channel_full() {
        let (mut writer, mut rx) = pack_pipe();
        let big = vec![0u8; PIPE_CHUNK_SIZE];
        let (filled_tx, filled_rx) = tokio::sync::oneshot::channel();
        let writer_task = tokio::task::spawn_blocking(move || {
            for _ in 0..PIPE_CHUNKS {
                writer.write_all(&big).unwrap();
            }
            // Channel is now full; signal and block on the next write until
            // the async side drains a chunk.
            let _ = filled_tx.send(());
            writer.write_all(&big).unwrap();
        });

        filled_rx.await.unwrap();
        // No read has happened yet, so the writer must be blocked — a
        // completed task here would mean the channel is unbounded.
        assert!(
            !writer_task.is_finished(),
            "writer must block when the bounded channel is full"
        );
        let chunk = rx.recv().await.unwrap().unwrap();
        assert_eq!(chunk.len(), PIPE_CHUNK_SIZE);
        writer_task.await.unwrap();
    }
}
