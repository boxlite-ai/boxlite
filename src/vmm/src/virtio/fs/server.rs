// Copyright 2019 The Chromium OS Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

use std::ffi::CStr;
use std::fs::File;
use std::io::{self, Read, Write};
use std::mem::size_of;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use vm_memory::ByteValued;

use super::bindings;
use super::descriptor::{Reader, Writer};
use super::filesystem::{
    Context, DirEntry, Entry, Extensions, FileSystem, GetxattrReply, ListxattrReply,
    ZeroCopyReader, ZeroCopyWriter,
};
use super::fs_utils::einval;
use super::fuse::*;
use tracing::{debug, error};
#[derive(Debug, thiserror::Error)]
pub enum FsError {
    #[error("cannot decode FUSE request: {0}")]
    DecodeMessage(#[source] io::Error),
    #[error("cannot encode FUSE reply: {0}")]
    EncodeMessage(#[source] io::Error),
    #[error("invalid FUSE header or body length")]
    InvalidHeaderLength,
    #[error("missing request parameter")]
    MissingParameter,
    #[error("invalid NUL-terminated request string: {0}")]
    InvalidCString(#[source] std::ffi::FromBytesWithNulError),
    #[error("invalid xattr size: {0:?}")]
    InvalidXattrSize((u32, usize)),
}

pub type Result<T> = std::result::Result<T, FsError>;
use FsError as Error;

const MAX_BUFFER_SIZE: u32 = 1 << 20;
const BUFFER_HEADER_SIZE: u32 = 0x1000;
const DIRENT_PADDING: [u8; 8] = [0; 8];

struct ZCReader<'a>(Reader<'a>);

impl ZeroCopyReader for ZCReader<'_> {
    fn read_to(&mut self, f: &File, count: usize, off: u64) -> io::Result<usize> {
        self.0.read_to_at(f, count, off)
    }
}

impl io::Read for ZCReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf)
    }
}

struct ZCWriter<'a>(Writer<'a>);

impl ZeroCopyWriter for ZCWriter<'_> {
    fn write_from(&mut self, f: &File, count: usize, off: u64) -> io::Result<usize> {
        self.0.write_from_at(f, count, off)
    }
}

impl io::Write for ZCWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

pub struct Server<F: FileSystem + Sync> {
    fs: F,
    options: AtomicU64,
    initialized: AtomicBool,
}

impl<F: FileSystem + Sync> Server<F> {
    pub fn new(fs: F) -> Server<F> {
        Server {
            fs,
            options: AtomicU64::new(FsOptions::empty().bits()),
            initialized: AtomicBool::new(false),
        }
    }

    /// Clear negotiated protocol state and invalidate backend session resources.
    pub fn reset(&self) {
        self.options.store(0, Ordering::Relaxed);
        self.initialized.store(false, Ordering::Relaxed);
        self.fs.destroy();
    }

    pub fn handle_message(&self, mut r: Reader, mut w: Writer) -> Result<usize> {
        let in_header: InHeader = r.read_obj().map_err(Error::DecodeMessage)?;
        let no_reply = matches!(in_header.opcode, x if x == Opcode::Forget as u32
            || x == Opcode::BatchForget as u32 || x == Opcode::Destroy as u32);
        if !no_reply && w.available_bytes() < size_of::<OutHeader>() {
            return Err(Error::EncodeMessage(io::ErrorKind::WriteZero.into()));
        }
        let invalid = in_header.len < size_of::<InHeader>() as u32
            || in_header.len > MAX_BUFFER_SIZE + BUFFER_HEADER_SIZE
            || in_header.len as usize - size_of::<InHeader>() > r.available_bytes();
        if invalid {
            return if no_reply {
                Ok(0)
            } else {
                reply_error(einval(), in_header.unique, &mut w)
            };
        }
        // Extra readable descriptor capacity is not part of this FUSE frame.
        r.split_at(in_header.len as usize - size_of::<InHeader>())
            .map_err(Error::DecodeMessage)?;
        if let Err(error) = validate_body(in_header.opcode, r.available_bytes()) {
            return if no_reply {
                Ok(0)
            } else {
                reply_error(error, in_header.unique, &mut w)
            };
        }
        if !no_reply && w.available_bytes() < minimum_reply_size(in_header.opcode) {
            return reply_error(
                io::Error::from_raw_os_error(libc::ENOMEM),
                in_header.unique,
                &mut w,
            );
        }
        if in_header.opcode != Opcode::Init as u32 && !self.initialized.load(Ordering::Relaxed) {
            return if no_reply {
                Ok(0)
            } else {
                reply_error(
                    io::Error::from_raw_os_error(libc::EPROTO),
                    in_header.unique,
                    &mut w,
                )
            };
        }
        match self.dispatch(in_header, r, &mut w) {
            Err(Error::EncodeMessage(error)) => Err(Error::EncodeMessage(error)),
            Err(_) if no_reply => Ok(0),
            Err(_) => reply_error(einval(), in_header.unique, &mut w),
            result => result,
        }
    }

