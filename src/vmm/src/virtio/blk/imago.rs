// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The synchronous imago backend: raw and qcow2 images, with a qcow2 backing
//! chain resolved by imago, every request run inline on the worker thread.

use std::{io, path::Path};

use imago::{
    DynStorage, FormatAccess, FormatDriverBuilder, PermissiveImplicitOpenGate, qcow2::Qcow2,
    raw::Raw,
};

use super::{
    SECTOR_SHIFT, VIRTIO_BLK_S_IOERR, VIRTIO_BLK_S_OK,
    backend::{Completed, DiskBackend, Geometry, Outcome, Request, RequestKind},
};
use crate::{config::DiskFormat, virtio::EventSource};

/// An image served through imago's format driver.
pub(crate) struct ImagoBackend {
    image: FormatAccess<Box<dyn DynStorage>>,
    geometry: Geometry,
}

impl ImagoBackend {
    /// Opens `path` as `format`, writable unless `read_only`. A qcow2 image
    /// opens the backing chain its header names.
    pub(crate) fn open(path: &Path, format: DiskFormat, read_only: bool) -> io::Result<Self> {
        let writable = !read_only;
        let gate = PermissiveImplicitOpenGate::default();
        let image = match format {
            DiskFormat::Raw => FormatAccess::new(
                Raw::<Box<dyn DynStorage>>::builder_path(path)
                    .write(writable)
                    .open(gate)?,
            ),
            DiskFormat::Qcow2 => FormatAccess::new(
                Qcow2::<Box<dyn DynStorage>>::builder_path(path)
                    .write(writable)
                    .open(gate)?,
            ),
        };
        let geometry = Geometry {
            capacity_sectors: image.size() >> SECTOR_SHIFT,
            read_only,
            // imago zeroes what the format cannot discard, so any sector
            // boundary is acceptable.
            discard_sector_alignment: 1,
        };
        Ok(Self { image, geometry })
    }

    /// Runs one request to completion.
    fn run(&mut self, kind: &mut RequestKind) -> io::Result<()> {
        match kind {
            RequestKind::In { offset, buf } => self.image.read(buf.as_mut_slice(), *offset),
            RequestKind::Out { offset, buf, sync } => {
                self.image.write(buf.as_slice(), *offset)?;
                if *sync { self.flush() } else { Ok(()) }
            }
            RequestKind::Flush => self.flush(),
            RequestKind::Discard { offset, len } => self.image.discard_to_zero(*offset, *len),
        }
    }
}

impl DiskBackend for ImagoBackend {
    fn geometry(&self) -> Geometry {
        self.geometry
    }

    fn submit(&mut self, token: u32, mut request: Request) -> Outcome {
        let status = match self.run(&mut request.kind) {
            Ok(()) => VIRTIO_BLK_S_OK,
            Err(error) => {
                tracing::debug!(%error, "block request failed");
                VIRTIO_BLK_S_IOERR
            }
        };
        Outcome::Done(Completed {
            token,
            status,
            request,
        })
    }

    fn completions(&mut self, _out: &mut Vec<Completed>) {}

    fn event_source(&mut self) -> Option<Box<dyn EventSource>> {
        None
    }

    fn flush(&mut self) -> io::Result<()> {
        self.image.flush()?;
        self.image.sync()
    }
}
