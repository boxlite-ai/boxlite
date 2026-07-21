//! Replayable, multi-subscriber output buffering for exec streams.
//!
//! A permanent drain task copies process stdout/stderr into a bounded ring and
//! fans each chunk out to live subscribers. Because the drain owns the fd for
//! the whole exec lifetime, a client disconnect no longer drops the PTY master
//! (which would SIGHUP the child). Re-attaching replays recent scrollback from
//! the ring, then tails live output — enabling reconnect after a dropped
//! terminal session (e.g. a runner update).

use boxlite_shared::{exec_output, ExecOutput, Stderr, Stdout};
use futures::stream::{Stream, StreamExt};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use tonic::Status;

/// Max bytes of scrollback retained per stream for replay on re-attach.
const RING_CAPACITY: usize = 256 * 1024;

/// Max live chunks buffered between a subscriber's resubscribe and first recv.
const BROADCAST_CAPACITY: usize = 256;

/// Which standard stream a buffer carries (controls ExecOutput wrapping).
#[derive(Clone, Copy)]
pub(super) enum StreamKind {
    Stdout,
    Stderr,
}

impl StreamKind {
    fn wrap(self, data: Vec<u8>) -> ExecOutput {
        let event = match self {
            StreamKind::Stdout => exec_output::Event::Stdout(Stdout { data }),
            StreamKind::Stderr => exec_output::Event::Stderr(Stderr { data }),
        };
        ExecOutput { event: Some(event) }
    }
}

struct BufferInner {
    /// Recent bytes retained for replay (bounded to RING_CAPACITY).
    ring: VecDeque<u8>,
    /// Set once the source stream reaches EOF (process output finished).
    closed: bool,
    /// Template receiver used to spawn live subscribers via `resubscribe()`.
    /// Held only to resubscribe; never polled itself.
    template_rx: broadcast::Receiver<Vec<u8>>,
}

/// Replayable output buffer for a single exec stream.
pub(super) struct OutputBuffer {
    kind: StreamKind,
    inner: Mutex<BufferInner>,
}

impl OutputBuffer {
    /// Start draining `stream` into a new buffer.
    ///
    /// Spawns a permanent task that reads until EOF, appending to the ring and
    /// broadcasting each chunk. Returns the shared buffer plus the drain task
    /// handle (detached on drop; keeps the fd open until the process exits).
    pub(super) fn spawn<S>(kind: StreamKind, mut stream: S) -> (Arc<OutputBuffer>, JoinHandle<()>)
    where
        S: Stream<Item = Vec<u8>> + Unpin + Send + 'static,
    {
        let (tx, template_rx) = broadcast::channel(BROADCAST_CAPACITY);
        let buffer = Arc::new(OutputBuffer {
            kind,
            inner: Mutex::new(BufferInner {
                ring: VecDeque::new(),
                closed: false,
                template_rx,
            }),
        });

        let drain_buffer = buffer.clone();
        let task = tokio::spawn(async move {
            while let Some(chunk) = stream.next().await {
                if chunk.is_empty() {
                    continue;
                }
                // Append and broadcast under one lock so a concurrent attach
                // (which snapshots the ring and resubscribes under the same
                // lock) observes each chunk exactly once — either already in
                // the snapshot, or delivered via the broadcast.
                let mut inner = drain_buffer.inner.lock().unwrap();
                push_bounded(&mut inner.ring, &chunk);
                let _ = tx.send(chunk);
            }
            drain_buffer.inner.lock().unwrap().closed = true;
            // `tx` drops here → live subscribers observe RecvError::Closed.
        });

        (buffer, task)
    }

