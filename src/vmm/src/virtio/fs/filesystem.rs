// Copyright 2019 The Chromium OS Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

use std::ffi::CStr;
use std::fs::File;
use std::io;
use std::time::Duration;

use super::bindings;
use super::fuse;

pub use super::fuse::FsOptions;
pub use fuse::OpenOptions;
pub use fuse::SetattrValid;

/// Information about a path in the filesystem.
pub struct Entry {
    /// An `Inode` that uniquely identifies this path. During `lookup`, setting this to `0` means a
    /// negative entry. Returning `ENOENT` also means a negative entry but setting this to `0`
    /// allows the kernel to cache the negative result for `entry_timeout`. The value should be
    /// produced by converting a `FileSystem::Inode` into a `u64`.
    pub inode: u64,

    /// The generation number for this `Entry`. Typically used for network file systems. An `inode`
    /// / `generation` pair must be unique over the lifetime of the file system (rather than just
    /// the lifetime of the mount). In other words, if a `FileSystem` implementation re-uses an
    /// `Inode` after it has been deleted then it must assign a new, previously unused generation
    /// number to the `Inode` at the same time.
    pub generation: u64,

    /// Inode attributes. Even if `attr_timeout` is zero, `attr` must be correct. For example, for
    /// `open()`, FUSE uses `attr.st_size` from `lookup()` to determine how many bytes to request.
    /// If this value is not correct, incorrect data will be returned.
    pub attr: bindings::stat64,

    /// Flags for `fuse::Attr.flags`.
    pub attr_flags: u32,

    /// How long the values in `attr` should be considered valid. If the attributes of the `Entry`
    /// are only modified by the FUSE client, then this should be set to a very large value.
    pub attr_timeout: Duration,

    /// How long the name associated with this `Entry` should be considered valid. If directory
    /// entries are only changed or deleted by the FUSE client, then this should be set to a very
    /// large value.
    pub entry_timeout: Duration,
}

impl From<Entry> for fuse::EntryOut {
    fn from(entry: Entry) -> fuse::EntryOut {
        fuse::EntryOut {
            nodeid: entry.inode,
            generation: entry.generation,
            entry_valid: entry.entry_timeout.as_secs(),
            attr_valid: entry.attr_timeout.as_secs(),
            entry_valid_nsec: entry.entry_timeout.subsec_nanos(),
            attr_valid_nsec: entry.attr_timeout.subsec_nanos(),
            attr: fuse::Attr::with_flags(entry.attr, entry.attr_flags),
        }
    }
}

/// Represents information about an entry in a directory.
pub struct DirEntry<'a> {
    /// The inode number for this entry. This does NOT have to be the same as the `Inode` for this
    /// directory entry. However, it must be the same as the `attr.st_ino` field of the `Entry` that
    /// would be returned by a `lookup` request in the parent directory for `name`.
    pub ino: bindings::ino64_t,

    /// Any non-zero value that the kernel can use to identify the current point in the directory
    /// entry stream. It does not need to be the actual physical position. A value of `0` is
    /// reserved to mean "from the beginning" and should never be used. The `offset` value of the
    /// first entry in a stream should point to the beginning of the second entry and so on.
    pub offset: u64,

    /// The type of this directory entry. Valid values are any of the `libc::DT_*` constants.
    pub type_: u32,

    /// The name of this directory entry. There are no requirements for the contents of this field
    /// and any sequence of bytes is considered valid.
    pub name: &'a [u8],
}

/// A reply to a `getxattr` method call.
pub enum GetxattrReply {
    /// The value of the requested extended attribute. This can be arbitrary textual or binary data
    /// and does not need to be nul-terminated.
    Value(Vec<u8>),

    /// The size of the buffer needed to hold the value of the requested extended attribute. Should
    /// be returned when the `size` parameter is 0. Callers should note that it is still possible
    /// for the size of the value to change in between `getxattr` calls and should not assume that a
    /// subsequent call to `getxattr` with the returned count will always succeed.
    Count(u32),
}

