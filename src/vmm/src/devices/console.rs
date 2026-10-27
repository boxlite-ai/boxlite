// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The console queue between the serial port and the host sink.
//!
//! A vCPU serves a serial write under the device lock, so [`ConsoleWriter`]
//! pushes the byte into a bounded queue and returns; a worker thread writes
//! the queue to the sink. A stalled or failing sink never stalls the guest:
//! a full queue drops its oldest bytes, as the kernel's log ring does, and
//! counts them, like a batch the sink refuses and a write after `finish`.

use std::{
    collections::VecDeque,
    io::{self, Write},
    sync::{
        Arc, Condvar, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicUsize, Ordering},
        mpsc::{self, RecvTimeoutError},
    },
    thread,
    time::Duration,
};

/// Bytes of guest serial output the queue holds before it drops the oldest.
pub(crate) const DEFAULT_QUEUE_BYTES: usize = 64 * 1024;

/// How long `finish` waits: enough for a healthy sink to take a full queue.
const FINISH_TIMEOUT: Duration = Duration::from_secs(1);

/// Guest serial output on its way to the host sink, one byte per entry.
struct OutputQueue {
    /// Bytes the worker has not taken yet, oldest first.
    pending: VecDeque<u8>,
    /// How many bytes the worker took and is still writing to the sink.
    writing_len: usize,
    /// Set once the console finishes: later writes are dropped.
    closed: bool,
}

/// The state the serial port's writer and the worker thread share.
struct ConsoleState {
    queue: Mutex<OutputQueue>,
    /// Wakes the worker when bytes arrive or the queue closes.
    wake_worker: Condvar,
    /// Most bytes `pending` holds.
    capacity: usize,
    /// Bytes dropped so far, read through `ConsoleWorker::dropped_bytes`.
    dropped: AtomicUsize,
}

impl ConsoleState {
    /// Locks the queue, which a panic under the lock leaves consistent.
    fn lock_queue(&self) -> MutexGuard<'_, OutputQueue> {
        self.queue.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Closes the queue: the worker writes what is left and ends.
    fn close(&self) {
        self.lock_queue().closed = true;
        self.wake_worker.notify_one();
    }
}

/// The serial port's sink: a write queues the bytes and returns.
pub(crate) struct ConsoleWriter(Arc<ConsoleState>);

impl Write for ConsoleWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut queue = self.0.lock_queue();
        if queue.closed {
            self.0.dropped.fetch_add(buf.len(), Ordering::Relaxed);
            return Ok(buf.len());
        }
        for &byte in buf {
            if queue.pending.len() == self.0.capacity {
                queue.pending.pop_front();
                self.0.dropped.fetch_add(1, Ordering::Relaxed);
            }
            queue.pending.push_back(byte);
        }
        drop(queue);
        self.0.wake_worker.notify_one();
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The worker thread that writes the queue to the sink.
pub(crate) struct ConsoleWorker {
    state: Arc<ConsoleState>,
    thread: Option<thread::JoinHandle<()>>,
    /// Disconnects when the worker thread exits, panics included.
    exited: mpsc::Receiver<()>,
}

impl ConsoleWorker {
    /// Starts a worker writing to `sink`, with a queue of `capacity` bytes,
    /// and returns the writer the serial port uses; refuses a capacity of 0.
    pub(crate) fn spawn(
        sink: Box<dyn Write + Send>,
        capacity: usize,
    ) -> io::Result<(ConsoleWriter, Self)> {
        if capacity == 0 {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let state = Arc::new(ConsoleState {
            queue: Mutex::new(OutputQueue {
                pending: VecDeque::with_capacity(capacity),
                writing_len: 0,
                closed: false,
            }),
            wake_worker: Condvar::new(),
            capacity,
            dropped: AtomicUsize::new(0),
        });
        let (exit_sender, exited) = mpsc::channel::<()>();
        let thread = thread::Builder::new().name("console".into()).spawn({
            let state = Arc::clone(&state);
            move || {
                let _exit_sender = exit_sender;
                run_worker(&state, sink);
            }
        })?;
        Ok((
            ConsoleWriter(Arc::clone(&state)),
            Self {
                state,
                thread: Some(thread),
                exited,
            },
        ))
    }

    /// Bytes dropped: the queue was full or closed, or the sink never took them.
    pub(crate) fn dropped_bytes(&self) -> u64 {
        self.state.dropped.load(Ordering::Relaxed) as u64
    }

    /// Closes the queue and waits up to [`FINISH_TIMEOUT`] for the worker to
    /// write the rest. A sink write cannot be cancelled, so then the worker
    /// is left behind and every unwritten byte, its batch included, counts
    /// as dropped. A second call does nothing.
    pub(crate) fn finish(&mut self) {
        let Some(thread) = self.thread.take() else {
            return;
        };
        self.state.close();
        if let Err(RecvTimeoutError::Disconnected) = self.exited.recv_timeout(FINISH_TIMEOUT) {
            let _ = thread.join();
            return;
        }
        let mut queue = self.state.lock_queue();
        let unwritten = queue.pending.drain(..).count() + std::mem::take(&mut queue.writing_len);
        self.state.dropped.fetch_add(unwritten, Ordering::Relaxed);
    }
}

impl Drop for ConsoleWorker {
    fn drop(&mut self) {
        self.state.close(); // Without `finish`, nothing waits for the worker.
    }
}

/// The worker loop: takes every pending byte as one batch, writes it outside
/// the lock, and ends once the queue is closed and empty.
fn run_worker(state: &ConsoleState, mut sink: Box<dyn Write + Send>) {
    loop {
        let mut queue = state
            .wake_worker
            .wait_while(state.lock_queue(), |q| q.pending.is_empty() && !q.closed)
            .unwrap_or_else(PoisonError::into_inner);
        if queue.pending.is_empty() {
            return;
        }
        let batch: Vec<u8> = queue.pending.drain(..).collect();
        queue.writing_len = batch.len();
        drop(queue);
        let write_result = sink.write_all(&batch).and_then(|()| sink.flush());
        let mut queue = state.lock_queue();
        // A `finish` that gave up has already counted the batch and reset this to 0.
        let lost = std::mem::take(&mut queue.writing_len);
        if write_result.is_err() {
            state.dropped.fetch_add(lost, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
#[path = "../../tests/console/mod.rs"]
mod tests;
