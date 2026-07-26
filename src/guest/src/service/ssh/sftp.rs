//! SFTP subsystem adapter: implements [`russh_sftp::server::Handler`] over
//! the shared [`GuestFilesystem`] backend -- the same path/symlink/handle
//! policy the tar `Upload`/`Download` RPCs use. This module never opens a
//! host path itself and never starts an external `sftp-server`/`scp`
//! process; the wire protocol is handled entirely by the `russh-sftp`
//! library, in-process.

use crate::service::files::backend::{FsOpenOptions, FsOwnerId, GuestFilesystem, GuestFsError};
use crate::service::ssh::limits::{
    MAX_READDIR_ENTRIES_PER_RESPONSE, MAX_SFTP_HANDLES_PER_CONNECTION, MAX_SFTP_RW_BYTES,
};
use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version,
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

enum OpenHandle {
    File(u64),
    Dir {
        entries: Vec<crate::service::files::backend::DirEntry>,
        offset: usize,
    },
}

/// One SFTP session's state -- owns the [`FsOwnerId`] used to scope and
/// bulk-release every handle it opens.
pub(crate) struct SftpSession {
    filesystem: Arc<GuestFilesystem>,
    container_id: String,
    owner: FsOwnerId,
    handles: HashMap<String, OpenHandle>,
    next_handle: u64,
}

static NEXT_OWNER_ID: AtomicU64 = AtomicU64::new(1);

impl SftpSession {
    pub(crate) fn new(filesystem: Arc<GuestFilesystem>, container_id: String) -> Self {
        Self {
            filesystem,
            container_id,
            owner: NEXT_OWNER_ID.fetch_add(1, Ordering::Relaxed),
            handles: HashMap::new(),
            next_handle: 0,
        }
    }

    fn mint_handle(&mut self) -> String {
        self.next_handle += 1;
        format!("h{}", self.next_handle)
    }
}

impl Drop for SftpSession {
    /// Release every handle this session opened, however the SFTP stream
    /// ended (clean EOF, protocol error, or the underlying SSH
    /// channel/connection dropping out from under it) -- `russh_sftp`
    /// doesn't expose a completion hook, so `Drop` is the one place this is
    /// guaranteed to run.
    fn drop(&mut self) {
        let filesystem = self.filesystem.clone();
        let owner = self.owner;
        tokio::spawn(async move {
            filesystem.close_all_for_owner(owner).await;
        });
    }
}

fn map_error(e: GuestFsError) -> StatusCode {
    match e {
        GuestFsError::NotFound => StatusCode::NoSuchFile,
        GuestFsError::PermissionDenied => StatusCode::PermissionDenied,
        GuestFsError::InvalidPath
        | GuestFsError::AlreadyExists
        | GuestFsError::IsADirectory
        | GuestFsError::NotADirectory
        | GuestFsError::DirectoryNotEmpty
        | GuestFsError::HandleLimitExceeded
        | GuestFsError::UnknownHandle
        | GuestFsError::TooLarge
        | GuestFsError::Io(_) => StatusCode::Failure,
    }
}

fn unix_secs(t: Option<SystemTime>) -> u32 {
    t.and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as u32)
        .unwrap_or(0)
}

fn to_file_attributes(meta: &crate::service::files::backend::Metadata) -> FileAttributes {
    FileAttributes {
        size: Some(meta.len),
        uid: Some(0),
        user: None,
        gid: Some(0),
        group: None,
        permissions: Some(meta.mode),
        atime: Some(unix_secs(meta.modified)),
        mtime: Some(unix_secs(meta.modified)),
    }
}

fn to_open_options(pflags: OpenFlags) -> FsOpenOptions {
    let exclusive = pflags.contains(OpenFlags::EXCLUDE);
    FsOpenOptions {
        read: pflags.contains(OpenFlags::READ),
        write: pflags.contains(OpenFlags::WRITE) || pflags.contains(OpenFlags::APPEND),
        create: pflags.contains(OpenFlags::CREATE) && !exclusive,
        create_new: pflags.contains(OpenFlags::CREATE) && exclusive,
        truncate: pflags.contains(OpenFlags::TRUNCATE) && !pflags.contains(OpenFlags::APPEND),
        append: pflags.contains(OpenFlags::APPEND),
    }
}

