// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Device-owned I/O with a duplicate polling handle and automatic deregistration.

use crate::virtio::{DeviceError, EventRegistrar, EventSource, SourceId};
use mio::{Interest, Registry, Token, event::Source};
use std::{
    io,
    os::unix::net::{UnixListener, UnixStream},
    sync::Arc,
};

enum PollSource {
    Stream(mio::net::UnixStream, Interest),
    Listener(mio::net::UnixListener, Interest),
}

impl PollSource {
    fn source(&mut self) -> (&mut dyn Source, Interest) {
        match self {
            Self::Stream(io, interests) => (io, *interests),
            Self::Listener(io, interests) => (io, *interests),
        }
    }
}

impl EventSource for PollSource {
    fn as_source(&mut self) -> &mut dyn Source {
        self
    }
}

impl Source for PollSource {
    fn register(
        &mut self,
        registry: &Registry,
        token: Token,
        _interests: Interest,
    ) -> io::Result<()> {
        let (io, interests) = self.source();
        io.register(registry, token, interests)
    }
    fn reregister(
        &mut self,
        registry: &Registry,
        token: Token,
        _interests: Interest,
    ) -> io::Result<()> {
        let (io, interests) = self.source();
        io.reregister(registry, token, interests)
    }
    fn deregister(&mut self, registry: &Registry) -> io::Result<()> {
        self.source().0.deregister(registry)
    }
}

/// Owns a polling registration, independently of the caller's socket.
pub(super) struct Registration {
    registrar: Arc<dyn EventRegistrar>,
    id: SourceId,
}

impl Registration {
    /// Registers a duplicate of a caller-owned nonblocking stream.
    pub fn stream(
        io: &UnixStream,
        registrar: Arc<dyn EventRegistrar>,
        interests: Interest,
    ) -> Result<Self, DeviceError> {
        let copy = io
            .try_clone()
            .map_err(|_| DeviceError::Fatal("vsock socket duplication"))?;
        Self::new(
            PollSource::Stream(mio::net::UnixStream::from_std(copy), interests),
            registrar,
        )
    }

    /// Registers a duplicate of a caller-owned nonblocking listener.
    pub fn listener(
        io: &UnixListener,
        registrar: Arc<dyn EventRegistrar>,
        interests: Interest,
    ) -> Result<Self, DeviceError> {
        let copy = io
            .try_clone()
            .map_err(|_| DeviceError::Fatal("vsock socket duplication"))?;
        Self::new(
            PollSource::Listener(mio::net::UnixListener::from_std(copy), interests),
            registrar,
        )
    }

    fn new(source: PollSource, registrar: Arc<dyn EventRegistrar>) -> Result<Self, DeviceError> {
        let id = registrar
            .register(Box::new(source))
            .map_err(|_| DeviceError::Fatal("vsock event registration"))?;
        Ok(Self { registrar, id })
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.registrar.deregister(self.id);
    }
}