/// A reply to a `listxattr` method call.
pub enum ListxattrReply {
    /// A buffer containing a nul-separated list of the names of all the extended attributes
    /// associated with this `Inode`. This list of names may be unordered and includes a namespace
    /// prefix. There may be several disjoint namespaces associated with a single `Inode`.
    Names(Vec<u8>),

    /// This size of the buffer needed to hold the full list of extended attribute names associated
    /// with this `Inode`. Should be returned when the `size` parameter is 0. Callers should note
    /// that it is still possible for the set of extended attributes to change between `listxattr`
    /// calls and so should not assume that a subsequent call to `listxattr` with the returned count
    /// will always succeed.
    Count(u32),
}

/// Transfers guest data into a file without an intermediate buffer.
pub trait ZeroCopyReader {
    /// Transfer at most `count` bytes at `off`, consuming only the returned count.
    fn read_to(&mut self, file: &File, count: usize, off: u64) -> io::Result<usize>;
}

impl<R: ZeroCopyReader> ZeroCopyReader for &mut R {
    fn read_to(&mut self, file: &File, count: usize, off: u64) -> io::Result<usize> {
        (**self).read_to(file, count, off)
    }
}

/// Transfers file data into guest memory without an intermediate buffer.
pub trait ZeroCopyWriter {
    /// Transfer at most `count` bytes at `off`, consuming only the returned count.
    fn write_from(&mut self, file: &File, count: usize, off: u64) -> io::Result<usize>;
}

impl<W: ZeroCopyWriter> ZeroCopyWriter for &mut W {
    fn write_from(&mut self, file: &File, count: usize, off: u64) -> io::Result<usize> {
        (**self).write_from(file, count, off)
    }
}

/// Additional context associated with requests.
#[expect(
    dead_code,
    reason = "Wire caller credentials are retained in the FileSystem contract; the backend deliberately runs as the host user without guest impersonation"
)]
#[derive(Clone, Copy, Debug)]
pub struct Context {
    /// The user ID of the calling process.
    pub uid: libc::uid_t,

    /// The group ID of the calling process.
    pub gid: libc::gid_t,

    /// The thread group ID of the calling process.
    pub pid: libc::pid_t,
}

impl From<fuse::InHeader> for Context {
    fn from(source: fuse::InHeader) -> Self {
        Context {
            uid: source.uid,
            gid: source.gid,
            pid: source.pid as i32,
        }
    }
}

/// Request extensions
#[derive(Clone, Default, Debug)]
pub struct Extensions {
    /// Presence marker only: security-context extensions are not negotiated.
    pub secctx: Option<()>,
    pub sup_gid: Option<u32>,
}

/// The main trait that connects a file system with a transport.
pub trait FileSystem {
    type Inode: From<u64> + Into<u64>;

    /// Represents a file or directory that is open for reading/writing.
    type Handle: From<u64> + Into<u64>;

    /// Initialize the file system.
    ///
    /// This method is called when a connection to the FUSE kernel module is first established. The
    /// `capable` parameter indicates the features that are supported by the kernel module. The
    /// implementation should return the options that it supports. Any options set in the returned
    /// `FsOptions` that are not also set in `capable` are silently dropped.
    fn init(&self, capable: FsOptions) -> io::Result<FsOptions>;

    /// Clean up the file system.
    ///
    /// Called when the filesystem exits. All open `Handle`s should be closed and the lookup count
    /// for all open `Inode`s implicitly goes to zero. At this point the connection to the FUSE
    /// kernel module may already be gone so implementations should not rely on being able to
    /// communicate with the kernel.
    fn destroy(&self);

    /// Look up a directory entry by name and get its attributes.
    ///
    /// If this call is successful then the lookup count of the `Inode` associated with the returned
    /// `Entry` must be increased by 1.
    fn lookup(&self, ctx: Context, parent: Self::Inode, name: &CStr) -> io::Result<Entry>;

