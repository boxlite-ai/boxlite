//! Embedded SFTP v3 helper executed through the OCI container boundary.

use crate::service::ssh::limits::{
    MAX_SFTP_DIRECTORY_ENTRIES, MAX_SFTP_HANDLES, MAX_SFTP_READ_BYTES,
};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use russh_sftp::extensions::{
    FsyncExtension, HardlinkExtension, LimitsExtension, Statvfs, StatvfsExtension, FSYNC, HARDLINK,
    LIMITS, STATVFS,
};
use russh_sftp::protocol::{
    Attrs, Data, ExtendedReply, File as SftpFile, FileAttributes, Handle, Name, OpenFlags, Packet,
    Status, StatusCode, Version,
};
use russh_sftp::server::StatusReply;
use std::collections::HashMap;
use std::ffi::CString;
use std::fs::{self, File, OpenOptions, ReadDir};
use std::io::{ErrorKind, Read as _};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::oneshot;

pub(crate) const INTERNAL_SFTP_ARG: &str = "--boxlite-internal-sftp";
const EXPAND_PATH: &str = "expand-path@openssh.com";
const FSTATVFS: &str = "fstatvfs@openssh.com";
const HOME_DIRECTORY: &str = "home-directory";
const LSETSTAT: &str = "lsetstat@openssh.com";
const POSIX_RENAME: &str = "posix-rename@openssh.com";
const USERS_GROUPS_BY_ID: &str = "users-groups-by-id@openssh.com";
const MAX_ACCOUNT_DATABASE_BYTES: u64 = 1024 * 1024;
const MAX_ACCOUNT_NAME_BYTES: usize = 256;
const MAX_ID_LOOKUPS: usize = 1024;

#[derive(serde::Deserialize, serde::Serialize)]
struct PosixRenameExtension {
    oldpath: String,
    newpath: String,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct LsetstatExtension {
    path: String,
    attrs: FileAttributes,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct UsersGroupsByIdExtension {
    uids: Vec<u8>,
    gids: Vec<u8>,
}

enum OpenHandle {
    File(File),
    Directory(ReadDir),
}

/// A filesystem server isolated by the same tenant namespaces, credentials,
/// and capability set as container exec. Handles are opaque, connection-local,
/// and bounded.
struct SftpSession {
    handles: HashMap<String, OpenHandle>,
    next_handle: u64,
}

/// Makes the detached `russh-sftp` protocol task observable by its helper
/// process so EOF or a pipe error terminates the execution cleanly.
struct EofAwareStream<S> {
    inner: S,
    finished: Option<oneshot::Sender<()>>,
}

impl<S> EofAwareStream<S> {
    fn new(inner: S) -> (Self, oneshot::Receiver<()>) {
        let (finished_tx, finished_rx) = oneshot::channel();
        (
            Self {
                inner,
                finished: Some(finished_tx),
            },
            finished_rx,
        )
    }

    fn finish(&mut self) {
        if let Some(finished) = self.finished.take() {
            let _ = finished.send(());
        }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for EofAwareStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let filled_before = buffer.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(context, buffer);
        let is_finished = match &result {
            Poll::Ready(Err(_)) => true,
            Poll::Ready(Ok(())) => buffer.filled().len() == filled_before,
            Poll::Pending => false,
        };
        if is_finished {
            self.finish();
        }
        result
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for EofAwareStream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let result = Pin::new(&mut self.inner).poll_write(context, buffer);
        if matches!(&result, Poll::Ready(Err(_)))
            || matches!(&result, Poll::Ready(Ok(0)) if !buffer.is_empty())
        {
            self.finish();
        }
        result
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        let result = Pin::new(&mut self.inner).poll_flush(context);
        if matches!(&result, Poll::Ready(Err(_))) {
            self.finish();
        }
        result
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        let result = Pin::new(&mut self.inner).poll_shutdown(context);
        if matches!(&result, Poll::Ready(_)) {
            self.finish();
        }
        result
    }
}

impl SftpSession {
    fn new() -> Self {
        Self {
            handles: HashMap::new(),
            next_handle: 1,
        }
    }

    fn insert_handle(&mut self, handle: OpenHandle) -> Result<String, StatusReply> {
        if self.handles.len() >= MAX_SFTP_HANDLES {
            return Err(StatusCode::Failure.with_message("too many open SFTP handles"));
        }
        let id = format!("{:016x}", self.next_handle);
        self.next_handle = self.next_handle.wrapping_add(1);
        self.handles.insert(id.clone(), handle);
        Ok(id)
    }

    fn file(&self, handle: &str) -> Result<&File, StatusReply> {
        match self.handles.get(handle) {
            Some(OpenHandle::File(file)) => Ok(file),
            Some(OpenHandle::Directory(_)) => {
                Err(StatusCode::Failure.with_message("handle is a directory"))
            }
            None => Err(StatusCode::NoSuchFile.with_message("unknown SFTP handle")),
        }
    }

    fn directory(&mut self, handle: &str) -> Result<&mut ReadDir, StatusReply> {
        match self.handles.get_mut(handle) {
            Some(OpenHandle::Directory(directory)) => Ok(directory),
            Some(OpenHandle::File(_)) => {
                Err(StatusCode::Failure.with_message("handle is not a directory"))
            }
            None => Err(StatusCode::NoSuchFile.with_message("unknown SFTP handle")),
        }
    }
}

impl russh_sftp::server::Handler for SftpSession {
    type Error = StatusReply;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported.into()
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        let mut version = Version::new();
        version
            .extensions
            .insert(LIMITS.to_string(), "1".to_string());
        version
            .extensions
            .insert(HARDLINK.to_string(), "1".to_string());
        version
            .extensions
            .insert(FSYNC.to_string(), "1".to_string());
        version
            .extensions
            .insert(STATVFS.to_string(), "2".to_string());
        version
            .extensions
            .insert(FSTATVFS.to_string(), "2".to_string());
        version
            .extensions
            .insert(LSETSTAT.to_string(), "1".to_string());
        version
            .extensions
            .insert(EXPAND_PATH.to_string(), "1".to_string());
        version
            .extensions
            .insert(HOME_DIRECTORY.to_string(), "1".to_string());
        version
            .extensions
            .insert(USERS_GROUPS_BY_ID.to_string(), "1".to_string());
        version
            .extensions
            .insert(POSIX_RENAME.to_string(), "1".to_string());
        Ok(version)
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let mut options: OpenOptions = pflags.into();
        options.mode(attrs.permissions.unwrap_or(0o666) & 0o7777);
        let file = options.open(&filename).map_err(io_status)?;
        let handle = self.insert_handle(OpenHandle::File(file))?;
        Ok(Handle { id, handle })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.handles
            .remove(&handle)
            .ok_or_else(|| StatusCode::NoSuchFile.with_message("unknown SFTP handle"))?;
        Ok(ok_status(id))
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let len = usize::try_from(len)
            .unwrap_or(usize::MAX)
            .min(MAX_SFTP_READ_BYTES);
        let mut data = vec![0; len];
        let read = self
            .file(&handle)?
            .read_at(&mut data, offset)
            .map_err(io_status)?;
        if read == 0 {
            return Err(StatusCode::Eof.into());
        }
        data.truncate(read);
        Ok(Data { id, data })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        if data.len() > MAX_SFTP_READ_BYTES {
            return Err(StatusCode::Failure.with_message("SFTP write exceeds the size limit"));
        }
        offset
            .checked_add(
                u64::try_from(data.len()).map_err(|_| {
                    StatusCode::Failure.with_message("SFTP write length exceeds u64")
                })?,
            )
            .ok_or_else(|| StatusCode::Failure.with_message("SFTP write offset overflow"))?;
        let file = self.file(&handle)?;
        let mut written = 0;
        while written < data.len() {
            let write_offset = offset
                .checked_add(u64::try_from(written).map_err(|_| {
                    StatusCode::Failure.with_message("SFTP write length exceeds u64")
                })?)
                .ok_or_else(|| StatusCode::Failure.with_message("SFTP write offset overflow"))?;
            let count = file
                .write_at(&data[written..], write_offset)
                .map_err(io_status)?;
            if count == 0 {
                return Err(StatusCode::Failure.with_message("short SFTP write"));
            }
            written += count;
        }
        Ok(ok_status(id))
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        attrs_for(id, fs::symlink_metadata(path).map_err(io_status)?)
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        attrs_for(id, fs::metadata(path).map_err(io_status)?)
    }

    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        attrs_for(id, self.file(&handle)?.metadata().map_err(io_status)?)
    }

