// Copyright 2019 The Chromium OS Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

//! Linux FUSE 7.27 wire definitions used by the synchronous non-DAX server.

use super::bindings;
use bitflags::bitflags;
use std::mem;
use vm_memory::ByteValued;

pub const KERNEL_VERSION: u32 = 7;
pub const KERNEL_MINOR_VERSION: u32 = 27;
pub const ROOT_ID: u64 = 1;
pub const FATTR_FH: u32 = 64;
pub const GETATTR_FH: u32 = 1;
pub const RELEASE_FLUSH: u32 = 1;
pub const RELEASE_FLOCK_UNLOCK: u32 = 2;
pub const WRITE_CACHE: u32 = 1;
pub const WRITE_LOCKOWNER: u32 = 2;
pub const WRITE_KILL_PRIV: u32 = 4;
pub const READ_LOCKOWNER: u32 = 2;
pub const OPEN_KILL_SUIDGID: u32 = 1;

bitflags! {
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct SetattrValid: u32 {
        const MODE = 1;
        const UID = 2;
        const GID = 4;
        const SIZE = 8;
        const ATIME = 16;
        const MTIME = 32;
        const ATIME_NOW = 128;
        const MTIME_NOW = 256;
        const CTIME = 1024;
        const KILL_SUIDGID = 2048;
    }
}

bitflags! {
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct OpenOptions: u32 {
        const DIRECT_IO = 1;
        const KEEP_CACHE = 2;
        const NONSEEKABLE = 4;
        const CACHE_DIR = 8;
    }
}

bitflags! {
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct FsOptions: u64 {
        const ATOMIC_O_TRUNC = 1 << 3;
        const BIG_WRITES = 1 << 5;
        const DONT_MASK = 1 << 6;
        const AUTO_INVAL_DATA = 1 << 12;
        const DO_READDIRPLUS = 1 << 13;
        const READDIRPLUS_AUTO = 1 << 14;
    }
}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct Attr {
    pub ino: u64,
    pub size: u64,
    pub blocks: u64,
    pub atime: u64,
    pub mtime: u64,
    pub ctime: u64,
    pub atimensec: u32,
    pub mtimensec: u32,
    pub ctimensec: u32,
    pub mode: u32,
    pub nlink: u32,
    pub uid: u32,
    pub gid: u32,
    pub rdev: u32,
    pub blksize: u32,
    pub flags: u32,
}
unsafe impl ByteValued for Attr {}

impl From<bindings::stat64> for Attr {
    fn from(st: bindings::stat64) -> Attr {
        Attr::with_flags(st, 0)
    }
}

impl Attr {
    pub fn with_flags(st: bindings::stat64, flags: u32) -> Attr {
        Attr {
            ino: st.st_ino,
            size: st.st_size as u64,
            blocks: st.st_blocks as u64,
            atime: st.st_atime as u64,
            mtime: st.st_mtime as u64,
            ctime: st.st_ctime as u64,
            atimensec: st.st_atime_nsec as u32,
            mtimensec: st.st_mtime_nsec as u32,
            ctimensec: st.st_ctime_nsec as u32,
            #[cfg(target_os = "linux")]
            mode: st.st_mode,
            #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
            nlink: st.st_nlink as u32,
            #[cfg(all(
                target_os = "linux",
                any(target_arch = "aarch64", target_arch = "riscv64")
            ))]
            nlink: st.st_nlink,
            uid: st.st_uid,
            gid: st.st_gid,
            rdev: st.st_rdev as u32,
            blksize: st.st_blksize as u32,
            flags,
        }
    }
}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct Kstatfs {
    pub blocks: u64,
    pub bfree: u64,
    pub bavail: u64,
    pub files: u64,
    pub ffree: u64,
    pub bsize: u32,
    pub namelen: u32,
    pub frsize: u32,
    pub padding: u32,
    pub spare: [u32; 6],
}
unsafe impl ByteValued for Kstatfs {}

#[cfg(target_os = "linux")]
impl From<bindings::statvfs64> for Kstatfs {
    fn from(st: bindings::statvfs64) -> Self {
        Kstatfs {
            blocks: st.f_blocks,
            bfree: st.f_bfree,
            bavail: st.f_bavail,
            files: st.f_files,
            ffree: st.f_ffree,
            bsize: st.f_bsize as u32,
            namelen: st.f_namemax as u32,
            frsize: st.f_frsize as u32,
            ..Default::default()
        }
    }
}

