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
    backend::{CompletedRequest, DiskBackend, DiskInfo, Request, RequestKind, SubmitOutcome},
};
use crate::{config::DiskFormat, virtio::EventSource};

/// An image served through imago's format driver.
pub(crate) struct ImagoBackend {
    image: FormatAccess<Box<dyn DynStorage>>,
    disk_info: DiskInfo,
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
        let disk_info = DiskInfo {
            capacity_sectors: image.size() >> SECTOR_SHIFT,
            read_only,
            // imago zeroes what the format cannot discard, so any sector
            // boundary is acceptable.
            discard_sector_alignment: 1,
        };
        Ok(Self { image, disk_info })
    }

    /// Runs one request to completion.
    fn execute(&mut self, kind: &mut RequestKind) -> io::Result<()> {
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
    fn disk_info(&self) -> DiskInfo {
        self.disk_info
    }

    fn submit(&mut self, token: u32, mut request: Request) -> SubmitOutcome {
        let status = match self.execute(&mut request.kind) {
            Ok(()) => VIRTIO_BLK_S_OK,
            Err(error) => {
                tracing::debug!(%error, "block request failed");
                VIRTIO_BLK_S_IOERR
            }
        };
        SubmitOutcome::Done(CompletedRequest {
            token,
            status,
            request,
        })
    }

    fn completions(&mut self, _out: &mut Vec<CompletedRequest>) {}

    fn event_source(&mut self) -> Option<Box<dyn EventSource>> {
        None
    }

    fn flush(&mut self) -> io::Result<()> {
        self.image.flush()?;
        self.image.sync()
    }
}