    async fn setstat(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        apply_path_attributes(Path::new(&path), attrs)?;
        Ok(ok_status(id))
    }

    async fn fsetstat(
        &mut self,
        id: u32,
        handle: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        apply_file_attributes(self.file(&handle)?, attrs)?;
        Ok(ok_status(id))
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let directory = fs::read_dir(path).map_err(io_status)?;
        let handle = self.insert_handle(OpenHandle::Directory(directory))?;
        Ok(Handle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        let directory = self.directory(&handle)?;
        let mut files = Vec::new();
        for entry in directory.take(MAX_SFTP_DIRECTORY_ENTRIES) {
            let entry = entry.map_err(io_status)?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(io_status)?;
            files.push(SftpFile::new(
                entry.file_name().to_string_lossy(),
                FileAttributes::from(&metadata),
            ));
        }
        if files.is_empty() {
            return Err(StatusCode::Eof.into());
        }
        Ok(Name { id, files })
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        fs::remove_file(filename).map_err(io_status)?;
        Ok(ok_status(id))
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        fs::create_dir(&path).map_err(io_status)?;
        if let Some(mode) = attrs.permissions {
            fs::set_permissions(&path, fs::Permissions::from_mode(mode & 0o7777))
                .map_err(io_status)?;
        }
        Ok(ok_status(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        fs::remove_dir(path).map_err(io_status)?;
        Ok(ok_status(id))
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let path = fs::canonicalize(path).map_err(io_status)?;
        Ok(Name {
            id,
            files: vec![SftpFile::dummy(path.to_string_lossy())],
        })
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        rename_without_replace(Path::new(&oldpath), Path::new(&newpath))?;
        Ok(ok_status(id))
    }

    async fn readlink(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let target = fs::read_link(path).map_err(io_status)?;
        Ok(Name {
            id,
            files: vec![SftpFile::dummy(target.to_string_lossy())],
        })
    }

    async fn symlink(
        &mut self,
        id: u32,
        linkpath: String,
        targetpath: String,
    ) -> Result<Status, Self::Error> {
        // OpenSSH sends target then link name, opposite the field names in
        // russh-sftp's v3 decoder. Treat the first value as the target.
        std::os::unix::fs::symlink(linkpath, targetpath).map_err(io_status)?;
        Ok(ok_status(id))
    }

    async fn extended(
        &mut self,
        id: u32,
        request: String,
        data: Vec<u8>,
    ) -> Result<Packet, Self::Error> {
        use bytes::Bytes;

        match request.as_str() {
            LIMITS => extended_reply(
                id,
                &LimitsExtension {
                    max_packet_len: MAX_SFTP_READ_BYTES as u64 + 1024,
                    max_read_len: MAX_SFTP_READ_BYTES as u64,
                    max_write_len: MAX_SFTP_READ_BYTES as u64,
                    max_open_handles: MAX_SFTP_HANDLES as u64,
                },
            ),
            HARDLINK => {
                let mut data = Bytes::from(data);
                let request: HardlinkExtension =
                    russh_sftp::de::from_bytes(&mut data).map_err(protocol_status)?;
                fs::hard_link(request.oldpath, request.newpath).map_err(io_status)?;
                Ok(ok_status(id).into())
            }
            FSYNC => {
                let mut data = Bytes::from(data);
                let request: FsyncExtension =
                    russh_sftp::de::from_bytes(&mut data).map_err(protocol_status)?;
                self.file(&request.handle)?.sync_all().map_err(io_status)?;
                Ok(ok_status(id).into())
            }
            STATVFS => {
                let mut data = Bytes::from(data);
                let request: StatvfsExtension =
                    russh_sftp::de::from_bytes(&mut data).map_err(protocol_status)?;
                extended_reply(id, &statvfs(Path::new(&request.path))?)
            }
            FSTATVFS => {
                let request: FsyncExtension = decode_extension(data)?;
                extended_reply(id, &fstatvfs(self.file(&request.handle)?)?)
            }
            LSETSTAT => {
                let request: LsetstatExtension = decode_extension(data)?;
                apply_symlink_attributes(Path::new(&request.path), request.attrs)?;
                Ok(ok_status(id).into())
            }
            EXPAND_PATH => {
                let path: String = decode_extension(data)?;
                Ok(name_packet(id, expand_path(&path)?)?.into())
            }
            HOME_DIRECTORY => {
                let username: String = decode_extension(data)?;
                let username = (!username.is_empty()).then_some(username.as_str());
                let home = fs::canonicalize(passwd_home(username)?).map_err(io_status)?;
                Ok(name_packet(id, home)?.into())
            }
            USERS_GROUPS_BY_ID => {
                let request: UsersGroupsByIdExtension = decode_extension(data)?;
                let uids = unpack_ids(&request.uids)?;
                let gids = unpack_ids(&request.gids)?;
                extended_reply(
                    id,
                    &UsersGroupsByIdExtension {
                        uids: pack_names(account_names(Path::new("/etc/passwd"), &uids, 2)?)?,
                        gids: pack_names(account_names(Path::new("/etc/group"), &gids, 2)?)?,
                    },
                )
            }
            POSIX_RENAME => {
                let mut data = Bytes::from(data);
                let request: PosixRenameExtension =
                    russh_sftp::de::from_bytes(&mut data).map_err(protocol_status)?;
                fs::rename(request.oldpath, request.newpath).map_err(io_status)?;
                Ok(ok_status(id).into())
            }
            _ => Err(StatusCode::OpUnsupported.into()),
        }
    }
}

pub(crate) fn run_internal() -> BoxliteResult<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| BoxliteError::Internal(format!("SFTP runtime: {error}")))?;
    runtime.block_on(async {
        let stream = tokio::io::join(tokio::io::stdin(), tokio::io::stdout());
        let (stream, finished) = EofAwareStream::new(stream);
        russh_sftp::server::run_with_config(
            stream,
            SftpSession::new(),
            russh_sftp::server::Config {
                // Includes request metadata in addition to the advertised
                // read/write payload limit.
                max_client_packet_len: (MAX_SFTP_READ_BYTES + 4096) as u32,
            },
        )
        .await;
        // `run_with_config` detaches its protocol loop. Wait for that loop's
        // stream to observe EOF/error before exiting the tenant process.
        let _ = finished.await;
    });
    Ok(())
}

fn ok_status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "OK".to_string(),
        language_tag: "en-US".to_string(),
    }
}