#[repr(u32)]
#[derive(Debug, Copy, Clone)]
pub enum Opcode {
    Lookup = 1,
    Forget = 2, /* No Reply */
    Getattr = 3,
    Setattr = 4,
    Readlink = 5,
    Symlink = 6,
    Mknod = 8,
    Mkdir = 9,
    Unlink = 10,
    Rmdir = 11,
    Rename = 12,
    Link = 13,
    Open = 14,
    Read = 15,
    Write = 16,
    Statfs = 17,
    Release = 18,
    Fsync = 20,
    Setxattr = 21,
    Getxattr = 22,
    Listxattr = 23,
    Removexattr = 24,
    Flush = 25,
    Init = 26,
    Opendir = 27,
    Readdir = 28,
    Releasedir = 29,
    Fsyncdir = 30,
    Access = 34,
    Create = 35,
    Destroy = 38,
    Ioctl = 39,
    Poll = 40,
    BatchForget = 42,
    Fallocate = 43,
    Readdirplus = 44,
    Rename2 = 45,
    Lseek = 46,
    CopyFileRange = 47,
}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct EntryOut {
    pub nodeid: u64,      /* Inode ID */
    pub generation: u64,  /* Inode generation: nodeid:gen must be unique for the fs's lifetime */
    pub entry_valid: u64, /* Cache timeout for the name */
    pub attr_valid: u64,  /* Cache timeout for the attributes */
    pub entry_valid_nsec: u32,
    pub attr_valid_nsec: u32,
    pub attr: Attr,
}
unsafe impl ByteValued for EntryOut {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct ForgetIn {
    pub nlookup: u64,
}
unsafe impl ByteValued for ForgetIn {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct ForgetOne {
    pub nodeid: u64,
    pub nlookup: u64,
}
unsafe impl ByteValued for ForgetOne {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct BatchForgetIn {
    pub count: u32,
    pub dummy: u32,
}
unsafe impl ByteValued for BatchForgetIn {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct GetattrIn {
    pub flags: u32,
    pub dummy: u32,
    pub fh: u64,
}
unsafe impl ByteValued for GetattrIn {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct AttrOut {
    pub attr_valid: u64, /* Cache timeout for the attributes */
    pub attr_valid_nsec: u32,
    pub dummy: u32,
    pub attr: Attr,
}
unsafe impl ByteValued for AttrOut {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct MknodIn {
    pub mode: u32,
    pub rdev: u32,
    pub umask: u32,
    pub padding: u32,
}
unsafe impl ByteValued for MknodIn {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct MkdirIn {
    pub mode: u32,
    pub umask: u32,
}
unsafe impl ByteValued for MkdirIn {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct RenameIn {
    pub newdir: u64,
}
unsafe impl ByteValued for RenameIn {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct Rename2In {
    pub newdir: u64,
    pub flags: u32,
    pub padding: u32,
}
unsafe impl ByteValued for Rename2In {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct LinkIn {
    pub oldnodeid: u64,
}
unsafe impl ByteValued for LinkIn {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct SetattrIn {
    pub valid: u32,
    pub padding: u32,
    pub fh: u64,
    pub size: u64,
    pub lock_owner: u64,
    pub atime: u64,
    pub mtime: u64,
    pub ctime: u64,
    pub atimensec: u32,
    pub mtimensec: u32,
    pub ctimensec: u32,
    pub mode: u32,
    pub unused4: u32,
    pub uid: u32,
    pub gid: u32,
    pub unused5: u32,
}
unsafe impl ByteValued for SetattrIn {}

impl From<SetattrIn> for bindings::stat64 {
    fn from(sai: SetattrIn) -> bindings::stat64 {
        let mut out: bindings::stat64 = unsafe { mem::zeroed() };
        out.st_mode = sai.mode;
        out.st_uid = sai.uid;
        out.st_gid = sai.gid;
        out.st_size = sai.size as i64;
        out.st_atime = sai.atime as i64;
        out.st_mtime = sai.mtime as i64;
        out.st_ctime = sai.ctime as i64;
        out.st_atime_nsec = sai.atimensec.into();
        out.st_mtime_nsec = sai.mtimensec.into();
        out.st_ctime_nsec = sai.ctimensec.into();

        out
    }
}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct OpenIn {
    pub flags: u32,
    pub open_flags: u32,
}
unsafe impl ByteValued for OpenIn {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct CreateIn {
    pub flags: u32,
    pub mode: u32,
    pub umask: u32,
    pub open_flags: u32,
}
unsafe impl ByteValued for CreateIn {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct OpenOut {
    pub fh: u64,
    pub open_flags: u32,
    pub padding: u32,
}
unsafe impl ByteValued for OpenOut {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct ReleaseIn {
    pub fh: u64,
    pub flags: u32,
    pub release_flags: u32,
    pub lock_owner: u64,
}
unsafe impl ByteValued for ReleaseIn {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct FlushIn {
    pub fh: u64,
    pub unused: u32,
    pub padding: u32,
    pub lock_owner: u64,
}
unsafe impl ByteValued for FlushIn {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct ReadIn {
    pub fh: u64,
    pub offset: u64,
    pub size: u32,
    pub read_flags: u32,
    pub lock_owner: u64,
    pub flags: u32,
    pub padding: u32,
}
unsafe impl ByteValued for ReadIn {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct WriteIn {
    pub fh: u64,
    pub offset: u64,
    pub size: u32,
    pub write_flags: u32,
    pub lock_owner: u64,
    pub flags: u32,
    pub padding: u32,
}
unsafe impl ByteValued for WriteIn {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct WriteOut {
    pub size: u32,
    pub padding: u32,
}
unsafe impl ByteValued for WriteOut {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct FsyncIn {
    pub fh: u64,
    pub fsync_flags: u32,
    pub padding: u32,
}
unsafe impl ByteValued for FsyncIn {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct SetxattrIn {
    pub size: u32,
    pub flags: u32,
}
unsafe impl ByteValued for SetxattrIn {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct GetxattrIn {
    pub size: u32,
    pub padding: u32,
}
unsafe impl ByteValued for GetxattrIn {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct GetxattrOut {
    pub size: u32,
    pub padding: u32,
}
unsafe impl ByteValued for GetxattrOut {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct AccessIn {
    pub mask: u32,
    pub padding: u32,
}
unsafe impl ByteValued for AccessIn {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct InitInCompat {
    pub major: u32,
    pub minor: u32,
    pub max_readahead: u32,
    pub flags: u32,
}
unsafe impl ByteValued for InitInCompat {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct InitInExt {
    pub flags2: u32,
    pub unused: [u32; 11],
}
unsafe impl ByteValued for InitInExt {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct InitOut {
    pub major: u32,
    pub minor: u32,
    pub max_readahead: u32,
    pub flags: u32,
    pub max_background: u16,
    pub congestion_threshold: u16,
    pub max_write: u32,
    pub time_gran: u32,
    pub max_pages: u16,
    pub map_alignment: u16,
    pub flags2: u32,
    pub unused: [u32; 7],
}
unsafe impl ByteValued for InitOut {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct FallocateIn {
    pub fh: u64,
    pub offset: u64,
    pub length: u64,
    pub mode: u32,
    pub padding: u32,
}
unsafe impl ByteValued for FallocateIn {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct InHeader {
    pub len: u32,
    pub opcode: u32,
    pub unique: u64,
    pub nodeid: u64,
    pub uid: u32,
    pub gid: u32,
    pub pid: u32,
    pub padding: u32,
}
unsafe impl ByteValued for InHeader {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct OutHeader {
    pub len: u32,
    pub error: i32,
    pub unique: u64,
}
unsafe impl ByteValued for OutHeader {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct Dirent {
    pub ino: u64,
    pub off: u64,
    pub namelen: u32,
    pub type_: u32,
    // char name[];
}
unsafe impl ByteValued for Dirent {}

/* Matches the size of fuse_write_in */

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct LseekIn {
    pub fh: u64,
    pub offset: u64,
    pub whence: u32,
    pub padding: u32,
}
unsafe impl ByteValued for LseekIn {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct LseekOut {
    pub offset: u64,
}
unsafe impl ByteValued for LseekOut {}

#[repr(C)]
#[derive(Debug, Default, Copy, Clone)]
pub struct CopyfilerangeIn {
    pub fh_in: u64,
    pub off_in: u64,
    pub nodeid_out: u64,
    pub fh_out: u64,
    pub off_out: u64,
    pub len: u64,
    pub flags: u64,
}
unsafe impl ByteValued for CopyfilerangeIn {}