    fn dispatch(&self, in_header: InHeader, r: Reader, w: &mut Writer) -> Result<usize> {
        debug!("opcode: {}", in_header.opcode);
        match in_header.opcode {
            x if x == Opcode::Lookup as u32 => self.lookup(in_header, r, w),
            x if x == Opcode::Forget as u32 => self.forget(in_header, r), // No reply.
            x if x == Opcode::Getattr as u32 => self.getattr(in_header, r, w),
            x if x == Opcode::Setattr as u32 => self.setattr(in_header, r, w),
            x if x == Opcode::Readlink as u32 => self.readlink(in_header, w),
            x if x == Opcode::Symlink as u32 => self.symlink(in_header, r, w),
            x if x == Opcode::Mknod as u32 => self.mknod(in_header, r, w),
            x if x == Opcode::Mkdir as u32 => self.mkdir(in_header, r, w),
            x if x == Opcode::Unlink as u32 => self.unlink(in_header, r, w),
            x if x == Opcode::Rmdir as u32 => self.rmdir(in_header, r, w),
            x if x == Opcode::Rename as u32 => self.rename(in_header, r, w),
            x if x == Opcode::Link as u32 => self.link(in_header, r, w),
            x if x == Opcode::Open as u32 => self.open(in_header, r, w),
            x if x == Opcode::Read as u32 => self.read(in_header, r, w),
            x if x == Opcode::Write as u32 => self.write(in_header, r, w),
            x if x == Opcode::Statfs as u32 => self.statfs(in_header, w),
            x if x == Opcode::Release as u32 => self.release(in_header, r, w),
            x if x == Opcode::Fsync as u32 => self.fsync(in_header, r, w),
            x if x == Opcode::Setxattr as u32 => self.setxattr(in_header, r, w),
            x if x == Opcode::Getxattr as u32 => self.getxattr(in_header, r, w),
            x if x == Opcode::Listxattr as u32 => self.listxattr(in_header, r, w),
            x if x == Opcode::Removexattr as u32 => self.removexattr(in_header, r, w),
            x if x == Opcode::Flush as u32 => self.flush(in_header, r, w),
            x if x == Opcode::Init as u32 => self.init(in_header, r, w),
            x if x == Opcode::Opendir as u32 => self.opendir(in_header, r, w),
            x if x == Opcode::Readdir as u32 => self.readdir(in_header, r, w),
            x if x == Opcode::Releasedir as u32 => self.releasedir(in_header, r, w),
            x if x == Opcode::Fsyncdir as u32 => self.fsyncdir(in_header, r, w),
            x if x == Opcode::Access as u32 => self.access(in_header, r, w),
            x if x == Opcode::Create as u32 => self.create(in_header, r, w),
            x if x == Opcode::Destroy as u32 => self.destroy(),
            x if x == Opcode::BatchForget as u32 => self.batch_forget(in_header, r),
            x if x == Opcode::Fallocate as u32 => self.fallocate(in_header, r, w),
            x if x == Opcode::Readdirplus as u32 => self.readdirplus(in_header, r, w),
            x if x == Opcode::Rename2 as u32 => self.rename2(in_header, r, w),
            x if x == Opcode::Lseek as u32 => self.lseek(in_header, r, w),
            x if x == Opcode::CopyFileRange as u32 => self.copyfilerange(in_header, r, w),
            x if x == Opcode::Ioctl as u32 || x == Opcode::Poll as u32 => {
                reply_errno(libc::ENOSYS, in_header.unique, w)
            }
            _ => reply_error(
                io::Error::from_raw_os_error(libc::EOPNOTSUPP),
                in_header.unique,
                w,
            ),
        }
    }