fn attrs_for(id: u32, metadata: fs::Metadata) -> Result<Attrs, StatusReply> {
    Ok(Attrs {
        id,
        attrs: FileAttributes::from(&metadata),
    })
}

fn io_status(error: std::io::Error) -> StatusReply {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
        std::io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
        std::io::ErrorKind::UnexpectedEof => StatusCode::Eof,
        _ => StatusCode::Failure,
    };
    code.with_message(error.to_string())
}

fn protocol_status(error: impl std::fmt::Display) -> StatusReply {
    StatusCode::BadMessage.with_message(error.to_string())
}

fn rename_without_replace(oldpath: &Path, newpath: &Path) -> Result<(), StatusReply> {
    let oldpath = c_path(oldpath)?;
    let newpath = c_path(newpath)?;
    // SFTP v3 requires SSH_FXP_RENAME to fail when newpath exists. Linux's
    // renameat2 gives that rule atomic semantics; a metadata pre-check would
    // allow another process to race us and have its file overwritten.
    let result = unsafe {
        nix::libc::syscall(
            nix::libc::SYS_renameat2,
            nix::libc::AT_FDCWD,
            oldpath.as_ptr(),
            nix::libc::AT_FDCWD,
            newpath.as_ptr(),
            nix::libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io_status(std::io::Error::last_os_error()))
    }
}

