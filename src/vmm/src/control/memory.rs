// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::VecDeque,
    io::{self, Read, Write},
    os::unix::net::UnixStream,
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        mpsc::{self, RecvTimeoutError, SyncSender},
    },
    time::Duration,
};

use crate::{MemoryStatus, virtio::EventSource};

const CAPACITY: usize = 16;

pub(crate) enum MemoryRequest {
    SetTarget {
        added_mib: u32,
        reply: SyncSender<io::Result<()>>,
    },
    Status(SyncSender<io::Result<MemoryStatus>>),
}

#[derive(Default)]
struct Endpoint {
    closed: bool,
    activation: Option<Activation>,
}

struct Activation {
    token: Arc<()>,
    started: bool,
    read: UnixStream,
    write: UnixStream,
    pending: VecDeque<MemoryRequest>,
}

fn lock(endpoint: &Mutex<Endpoint>) -> MutexGuard<'_, Endpoint> {
    endpoint.lock().unwrap_or_else(PoisonError::into_inner)
}

fn closed() -> io::Error {
    io::Error::new(
        io::ErrorKind::BrokenPipe,
        "the memory control endpoint closed",
    )
}

#[derive(Clone)]
pub(super) struct MemorySender(Arc<Mutex<Endpoint>>);

impl std::fmt::Debug for MemorySender {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MemorySender").finish_non_exhaustive()
    }
}

impl MemorySender {
    pub(super) fn request<T>(
        &self,
        timeout: Duration,
        build: impl FnOnce(SyncSender<io::Result<T>>) -> MemoryRequest,
    ) -> io::Result<T> {
        let (reply, done) = mpsc::sync_channel(1);
        self.submit(build(reply))?;
        done.recv_timeout(timeout).map_err(|error| match error {
            RecvTimeoutError::Timeout => io::Error::new(
                io::ErrorKind::TimedOut,
                "virtio-mem has not replied to the control request",
            ),
            RecvTimeoutError::Disconnected => closed(),
        })?
    }

    fn submit(&self, request: MemoryRequest) -> io::Result<()> {
        let mut endpoint = lock(&self.0);
        if endpoint.closed {
            return Err(closed());
        }
        let active = endpoint
            .activation
            .as_mut()
            .filter(|activation| activation.started)
            .ok_or_else(|| io::Error::new(io::ErrorKind::WouldBlock, "virtio-mem is inactive"))?;
        if active.pending.len() == CAPACITY {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "the memory control queue is full",
            ));
        }
        active.pending.push_back(request);
        // Enqueue and ring under the same lock used for the worker's drain
        // and snapshot. A full socket already signals readiness.
        if let Err(error) = (&active.write).write_all(&[1])
            && error.kind() != io::ErrorKind::WouldBlock
        {
            endpoint.activation = None;
            return Err(error);
        }
        Ok(())
    }

    pub(super) fn close(&self) {
        let mut endpoint = lock(&self.0);
        endpoint.closed = true;
        endpoint.activation = None;
    }
}

pub(crate) struct MemoryRequests(Arc<Mutex<Endpoint>>);

impl MemoryRequests {
    pub(crate) fn prepare(&self) -> io::Result<Box<dyn EventSource>> {
        let (read, write) = UnixStream::pair()?;
        read.set_nonblocking(true)?;
        write.set_nonblocking(true)?;
        let bell = mio::net::UnixStream::from_std(read.try_clone()?);
        let mut endpoint = lock(&self.0);
        if endpoint.closed {
            return Err(closed());
        }
        let token = Arc::new(());
        endpoint.activation = Some(Activation {
            token: token.clone(),
            started: false,
            read,
            write,
            pending: VecDeque::new(),
        });
        Ok(Box::new(Bell {
            bell,
            endpoint: self.0.clone(),
            token,
        }))
    }

    pub(crate) fn batch_len(&self) -> io::Result<usize> {
        let mut endpoint = lock(&self.0);
        let Some(active) = endpoint.activation.as_mut() else {
            return Ok(0);
        };
        if let Err(error) = drain(&active.read) {
            endpoint.activation = None;
            return Err(error);
        }
        Ok(active.pending.len())
    }

    pub(crate) fn claim(&self) -> Option<MemoryRequest> {
        lock(&self.0).activation.as_mut()?.pending.pop_front()
    }
}

impl Drop for MemoryRequests {
    fn drop(&mut self) {
        MemorySender(self.0.clone()).close();
    }
}

#[cfg(any(test, all(target_os = "linux", target_arch = "x86_64")))]
pub(super) fn channel() -> (MemorySender, MemoryRequests) {
    let endpoint = Arc::new(Mutex::new(Endpoint::default()));
    (MemorySender(endpoint.clone()), MemoryRequests(endpoint))
}

fn drain(mut bell: impl Read) -> io::Result<()> {
    let mut bytes = [0; 64];
    loop {
        match bell.read(&mut bytes) {
            Ok(0) => return Err(closed()),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
            Err(error) => return Err(error),
        }
    }
}

struct Bell {
    bell: mio::net::UnixStream,
    endpoint: Arc<Mutex<Endpoint>>,
    token: Arc<()>,
}

impl EventSource for Bell {
    fn as_source(&mut self) -> &mut dyn mio::event::Source {
        &mut self.bell
    }

    fn worker_started(&mut self) {
        if let Some(active) = lock(&self.endpoint).activation.as_mut()
            && Arc::ptr_eq(&active.token, &self.token)
        {
            active.started = true;
        }
    }

    fn worker_stopped(&mut self) {
        let mut endpoint = lock(&self.endpoint);
        if endpoint
            .activation
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(&active.token, &self.token))
        {
            endpoint.activation = None;
        }
    }
}

impl Drop for Bell {
    fn drop(&mut self) {
        self.worker_stopped();
    }
}

#[cfg(test)]
#[path = "../../tests/control/memory.rs"]
mod tests;