    /// Spawn a forwarding task that replays scrollback then tails live output.
    ///
    /// Re-entrant: any number of attaches can run concurrently against the same
    /// buffer. Each forwards to its own `tx`; a closed `tx` (client gone) ends
    /// only that subscriber, never the drain or the process.
    pub(super) fn attach(self: &Arc<Self>, tx: mpsc::Sender<Result<ExecOutput, Status>>) {
        let buffer = self.clone();
        let (replay, mut rx, closed) = {
            let inner = self.inner.lock().unwrap();
            let replay: Vec<u8> = inner.ring.iter().copied().collect();
            let rx = inner.template_rx.resubscribe();
            (replay, rx, inner.closed)
        };

        tokio::spawn(async move {
            if !replay.is_empty() && tx.send(Ok(buffer.kind.wrap(replay))).await.is_err() {
                return;
            }
            if closed {
                return;
            }
            loop {
                match rx.recv().await {
                    Ok(chunk) => {
                        if tx.send(Ok(buffer.kind.wrap(chunk))).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                }
            }
        });
    }
}

/// Append `chunk` to `ring`, trimming the oldest bytes past RING_CAPACITY.
fn push_bounded(ring: &mut VecDeque<u8>, chunk: &[u8]) {
    ring.extend(chunk.iter().copied());
    let overflow = ring.len().saturating_sub(RING_CAPACITY);
    if overflow > 0 {
        ring.drain(..overflow);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;
    use tokio_stream::wrappers::ReceiverStream;

    /// Extract the payload bytes from an ExecOutput event.
    fn bytes_of(ev: ExecOutput) -> Vec<u8> {
        match ev.event.expect("event present") {
            exec_output::Event::Stdout(s) => s.data,
            exec_output::Event::Stderr(s) => s.data,
        }
    }

    /// Build a buffer fed by an mpsc channel; returns (source_tx, buffer, drain).
    fn buffer() -> (mpsc::Sender<Vec<u8>>, Arc<OutputBuffer>, JoinHandle<()>) {
        let (tx, rx) = mpsc::channel::<Vec<u8>>(16);
        let (buf, drain) = OutputBuffer::spawn(StreamKind::Stdout, ReceiverStream::new(rx));
        (tx, buf, drain)
    }

    /// Drain an attach receiver to EOF, collecting all forwarded bytes.
    async fn collect(mut rx: mpsc::Receiver<Result<ExecOutput, Status>>) -> Vec<u8> {
        let mut out = Vec::new();
        while let Some(item) = rx.recv().await {
            out.extend(bytes_of(item.expect("ok event")));
        }
        out
    }

    /// Attaching after the process finished replays the full scrollback, then ends.
    #[tokio::test]
    async fn replays_scrollback_after_eof() {
        let (src, buf, drain) = buffer();
        src.send(b"hello".to_vec()).await.unwrap();
        src.send(b" world".to_vec()).await.unwrap();
        drop(src); // EOF
        drain.await.unwrap();

        let (tx, rx) = mpsc::channel(16);
        buf.attach(tx);
        assert_eq!(collect(rx).await, b"hello world");
    }

    /// A late attach replays what was buffered, then tails new live output.
    #[tokio::test]
    async fn replays_then_tails_live() {
        let (src, buf, _drain) = buffer();

        // Attach first so the subscriber exists, then drive live output through.
        let (tx, mut rx) = mpsc::channel(16);
        buf.attach(tx);

        src.send(b"abc".to_vec()).await.unwrap();
        assert_eq!(bytes_of(rx.recv().await.unwrap().unwrap()), b"abc");

        src.send(b"def".to_vec()).await.unwrap();
        assert_eq!(bytes_of(rx.recv().await.unwrap().unwrap()), b"def");

        drop(src); // EOF closes the subscriber
        assert!(rx.recv().await.is_none());
    }

    /// Two concurrent attaches each receive the full scrollback independently.
    #[tokio::test]
    async fn fans_out_to_multiple_attaches() {
        let (src, buf, drain) = buffer();
        src.send(b"shared".to_vec()).await.unwrap();
        drop(src);
        drain.await.unwrap();

        let (tx1, rx1) = mpsc::channel(16);
        let (tx2, rx2) = mpsc::channel(16);
        buf.attach(tx1);
        buf.attach(tx2);

        assert_eq!(collect(rx1).await, b"shared");
        assert_eq!(collect(rx2).await, b"shared");
    }

    /// The ring keeps only the most recent RING_CAPACITY bytes.
    #[test]
    fn ring_trims_to_capacity() {
        let mut ring = VecDeque::new();
        let overflow = vec![0u8; RING_CAPACITY + 10];
        push_bounded(&mut ring, &overflow);
        push_bounded(&mut ring, &[1, 2, 3]);

        assert_eq!(ring.len(), RING_CAPACITY);
        // Newest bytes are retained at the tail.
        assert_eq!(
            ring.iter().rev().take(3).copied().collect::<Vec<_>>(),
            vec![3, 2, 1]
        );
    }
}