fn extended_reply<T: serde::Serialize>(id: u32, value: &T) -> Result<Packet, StatusReply> {
    let data = russh_sftp::ser::to_bytes(value)
        .map_err(protocol_status)?
        .to_vec();
    Ok(ExtendedReply { id, data }.into())
}

fn decode_extension<T: serde::de::DeserializeOwned>(data: Vec<u8>) -> Result<T, StatusReply> {
    let mut data = bytes::Bytes::from(data);
    let value = russh_sftp::de::from_bytes(&mut data).map_err(protocol_status)?;
    if !data.is_empty() {
        return Err(StatusCode::BadMessage.with_message("trailing extension data"));
    }
    Ok(value)
}

fn name_packet(id: u32, path: PathBuf) -> Result<Name, StatusReply> {
    let path = path
        .into_os_string()
        .into_string()
        .map_err(|_| StatusCode::Failure.with_message("path is not valid UTF-8"))?;
    Ok(Name {
        id,
        files: vec![SftpFile::dummy(path)],
    })
}

fn apply_path_attributes(path: &Path, attrs: FileAttributes) -> Result<(), StatusReply> {
    if let Some(size) = attrs.size {
        OpenOptions::new()
            .write(true)
            .open(path)
            .and_then(|file| file.set_len(size))
            .map_err(io_status)?;
    }
    if attrs.uid.is_some() || attrs.gid.is_some() {
        let path = c_path(path)?;
        let result = unsafe {
            nix::libc::chown(
                path.as_ptr(),
                attrs.uid.unwrap_or(u32::MAX),
                attrs.gid.unwrap_or(u32::MAX),
            )
        };
        cvt(result, "chown")?;
    }
    if let Some(mode) = attrs.permissions {
        fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o7777)).map_err(io_status)?;
    }
    if attrs.atime.is_some() || attrs.mtime.is_some() {
        set_path_times(path, attrs.atime, attrs.mtime)?;
    }
    Ok(())
}

fn apply_file_attributes(file: &File, attrs: FileAttributes) -> Result<(), StatusReply> {
    if let Some(size) = attrs.size {
        file.set_len(size).map_err(io_status)?;
    }
    if attrs.uid.is_some() || attrs.gid.is_some() {
        let result = unsafe {
            nix::libc::fchown(
                file.as_raw_fd(),
                attrs.uid.unwrap_or(u32::MAX),
                attrs.gid.unwrap_or(u32::MAX),
            )
        };
        cvt(result, "fchown")?;
    }
    if let Some(mode) = attrs.permissions {
        let result = unsafe { nix::libc::fchmod(file.as_raw_fd(), mode & 0o7777) };
        cvt(result, "fchmod")?;
    }
    if attrs.atime.is_some() || attrs.mtime.is_some() {
        let times = timespecs(attrs.atime, attrs.mtime);
        let result = unsafe { nix::libc::futimens(file.as_raw_fd(), times.as_ptr()) };
        cvt(result, "futimens")?;
    }
    Ok(())
}

fn set_path_times(path: &Path, atime: Option<u32>, mtime: Option<u32>) -> Result<(), StatusReply> {
    let path = c_path(path)?;
    let times = timespecs(atime, mtime);
    let result =
        unsafe { nix::libc::utimensat(nix::libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), 0) };
    cvt(result, "utimensat")
}

fn timespecs(atime: Option<u32>, mtime: Option<u32>) -> [nix::libc::timespec; 2] {
    [
        nix::libc::timespec {
            tv_sec: atime.map_or(0, i64::from),
            tv_nsec: if atime.is_some() {
                0
            } else {
                nix::libc::UTIME_OMIT
            },
        },
        nix::libc::timespec {
            tv_sec: mtime.map_or(0, i64::from),
            tv_nsec: if mtime.is_some() {
                0
            } else {
                nix::libc::UTIME_OMIT
            },
        },
    ]
}

fn statvfs(path: &Path) -> Result<Statvfs, StatusReply> {
    let path = c_path(path)?;
    let mut value = std::mem::MaybeUninit::<nix::libc::statvfs>::zeroed();
    let result = unsafe { nix::libc::statvfs(path.as_ptr(), value.as_mut_ptr()) };
    cvt(result, "statvfs")?;
    Ok(portable_statvfs(unsafe { value.assume_init() }))
}

fn fstatvfs(file: &File) -> Result<Statvfs, StatusReply> {
    let mut value = std::mem::MaybeUninit::<nix::libc::statvfs>::zeroed();
    let result = unsafe { nix::libc::fstatvfs(file.as_raw_fd(), value.as_mut_ptr()) };
    cvt(result, "fstatvfs")?;
    Ok(portable_statvfs(unsafe { value.assume_init() }))
}