    fn lookup(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let namelen = (in_header.len as usize)
            .checked_sub(size_of::<InHeader>())
            .ok_or(Error::InvalidHeaderLength)?;

        let mut buf = vec![0u8; namelen];

        r.read_exact(&mut buf).map_err(Error::DecodeMessage)?;

        let name = bytes_to_cstr(buf.as_ref())?;

        match self
            .fs
            .lookup(Context::from(in_header), in_header.nodeid.into(), name)
        {
            Ok(entry) => {
                let out = EntryOut::from(entry);

                reply_ok(Some(out), None, in_header.unique, w)
            }
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn forget(&self, in_header: InHeader, mut r: Reader) -> Result<usize> {
        let ForgetIn { nlookup } = r.read_obj().map_err(Error::DecodeMessage)?;

        self.fs
            .forget(Context::from(in_header), in_header.nodeid.into(), nlookup);

        // There is no reply for forget messages.
        Ok(0)
    }

    fn getattr(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let GetattrIn { flags, fh, .. } = r.read_obj().map_err(Error::DecodeMessage)?;

        let handle = if (flags & GETATTR_FH) != 0 {
            Some(fh.into())
        } else {
            None
        };

        match self
            .fs
            .getattr(Context::from(in_header), in_header.nodeid.into(), handle)
        {
            Ok((st, timeout)) => {
                let out = AttrOut {
                    attr_valid: timeout.as_secs(),
                    attr_valid_nsec: timeout.subsec_nanos(),
                    dummy: 0,
                    attr: st.into(),
                };
                reply_ok(Some(out), None, in_header.unique, w)
            }
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn setattr(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let setattr_in: SetattrIn = r.read_obj().map_err(Error::DecodeMessage)?;

        let handle = if setattr_in.valid & FATTR_FH != 0 {
            Some(setattr_in.fh.into())
        } else {
            None
        };

        let valid = SetattrValid::from_bits_truncate(setattr_in.valid);

        let st: bindings::stat64 = setattr_in.into();

        match self.fs.setattr(
            Context::from(in_header),
            in_header.nodeid.into(),
            st,
            handle,
            valid,
        ) {
            Ok((st, timeout)) => {
                let out = AttrOut {
                    attr_valid: timeout.as_secs(),
                    attr_valid_nsec: timeout.subsec_nanos(),
                    dummy: 0,
                    attr: st.into(),
                };
                reply_ok(Some(out), None, in_header.unique, w)
            }
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn readlink(&self, in_header: InHeader, w: &mut Writer) -> Result<usize> {
        match self
            .fs
            .readlink(Context::from(in_header), in_header.nodeid.into())
        {
            Ok(linkname) => {
                // We need to disambiguate the option type here even though it is `None`.
                reply_ok(None::<u8>, Some(&linkname), in_header.unique, w)
            }
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn symlink(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        // Unfortunately the name and linkname are encoded one after another and
        // separated by a nul character.
        let len = (in_header.len as usize)
            .checked_sub(size_of::<InHeader>())
            .ok_or(Error::InvalidHeaderLength)?;
        let mut buf = vec![0; len];

        r.read_exact(&mut buf).map_err(Error::DecodeMessage)?;

        let mut components = buf.split_inclusive(|c| *c == b'\0');

        let name = components.next().ok_or(Error::MissingParameter)?;
        let linkname = components.next().ok_or(Error::MissingParameter)?;

        let options = FsOptions::from_bits_truncate(self.options.load(Ordering::Relaxed));

        let extensions = get_extensions(options, name.len() + linkname.len(), buf.as_slice())?;

        match self.fs.symlink(
            Context::from(in_header),
            bytes_to_cstr(linkname)?,
            in_header.nodeid.into(),
            bytes_to_cstr(name)?,
            extensions,
        ) {
            Ok(entry) => {
                let out = EntryOut::from(entry);

                reply_ok(Some(out), None, in_header.unique, w)
            }
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn mknod(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let MknodIn {
            mode, rdev, umask, ..
        } = r.read_obj().map_err(Error::DecodeMessage)?;

        let remaining_len = (in_header.len as usize)
            .checked_sub(size_of::<InHeader>())
            .and_then(|l| l.checked_sub(size_of::<MknodIn>()))
            .ok_or(Error::InvalidHeaderLength)?;
        let mut buf = vec![0; remaining_len];

        r.read_exact(&mut buf).map_err(Error::DecodeMessage)?;
        let mut components = buf.split_inclusive(|c| *c == b'\0');
        let name = components.next().ok_or(Error::MissingParameter)?;

        let options = FsOptions::from_bits_truncate(self.options.load(Ordering::Relaxed));

        let extensions = get_extensions(options, name.len(), buf.as_slice())?;

        match self.fs.mknod(
            Context::from(in_header),
            in_header.nodeid.into(),
            bytes_to_cstr(name)?,
            mode,
            rdev,
            umask,
            extensions,
        ) {
            Ok(entry) => {
                let out = EntryOut::from(entry);

                reply_ok(Some(out), None, in_header.unique, w)
            }
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn mkdir(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let MkdirIn { mode, umask } = r.read_obj().map_err(Error::DecodeMessage)?;

        let remaining_len = (in_header.len as usize)
            .checked_sub(size_of::<InHeader>())
            .and_then(|l| l.checked_sub(size_of::<MkdirIn>()))
            .ok_or(Error::InvalidHeaderLength)?;
        let mut buf = vec![0; remaining_len];

        r.read_exact(&mut buf).map_err(Error::DecodeMessage)?;
        let mut components = buf.split_inclusive(|c| *c == b'\0');
        let name = components.next().ok_or(Error::MissingParameter)?;

        let options = FsOptions::from_bits_truncate(self.options.load(Ordering::Relaxed));

        let extensions = get_extensions(options, name.len(), buf.as_slice())?;

        match self.fs.mkdir(
            Context::from(in_header),
            in_header.nodeid.into(),
            bytes_to_cstr(name)?,
            mode,
            umask,
            extensions,
        ) {
            Ok(entry) => {
                let out = EntryOut::from(entry);

                reply_ok(Some(out), None, in_header.unique, w)
            }
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn unlink(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let namelen = (in_header.len as usize)
            .checked_sub(size_of::<InHeader>())
            .ok_or(Error::InvalidHeaderLength)?;
        let mut name = vec![0; namelen];

        r.read_exact(&mut name).map_err(Error::DecodeMessage)?;

        match self.fs.unlink(
            Context::from(in_header),
            in_header.nodeid.into(),
            bytes_to_cstr(&name)?,
        ) {
            Ok(()) => reply_ok(None::<u8>, None, in_header.unique, w),
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn rmdir(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let namelen = (in_header.len as usize)
            .checked_sub(size_of::<InHeader>())
            .ok_or(Error::InvalidHeaderLength)?;
        let mut name = vec![0; namelen];

        r.read_exact(&mut name).map_err(Error::DecodeMessage)?;

        match self.fs.rmdir(
            Context::from(in_header),
            in_header.nodeid.into(),
            bytes_to_cstr(&name)?,
        ) {
            Ok(()) => reply_ok(None::<u8>, None, in_header.unique, w),
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn do_rename(
        &self,
        in_header: InHeader,
        msg_size: usize,
        newdir: u64,
        flags: u32,
        mut r: Reader,
        w: &mut Writer,
    ) -> Result<usize> {
        let buflen = (in_header.len as usize)
            .checked_sub(size_of::<InHeader>())
            .and_then(|l| l.checked_sub(msg_size))
            .ok_or(Error::InvalidHeaderLength)?;
        let mut buf = vec![0; buflen];

        r.read_exact(&mut buf).map_err(Error::DecodeMessage)?;

        // We want to include the '\0' byte in the first slice.
        let split_pos = buf
            .iter()
            .position(|c| *c == b'\0')
            .map(|p| p + 1)
            .ok_or(Error::MissingParameter)?;

        let (oldname, newname) = buf.split_at(split_pos);

        match self.fs.rename(
            Context::from(in_header),
            in_header.nodeid.into(),
            bytes_to_cstr(oldname)?,
            newdir.into(),
            bytes_to_cstr(newname)?,
            flags,
        ) {
            Ok(()) => reply_ok(None::<u8>, None, in_header.unique, w),
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn rename(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let RenameIn { newdir } = r.read_obj().map_err(Error::DecodeMessage)?;

        self.do_rename(in_header, size_of::<RenameIn>(), newdir, 0, r, w)
    }

    fn rename2(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let Rename2In { newdir, flags, .. } = r.read_obj().map_err(Error::DecodeMessage)?;

        if flags & !(libc::RENAME_EXCHANGE | libc::RENAME_NOREPLACE) != 0 {
            return reply_error(einval(), in_header.unique, w);
        }

        self.do_rename(in_header, size_of::<Rename2In>(), newdir, flags, r, w)
    }

    fn link(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let LinkIn { oldnodeid } = r.read_obj().map_err(Error::DecodeMessage)?;

        let namelen = (in_header.len as usize)
            .checked_sub(size_of::<InHeader>())
            .and_then(|l| l.checked_sub(size_of::<LinkIn>()))
            .ok_or(Error::InvalidHeaderLength)?;
        let mut name = vec![0; namelen];

        r.read_exact(&mut name).map_err(Error::DecodeMessage)?;

        match self.fs.link(
            Context::from(in_header),
            oldnodeid.into(),
            in_header.nodeid.into(),
            bytes_to_cstr(&name)?,
        ) {
            Ok(entry) => {
                let out = EntryOut::from(entry);

                reply_ok(Some(out), None, in_header.unique, w)
            }
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn open(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let OpenIn {
            flags, open_flags, ..
        } = r.read_obj().map_err(Error::DecodeMessage)?;

        let kill_priv = open_flags & OPEN_KILL_SUIDGID != 0;

        match self.fs.open(
            Context::from(in_header),
            in_header.nodeid.into(),
            kill_priv,
            flags,
        ) {
            Ok((handle, opts)) => {
                let out = OpenOut {
                    fh: handle.map(Into::into).unwrap_or(0),
                    open_flags: opts.bits(),
                    ..Default::default()
                };

                reply_ok(Some(out), None, in_header.unique, w)
            }
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn read(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let ReadIn {
            fh,
            offset,
            size,
            read_flags,
            lock_owner,
            flags,
            ..
        } = r.read_obj().map_err(Error::DecodeMessage)?;

        if size > MAX_BUFFER_SIZE {
            return reply_error(
                io::Error::from_raw_os_error(libc::ENOMEM),
                in_header.unique,
                w,
            );
        }

        let owner = if read_flags & READ_LOCKOWNER != 0 {
            Some(lock_owner)
        } else {
            None
        };

        // Split the writer into 2 pieces: one for the `OutHeader` and the rest for the data.
        if w.available_bytes().saturating_sub(size_of::<OutHeader>()) < size as usize {
            return reply_error(
                io::Error::from_raw_os_error(libc::ENOMEM),
                in_header.unique,
                w,
            );
        }
        let mut payload = w
            .split_at(size_of::<OutHeader>())
            .map_err(Error::EncodeMessage)?;
        payload
            .split_at(size as usize)
            .map_err(Error::EncodeMessage)?;
        let data_writer = ZCWriter(payload);

        match self.fs.read(
            Context::from(in_header),
            in_header.nodeid.into(),
            fh.into(),
            data_writer,
            size,
            offset,
            owner,
            flags,
        ) {
            Ok(count) if count <= size as usize => {
                // Don't use `reply_ok` because we need to set a custom size length for the
                // header.
                let out = OutHeader {
                    len: (size_of::<OutHeader>() + count) as u32,
                    error: 0,
                    unique: in_header.unique,
                };

                w.write_all(out.as_slice()).map_err(Error::EncodeMessage)?;
                Ok(out.len as usize)
            }
            Ok(_) => reply_error(io::Error::from_raw_os_error(libc::EIO), in_header.unique, w),
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn write(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let WriteIn {
            fh,
            offset,
            size,
            write_flags,
            lock_owner,
            flags,
            ..
        } = r.read_obj().map_err(Error::DecodeMessage)?;

        if size > MAX_BUFFER_SIZE {
            return reply_error(
                io::Error::from_raw_os_error(libc::ENOMEM),
                in_header.unique,
                w,
            );
        }

        let owner = if write_flags & WRITE_LOCKOWNER != 0 {
            Some(lock_owner)
        } else {
            None
        };

        let delayed_write = write_flags & WRITE_CACHE != 0;
        let kill_priv = write_flags & WRITE_KILL_PRIV != 0;

        if r.available_bytes() != size as usize {
            return reply_error(einval(), in_header.unique, w);
        }
        let data_reader = ZCReader(r);

        match self.fs.write(
            Context::from(in_header),
            in_header.nodeid.into(),
            fh.into(),
            data_reader,
            size,
            offset,
            owner,
            delayed_write,
            kill_priv,
            flags,
        ) {
            Ok(count) if count <= size as usize => {
                let out = WriteOut {
                    size: count as u32,
                    ..Default::default()
                };

                reply_ok(Some(out), None, in_header.unique, w)
            }
            Ok(_) => reply_error(io::Error::from_raw_os_error(libc::EIO), in_header.unique, w),
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn statfs(&self, in_header: InHeader, w: &mut Writer) -> Result<usize> {
        match self
            .fs
            .statfs(Context::from(in_header), in_header.nodeid.into())
        {
            Ok(st) => reply_ok(Some(Kstatfs::from(st)), None, in_header.unique, w),
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn release(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let ReleaseIn {
            fh,
            flags,
            release_flags,
            lock_owner,
        } = r.read_obj().map_err(Error::DecodeMessage)?;

        let flush = release_flags & RELEASE_FLUSH != 0;
        let flock_release = release_flags & RELEASE_FLOCK_UNLOCK != 0;
        let lock_owner = if flush || flock_release {
            Some(lock_owner)
        } else {
            None
        };

        match self.fs.release(
            Context::from(in_header),
            in_header.nodeid.into(),
            flags,
            fh.into(),
            flush,
            flock_release,
            lock_owner,
        ) {
            Ok(()) => reply_ok(None::<u8>, None, in_header.unique, w),
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn fsync(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let FsyncIn {
            fh, fsync_flags, ..
        } = r.read_obj().map_err(Error::DecodeMessage)?;
        let datasync = fsync_flags & 0x1 != 0;

        match self.fs.fsync(
            Context::from(in_header),
            in_header.nodeid.into(),
            datasync,
            fh.into(),
        ) {
            Ok(()) => reply_ok(None::<u8>, None, in_header.unique, w),
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn setxattr(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let SetxattrIn { size, flags } = r.read_obj().map_err(Error::DecodeMessage)?;

        // The name and value and encoded one after another and separated by a '\0' character.
        let len = (in_header.len as usize)
            .checked_sub(size_of::<InHeader>())
            .and_then(|l| l.checked_sub(size_of::<SetxattrIn>()))
            .ok_or(Error::InvalidHeaderLength)?;
        let mut buf = vec![0; len];

        r.read_exact(&mut buf).map_err(Error::DecodeMessage)?;

        // We want to include the '\0' byte in the first slice.
        let split_pos = buf
            .iter()
            .position(|c| *c == b'\0')
            .map(|p| p + 1)
            .ok_or(Error::MissingParameter)?;

        let (name, value) = buf.split_at(split_pos);

        if size != value.len() as u32 {
            return Err(Error::InvalidXattrSize((size, value.len())));
        }

        match self.fs.setxattr(
            Context::from(in_header),
            in_header.nodeid.into(),
            bytes_to_cstr(name)?,
            value,
            flags,
        ) {
            Ok(()) => reply_ok(None::<u8>, None, in_header.unique, w),
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn getxattr(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let GetxattrIn { size, .. } = r.read_obj().map_err(Error::DecodeMessage)?;

        let namelen = (in_header.len as usize)
            .checked_sub(size_of::<InHeader>())
            .and_then(|l| l.checked_sub(size_of::<GetxattrIn>()))
            .ok_or(Error::InvalidHeaderLength)?;
        let mut name = vec![0; namelen];

        r.read_exact(&mut name).map_err(Error::DecodeMessage)?;

        if size > MAX_BUFFER_SIZE {
            return reply_error(
                io::Error::from_raw_os_error(libc::ENOMEM),
                in_header.unique,
                w,
            );
        }

        match self.fs.getxattr(
            Context::from(in_header),
            in_header.nodeid.into(),
            bytes_to_cstr(&name)?,
            size,
        ) {
            Ok(GetxattrReply::Value(val)) => reply_ok(None::<u8>, Some(&val), in_header.unique, w),
            Ok(GetxattrReply::Count(count)) => {
                let out = GetxattrOut {
                    size: count,
                    ..Default::default()
                };

                reply_ok(Some(out), None, in_header.unique, w)
            }
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn listxattr(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let GetxattrIn { size, .. } = r.read_obj().map_err(Error::DecodeMessage)?;

        if size > MAX_BUFFER_SIZE {
            return reply_error(
                io::Error::from_raw_os_error(libc::ENOMEM),
                in_header.unique,
                w,
            );
        }

        match self
            .fs
            .listxattr(Context::from(in_header), in_header.nodeid.into(), size)
        {
            Ok(ListxattrReply::Names(val)) => reply_ok(None::<u8>, Some(&val), in_header.unique, w),
            Ok(ListxattrReply::Count(count)) => {
                let out = GetxattrOut {
                    size: count,
                    ..Default::default()
                };

                reply_ok(Some(out), None, in_header.unique, w)
            }
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn removexattr(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let namelen = (in_header.len as usize)
            .checked_sub(size_of::<InHeader>())
            .ok_or(Error::InvalidHeaderLength)?;

        let mut buf = vec![0; namelen];

        r.read_exact(&mut buf).map_err(Error::DecodeMessage)?;

        let name = bytes_to_cstr(&buf)?;

        match self
            .fs
            .removexattr(Context::from(in_header), in_header.nodeid.into(), name)
        {
            Ok(()) => reply_ok(None::<u8>, None, in_header.unique, w),
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn flush(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let FlushIn { fh, lock_owner, .. } = r.read_obj().map_err(Error::DecodeMessage)?;

        match self.fs.flush(
            Context::from(in_header),
            in_header.nodeid.into(),
            fh.into(),
            lock_owner,
        ) {
            Ok(()) => reply_ok(None::<u8>, None, in_header.unique, w),
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn init(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        if self.initialized.load(Ordering::Relaxed) {
            return reply_error(
                io::Error::from_raw_os_error(libc::EPROTO),
                in_header.unique,
                w,
            );
        }
        let InitInCompat {
            major,
            minor,
            max_readahead,
            flags,
        } = r.read_obj().map_err(Error::DecodeMessage)?;

        let InitInExt { flags2, .. } = if flags & (1 << 30) != 0 {
            r.read_obj().map_err(Error::DecodeMessage)?
        } else {
            InitInExt::default()
        };

        if r.available_bytes() != 0 {
            return Err(Error::InvalidHeaderLength);
        }

        if major < KERNEL_VERSION {
            error!("Unsupported fuse protocol version: {major}.{minor}");
            return reply_error(
                io::Error::from_raw_os_error(libc::EPROTO),
                in_header.unique,
                w,
            );
        }

        if major > KERNEL_VERSION {
            // Wait for the kernel to reply back with a 7.X version.
            let out = InitOut {
                major: KERNEL_VERSION,
                minor: KERNEL_MINOR_VERSION,
                ..Default::default()
            };

            return reply_ok(Some(out), None, in_header.unique, w);
        }

        if minor < KERNEL_MINOR_VERSION {
            error!("Unsupported fuse protocol minor version: {major}.{minor}");
            return reply_error(
                io::Error::from_raw_os_error(libc::EPROTO),
                in_header.unique,
                w,
            );
        }

        let supported =
            FsOptions::BIG_WRITES | FsOptions::AUTO_INVAL_DATA | FsOptions::ATOMIC_O_TRUNC;
        let allowed = supported
            | FsOptions::DO_READDIRPLUS
            | FsOptions::READDIRPLUS_AUTO
            | FsOptions::DONT_MASK;
        let flags_64 = ((flags2 as u64) << 32) | flags as u64;
        let capable = FsOptions::from_bits_truncate(flags_64) & allowed;
        match self.fs.init(capable) {
            Ok(want) => {
                let mut enabled = capable & (want | supported) & allowed;
                // Adaptive selection only makes sense when READDIRPLUS itself
                // was offered by the guest and enabled by the backend.
                if !enabled.contains(FsOptions::DO_READDIRPLUS) {
                    enabled.remove(FsOptions::READDIRPLUS_AUTO);
                }
                let enabled = enabled.bits();
                self.options.store(enabled, Ordering::Relaxed);
                self.initialized.store(true, Ordering::Relaxed);

                let out = InitOut {
                    major: KERNEL_VERSION,
                    minor: KERNEL_MINOR_VERSION,
                    max_readahead,
                    flags: enabled as u32,
                    max_background: 1,
                    congestion_threshold: 1,
                    max_write: MAX_BUFFER_SIZE,
                    time_gran: 1, // nanoseconds
                    max_pages: 0,
                    map_alignment: 0,
                    flags2: (enabled >> 32) as u32,
                    ..Default::default()
                };

                reply_ok(Some(out), None, in_header.unique, w)
            }
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn opendir(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let OpenIn { flags, .. } = r.read_obj().map_err(Error::DecodeMessage)?;

        match self
            .fs
            .opendir(Context::from(in_header), in_header.nodeid.into(), flags)
        {
            Ok((handle, opts)) => {
                let out = OpenOut {
                    fh: handle.map(Into::into).unwrap_or(0),
                    open_flags: opts.bits(),
                    ..Default::default()
                };

                reply_ok(Some(out), None, in_header.unique, w)
            }
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn do_readdir(
        &self,
        in_header: InHeader,
        mut r: Reader,
        w: &mut Writer,
        plus: bool,
    ) -> Result<usize> {
        let ReadIn {
            fh, offset, size, ..
        } = r.read_obj().map_err(Error::DecodeMessage)?;

        if size > MAX_BUFFER_SIZE {
            return reply_error(
                io::Error::from_raw_os_error(libc::ENOMEM),
                in_header.unique,
                w,
            );
        }

        let available_bytes = w.available_bytes();
        if available_bytes.saturating_sub(size_of::<OutHeader>()) < size as usize {
            return reply_error(
                io::Error::from_raw_os_error(libc::ENOMEM),
                in_header.unique,
                w,
            );
        }

        // Skip over enough bytes for the header.
        let mut cursor = w
            .split_at(size_of::<OutHeader>())
            .map_err(Error::EncodeMessage)?;
        cursor
            .split_at(size as usize)
            .map_err(Error::EncodeMessage)?;

        let res = if plus {
            self.fs.readdirplus(
                Context::from(in_header),
                in_header.nodeid.into(),
                fh.into(),
                size,
                offset,
                |d, e| add_dirent(&mut cursor, size, d, Some(e)),
            )
        } else {
            self.fs.readdir(
                Context::from(in_header),
                in_header.nodeid.into(),
                fh.into(),
                size,
                offset,
                |d| add_dirent(&mut cursor, size, d, None),
            )
        };

        if let Err(e) = res {
            reply_error(e, in_header.unique, w)
        } else {
            // Don't use `reply_ok` because we need to set a custom size length for the
            // header.
            let out = OutHeader {
                len: (size_of::<OutHeader>() + cursor.bytes_written()) as u32,
                error: 0,
                unique: in_header.unique,
            };

            w.write_all(out.as_slice()).map_err(Error::EncodeMessage)?;
            Ok(out.len as usize)
        }
    }

    fn readdir(&self, in_header: InHeader, r: Reader, w: &mut Writer) -> Result<usize> {
        self.do_readdir(in_header, r, w, false)
    }

    fn readdirplus(&self, in_header: InHeader, r: Reader, w: &mut Writer) -> Result<usize> {
        self.do_readdir(in_header, r, w, true)
    }

    fn releasedir(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let ReleaseIn { fh, flags, .. } = r.read_obj().map_err(Error::DecodeMessage)?;

        match self.fs.releasedir(
            Context::from(in_header),
            in_header.nodeid.into(),
            flags,
            fh.into(),
        ) {
            Ok(()) => reply_ok(None::<u8>, None, in_header.unique, w),
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn fsyncdir(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let FsyncIn {
            fh, fsync_flags, ..
        } = r.read_obj().map_err(Error::DecodeMessage)?;
        let datasync = fsync_flags & 0x1 != 0;

        match self.fs.fsyncdir(
            Context::from(in_header),
            in_header.nodeid.into(),
            datasync,
            fh.into(),
        ) {
            Ok(()) => reply_ok(None::<u8>, None, in_header.unique, w),
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn access(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let AccessIn { mask, .. } = r.read_obj().map_err(Error::DecodeMessage)?;

        match self
            .fs
            .access(Context::from(in_header), in_header.nodeid.into(), mask)
        {
            Ok(()) => reply_ok(None::<u8>, None, in_header.unique, w),
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn create(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let CreateIn {
            flags,
            mode,
            umask,
            open_flags,
            ..
        } = r.read_obj().map_err(Error::DecodeMessage)?;

        let namelen = (in_header.len as usize)
            .checked_sub(size_of::<InHeader>())
            .and_then(|l| l.checked_sub(size_of::<CreateIn>()))
            .ok_or(Error::InvalidHeaderLength)?;

        let mut buf = vec![0; namelen];

        r.read_exact(&mut buf).map_err(Error::DecodeMessage)?;
        let mut components = buf.split_inclusive(|c| *c == b'\0');
        let name = components.next().ok_or(Error::MissingParameter)?;

        let options = FsOptions::from_bits_truncate(self.options.load(Ordering::Relaxed));

        let extensions = get_extensions(options, name.len(), buf.as_slice())?;

        let kill_priv = open_flags & OPEN_KILL_SUIDGID != 0;

        match self.fs.create(
            Context::from(in_header),
            in_header.nodeid.into(),
            bytes_to_cstr(name)?,
            mode,
            kill_priv,
            flags,
            umask,
            extensions,
        ) {
            Ok((entry, handle, opts)) => {
                let entry_out = EntryOut {
                    nodeid: entry.inode,
                    generation: entry.generation,
                    entry_valid: entry.entry_timeout.as_secs(),
                    attr_valid: entry.attr_timeout.as_secs(),
                    entry_valid_nsec: entry.entry_timeout.subsec_nanos(),
                    attr_valid_nsec: entry.attr_timeout.subsec_nanos(),
                    attr: entry.attr.into(),
                };
                let open_out = OpenOut {
                    fh: handle.map(Into::into).unwrap_or(0),
                    open_flags: opts.bits(),
                    ..Default::default()
                };

                // Kind of a hack to write both structs.
                reply_ok(
                    Some(entry_out),
                    Some(open_out.as_slice()),
                    in_header.unique,
                    w,
                )
            }
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn destroy(&self) -> Result<usize> {
        // No reply to this function.
        self.reset();
        Ok(0)
    }

    fn batch_forget(&self, in_header: InHeader, mut r: Reader) -> Result<usize> {
        let BatchForgetIn { count, .. } = r.read_obj().map_err(Error::DecodeMessage)?;

        let size = (count as usize)
            .checked_mul(size_of::<ForgetOne>())
            .ok_or(Error::InvalidHeaderLength)?;
        if size > MAX_BUFFER_SIZE as usize || r.available_bytes() != size {
            return Err(Error::InvalidHeaderLength);
        }
        let mut requests = Vec::with_capacity(count as usize);
        for _ in 0..count {
            requests.push(
                r.read_obj::<ForgetOne>()
                    .map(|f| (f.nodeid.into(), f.nlookup))
                    .map_err(Error::DecodeMessage)?,
            );
        }

        self.fs.batch_forget(Context::from(in_header), requests);

        // No reply for forget messages.
        Ok(0)
    }

    fn fallocate(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let FallocateIn {
            fh,
            offset,
            length,
            mode,
            ..
        } = r.read_obj().map_err(Error::DecodeMessage)?;

        match self.fs.fallocate(
            Context::from(in_header),
            in_header.nodeid.into(),
            fh.into(),
            mode,
            offset,
            length,
        ) {
            Ok(()) => reply_ok(None::<u8>, None, in_header.unique, w),
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn lseek(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let LseekIn {
            fh, offset, whence, ..
        } = r.read_obj().map_err(Error::DecodeMessage)?;

        match self.fs.lseek(
            Context::from(in_header),
            in_header.nodeid.into(),
            fh.into(),
            offset,
            whence,
        ) {
            Ok(offset) => {
                let out = LseekOut { offset };

                reply_ok(Some(out), None, in_header.unique, w)
            }
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }

    fn copyfilerange(&self, in_header: InHeader, mut r: Reader, w: &mut Writer) -> Result<usize> {
        let CopyfilerangeIn {
            fh_in,
            off_in,
            nodeid_out,
            fh_out,
            off_out,
            len,
            flags,
            ..
        } = r.read_obj().map_err(Error::DecodeMessage)?;

        match self.fs.copyfilerange(
            Context::from(in_header),
            in_header.nodeid.into(),
            fh_in.into(),
            off_in,
            nodeid_out.into(),
            fh_out.into(),
            off_out,
            len,
            flags,
        ) {
            Ok(count) if count as u64 <= len && count <= u32::MAX as usize => {
                let out = WriteOut {
                    size: count as u32,
                    ..Default::default()
                };

                reply_ok(Some(out), None, in_header.unique, w)
            }
            Ok(_) => reply_error(io::Error::from_raw_os_error(libc::EIO), in_header.unique, w),
            Err(e) => reply_error(e, in_header.unique, w),
        }
    }
}

fn reply_ok<T: ByteValued>(
    out: Option<T>,
    data: Option<&[u8]>,
    unique: u64,
    w: &mut Writer,
) -> Result<usize> {
    let mut len = size_of::<OutHeader>();

    if out.is_some() {
        len += size_of::<T>();
    }

    if let Some(data) = data {
        len += data.len();
    }

    if len > w.available_bytes() || len > u32::MAX as usize {
        return reply_error(io::Error::from_raw_os_error(libc::ENOMEM), unique, w);
    }
    let header = OutHeader {
        len: len as u32,
        error: 0,
        unique,
    };

    w.write_all(header.as_slice())
        .map_err(Error::EncodeMessage)?;

    if let Some(out) = out {
        w.write_all(out.as_slice()).map_err(Error::EncodeMessage)?;
    }

    if let Some(data) = data {
        w.write_all(data).map_err(Error::EncodeMessage)?;
    }

    debug_assert_eq!(len, w.bytes_written());
    Ok(w.bytes_written())
}

fn reply_error(e: io::Error, unique: u64, w: &mut Writer) -> Result<usize> {
    let errno = match e.raw_os_error() {
        Some(libc::ENOSYS) => libc::EOPNOTSUPP,
        Some(errno) if errno > 0 => errno,
        _ => libc::EIO,
    };
    reply_errno(errno, unique, w)
}

fn reply_errno(errno: i32, unique: u64, w: &mut Writer) -> Result<usize> {
    let header = OutHeader {
        len: size_of::<OutHeader>() as u32,
        error: -errno,
        unique,
    };

    w.write_all(header.as_slice())
        .map_err(Error::EncodeMessage)?;

    debug_assert_eq!(header.len as usize, w.bytes_written());
    Ok(w.bytes_written())
}

fn bytes_to_cstr(buf: &[u8]) -> Result<&CStr> {
    // Convert to a `CStr` first so that we can drop the '\0' byte at the end
    // and make sure there are no interior '\0' bytes.
    CStr::from_bytes_with_nul(buf).map_err(Error::InvalidCString)
}

fn add_dirent(
    cursor: &mut Writer,
    max: u32,
    d: DirEntry,
    entry: Option<Entry>,
) -> io::Result<usize> {
    if d.name.len() > u32::MAX as usize {
        return Err(io::Error::from_raw_os_error(libc::EOVERFLOW));
    }

    let dirent_len = size_of::<Dirent>()
        .checked_add(d.name.len())
        .ok_or_else(|| io::Error::from_raw_os_error(libc::EOVERFLOW))?;

    // Directory entries must be padded to 8-byte alignment.  If adding 7 causes
    // an overflow then this dirent cannot be properly padded.
    let padded_dirent_len = dirent_len
        .checked_add(7)
        .map(|l| l & !7)
        .ok_or_else(|| io::Error::from_raw_os_error(libc::EOVERFLOW))?;

    let total_len = if entry.is_some() {
        padded_dirent_len
            .checked_add(size_of::<EntryOut>())
            .ok_or_else(|| io::Error::from_raw_os_error(libc::EOVERFLOW))?
    } else {
        padded_dirent_len
    };

    if (max as usize).saturating_sub(cursor.bytes_written()) < total_len {
        Ok(0)
    } else {
        if let Some(entry) = entry {
            cursor.write_all(EntryOut::from(entry).as_slice())?;
        }

        let dirent = Dirent {
            ino: d.ino,
            off: d.offset,
            namelen: d.name.len() as u32,
            type_: d.type_,
        };

        cursor.write_all(dirent.as_slice())?;
        cursor.write_all(d.name)?;

        // We know that `dirent_len` <= `padded_dirent_len` due to the check above
        // so there's no need for checked arithmetic.
        let padding = padded_dirent_len - dirent_len;
        if padding > 0 {
            cursor.write_all(&DIRENT_PADDING[..padding])?;
        }

        Ok(total_len)
    }
}

fn get_extensions(_options: FsOptions, skip: usize, request_bytes: &[u8]) -> Result<Extensions> {
    if skip != request_bytes.len() {
        return Err(Error::InvalidHeaderLength);
    }
    Ok(Extensions::default())
}

fn validate_body(opcode: u32, length: usize) -> io::Result<()> {
    let fixed = match opcode {
        x if x == Opcode::Forget as u32 => Some(size_of::<ForgetIn>()),
        x if x == Opcode::Getattr as u32 => Some(size_of::<GetattrIn>()),
        x if x == Opcode::Setattr as u32 => Some(size_of::<SetattrIn>()),
        x if x == Opcode::Readlink as u32
            || x == Opcode::Statfs as u32
            || x == Opcode::Destroy as u32 =>
        {
            Some(0)
        }
        x if x == Opcode::Open as u32 || x == Opcode::Opendir as u32 => Some(size_of::<OpenIn>()),
        x if x == Opcode::Read as u32
            || x == Opcode::Readdir as u32
            || x == Opcode::Readdirplus as u32 =>
        {
            Some(size_of::<ReadIn>())
        }
        x if x == Opcode::Release as u32 || x == Opcode::Releasedir as u32 => {
            Some(size_of::<ReleaseIn>())
        }
        x if x == Opcode::Fsync as u32 || x == Opcode::Fsyncdir as u32 => {
            Some(size_of::<FsyncIn>())
        }
        x if x == Opcode::Listxattr as u32 => Some(size_of::<GetxattrIn>()),
        x if x == Opcode::Flush as u32 => Some(size_of::<FlushIn>()),
        x if x == Opcode::Access as u32 => Some(size_of::<AccessIn>()),
        x if x == Opcode::Fallocate as u32 => Some(size_of::<FallocateIn>()),
        x if x == Opcode::Lseek as u32 => Some(size_of::<LseekIn>()),
        x if x == Opcode::CopyFileRange as u32 => Some(size_of::<CopyfilerangeIn>()),
        _ => None,
    };
    if fixed.is_some_and(|expected| length != expected) {
        return Err(einval());
    }
    let minimum = match opcode {
        x if x == Opcode::Write as u32 => size_of::<WriteIn>(),
        x if x == Opcode::Init as u32 => size_of::<InitInCompat>(),
        x if x == Opcode::BatchForget as u32 => size_of::<BatchForgetIn>(),
        x if x == Opcode::Create as u32 => size_of::<CreateIn>() + 1,
        x if x == Opcode::Mkdir as u32 => size_of::<MkdirIn>() + 1,
        x if x == Opcode::Mknod as u32 => size_of::<MknodIn>() + 1,
        x if x == Opcode::Rename as u32 => size_of::<RenameIn>() + 2,
        x if x == Opcode::Rename2 as u32 => size_of::<Rename2In>() + 2,
        x if x == Opcode::Link as u32 => size_of::<LinkIn>() + 1,
        x if x == Opcode::Getxattr as u32 => size_of::<GetxattrIn>() + 1,
        x if x == Opcode::Setxattr as u32 => size_of::<SetxattrIn>() + 1,
        x if x == Opcode::Symlink as u32 => 2,
        x if x == Opcode::Lookup as u32
            || x == Opcode::Unlink as u32
            || x == Opcode::Rmdir as u32
            || x == Opcode::Removexattr as u32 =>
        {
            1
        }
        _ => 0,
    };
    if length < minimum {
        return Err(einval());
    }
    Ok(())
}

fn minimum_reply_size(opcode: u32) -> usize {
    let body = match opcode {
        x if x == Opcode::Lookup as u32
            || x == Opcode::Symlink as u32
            || x == Opcode::Mknod as u32
            || x == Opcode::Mkdir as u32
            || x == Opcode::Link as u32 =>
        {
            size_of::<EntryOut>()
        }
        x if x == Opcode::Getattr as u32 || x == Opcode::Setattr as u32 => size_of::<AttrOut>(),
        x if x == Opcode::Open as u32 || x == Opcode::Opendir as u32 => size_of::<OpenOut>(),
        x if x == Opcode::Create as u32 => size_of::<EntryOut>() + size_of::<OpenOut>(),
        x if x == Opcode::Write as u32 || x == Opcode::CopyFileRange as u32 => {
            size_of::<WriteOut>()
        }
        x if x == Opcode::Init as u32 => size_of::<InitOut>(),
        x if x == Opcode::Statfs as u32 => size_of::<Kstatfs>(),
        x if x == Opcode::Lseek as u32 => size_of::<LseekOut>(),
        _ => 0,
    };
    size_of::<OutHeader>() + body
}
