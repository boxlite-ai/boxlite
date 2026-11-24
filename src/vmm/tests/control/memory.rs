// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::net::Shutdown;
use std::sync::mpsc::{Receiver, TryRecvError};

use super::*;

fn queue(sender: &MemorySender) -> io::Result<Receiver<io::Result<()>>> {
    let (reply, done) = mpsc::sync_channel(1);
    sender.submit(MemoryRequest::SetTarget {
        added_mib: 128,
        reply,
    })?;
    Ok(done)
}

#[test]
fn stop_discards_unclaimed_commands_and_prevents_late_activation() {
    let (sender, device) = channel();
    let mut old = device.prepare().unwrap();
    assert_eq!(
        queue(&sender).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
    old.worker_started();

    let claimed = queue(&sender).unwrap();
    let pending = queue(&sender).unwrap();
    assert_eq!(device.batch_len().unwrap(), 2);
    let Some(MemoryRequest::SetTarget { reply, .. }) = device.claim() else {
        panic!("expected the admitted command");
    };
    old.worker_stopped();
    old.worker_started();
    assert_eq!(pending.try_recv().unwrap_err(), TryRecvError::Disconnected);
    assert_eq!(
        queue(&sender).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
    assert!(device.claim().is_none());
    reply.send(Ok(())).unwrap();
    claimed.try_recv().unwrap().unwrap();

    let mut current = device.prepare().unwrap();
    current.worker_started();
    drop(old);
    assert_eq!(device.batch_len().unwrap(), 0);
    let new_command = queue(&sender).unwrap();
    drop(device);
    assert_eq!(
        queue(&sender).unwrap_err().kind(),
        io::ErrorKind::BrokenPipe
    );
    assert_eq!(
        new_command.try_recv().unwrap_err(),
        TryRecvError::Disconnected
    );
}

#[test]
fn admission_is_bounded_and_post_snapshot_work_rings_again() {
    let (sender, device) = channel();
    let mut source = device.prepare().unwrap();
    let mut poll = mio::Poll::new().unwrap();
    let mut events = mio::Events::with_capacity(4);
    poll.registry()
        .register(source.as_source(), mio::Token(0), mio::Interest::READABLE)
        .unwrap();
    source.worker_started();
    let replies: Vec<_> = (0..CAPACITY).map(|_| queue(&sender).unwrap()).collect();
    assert_eq!(
        queue(&sender).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
    poll.poll(&mut events, Some(Duration::from_secs(1)))
        .unwrap();
    assert!(!events.is_empty());
    let batch = device.batch_len().unwrap();
    assert_eq!(batch, CAPACITY);
    assert!(device.claim().is_some());
    let late = queue(&sender).unwrap();
    for _ in 1..batch {
        assert!(device.claim().is_some());
    }
    poll.poll(&mut events, Some(Duration::from_secs(1)))
        .unwrap();
    assert!(!events.is_empty());
    assert!(
        replies
            .iter()
            .all(|reply| matches!(reply.try_recv(), Err(TryRecvError::Disconnected)))
    );
    assert_eq!(device.batch_len().unwrap(), 1);
    assert!(matches!(late.try_recv(), Err(TryRecvError::Empty)));
    assert!(device.claim().is_some());
}

#[test]
fn hard_wake_errors_close_admission_and_drop_queued_replies() {
    for read_error in [false, true] {
        let (sender, device) = channel();
        let mut source = device.prepare().unwrap();
        source.worker_started();
        let pending = queue(&sender).unwrap();
        {
            let endpoint = lock(&device.0);
            let active = endpoint.activation.as_ref().unwrap();
            if read_error {
                active.read.shutdown(Shutdown::Read).unwrap();
            } else {
                active.write.shutdown(Shutdown::Write).unwrap();
            }
        }
        if read_error {
            assert_eq!(
                device.batch_len().unwrap_err().kind(),
                io::ErrorKind::BrokenPipe
            );
        } else {
            assert_eq!(
                queue(&sender).unwrap_err().kind(),
                io::ErrorKind::BrokenPipe
            );
        }
        assert_eq!(pending.try_recv().unwrap_err(), TryRecvError::Disconnected);
        assert!(device.claim().is_none());
        assert_eq!(
            queue(&sender).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
    }
}

#[test]
fn doorbell_drain_retries_interruptions_until_empty() {
    let mut reads = [
        Err(io::Error::from(io::ErrorKind::Interrupted)),
        Ok(1),
        Err(io::Error::from(io::ErrorKind::WouldBlock)),
    ]
    .into_iter();
    struct Scripted<'a>(&'a mut dyn Iterator<Item = io::Result<usize>>);
    impl Read for Scripted<'_> {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            self.0.next().unwrap()
        }
    }
    drain(Scripted(&mut reads)).unwrap();
    assert!(reads.next().is_none());
}