fn portable_statvfs(value: nix::libc::statvfs) -> Statvfs {
    Statvfs {
        block_size: value.f_bsize,
        fragment_size: value.f_frsize,
        blocks: value.f_blocks,
        blocks_free: value.f_bfree,
        blocks_avail: value.f_bavail,
        inodes: value.f_files,
        inodes_free: value.f_ffree,
        inodes_avail: value.f_favail,
        fs_id: value.f_fsid,
        // OpenSSH's wire format defines only read-only and no-setuid.
        flags: value.f_flag & 0x3,
        name_max: value.f_namemax,
    }
}

fn expand_path(path: &str) -> Result<PathBuf, StatusReply> {
    let expanded = if path.is_empty() {
        PathBuf::from(".")
    } else if let Some(path) = path.strip_prefix('~') {
        let (username, suffix) = path.split_once('/').unwrap_or((path, ""));
        let username = (!username.is_empty()).then_some(username);
        let mut expanded = passwd_home(username)?;
        if !suffix.is_empty() {
            expanded.push(suffix);
        }
        expanded
    } else {
        PathBuf::from(path)
    };
    fs::canonicalize(expanded).map_err(io_status)
}

fn passwd_home(username: Option<&str>) -> Result<PathBuf, StatusReply> {
    if username.is_some_and(|username| username.len() > MAX_ACCOUNT_NAME_BYTES) {
        return Err(StatusCode::BadMessage.with_message("account name is too long"));
    }
    let passwd = read_account_database(Path::new("/etc/passwd"))?
        .ok_or_else(|| StatusCode::Failure.with_message("passwd database is unavailable"))?;
    let effective_uid = unsafe { nix::libc::geteuid() };
    for line in passwd.lines() {
        let fields: Vec<_> = line.split(':').collect();
        if fields.len() < 7 {
            continue;
        }
        let is_match = match username {
            Some(username) => fields[0] == username,
            None => fields[2].parse::<u32>().ok() == Some(effective_uid),
        };
        if is_match {
            let home = PathBuf::from(fields[5]);
            if !home.is_absolute() {
                return Err(
                    StatusCode::Failure.with_message("passwd home directory is not absolute")
                );
            }
            return Ok(home);
        }
    }
    Err(StatusCode::Failure.with_message("account has no passwd entry"))
}

fn unpack_ids(data: &[u8]) -> Result<Vec<u32>, StatusReply> {
    if !data.len().is_multiple_of(std::mem::size_of::<u32>()) {
        return Err(StatusCode::BadMessage.with_message("ID list is not a sequence of uint32"));
    }
    let count = data.len() / std::mem::size_of::<u32>();
    if count > MAX_ID_LOOKUPS {
        return Err(StatusCode::Failure.with_message("too many account ID lookups"));
    }
    Ok(data
        .as_chunks::<4>()
        .0
        .iter()
        .map(|id| u32::from_be_bytes(*id))
        .collect())
}

fn account_names(
    database_path: &Path,
    ids: &[u32],
    id_field: usize,
) -> Result<Vec<String>, StatusReply> {
    let mut names: HashMap<u32, Option<String>> =
        ids.iter().copied().map(|id| (id, None)).collect();
    if let Some(database) = read_account_database(database_path)? {
        for line in database.lines() {
            let fields: Vec<_> = line.split(':').collect();
            let Some(id) = fields.get(id_field).and_then(|id| id.parse::<u32>().ok()) else {
                continue;
            };
            let Some(name) = fields.first() else {
                continue;
            };
            if name.len() > MAX_ACCOUNT_NAME_BYTES {
                return Err(StatusCode::Failure.with_message("account name is too long"));
            }
            if let Some(slot) = names.get_mut(&id) {
                if slot.is_none() {
                    *slot = Some((*name).to_string());
                }
            }
        }
    }
    Ok(ids
        .iter()
        .map(|id| names.get(id).cloned().flatten().unwrap_or_default())
        .collect())
}

fn pack_names(names: Vec<String>) -> Result<Vec<u8>, StatusReply> {
    let mut packed = Vec::new();
    for name in names {
        let length = u32::try_from(name.len())
            .map_err(|_| StatusCode::Failure.with_message("account name is too long"))?;
        let next_len = packed
            .len()
            .checked_add(4)
            .and_then(|length| length.checked_add(name.len()))
            .ok_or_else(|| StatusCode::Failure.with_message("account name reply is too large"))?;
        if next_len > MAX_SFTP_READ_BYTES {
            return Err(StatusCode::Failure.with_message("account name reply is too large"));
        }
        packed.extend_from_slice(&length.to_be_bytes());
        packed.extend_from_slice(name.as_bytes());
    }
    Ok(packed)
}

fn read_account_database(path: &Path) -> Result<Option<String>, StatusReply> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_status(error)),
    };
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_ACCOUNT_DATABASE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_status)?;
    if bytes.len() as u64 > MAX_ACCOUNT_DATABASE_BYTES {
        return Err(StatusCode::Failure.with_message("account database is too large"));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| StatusCode::Failure.with_message("account database is not valid UTF-8"))
}

