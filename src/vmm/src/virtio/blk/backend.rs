// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The block device's backend contract.
//!
//! The device parses a chain into a [`Request`] that owns its bounce buffer
//! and submits it with a token. A backend finishes the request inline with
//! [`Outcome::Done`], or keeps it and answers [`Outcome::Pending`]: the device
//! then defers the chain, and the backend's [`EventSource`] wakes the workers
//! once [`DiskBackend::completions`] has results. The synchronous imago
//! backend always finishes inline; a thread-pool or io_uring engine implements
//! the same trait behind the pending path.

use std::io;

use crate::virtio::EventSource;

/// What the device reports about a disk, fixed once the disk is open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Geometry {
    /// The disk size in 512-byte sectors.
    pub(crate) capacity_sectors: u64,
    /// Whether the guest may write to it.
    pub(crate) read_only: bool,
    /// The discard alignment in sectors, at least one.
    pub(crate) discard_sector_alignment: u32,
}

/// One request's operation and the buffer it owns.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RequestKind {
    /// Reads `buf.len()` bytes at `offset` into `buf`.
    In { offset: u64, buf: Vec<u8> },
    /// Writes `buf` at `offset`; `sync` also commits it to stable storage,
    /// for a driver that did not negotiate `FLUSH`.
    Out {
        offset: u64,
        buf: Vec<u8>,
        sync: bool,
    },
    /// Commits every completed write to stable storage.
    Flush,
    /// Discards `len` bytes at `offset`; they read back as zeroes.
    Discard { offset: u64, len: u64 },
}

/// A request the device submits. It owns its bounce buffer, so a backend can
/// keep it across events.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Request {
    pub(crate) kind: RequestKind,
}

/// A finished request: its virtio status byte and the request itself, so the
/// device can copy `In` data to the guest.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Completed {
    /// The token the request was submitted with.
    pub(crate) token: u32,
    /// `VIRTIO_BLK_S_OK` or `VIRTIO_BLK_S_IOERR`.
    pub(crate) status: u8,
    /// The request, buffer included.
    pub(crate) request: Request,
}

/// How a backend answered [`DiskBackend::submit`].
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// The request finished inline.
    Done(Completed),
    /// The backend kept the request. It arrives through
    /// [`DiskBackend::completions`] after the backend's source signals.
    Pending,
}

/// A disk behind the block device. The device serializes every call, so a
/// backend adds no lock of its own.
pub(crate) trait DiskBackend: Send {
    /// The disk's fixed geometry.
    fn geometry(&self) -> Geometry;

    /// Submits `request` under `token`, which is unique among the requests
    /// in flight. A synchronous backend runs the request inline and returns
    /// [`Outcome::Done`]; an asynchronous one queues it and returns
    /// [`Outcome::Pending`] without waiting for it.
    fn submit(&mut self, token: u32, request: Request) -> Outcome;

    /// Moves every finished pending request into `out` without blocking.
    fn completions(&mut self, out: &mut Vec<Completed>);

    /// The source the device registers with the workers at each activation,
    /// so that [`Self::completions`] runs after it signals; `None` for a
    /// backend that never answers [`Outcome::Pending`].
    fn event_source(&mut self) -> Option<Box<dyn EventSource>>;

    /// Commits every completed write to stable storage. The control plane
    /// calls it on reset and quiesce, with the worker stopped.
    fn flush(&mut self) -> io::Result<()>;
}
