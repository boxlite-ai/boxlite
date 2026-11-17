// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Typed control requests for one disk while the VM runs.
//!
//! A [`DiskSender`] queues the request and rings a doorbell socket. The block
//! device registers the doorbell's other end with the workers at each
//! activation and applies queued requests on the worker thread, between
//! guest requests, so the handle never touches the device. A request sent
//! before the driver activates the device waits for that activation.

use std::{
    fmt,
    io::{self, Read, Write},
    os::unix::net::UnixStream,
    sync::{
        Arc,
        mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender, TryRecvError},
    },
    time::Duration,
};

use crate::virtio::EventSource;

/// Sends control requests to one disk of a running VM from any thread.
#[derive(Clone)]
pub(crate) struct DiskSender {
    requests: Sender<BlockControlRequest>,
    bell: Arc<UnixStream>,
}

impl fmt::Debug for DiskSender {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DiskSender").finish_non_exhaustive()
    }
}

impl DiskSender {
    /// Grows the disk to `bytes` and notifies the guest when capacity increases.
    /// `bytes` must be a multiple of 512 and no smaller than the current size;
    /// the current size succeeds without changing capacity or notifying, so
    /// a retry after a timeout is safe. A timeout leaves the request queued:
    /// the device still applies it when the guest activates it.
    pub(crate) fn grow(&self, bytes: u64, timeout: Duration) -> io::Result<u64> {
        self.request(timeout, |reply| BlockControlRequest::Resize {
            bytes,
            reply,
        })
    }

    /// The constructor pairs each operation with its own reply type; only the
    /// request travels to the worker. A timeout leaves that request queued.
    fn request<T>(
        &self,
        timeout: Duration,
        build: impl FnOnce(SyncSender<io::Result<T>>) -> BlockControlRequest,
    ) -> io::Result<T> {
        let (reply, done) = mpsc::sync_channel(1);
        self.requests.send(build(reply)).map_err(|_| gone())?;
        match (&*self.bell).write(&[1]) {
            // A full doorbell is already ringing.
            Err(error) if error.kind() != io::ErrorKind::WouldBlock => return Err(error),
            _ => {}
        }
        done.recv_timeout(timeout).map_err(|error| match error {
            RecvTimeoutError::Timeout => io::Error::new(
                io::ErrorKind::TimedOut,
                "the disk has not applied the control request yet",
            ),
            RecvTimeoutError::Disconnected => gone(),
        })?
    }
}

fn gone() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "the disk is gone")
}

/// Each operation carries the reply type its caller expects.
pub(crate) enum BlockControlRequest {
    Resize {
        bytes: u64,
        reply: SyncSender<io::Result<u64>>,
    },
}

/// The device's end: the queue and the doorbell it registers.
pub(crate) struct Controls {
    requests: Receiver<BlockControlRequest>,
    bell: UnixStream,
}

impl Controls {
    /// A source the workers poll for this activation; it reads ready once a
    /// handle rings, including a ring from before the registration.
    pub(crate) fn event_source(&self) -> io::Result<Box<dyn EventSource>> {
        let bell = self.bell.try_clone()?;
        Ok(Box::new(Bell(mio::net::UnixStream::from_std(bell))))
    }

    /// Silences the doorbell, then returns every queued request. Reading the
    /// doorbell first keeps a request queued after this call ringing again.
    pub(crate) fn take(&mut self) -> Vec<BlockControlRequest> {
        let mut buf = [0u8; 64];
        while matches!((&self.bell).read(&mut buf), Ok(read) if read > 0) {}
        let mut taken = Vec::new();
        loop {
            match self.requests.try_recv() {
                Ok(request) => taken.push(request),
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => return taken,
            }
        }
    }
}

/// Creates one disk's handle and the device's end.
pub(crate) fn channel() -> io::Result<(DiskSender, Controls)> {
    let (ring, bell) = UnixStream::pair()?;
    ring.set_nonblocking(true)?;
    bell.set_nonblocking(true)?;
    let (requests, queue) = mpsc::channel();
    Ok((
        DiskSender {
            requests,
            bell: Arc::new(ring),
        },
        Controls {
            requests: queue,
            bell,
        },
    ))
}

struct Bell(mio::net::UnixStream);

impl EventSource for Bell {
    fn as_source(&mut self) -> &mut dyn mio::event::Source {
        &mut self.0
    }
}
