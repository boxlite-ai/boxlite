// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The synchronous imago backend: raw and qcow2 images, with a qcow2 backing
//! chain resolved by imago, every request run inline on the worker thread.

use std::{io, path::Path};

use imago::{
    DynStorage, FormatAccess, FormatDriverBuilder, PermissiveImplicitOpenGate,
    format::PreallocateMode, qcow2::Qcow2, raw::Raw,
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

    fn resize_grow(&mut self, bytes: u64) -> io::Result<DiskInfo> {
        #[cfg(target_os = "linux")]
        match self.image.inner().format() {
            imago::format::Format::Qcow2 => {
                // Temporary allowance based on measurements of fresh qcow2
                // images. Existing cluster layouts can require more space.
                const GIB: u64 = 1 << 30;
                const METADATA_BYTES_PER_GIB: u64 = 1 << 20;
                let metadata_reserve = bytes.div_ceil(GIB) * METADATA_BYTES_PER_GIB;
                check_file_size_limit(bytes, metadata_reserve)?;
            }
            imago::format::Format::Raw => check_file_size_limit(bytes, 0)?,
            _ => {}
        }
        // `None` only grows metadata and the file length: the new range reads
        // as zeroes because it maps nothing, even past a shorter backing file.
        self.image.resize_grow(bytes, PreallocateMode::None)?;
        self.disk_info.capacity_sectors = self.image.size() >> SECTOR_SHIFT;
        Ok(self.disk_info)
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

#[cfg(target_os = "linux")]
fn check_file_size_limit(bytes: u64, metadata_reserve: u64) -> io::Result<()> {
    let mut limit = libc::rlimit64 {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: getrlimit64 writes the calling process's limits to this struct.
    if unsafe { libc::getrlimit64(libc::RLIMIT_FSIZE, &mut limit) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let soft_limit = limit.rlim_cur;
    let required = u128::from(bytes) + u128::from(metadata_reserve);
    if soft_limit != u64::MAX && required > u128::from(soft_limit) {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
            format!(
                "Resize to {bytes} bytes needs an estimated host file size of {required} bytes \
                 (including {metadata_reserve} bytes for metadata), above the RLIMIT_FSIZE \
                 soft limit of {soft_limit} bytes"
            ),
        ));
    }
    Ok(())
}
