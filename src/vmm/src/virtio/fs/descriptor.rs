// Copyright 2019 The Chromium OS Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
//
// Adapted for BoxLite from boxlite-ai/libkrun commit
// e12b9b3780ffa8df9f3e1797b217d13453479167,
// src/devices/src/virtio/descriptor_utils.rs.
// BoxLite modifications: checked guest-memory views and bounded positioned I/O.

//! Descriptor adapters with bounded, positioned file transfers. virtio-queue's
//! Reader/Writer do not expose their volatile slices for positioned file I/O.

use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;

use virtio_queue::DescriptorChain;
use vm_memory::{ByteValued, GuestMemory, GuestMemoryMmap, Permissions, VolatileSlice};

fn invalid(e: impl std::error::Error + Send + Sync + 'static) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, e)
}

struct Buffers<'a> {
    slices: VecDeque<VolatileSlice<'a>>,
    available: usize,
    consumed: usize,
}

/// Build both request views from one descriptor traversal, before host effects.
/// The slices retain the validated addresses even if guest metadata later changes.
/// Freezing the common queue's indirect-descriptor validation remains its contract.
pub fn request_buffers<'a>(
    mem: &'a GuestMemoryMmap,
    chain: DescriptorChain<&'a GuestMemoryMmap>,
) -> io::Result<(Reader<'a>, Writer<'a>)> {
    let mut readable = Buffers::empty();
    let mut writable = Buffers::empty();
    let mut seen_writable = false;
    let mut has_next = false;
    for desc in chain {
        has_next = desc.has_next();
        let (buffers, permissions) = if desc.is_write_only() {
            seen_writable = true;
            (&mut writable, Permissions::Write)
        } else {
            if seen_writable {
                return Err(io::Error::from_raw_os_error(libc::EINVAL));
            }
            (&mut readable, Permissions::Read)
        };
        buffers.available = buffers
            .available
            .checked_add(desc.len() as usize)
            .ok_or_else(|| io::Error::from_raw_os_error(libc::EOVERFLOW))?;
        for slice in mem
            .get_slices(desc.addr(), desc.len() as usize, permissions)
            .map_err(invalid)?
        {
            let slice = slice.map_err(invalid)?;
            if !slice.is_empty() {
                buffers.slices.push_back(slice);
            }
        }
    }
    // DescriptorChain silently stops on invalid NEXT indices, cycles, and byte
    // count overflow. A valid prefix must not execute a mutating FUSE operation.
    if has_next {
        return Err(io::Error::from_raw_os_error(libc::EINVAL));
    }
    Ok((Reader(readable), Writer(writable)))
}

impl<'a> Buffers<'a> {
    fn empty() -> Self {
        Self {
            slices: VecDeque::new(),
            available: 0,
            consumed: 0,
        }
    }

    fn advance(&mut self, count: usize) -> io::Result<()> {
        if count > self.available {
            return Err(io::Error::from_raw_os_error(libc::EINVAL));
        }
        let mut remaining = count;
        while remaining > 0 {
            let Some(front) = self.slices.front_mut() else {
                return Err(io::Error::from_raw_os_error(libc::EINVAL));
            };
            if remaining < front.len() {
                *front = front.offset(remaining).map_err(invalid)?;
                break;
            }
            remaining -= front.len();
            self.slices.pop_front();
        }
        self.available -= count;
        self.consumed += count;
        Ok(())
    }

    fn split_at(&mut self, offset: usize) -> io::Result<Self> {
        if offset > self.available {
            return Err(io::Error::from_raw_os_error(libc::EINVAL));
        }
        let mut remaining = offset;
        let position = self.slices.iter().position(|slice| {
            if remaining < slice.len() {
                true
            } else {
                remaining -= slice.len();
                false
            }
        });
        let mut suffix = match position {
            Some(position) => self.slices.split_off(position),
            None => VecDeque::new(),
        };
        if remaining > 0 {
            let front = suffix
                .pop_front()
                .ok_or_else(|| io::Error::from_raw_os_error(libc::EINVAL))?;
            self.slices
                .push_back(front.subslice(0, remaining).map_err(invalid)?);
            suffix.push_front(front.offset(remaining).map_err(invalid)?);
        }
        let available = self.available - offset;
        self.available = offset;
        Ok(Self {
            slices: suffix,
            available,
            consumed: 0,
        })
    }