fn apply_symlink_attributes(path: &Path, attrs: FileAttributes) -> Result<(), StatusReply> {
    if attrs.size.is_some() {
        return Err(StatusCode::BadMessage.with_message("cannot set the size of a symlink"));
    }
    let path = c_path(path)?;
    if let Some(mode) = attrs.permissions {
        let result = unsafe {
            nix::libc::fchmodat(
                nix::libc::AT_FDCWD,
                path.as_ptr(),
                mode & 0o7777,
                nix::libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        cvt(result, "fchmodat")?;
    }
    if attrs.atime.is_some() || attrs.mtime.is_some() {
        let times = timespecs(attrs.atime, attrs.mtime);
        let result = unsafe {
            nix::libc::utimensat(
                nix::libc::AT_FDCWD,
                path.as_ptr(),
                times.as_ptr(),
                nix::libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        cvt(result, "utimensat")?;
    }
    if attrs.uid.is_some() || attrs.gid.is_some() {
        let result = unsafe {
            nix::libc::fchownat(
                nix::libc::AT_FDCWD,
                path.as_ptr(),
                attrs.uid.unwrap_or(u32::MAX),
                attrs.gid.unwrap_or(u32::MAX),
                nix::libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        cvt(result, "fchownat")?;
    }
    Ok(())
}

fn c_path(path: &Path) -> Result<CString, StatusReply> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| StatusCode::BadMessage.with_message("path contains NUL"))
}

fn cvt(result: i32, operation: &str) -> Result<(), StatusReply> {
    if result == 0 {
        Ok(())
    } else {
        Err(io_status(std::io::Error::last_os_error())
            .with_message(format!("{operation}: {}", std::io::Error::last_os_error())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh_sftp::server::Handler as _;

    #[derive(serde::Deserialize, serde::Serialize)]
    struct TestUsersGroupsById {
        uids: Vec<u8>,
        gids: Vec<u8>,
    }

    fn packed_ids(ids: &[u32]) -> Vec<u8> {
        ids.iter().flat_map(|id| id.to_be_bytes()).collect()
    }

    fn unpack_names(mut bytes: &[u8]) -> Vec<String> {
        let mut names = Vec::new();
        while !bytes.is_empty() {
            let (length, rest) = bytes.split_at(4);
            let length = u32::from_be_bytes(length.try_into().unwrap()) as usize;
            let (name, rest) = rest.split_at(length);
            names.push(String::from_utf8(name.to_vec()).unwrap());
            bytes = rest;
        }
        names
    }

    fn current_passwd_identity() -> (String, PathBuf) {
        let effective_uid = unsafe { nix::libc::geteuid() };
        fs::read_to_string("/etc/passwd")
            .unwrap()
            .lines()
            .find_map(|line| {
                let fields: Vec<_> = line.split(':').collect();
                (fields.len() >= 7 && fields[2].parse::<u32>().ok() == Some(effective_uid))
                    .then(|| (fields[0].to_string(), PathBuf::from(fields[5])))
            })
            .unwrap()
    }

    #[tokio::test]
    async fn sftp_file_handles_support_offset_reads_and_writes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("file");
        let mut session = SftpSession::new();
        let handle = session
            .open(
                1,
                path.to_string_lossy().into_owned(),
                OpenFlags::WRITE | OpenFlags::CREATE,
                FileAttributes::empty(),
            )
            .await
            .unwrap()
            .handle;
        session
            .write(2, handle.clone(), 3, b"box".to_vec())
            .await
            .unwrap();
        session.close(3, handle).await.unwrap();

        let handle = session
            .open(
                4,
                path.to_string_lossy().into_owned(),
                OpenFlags::READ,
                FileAttributes::empty(),
            )
            .await
            .unwrap()
            .handle;
        let data = session.read(5, handle, 3, 3).await.unwrap();
        assert_eq!(data.data, b"box");
    }

    #[tokio::test]
    async fn sftp_write_rejects_an_offset_range_that_overflows_u64() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("file");
        let mut session = SftpSession::new();
        let handle = session
            .open(
                1,
                path.to_string_lossy().into_owned(),
                OpenFlags::WRITE | OpenFlags::CREATE,
                FileAttributes::empty(),
            )
            .await
            .unwrap()
            .handle;

        let error = session
            .write(2, handle, u64::MAX, vec![1, 2])
            .await
            .unwrap_err();

        assert_eq!(
            error.error_message.as_deref(),
            Some("SFTP write offset overflow")
        );
        assert!(fs::read(path).unwrap().is_empty());
    }

    #[tokio::test]
    async fn sftp_v3_rename_does_not_replace_an_existing_destination() {
        let temp = tempfile::tempdir().unwrap();
        let oldpath = temp.path().join("old");
        let newpath = temp.path().join("new");
        fs::write(&oldpath, b"old").unwrap();
        fs::write(&newpath, b"new").unwrap();
        let mut session = SftpSession::new();

        let result = session
            .rename(
                1,
                oldpath.to_string_lossy().into_owned(),
                newpath.to_string_lossy().into_owned(),
            )
            .await;

        assert!(result.is_err());
        assert_eq!(fs::read(oldpath).unwrap(), b"old");
        assert_eq!(fs::read(newpath).unwrap(), b"new");
    }

    #[tokio::test]
    async fn openssh_posix_rename_is_advertised_and_replaces_the_destination() {
        let temp = tempfile::tempdir().unwrap();
        let oldpath = temp.path().join("old");
        let newpath = temp.path().join("new");
        fs::write(&oldpath, b"replacement").unwrap();
        fs::write(&newpath, b"original").unwrap();
        let mut session = SftpSession::new();

        let version = session.init(3, HashMap::new()).await.unwrap();
        assert_eq!(
            version.extensions.get(POSIX_RENAME).map(String::as_str),
            Some("1")
        );

        let request = PosixRenameExtension {
            oldpath: oldpath.to_string_lossy().into_owned(),
            newpath: newpath.to_string_lossy().into_owned(),
        };
        let packet = session
            .extended(
                1,
                POSIX_RENAME.to_string(),
                russh_sftp::ser::to_bytes(&request).unwrap().to_vec(),
            )
            .await
            .unwrap();

        assert!(matches!(
            packet,
            Packet::Status(Status {
                status_code: StatusCode::Ok,
                ..
            })
        ));
        assert!(!oldpath.exists());
        assert_eq!(fs::read(newpath).unwrap(), b"replacement");
    }

    #[tokio::test]
    async fn openssh_fstatvfs_is_advertised_and_uses_an_open_file_handle() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("file");
        fs::write(&path, b"boxlite").unwrap();
        let mut session = SftpSession::new();

        let version = session.init(3, HashMap::new()).await.unwrap();
        assert_eq!(
            version
                .extensions
                .get("fstatvfs@openssh.com")
                .map(String::as_str),
            Some("2")
        );

        let handle = session
            .open(
                1,
                path.to_string_lossy().into_owned(),
                OpenFlags::READ,
                FileAttributes::empty(),
            )
            .await
            .unwrap()
            .handle;
        let packet = session
            .extended(
                2,
                "fstatvfs@openssh.com".to_string(),
                russh_sftp::ser::to_bytes(&handle).unwrap().to_vec(),
            )
            .await
            .unwrap();
        let Packet::ExtendedReply(reply) = packet else {
            panic!("fstatvfs returned the wrong SFTP packet type");
        };
        let value: Statvfs = russh_sftp::de::from_bytes(&mut reply.data.into()).unwrap();
        assert!(value.block_size > 0);
        assert!(value.name_max > 0);
    }

    #[tokio::test]
    async fn openssh_statvfs_exposes_only_portable_flag_bits() {
        let temp = tempfile::tempdir().unwrap();
        let mut session = SftpSession::new();
        let request = StatvfsExtension {
            path: temp.path().to_string_lossy().into_owned(),
        };

        let packet = session
            .extended(
                1,
                STATVFS.to_string(),
                russh_sftp::ser::to_bytes(&request).unwrap().to_vec(),
            )
            .await
            .unwrap();
        let Packet::ExtendedReply(reply) = packet else {
            panic!("statvfs returned the wrong SFTP packet type");
        };
        let value: Statvfs = russh_sftp::de::from_bytes(&mut reply.data.into()).unwrap();

        assert_eq!(value.flags & !0x3, 0);
    }

    #[tokio::test]
    async fn openssh_expand_path_is_advertised_and_returns_a_canonical_name() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("directory");
        fs::create_dir(&directory).unwrap();
        let requested = directory.join("..").join("directory");
        let mut session = SftpSession::new();

        let version = session.init(3, HashMap::new()).await.unwrap();
        assert_eq!(
            version
                .extensions
                .get("expand-path@openssh.com")
                .map(String::as_str),
            Some("1")
        );

        let packet = session
            .extended(
                1,
                "expand-path@openssh.com".to_string(),
                russh_sftp::ser::to_bytes(&requested.to_string_lossy().into_owned())
                    .unwrap()
                    .to_vec(),
            )
            .await
            .unwrap();
        let Packet::Name(name) = packet else {
            panic!("expand-path returned the wrong SFTP packet type");
        };
        assert_eq!(name.files.len(), 1);
        assert_eq!(
            Path::new(&name.files[0].filename),
            fs::canonicalize(directory).unwrap()
        );

        let (username, home) = current_passwd_identity();
        for requested in [
            "~".to_string(),
            "~/./".to_string(),
            format!("~{username}"),
            format!("~{username}/."),
        ] {
            let packet = session
                .extended(
                    2,
                    EXPAND_PATH.to_string(),
                    russh_sftp::ser::to_bytes(&requested).unwrap().to_vec(),
                )
                .await
                .unwrap();
            let Packet::Name(name) = packet else {
                panic!("tilde expansion returned the wrong SFTP packet type");
            };
            assert_eq!(
                Path::new(&name.files[0].filename),
                fs::canonicalize(&home).unwrap()
            );
        }
    }

    #[tokio::test]
    async fn home_directory_is_advertised_and_resolves_the_current_user() {
        let mut session = SftpSession::new();
        let (username, expected_home) = current_passwd_identity();

        let version = session.init(3, HashMap::new()).await.unwrap();
        assert_eq!(
            version.extensions.get("home-directory").map(String::as_str),
            Some("1")
        );

        for requested in [String::new(), username] {
            let packet = session
                .extended(
                    1,
                    HOME_DIRECTORY.to_string(),
                    russh_sftp::ser::to_bytes(&requested).unwrap().to_vec(),
                )
                .await
                .unwrap();
            let Packet::Name(name) = packet else {
                panic!("home-directory returned the wrong SFTP packet type");
            };
            assert_eq!(name.files.len(), 1);
            assert_eq!(
                Path::new(&name.files[0].filename),
                fs::canonicalize(&expected_home).unwrap()
            );
        }
    }

    #[tokio::test]
    async fn users_groups_by_id_is_advertised_and_preserves_request_order() {
        let mut session = SftpSession::new();
        let version = session.init(3, HashMap::new()).await.unwrap();
        assert_eq!(
            version
                .extensions
                .get("users-groups-by-id@openssh.com")
                .map(String::as_str),
            Some("1")
        );

        let request = TestUsersGroupsById {
            uids: packed_ids(&[0, u32::MAX]),
            gids: packed_ids(&[0, u32::MAX]),
        };
        let packet = session
            .extended(
                1,
                "users-groups-by-id@openssh.com".to_string(),
                russh_sftp::ser::to_bytes(&request).unwrap().to_vec(),
            )
            .await
            .unwrap();
        let Packet::ExtendedReply(reply) = packet else {
            panic!("users-groups-by-id returned the wrong SFTP packet type");
        };
        let reply: TestUsersGroupsById =
            russh_sftp::de::from_bytes(&mut reply.data.into()).unwrap();
        assert_eq!(unpack_names(&reply.uids), ["root", ""]);
        assert_eq!(unpack_names(&reply.gids), ["root", ""]);

        let malformed = TestUsersGroupsById {
            uids: vec![0, 0, 0],
            gids: Vec::new(),
        };
        let error = session
            .extended(
                2,
                USERS_GROUPS_BY_ID.to_string(),
                russh_sftp::ser::to_bytes(&malformed).unwrap().to_vec(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.status_code, StatusCode::BadMessage);

        let too_many = TestUsersGroupsById {
            uids: vec![0; (MAX_ID_LOOKUPS + 1) * 4],
            gids: Vec::new(),
        };
        let error = session
            .extended(
                3,
                USERS_GROUPS_BY_ID.to_string(),
                russh_sftp::ser::to_bytes(&too_many).unwrap().to_vec(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.status_code, StatusCode::Failure);
    }

    #[tokio::test]
    async fn openssh_lsetstat_is_advertised_and_changes_the_link_not_its_target() {
        use std::os::unix::fs::symlink;
        use std::time::UNIX_EPOCH;

        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        let link = temp.path().join("link");
        fs::write(&target, b"target").unwrap();
        symlink(&target, &link).unwrap();
        let target_mtime = fs::metadata(&target).unwrap().modified().unwrap();
        let mut session = SftpSession::new();

        let version = session.init(3, HashMap::new()).await.unwrap();
        assert_eq!(
            version
                .extensions
                .get("lsetstat@openssh.com")
                .map(String::as_str),
            Some("1")
        );

        let request = (
            link.to_string_lossy().into_owned(),
            FileAttributes {
                atime: Some(1_600_000_000),
                mtime: Some(1_600_000_001),
                ..FileAttributes::empty()
            },
        );
        let packet = session
            .extended(
                1,
                "lsetstat@openssh.com".to_string(),
                russh_sftp::ser::to_bytes(&request).unwrap().to_vec(),
            )
            .await
            .unwrap();
        assert!(matches!(
            packet,
            Packet::Status(Status {
                status_code: StatusCode::Ok,
                ..
            })
        ));
        assert_eq!(
            fs::symlink_metadata(&link)
                .unwrap()
                .modified()
                .unwrap()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            1_600_000_001
        );
        assert_eq!(
            fs::metadata(&target).unwrap().modified().unwrap(),
            target_mtime
        );

        let size_request = (
            link.to_string_lossy().into_owned(),
            FileAttributes {
                size: Some(0),
                ..FileAttributes::empty()
            },
        );
        let error = session
            .extended(
                2,
                LSETSTAT.to_string(),
                russh_sftp::ser::to_bytes(&size_request).unwrap().to_vec(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.status_code, StatusCode::BadMessage);
        assert_eq!(fs::read_link(link).unwrap(), target);
    }

    #[tokio::test]
    async fn openssh_symlink_wire_order_creates_link_at_the_second_path() {
        let temp = tempfile::tempdir().unwrap();
        let linkpath = temp.path().join("link");
        let mut session = SftpSession::new();

        // russh-sftp calls these fields linkpath/targetpath, but OpenSSH puts
        // the target first and the link name second on the wire.
        session
            .symlink(
                1,
                "../target".to_string(),
                linkpath.to_string_lossy().into_owned(),
            )
            .await
            .unwrap();

        assert_eq!(fs::read_link(linkpath).unwrap(), Path::new("../target"));
    }

    #[tokio::test]
    async fn sftp_handle_table_is_bounded() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("file");
        fs::write(&path, b"x").unwrap();
        let mut session = SftpSession::new();
        for id in 0..MAX_SFTP_HANDLES {
            session
                .open(
                    id as u32,
                    path.to_string_lossy().into_owned(),
                    OpenFlags::READ,
                    FileAttributes::empty(),
                )
                .await
                .unwrap();
        }
        assert!(session
            .open(
                999,
                path.to_string_lossy().into_owned(),
                OpenFlags::READ,
                FileAttributes::empty(),
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn eof_aware_stream_reports_input_completion() {
        use tokio::io::AsyncWriteExt as _;

        let (client, server) = tokio::io::duplex(64);
        let (mut stream, finished) = EofAwareStream::new(server);
        drop(client);

        let mut byte = [0_u8; 1];
        let read = tokio::io::AsyncReadExt::read(&mut stream, &mut byte)
            .await
            .unwrap();
        assert_eq!(read, 0);
        finished.await.unwrap();

        stream.shutdown().await.unwrap();
    }
}