    /// Forget about an inode.
    ///
    /// Called when the kernel removes an inode from its internal caches. `count` indicates the
    /// amount by which the lookup count for the inode should be decreased. If reducing the lookup
    /// count by `count` causes it to go to zero, then the implementation may delete the `Inode`.
    fn forget(&self, ctx: Context, inode: Self::Inode, count: u64);

    /// Forget about multiple inodes.
    ///
    /// `requests` is a vector of `(inode, count)` pairs. See the documentation for `forget` for
    /// more information.
    fn batch_forget(&self, ctx: Context, requests: Vec<(Self::Inode, u64)>) {
        for (inode, count) in requests {
            self.forget(ctx, inode, count)
        }
    }

    fn getattr(
        &self,
        ctx: Context,
        inode: Self::Inode,
        handle: Option<Self::Handle>,
    ) -> io::Result<(bindings::stat64, Duration)>;

    fn setattr(
        &self,
        ctx: Context,
        inode: Self::Inode,
        attr: bindings::stat64,
        handle: Option<Self::Handle>,
        valid: SetattrValid,
    ) -> io::Result<(bindings::stat64, Duration)>;

    /// Read a symbolic link.
    fn readlink(&self, ctx: Context, inode: Self::Inode) -> io::Result<Vec<u8>>;

    /// Create a symbolic link.
    ///
    /// The file system must create a symbolic link named `name` in the directory represented by
    /// `parent`, which contains the string `linkname`. Returns an `Entry` for the newly created
    /// symlink.
    ///
    /// If this call is successful then the lookup count of the `Inode` associated with the returned
    /// `Entry` must be increased by 1.
    fn symlink(
        &self,
        ctx: Context,
        linkname: &CStr,
        parent: Self::Inode,
        name: &CStr,
        extensions: Extensions,
    ) -> io::Result<Entry>;