/// Lexically normalize `path` against a virtual root (never touches disk,
/// never returns a host path) -- `..` cannot walk above `/`. Used only for
/// `SSH_FXP_REALPATH`, where returning the real host-side rootfs path would
/// leak guest internals to the client.
fn virtual_realpath(path: &str) -> String {
    let mut stack: Vec<&str> = Vec::new();
    for component in path.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            other => stack.push(other),
        }
    }
    format!("/{}", stack.join("/"))
}

impl russh_sftp::server::Handler for SftpSession {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        if self.handles.len() >= MAX_SFTP_HANDLES_PER_CONNECTION {
            return Err(StatusCode::Failure);
        }
        let opts = to_open_options(pflags);
        let handle_id = self
            .filesystem
            .open(self.owner, &self.container_id, &filename, opts)
            .await
            .map_err(map_error)?;
        let handle = self.mint_handle();
        self.handles
            .insert(handle.clone(), OpenHandle::File(handle_id));
        Ok(Handle { id, handle })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        match self.handles.remove(&handle) {
            Some(OpenHandle::File(fid)) => {
                self.filesystem.close(fid).await.map_err(map_error)?;
            }
            Some(OpenHandle::Dir { .. }) => {}
            None => return Err(StatusCode::Failure),
        }
        Ok(ok_status(id))
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let fid = match self.handles.get(&handle) {
            Some(OpenHandle::File(fid)) => *fid,
            _ => return Err(StatusCode::Failure),
        };
        let len = (len as usize).min(MAX_SFTP_RW_BYTES);
        let data = self
            .filesystem
            .read_at(fid, offset, len)
            .await
            .map_err(map_error)?;
        if data.is_empty() && len > 0 {
            return Err(StatusCode::Eof);
        }
        Ok(Data { id, data })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let fid = match self.handles.get(&handle) {
            Some(OpenHandle::File(fid)) => *fid,
            _ => return Err(StatusCode::Failure),
        };
        if data.len() > MAX_SFTP_RW_BYTES {
            return Err(StatusCode::Failure);
        }
        self.filesystem
            .write_at(fid, offset, data)
            .await
            .map_err(map_error)?;
        Ok(ok_status(id))
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let meta = self
            .filesystem
            .metadata(&self.container_id, &path, false)
            .await
            .map_err(map_error)?;
        Ok(Attrs {
            id,
            attrs: to_file_attributes(&meta),
        })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let meta = self
            .filesystem
            .metadata(&self.container_id, &path, true)
            .await
            .map_err(map_error)?;
        Ok(Attrs {
            id,
            attrs: to_file_attributes(&meta),
        })
    }

    async fn fstat(&mut self, _id: u32, handle: String) -> Result<Attrs, Self::Error> {
        // No open file/dir carries its own path today (see OpenHandle) --
        // SFTPv3 fstat is rarely exercised by mainline clients (they use
        // `stat`/`lstat` by path instead), so this is intentionally
        // unsupported rather than adding path-tracking machinery unused
        // elsewhere.
        let _ = handle;
        Err(StatusCode::OpUnsupported)
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        if self.handles.len() >= MAX_SFTP_HANDLES_PER_CONNECTION {
            return Err(StatusCode::Failure);
        }
        let entries = self
            .filesystem
            .read_dir(&self.container_id, &path)
            .await
            .map_err(map_error)?;
        let handle = self.mint_handle();
        self.handles
            .insert(handle.clone(), OpenHandle::Dir { entries, offset: 0 });
        Ok(Handle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        let dir = match self.handles.get_mut(&handle) {
            Some(OpenHandle::Dir { entries, offset }) => (entries, offset),
            _ => return Err(StatusCode::Failure),
        };
        let (entries, offset) = dir;
        if *offset >= entries.len() {
            return Err(StatusCode::Eof);
        }
        // One batch per response; the client re-issues READDIR until Eof.
        let end = entries
            .len()
            .min(*offset + MAX_READDIR_ENTRIES_PER_RESPONSE);
        let files = entries[*offset..end]
            .iter()
            .map(|e| File::new(e.name.clone(), to_file_attributes(&e.metadata)))
            .collect();
        *offset = end;
        Ok(Name { id, files })
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        self.filesystem
            .remove_file(&self.container_id, &filename)
            .await
            .map_err(map_error)?;
        Ok(ok_status(id))
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        self.filesystem
            .create_dir(&self.container_id, &path, false)
            .await
            .map_err(map_error)?;
        Ok(ok_status(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        self.filesystem
            .remove_dir(&self.container_id, &path)
            .await
            .map_err(map_error)?;
        Ok(ok_status(id))
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        self.filesystem
            .rename(&self.container_id, &oldpath, &newpath)
            .await
            .map_err(map_error)?;
        Ok(ok_status(id))
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        Ok(Name {
            id,
            files: vec![File::dummy(virtual_realpath(&path))],
        })
    }
}

fn ok_status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".to_string(),
        language_tag: "en-US".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn virtual_realpath_collapses_dot_and_dotdot() {
        assert_eq!(virtual_realpath("."), "/");
        assert_eq!(virtual_realpath("a/./b"), "/a/b");
        assert_eq!(virtual_realpath("a/b/../c"), "/a/c");
    }

    #[test]
    fn virtual_realpath_cannot_escape_above_root() {
        assert_eq!(virtual_realpath("../../etc/passwd"), "/etc/passwd");
        assert_eq!(virtual_realpath(".."), "/");
    }

    #[test]
    fn open_flags_map_matches_sftp_semantics() {
        let ro = to_open_options(OpenFlags::READ);
        assert!(ro.read && !ro.write && !ro.create);

        let create_excl =
            to_open_options(OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE);
        assert!(create_excl.create_new && !create_excl.create);

        let append = to_open_options(OpenFlags::WRITE | OpenFlags::APPEND);
        assert!(append.write && append.append && !append.truncate);
    }

    use russh_sftp::server::Handler as SftpHandler;
    use std::os::unix::fs::symlink;

    async fn session_over_tempdir() -> (tempfile::TempDir, SftpSession) {
        let tmp = tempfile::tempdir().unwrap();
        let layout = crate::layout::GuestLayout::with_base(tmp.path());
        let root = layout.shared().container("c1").rootfs_dir();
        std::fs::create_dir_all(&root).unwrap();
        let fs = Arc::new(GuestFilesystem::new(layout));
        (tmp, SftpSession::new(fs, "c1".to_string()))
    }

    #[tokio::test]
    async fn init_returns_version() {
        let (_tmp, mut sftp) = session_over_tempdir().await;
        sftp.init(3, HashMap::new()).await.unwrap();
    }

    #[tokio::test]
    async fn open_write_read_close_round_trip() {
        let (_tmp, mut sftp) = session_over_tempdir().await;

        let handle = sftp
            .open(
                1,
                "file.txt".to_string(),
                OpenFlags::WRITE | OpenFlags::CREATE,
                FileAttributes::default(),
            )
            .await
            .unwrap();
        sftp.write(2, handle.handle.clone(), 0, b"hello sftp".to_vec())
            .await
            .unwrap();
        sftp.close(3, handle.handle.clone()).await.unwrap();

        let handle = sftp
            .open(
                4,
                "file.txt".to_string(),
                OpenFlags::READ,
                FileAttributes::default(),
            )
            .await
            .unwrap();
        let data = sftp.read(5, handle.handle.clone(), 0, 100).await.unwrap();
        assert_eq!(data.data, b"hello sftp");
        sftp.close(6, handle.handle).await.unwrap();
    }

    #[tokio::test]
    async fn read_at_eof_returns_eof_status() {
        let (_tmp, mut sftp) = session_over_tempdir().await;
        let handle = sftp
            .open(
                1,
                "empty.txt".to_string(),
                OpenFlags::WRITE | OpenFlags::CREATE,
                FileAttributes::default(),
            )
            .await
            .unwrap();
        sftp.close(2, handle.handle.clone()).await.unwrap();

        let handle = sftp
            .open(
                3,
                "empty.txt".to_string(),
                OpenFlags::READ,
                FileAttributes::default(),
            )
            .await
            .unwrap();
        let err = sftp.read(4, handle.handle, 0, 10).await.unwrap_err();
        assert_eq!(err, StatusCode::Eof);
    }

    #[tokio::test]
    async fn mkdir_opendir_readdir_then_eof() {
        let (_tmp, mut sftp) = session_over_tempdir().await;
        sftp.mkdir(1, "dir".to_string(), FileAttributes::default())
            .await
            .unwrap();

        let handle = sftp
            .open(
                2,
                "dir/a.txt".to_string(),
                OpenFlags::WRITE | OpenFlags::CREATE,
                FileAttributes::default(),
            )
            .await
            .unwrap();
        sftp.close(3, handle.handle).await.unwrap();

        let dir_handle = sftp.opendir(4, "dir".to_string()).await.unwrap();
        let name = sftp.readdir(5, dir_handle.handle.clone()).await.unwrap();
        assert_eq!(name.files.len(), 1);
        assert_eq!(name.files[0].filename, "a.txt");

        let err = sftp
            .readdir(6, dir_handle.handle.clone())
            .await
            .unwrap_err();
        assert_eq!(err, StatusCode::Eof);
        sftp.close(7, dir_handle.handle).await.unwrap();
    }

    #[tokio::test]
    async fn readdir_paginates_a_large_directory() {
        // A directory bigger than one batch must come back over several
        // responses. Answering it in a single Name packet overruns the packet
        // size clients accept, so a large directory becomes unlistable.
        let (_tmp, mut sftp) = session_over_tempdir().await;
        sftp.mkdir(1, "big".to_string(), FileAttributes::default())
            .await
            .unwrap();

        let total = MAX_READDIR_ENTRIES_PER_RESPONSE * 2 + 7;
        for i in 0..total {
            let handle = sftp
                .open(
                    2,
                    format!("big/f{i}.txt"),
                    OpenFlags::WRITE | OpenFlags::CREATE,
                    FileAttributes::default(),
                )
                .await
                .unwrap();
            sftp.close(3, handle.handle).await.unwrap();
        }

        let dir = sftp.opendir(4, "big".to_string()).await.unwrap();
        let mut batches = Vec::new();
        loop {
            match sftp.readdir(5, dir.handle.clone()).await {
                Ok(name) => batches.push(name.files),
                Err(StatusCode::Eof) => break,
                Err(other) => panic!("unexpected readdir error: {other:?}"),
            }
        }

        assert!(
            batches
                .iter()
                .all(|b| b.len() <= MAX_READDIR_ENTRIES_PER_RESPONSE),
            "a response exceeded the batch size: {:?}",
            batches.iter().map(Vec::len).collect::<Vec<_>>()
        );
        // Pagination must not lose or repeat entries.
        let seen: std::collections::HashSet<_> = batches
            .iter()
            .flatten()
            .map(|f| f.filename.clone())
            .collect();
        assert_eq!(seen.len(), total);
        assert_eq!(batches.iter().map(Vec::len).sum::<usize>(), total);
    }

    #[tokio::test]
    async fn remove_and_rename() {
        let (_tmp, mut sftp) = session_over_tempdir().await;
        let handle = sftp
            .open(
                1,
                "a.txt".to_string(),
                OpenFlags::WRITE | OpenFlags::CREATE,
                FileAttributes::default(),
            )
            .await
            .unwrap();
        sftp.close(2, handle.handle).await.unwrap();

        sftp.rename(3, "a.txt".to_string(), "b.txt".to_string())
            .await
            .unwrap();
        let err = sftp.stat(4, "a.txt".to_string()).await.unwrap_err();
        assert_eq!(err, StatusCode::NoSuchFile);
        sftp.stat(5, "b.txt".to_string()).await.unwrap();

        sftp.remove(6, "b.txt".to_string()).await.unwrap();
        let err = sftp.stat(7, "b.txt".to_string()).await.unwrap_err();
        assert_eq!(err, StatusCode::NoSuchFile);
    }

    #[tokio::test]
    async fn stat_and_lstat_report_size_and_type() {
        let (_tmp, mut sftp) = session_over_tempdir().await;
        let handle = sftp
            .open(
                1,
                "f.txt".to_string(),
                OpenFlags::WRITE | OpenFlags::CREATE,
                FileAttributes::default(),
            )
            .await
            .unwrap();
        sftp.write(2, handle.handle.clone(), 0, b"1234".to_vec())
            .await
            .unwrap();
        sftp.close(3, handle.handle).await.unwrap();

        let attrs = sftp.stat(4, "f.txt".to_string()).await.unwrap();
        assert_eq!(attrs.attrs.size, Some(4));
        assert!(!attrs.attrs.is_dir());
    }

    #[tokio::test]
    async fn path_traversal_is_rejected() {
        let (_tmp, mut sftp) = session_over_tempdir().await;
        let err = sftp
            .stat(1, "../../etc/passwd".to_string())
            .await
            .unwrap_err();
        assert_eq!(err, StatusCode::Failure);
    }

    #[tokio::test]
    async fn symlink_escape_does_not_leak_host_file() {
        let (tmp, mut sftp) = session_over_tempdir().await;
        let layout = crate::layout::GuestLayout::with_base(tmp.path());
        let root = layout.shared().container("c1").rootfs_dir();
        let secret = tmp.path().join("host-secret");
        std::fs::write(&secret, b"top secret").unwrap();
        symlink(&secret, root.join("escape")).unwrap();

        let err = sftp.stat(1, "escape".to_string()).await.unwrap_err();
        assert_eq!(
            err,
            StatusCode::NoSuchFile,
            "must not resolve to the real host file"
        );
    }

    #[tokio::test]
    async fn unsupported_extension_is_rejected() {
        let (_tmp, mut sftp) = session_over_tempdir().await;
        let err = sftp
            .extended(1, "statvfs@openssh.com".to_string(), vec![])
            .await
            .unwrap_err();
        assert_eq!(err, StatusCode::OpUnsupported);
    }

    #[tokio::test]
    async fn symlink_request_is_rejected() {
        let (_tmp, mut sftp) = session_over_tempdir().await;
        let err = sftp
            .symlink(1, "link".to_string(), "target".to_string())
            .await
            .unwrap_err();
        assert_eq!(err, StatusCode::OpUnsupported);
    }

    #[tokio::test]
    async fn realpath_never_returns_host_path() {
        let (_tmp, mut sftp) = session_over_tempdir().await;
        let name = sftp.realpath(1, "a/../b/./c".to_string()).await.unwrap();
        assert_eq!(name.files[0].filename, "/b/c");
        assert!(!name.files[0].filename.contains("tmp"));
    }

    #[tokio::test]
    async fn handles_are_released_when_session_drops() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = crate::layout::GuestLayout::with_base(tmp.path());
        std::fs::create_dir_all(layout.shared().container("c1").rootfs_dir()).unwrap();
        let filesystem = Arc::new(GuestFilesystem::new(layout));

        let owner = {
            let mut sftp = SftpSession::new(filesystem.clone(), "c1".to_string());
            sftp.open(
                1,
                "f.txt".to_string(),
                OpenFlags::WRITE | OpenFlags::CREATE,
                FileAttributes::default(),
            )
            .await
            .unwrap();
            let owner = sftp.owner;
            assert_eq!(filesystem.open_handle_count_for_owner(owner).await, 1);
            drop(sftp);
            owner
        };

        // `Drop` spawns the cleanup task -- give it a moment to run.
        for _ in 0..50 {
            if filesystem.open_handle_count_for_owner(owner).await == 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(filesystem.open_handle_count_for_owner(owner).await, 0);
    }
}