    fn transfer(
        &mut self,
        file: &File,
        count: usize,
        offset: u64,
        into_guest: bool,
    ) -> io::Result<usize> {
        let count = count.min(self.available);
        if count == 0 {
            return Ok(0);
        }
        let end = offset
            .checked_add(count as u64)
            .filter(|end| *end <= i64::MAX as u64)
            .ok_or_else(|| io::Error::from_raw_os_error(libc::EOVERFLOW))?;
        let _ = end;
        let mut total = 0;
        while total < count {
            let slice = self
                .slices
                .front()
                .ok_or_else(|| io::Error::from_raw_os_error(libc::EINVAL))?;
            let length = slice.len().min(count - total);
            let transferred = loop {
                let result = if into_guest {
                    let guard = slice.ptr_guard_mut();
                    // SAFETY: guard pins this validated guest slice for `length` bytes;
                    // offset and length were checked before any file I/O.
                    unsafe {
                        libc::pread64(
                            file.as_raw_fd(),
                            guard.as_ptr().cast(),
                            length,
                            (offset + total as u64) as i64,
                        )
                    }
                } else {
                    let guard = slice.ptr_guard();
                    // SAFETY: the validated slice and guard remain alive during pwrite64.
                    unsafe {
                        libc::pwrite64(
                            file.as_raw_fd(),
                            guard.as_ptr().cast(),
                            length,
                            (offset + total as u64) as i64,
                        )
                    }
                };
                if result >= 0 {
                    break result as usize;
                }
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return if total > 0 { Ok(total) } else { Err(error) };
            };
            if transferred == 0 {
                if !into_guest && total == 0 {
                    return Err(io::ErrorKind::WriteZero.into());
                }
                break;
            }
            self.advance(transferred)?;
            total += transferred;
            if transferred < length {
                break;
            }
        }
        Ok(total)
    }
}

pub struct Reader<'a>(Buffers<'a>);

impl<'a> Reader<'a> {
    pub fn available_bytes(&self) -> usize {
        self.0.available
    }
    pub fn read_obj<T: ByteValued>(&mut self) -> io::Result<T> {
        let mut object = std::mem::MaybeUninit::<T>::uninit();
        // SAFETY: the allocation holds size_of::<T>() bytes; ByteValued permits
        // every bit pattern once read_exact has initialized the entire object.
        let bytes = unsafe {
            std::slice::from_raw_parts_mut(
                object.as_mut_ptr().cast::<u8>(),
                std::mem::size_of::<T>(),
            )
        };
        self.read_exact(bytes)?;
        // SAFETY: read_exact initialized all bytes, and T is ByteValued.
        Ok(unsafe { object.assume_init() })
    }
    pub fn split_at(&mut self, offset: usize) -> io::Result<Self> {
        self.0.split_at(offset).map(Self)
    }
    pub fn read_to_at(&mut self, file: &File, count: usize, offset: u64) -> io::Result<usize> {
        self.0.transfer(file, count, offset, false)
    }
}

impl Read for Reader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let mut total = 0;
        for slice in &self.0.slices {
            let count = slice.len().min(buffer.len() - total);
            let view = slice.subslice(0, count).map_err(invalid)?;
            view.copy_to(&mut buffer[total..total + count]);
            total += count;
            if total == buffer.len() {
                break;
            }
        }
        self.0.advance(total)?;
        Ok(total)
    }
}

pub struct Writer<'a>(Buffers<'a>);

impl<'a> Writer<'a> {
    pub fn available_bytes(&self) -> usize {
        self.0.available
    }
    pub fn bytes_written(&self) -> usize {
        self.0.consumed
    }
    pub fn split_at(&mut self, offset: usize) -> io::Result<Self> {
        self.0.split_at(offset).map(Self)
    }
    pub fn write_from_at(&mut self, file: &File, count: usize, offset: u64) -> io::Result<usize> {
        self.0.transfer(file, count, offset, true)
    }
}

impl Write for Writer<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let mut total = 0;
        for slice in &self.0.slices {
            let count = slice.len().min(buffer.len() - total);
            let view = slice.subslice(0, count).map_err(invalid)?;
            view.copy_from(&buffer[total..total + count]);
            total += count;
            if total == buffer.len() {
                break;
            }
        }
        self.0.advance(total)?;
        Ok(total)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
