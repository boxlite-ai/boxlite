// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! A device and the worker share a source, with registration lifetime owned here.

use crate::virtio::{DeviceError, EventRegistrar, EventSource, SourceId};
use mio::{Interest, Registry, Token, event::Source};
use std::{
    io,
    sync::{Arc, Mutex},
};

struct SharedSource<T> {
    io: Arc<Mutex<T>>,
    interests: Interest,
}

impl<T: Source + Send + 'static> EventSource for SharedSource<T> {
    fn as_source(&mut self) -> &mut dyn Source {
        self
    }
}

impl<T: Source> Source for SharedSource<T> {
    fn register(
        &mut self,
        registry: &Registry,
        token: Token,
        _interests: Interest,
    ) -> io::Result<()> {
        self.io
            .lock()
            .unwrap()
            .register(registry, token, self.interests)
    }
    fn reregister(
        &mut self,
        registry: &Registry,
        token: Token,
        _interests: Interest,
    ) -> io::Result<()> {
        self.io
            .lock()
            .unwrap()
            .reregister(registry, token, self.interests)
    }
    fn deregister(&mut self, registry: &Registry) -> io::Result<()> {
        self.io.lock().unwrap().deregister(registry)
    }
}

pub(super) struct Registered<T> {
    pub io: Arc<Mutex<T>>,
    registrar: Arc<dyn EventRegistrar>,
    id: SourceId,
}

impl<T: Source + Send + 'static> Registered<T> {
    pub fn new(
        io: Arc<Mutex<T>>,
        registrar: Arc<dyn EventRegistrar>,
        interests: Interest,
    ) -> Result<Self, DeviceError> {
        // A callback services the bounded device set; it need not identify one fd.
        let id = registrar
            .register(Box::new(SharedSource {
                io: io.clone(),
                interests,
            }))
            .map_err(|_| DeviceError::Fatal("vsock event registration"))?;
        Ok(Self { io, registrar, id })
    }
}

impl<T> Drop for Registered<T> {
    fn drop(&mut self) {
        self.registrar.deregister(self.id);
    }
}