    /// Create a file node.
    ///
    /// Create a regular file, character device, block device, fifo, or socket node named `name` in
    /// the directory represented by `inode`. Valid values for `mode` and `rdev` are the same as
    /// those accepted by the `mknod(2)` system call. Returns an `Entry` for the newly created node.
    ///
    /// When the `FsOptions::DONT_MASK` feature is set, the file system is responsible for setting
    /// the permissions of the created node to `mode & !umask`.
    ///
    /// If this call is successful then the lookup count of the `Inode` associated with the returned
    /// `Entry` must be increased by 1.
    #[expect(
        clippy::too_many_arguments,
        reason = "Preserve the migrated FUSE operation signature"
    )]
    fn mknod(
        &self,
        ctx: Context,
        inode: Self::Inode,
        name: &CStr,
        mode: u32,
        rdev: u32,
        umask: u32,
        extensions: Extensions,
    ) -> io::Result<Entry>;

    /// Create a directory.
    ///
    /// When the `FsOptions::DONT_MASK` feature is set, the file system is responsible for setting
    /// the permissions of the created directory to `mode & !umask`. Returns an `Entry` for the
    /// newly created directory.
    ///
    /// If this call is successful then the lookup count of the `Inode` associated with the returned
    /// `Entry` must be increased by 1.
    fn mkdir(
        &self,
        ctx: Context,
        parent: Self::Inode,
        name: &CStr,
        mode: u32,
        umask: u32,
        extensions: Extensions,
    ) -> io::Result<Entry>;

    /// Remove a file.
    ///
    /// If the file's inode lookup count is non-zero, then the file system is expected to delay
    /// removal of the inode until the lookup count goes to zero. See the documentation of the
    /// `forget` function for more information.
    fn unlink(&self, ctx: Context, parent: Self::Inode, name: &CStr) -> io::Result<()>;

    /// Remove a directory.
    ///
    /// If the directory's inode lookup count is non-zero, then the file system is expected to delay
    /// removal of the inode until the lookup count goes to zero. See the documentation of the
    /// `forget` function for more information.
    fn rmdir(&self, ctx: Context, parent: Self::Inode, name: &CStr) -> io::Result<()>;

    /// Rename a file / directory.
    ///
    /// If the destination exists, it should be atomically replaced. If the destination's inode
    /// lookup count is non-zero, then the file system is expected to delay removal of the inode
    /// until the lookup count goes to zero. See the documentation of the `forget` function for more
    /// information.
    ///
    /// `flags` may be `libc::RENAME_EXCHANGE` or `libc::RENAME_NOREPLACE`. If
    /// `libc::RENAME_NOREPLACE` is specified, the implementation must not overwrite `newname` if it
    /// exists and must return an error instead. If `libc::RENAME_EXCHANGE` is specified, the
    /// implementation must atomically exchange the two files, i.e., both must exist and neither may
    /// be deleted.
    fn rename(
        &self,
        ctx: Context,
        olddir: Self::Inode,
        oldname: &CStr,
        newdir: Self::Inode,
        newname: &CStr,
        flags: u32,
    ) -> io::Result<()>;

    /// Create a hard link.
    ///
    /// Create a hard link from `inode` to `newname` in the directory represented by `newparent`.
    ///
    /// If this call is successful then the lookup count of the `Inode` associated with the returned
    /// `Entry` must be increased by 1.
    fn link(
        &self,
        ctx: Context,
        inode: Self::Inode,
        newparent: Self::Inode,
        newname: &CStr,
    ) -> io::Result<Entry>;

    fn open(
        &self,
        ctx: Context,
        inode: Self::Inode,
        kill_priv: bool,
        flags: u32,
    ) -> io::Result<(Option<Self::Handle>, OpenOptions)>;

    #[expect(
        clippy::too_many_arguments,
        reason = "Preserve the migrated FUSE operation signature"
    )]
    fn create(
        &self,
        ctx: Context,
        parent: Self::Inode,
        name: &CStr,
        mode: u32,
        kill_priv: bool,
        flags: u32,
        umask: u32,
        extensions: Extensions,
    ) -> io::Result<(Entry, Option<Self::Handle>, OpenOptions)>;

    /// Read data from a file.
    ///
    /// Returns `size` bytes of data starting from offset `off` from the file associated with
    /// `inode` or `handle`.
    ///
    /// `flags` contains the flags used to open the file. Similarly, `handle` is the `Handle`
    /// returned by the file system from the `open` method, if any. If the file system
    /// implementation did not return a `Handle` from `open` then the contents of `handle` are
    /// undefined.
    ///
    /// This method should return exactly the number of bytes requested by the kernel, except in the
    /// case of error or EOF. Otherwise, the kernel will substitute the rest of the data with
    /// zeroes. An exception to this rule is if the file was opened with the "direct I/O" option
    /// (`libc::O_DIRECT`), in which case the kernel will forward the return code from this method
    /// to the userspace application that made the system call.
    #[expect(
        clippy::too_many_arguments,
        reason = "Preserve the migrated FUSE operation signature"
    )]
    fn read<W: io::Write + ZeroCopyWriter>(
        &self,
        ctx: Context,
        inode: Self::Inode,
        handle: Self::Handle,
        w: W,
        size: u32,
        offset: u64,
        lock_owner: Option<u64>,
        flags: u32,
    ) -> io::Result<usize>;

    /// Write data to a file.
    ///
    /// Writes `size` bytes of data starting from offset `off` to the file associated with `inode`
    /// or `handle`.
    ///
    /// `flags` contains the flags used to open the file. Similarly, `handle` is the `Handle`
    /// returned by the file system from the `open` method, if any. If the file system
    /// implementation did not return a `Handle` from `open` then the contents of `handle` are
    /// undefined.
    ///
    /// If `delayed_write` is true then it indicates that this is a write for buffered data.
    ///
    /// If `kill_priv` is true then it indicates that the file system is expected to clear the
    /// setuid and setgid bits.
    ///
    /// This method should return exactly the number of bytes requested by the kernel, except in the
    /// case of error. An exception to this rule is if the file was opened with the "direct I/O"
    /// option (`libc::O_DIRECT`), in which case the kernel will forward the return code from this
    /// method to the userspace application that made the system call.
    #[expect(
        clippy::too_many_arguments,
        reason = "Preserve the migrated FUSE operation signature"
    )]
    fn write<R: io::Read + ZeroCopyReader>(
        &self,
        ctx: Context,
        inode: Self::Inode,
        handle: Self::Handle,
        r: R,
        size: u32,
        offset: u64,
        lock_owner: Option<u64>,
        delayed_write: bool,
        kill_priv: bool,
        flags: u32,
    ) -> io::Result<usize>;

    fn flush(
        &self,
        ctx: Context,
        inode: Self::Inode,
        handle: Self::Handle,
        lock_owner: u64,
    ) -> io::Result<()>;

    fn fsync(
        &self,
        ctx: Context,
        inode: Self::Inode,
        datasync: bool,
        handle: Self::Handle,
    ) -> io::Result<()>;

    fn fallocate(
        &self,
        ctx: Context,
        inode: Self::Inode,
        handle: Self::Handle,
        mode: u32,
        offset: u64,
        length: u64,
    ) -> io::Result<()>;

    /// Release an open file.
    ///
    /// This method is called when there are no more references to an open file: all file
    /// descriptors are closed and all memory mappings are unmapped.
    ///
    /// For every `open` call there will be exactly one `release` call (unless the file system is
    /// force-unmounted).
    ///
    /// The file system may reply with an error, but error values are not returned to the `close()`
    /// or `munmap()` which triggered the release.
    ///
    /// `handle` is the `Handle` returned by the file system from the `open` method, if any. If the
    /// file system did not return a `Handle` from `open` then the contents of
    /// `handle` are undefined.
    ///
    /// `flush` is the FUSE close/flush hint, not an fsync request. Like the
    /// migrated libkrun backend, release does not promise host durability.
    #[expect(
        clippy::too_many_arguments,
        reason = "Preserve the migrated FUSE operation signature"
    )]
    fn release(
        &self,
        ctx: Context,
        inode: Self::Inode,
        flags: u32,
        handle: Self::Handle,
        flush: bool,
        flock_release: bool,
        lock_owner: Option<u64>,
    ) -> io::Result<()>;

    /// Get information about the file system.
    fn statfs(&self, ctx: Context, inode: Self::Inode) -> io::Result<bindings::statvfs64>;

    fn setxattr(
        &self,
        ctx: Context,
        inode: Self::Inode,
        name: &CStr,
        value: &[u8],
        flags: u32,
    ) -> io::Result<()>;

    fn getxattr(
        &self,
        ctx: Context,
        inode: Self::Inode,
        name: &CStr,
        size: u32,
    ) -> io::Result<GetxattrReply>;

    fn listxattr(&self, ctx: Context, inode: Self::Inode, size: u32) -> io::Result<ListxattrReply>;

    fn removexattr(&self, ctx: Context, inode: Self::Inode, name: &CStr) -> io::Result<()>;

    fn opendir(
        &self,
        ctx: Context,
        inode: Self::Inode,
        flags: u32,
    ) -> io::Result<(Option<Self::Handle>, OpenOptions)>;

    /// Read a directory.
    ///
    /// `handle` is the `Handle` returned by the file system from the `opendir` method, if any. If
    /// the file system did not return a `Handle` from `opendir` then the contents of `handle` are
    /// undefined.
    ///
    /// `size` indicates the maximum number of bytes that should be returned by this method.
    ///
    /// If `offset` is non-zero then it corresponds to one of the `offset` values from a `DirEntry`
    /// that was previously returned by a call to `readdir` for the same handle. In this case the
    /// file system should skip over the entries before the position defined by the `offset` value.
    /// If entries were added or removed while the `Handle` is open then the file system may still
    /// include removed entries or skip newly created entries. However, adding or removing entries
    /// should never cause the file system to skip over unrelated entries or include an entry more
    /// than once. This means that `offset` cannot be a simple index and must include sufficient
    /// information to uniquely determine the next entry in the list even when the set of entries is
    /// being changed.
    ///
    /// The file system may return entries for the current directory (".") and parent directory
    /// ("..") but is not required to do so. FUSE forwards the returned entries as supplied.
    ///
    /// The lookup count for `Inode`s associated with the returned directory entries is **NOT**
    /// affected by this method.
    ///
    fn readdir<F>(
        &self,
        ctx: Context,
        inode: Self::Inode,
        handle: Self::Handle,
        size: u32,
        offset: u64,
        add_entry: F,
    ) -> io::Result<()>
    where
        F: FnMut(DirEntry) -> io::Result<usize>;

    /// Read a directory with entry attributes.
    ///
    /// Like `readdir` but also includes the attributes for each directory entry.
    ///
    /// `handle` is the `Handle` returned by the file system from the `opendir` method, if any. If
    /// the file system did not return a `Handle` from `opendir` then the contents of `handle` are
    /// undefined.
    ///
    /// `size` indicates the maximum number of bytes that should be returned by this method.
    ///
    /// Unlike `readdir`, the lookup count for `Inode`s associated with the returned directory
    /// entries **IS** affected by this method (since it returns an `Entry` for each `DirEntry`).
    /// The count for each `Inode` should be increased by 1.
    ///
    /// File systems that implement this method should enable the `FsOptions::DO_READDIRPLUS`
    /// feature when supported by the kernel. The kernel will not call this method unless that
    /// feature is enabled.
    ///
    /// Additionally, file systems that implement both `readdir` and `readdirplus` should enable the
    /// `FsOptions::READDIRPLUS_AUTO` feature to allow the kernel to issue both `readdir` and
    /// `readdirplus` requests, depending on how much information is expected to be required.
    ///
    fn readdirplus<F>(
        &self,
        ctx: Context,
        inode: Self::Inode,
        handle: Self::Handle,
        size: u32,
        offset: u64,
        add_entry: F,
    ) -> io::Result<()>
    where
        F: FnMut(DirEntry, Entry) -> io::Result<usize>;

    fn fsyncdir(
        &self,
        ctx: Context,
        inode: Self::Inode,
        datasync: bool,
        handle: Self::Handle,
    ) -> io::Result<()>;

    /// Release an open directory.
    ///
    /// For every `opendir` call there will be exactly one `releasedir` call (unless the file system
    /// is force-unmounted).
    ///
    /// `handle` is the `Handle` returned by the file system from the `opendir` method, if any. If
    /// the file system did not return a `Handle` from `opendir` then the contents of `handle` are
    /// undefined.
    ///
    /// `flags` contains used the flags used to open the directory in `opendir`.
    fn releasedir(
        &self,
        ctx: Context,
        inode: Self::Inode,
        flags: u32,
        handle: Self::Handle,
    ) -> io::Result<()>;

    fn access(&self, ctx: Context, inode: Self::Inode, mask: u32) -> io::Result<()>;

    /// Reposition read/write file offset.
    fn lseek(
        &self,
        ctx: Context,
        inode: Self::Inode,
        handle: Self::Handle,
        offset: u64,
        whence: u32,
    ) -> io::Result<u64>;

    #[expect(
        clippy::too_many_arguments,
        reason = "Preserve the migrated FUSE operation signature"
    )]
    fn copyfilerange(
        &self,
        ctx: Context,
        inode_in: Self::Inode,
        handle_in: Self::Handle,
        offset_in: u64,
        inode_out: Self::Inode,
        handle_out: Self::Handle,
        offset_out: u64,
        len: u64,
        flags: u64,
    ) -> io::Result<usize>;
}
