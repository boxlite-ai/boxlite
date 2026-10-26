// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The console queue: a stalled sink never blocks the writer, overflow drops
//! the oldest bytes and counts them, `finish` drains or gives up on a stuck
//! sink after a second, and a refused batch or a write after `finish` counts as
//! dropped.

use std::{
    io::{self, Write},
    sync::{Arc, Condvar, Mutex, mpsc},
    time::{Duration, Instant},
};

use super::{ConsoleWorker, DEFAULT_QUEUE_BYTES};

/// Bytes the sink took, shared with the test.
#[derive(Clone, Default)]
struct Taken(Arc<Mutex<Vec<u8>>>);

impl Write for Taken {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A sink that blocks every write until the test opens its gate.
#[derive(Clone, Default)]
struct Gated {
    open: Arc<(Mutex<bool>, Condvar)>,
    taken: Taken,
}

impl Gated {
    fn open(&self) {
        let (open, changed) = &*self.open;
        *open.lock().unwrap() = true;
        changed.notify_all();
    }
}

impl Write for Gated {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let (open, changed) = &*self.open;
        let mut open = open.lock().unwrap();
        while !*open {
            open = changed.wait(open).unwrap();
        }
        self.taken.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A sink whose reader went away.
struct Broken;

impl Write for Broken {
    fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
        Err(io::ErrorKind::BrokenPipe.into())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A sink stuck until the test opens its gate, then broken.
#[derive(Clone, Default)]
struct StuckThenBroken(Gated);

impl Write for StuckThenBroken {
    fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
        self.0.write(&[])?;
        Err(io::ErrorKind::BrokenPipe.into())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn a_stalled_sink_never_blocks_the_writer_and_overflow_drops_the_oldest() {
    let gated = Gated::default();
    let (mut writer, mut worker) = ConsoleWorker::spawn(Box::new(gated.clone()), 8).unwrap();

    let started = Instant::now();
    // The worker may take the first byte before the gate is checked, so
    // write one byte first and give it to the worker.
    writer.write_all(b"0").unwrap();
    std::thread::sleep(Duration::from_millis(20));
    writer.write_all(b"123456789abcdef").unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "the writer returned at once"
    );
    assert_eq!(worker.dropped_bytes(), 7, "15 bytes into a queue of 8");

    gated.open();
    worker.finish();

    assert_eq!(*gated.taken.0.lock().unwrap(), b"089abcdef");
}

/// A sink stuck in a write never returns it, so `finish` gives up after its
/// timeout and counts the bytes the sink never took, the held batch included.
#[test]
fn finish_gives_up_on_a_stuck_sink_and_counts_what_it_never_took() {
    let gated = Gated::default();
    let (mut writer, mut worker) = ConsoleWorker::spawn(Box::new(gated.clone()), 8).unwrap();
    // The worker takes the first byte and blocks in the sink with it.
    writer.write_all(b"0").unwrap();
    std::thread::sleep(Duration::from_millis(20));
    writer.write_all(b"12345").unwrap();

    let started = Instant::now();
    worker.finish();
    let waited = started.elapsed();

    assert!(
        (Duration::from_millis(900)..Duration::from_secs(2)).contains(&waited),
        "{waited:?}"
    );
    assert_eq!(
        worker.dropped_bytes(),
        6,
        "the held byte and the five queued"
    );
    // Freed, the worker writes its held batch and ends; nothing is left.
    gated.open();
    std::thread::sleep(Duration::from_millis(20));
    assert_eq!(*gated.taken.0.lock().unwrap(), b"0");
}

#[test]
fn finish_writes_what_is_queued_before_the_worker_ends() {
    let taken = Taken::default();
    let (mut writer, mut worker) =
        ConsoleWorker::spawn(Box::new(taken.clone()), DEFAULT_QUEUE_BYTES).unwrap();

    for line in ["Linux version 6.12\n", "reboot: Restarting system\n"] {
        writer.write_all(line.as_bytes()).unwrap();
    }
    writer.flush().unwrap();
    worker.finish();

    assert_eq!(
        String::from_utf8(taken.0.lock().unwrap().clone()).unwrap(),
        "Linux version 6.12\nreboot: Restarting system\n"
    );
}

#[test]
fn a_failing_sink_is_counted_and_the_guest_keeps_writing() {
    let (mut writer, mut worker) = ConsoleWorker::spawn(Box::new(Broken), 1024).unwrap();

    writer.write_all(b"lost\n").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while worker.dropped_bytes() == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    writer.write_all(b"still writing\n").unwrap();
    worker.finish();

    assert_eq!(
        worker.dropped_bytes(),
        19,
        "both failed batches are lost: 5 and 14 bytes"
    );
}

/// `finish` counts the held batch when it gives up; the sink failing on that
/// batch later must not count it again.
#[test]
fn a_batch_finish_gave_up_on_counts_once_when_the_sink_then_fails() {
    let stuck = StuckThenBroken::default();
    let (mut writer, mut worker) = ConsoleWorker::spawn(Box::new(stuck.clone()), 8).unwrap();
    // The worker takes the byte and blocks in the sink with it.
    writer.write_all(b"0").unwrap();
    std::thread::sleep(Duration::from_millis(20));
    worker.finish();
    assert_eq!(worker.dropped_bytes(), 1, "finish counted the held byte");

    stuck.0.open();
    assert_eq!(
        worker.exited.recv_timeout(Duration::from_secs(5)),
        Err(mpsc::RecvTimeoutError::Disconnected),
        "the freed worker ends"
    );
    assert_eq!(
        worker.dropped_bytes(),
        1,
        "the failed batch is not counted twice"
    );
}

#[test]
fn a_queue_of_no_bytes_is_refused() {
    let refused = ConsoleWorker::spawn(Box::new(Taken::default()), 0)
        .err()
        .map(|error| error.kind());

    assert_eq!(refused, Some(io::ErrorKind::InvalidInput));
}

#[test]
fn a_write_after_finish_is_counted_as_dropped() {
    let taken = Taken::default();
    let (mut writer, mut worker) = ConsoleWorker::spawn(Box::new(taken.clone()), 8).unwrap();
    worker.finish();

    writer.write_all(b"late").unwrap();

    assert_eq!(worker.dropped_bytes(), 4, "no worker will write them");
    assert!(taken.0.lock().unwrap().is_empty());
}
