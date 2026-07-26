//! `GuestFilesystem`: shared, bounded file-access backend for the guest.
//!
//! Owns the *only* path that is allowed to touch a container's rootfs from
//! guest-side host services: container-root resolution, symlink-escape-safe
//! path resolution, metadata, directory operations, and offset-based
//! read/write with handle lifecycle. Both the tar `Upload`/`Download` RPCs
//! (`super::Files`) and the SSH SFTP adapter delegate here so the two
//! surfaces can never drift into two different path/symlink/permission
//! policies.

use crate::layout::GuestLayout;
use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::SystemTime;
use tokio::sync::Mutex;

/// Symlink hops allowed while resolving a single request path. Bounds
/// otherwise-unbounded work on a symlink cycle crafted by a container image.
const MAX_SYMLINK_HOPS: usize = 40;

/// Cap on bytes moved by a single `read_at`/`write_at` call. Callers loop for
/// larger transfers; this keeps one SFTP request from buffering unbounded
/// guest memory.
pub(crate) const MAX_RW_CHUNK_BYTES: usize = 1 << 20; // 1 MiB

/// Cap on concurrently open handles per SFTP/session owner, so a client can't
/// exhaust guest file descriptors by opening handles and never closing them.
const MAX_OPEN_HANDLES_PER_OWNER: usize = 256;

/// Opaque handle returned by [`GuestFilesystem::open`]; passed back into
/// `read_at`/`write_at`/`close`.
pub(crate) type FileHandleId = u64;

/// Caller-assigned identity used only to scope handle limits and bulk-close
/// on disconnect (e.g. one id per SSH channel). Not a security boundary by
/// itself -- callers must already have authorized the underlying operation.
pub(crate) type FsOwnerId = u64;

#[derive(Debug)]
pub(crate) enum GuestFsError {
    /// Request path escapes the container root, contains `..`, or a
    /// symlink chain resolves outside the root / exceeds the hop limit.
    InvalidPath,
    NotFound,
    PermissionDenied,
    AlreadyExists,
    IsADirectory,
    NotADirectory,
    DirectoryNotEmpty,
    HandleLimitExceeded,
    UnknownHandle,
    /// Requested transfer size exceeds [`MAX_RW_CHUNK_BYTES`].
    TooLarge,
    Io(std::io::Error),
}

impl std::fmt::Display for GuestFsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GuestFsError::InvalidPath => write!(f, "invalid or unsafe path"),
            GuestFsError::NotFound => write!(f, "not found"),
            GuestFsError::PermissionDenied => write!(f, "permission denied"),
            GuestFsError::AlreadyExists => write!(f, "already exists"),
            GuestFsError::IsADirectory => write!(f, "is a directory"),
            GuestFsError::NotADirectory => write!(f, "not a directory"),
            GuestFsError::DirectoryNotEmpty => write!(f, "directory not empty"),
            GuestFsError::HandleLimitExceeded => write!(f, "too many open handles"),
            GuestFsError::UnknownHandle => write!(f, "unknown file handle"),
            GuestFsError::TooLarge => write!(f, "transfer too large"),
            GuestFsError::Io(e) => write!(f, "io error: {e}"),
        }
    }
}

impl std::error::Error for GuestFsError {}

impl From<std::io::Error> for GuestFsError {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => GuestFsError::NotFound,
            std::io::ErrorKind::PermissionDenied => GuestFsError::PermissionDenied,
            std::io::ErrorKind::AlreadyExists => GuestFsError::AlreadyExists,
            _ => GuestFsError::Io(e),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Metadata {
    pub len: u64,
    /// POSIX `st_mode` (type bits included, e.g. `S_IFLNK` for a symlink
    /// when this came from `symlink_metadata`/`lstat`).
    pub mode: u32,
    pub modified: Option<SystemTime>,
}

impl Metadata {
    fn from_std(meta: std::fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        Self {
            len: meta.len(),
            mode: meta.mode(),
            modified: meta.modified().ok(),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct DirEntry {
    pub name: String,
    pub metadata: Metadata,
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct FsOpenOptions {
    pub read: bool,
    pub write: bool,
    pub create: bool,
    /// Exclusive create; fails if the target already exists (SFTP `SSH_FXF_EXCL`).
    pub create_new: bool,
    pub truncate: bool,
    pub append: bool,
}

struct OpenFile {
    file: Arc<std::fs::File>,
    owner: FsOwnerId,
}

#[derive(Default)]
struct HandleTable {
    open: HashMap<FileHandleId, OpenFile>,
    by_owner: HashMap<FsOwnerId, HashSet<FileHandleId>>,
}

/// Shared, bounded file-access backend rooted at each container's rootfs.
pub(crate) struct GuestFilesystem {
    layout: GuestLayout,
    handles: Mutex<HandleTable>,
    handle_seq: AtomicU64,
}

impl GuestFilesystem {
    pub(crate) fn new(layout: GuestLayout) -> Self {
        Self {
            layout,
            handles: Mutex::new(HandleTable::default()),
            handle_seq: AtomicU64::new(1),
        }
    }

    /// Rootfs directory backing `container_id`. Callers that already resolved
    /// the container id (e.g. via [`super::resolve_container_id`]) pass it in
    /// here directly.
    pub(crate) fn container_rootfs(&self, container_id: &str) -> PathBuf {
        self.layout.shared().container(container_id).rootfs_dir()
    }

    /// Resolve a caller-supplied path to an absolute host path confined to
    /// `container_id`'s rootfs, rejecting `..` in the request and any
    /// symlink (direct or via a chain) that would resolve outside the root.
    ///
    /// This is the single security boundary shared by tar `Upload`/`Download`
    /// and the SFTP adapter -- callers must never open paths any other way.
    pub(crate) fn resolve_path(
        &self,
        container_id: &str,
        path: &str,
    ) -> Result<PathBuf, GuestFsError> {
        secure_resolve(&self.container_rootfs(container_id), path)
    }

    pub(crate) async fn metadata(
        &self,
        container_id: &str,
        path: &str,
        follow_symlinks: bool,
    ) -> Result<Metadata, GuestFsError> {
        let resolved = self.resolve_path(container_id, path)?;
        blocking(move || {
            let meta = if follow_symlinks {
                std::fs::metadata(&resolved)
            } else {
                std::fs::symlink_metadata(&resolved)
            }?;
            Ok(Metadata::from_std(meta))
        })
        .await
    }

    pub(crate) async fn read_dir(
        &self,
        container_id: &str,
        path: &str,
    ) -> Result<Vec<DirEntry>, GuestFsError> {
        let resolved = self.resolve_path(container_id, path)?;
        blocking(move || {
            let mut out = Vec::new();
            for entry in std::fs::read_dir(&resolved)? {
                let entry = entry?;
                let meta = entry.metadata()?;
                out.push(DirEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    metadata: Metadata::from_std(meta),
                });
            }
            Ok(out)
        })
        .await
    }

    pub(crate) async fn create_dir(
        &self,
        container_id: &str,
        path: &str,
        parents: bool,
    ) -> Result<(), GuestFsError> {
        let resolved = self.resolve_path(container_id, path)?;
        blocking(move || {
            if parents {
                std::fs::create_dir_all(&resolved)?;
            } else {
                std::fs::create_dir(&resolved)?;
            }
            Ok(())
        })
        .await
    }

    pub(crate) async fn remove_file(
        &self,
        container_id: &str,
        path: &str,
    ) -> Result<(), GuestFsError> {
        let resolved = self.resolve_path(container_id, path)?;
        blocking(move || {
            let meta = std::fs::symlink_metadata(&resolved)?;
            if meta.is_dir() {
                return Err(GuestFsError::IsADirectory);
            }
            std::fs::remove_file(&resolved)?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn remove_dir(
        &self,
        container_id: &str,
        path: &str,
    ) -> Result<(), GuestFsError> {
        let resolved = self.resolve_path(container_id, path)?;
        blocking(move || {
            let meta = std::fs::symlink_metadata(&resolved)?;
            if !meta.is_dir() {
                return Err(GuestFsError::NotADirectory);
            }
            std::fs::remove_dir(&resolved).map_err(|e| {
                if e.raw_os_error() == Some(libc_enotempty()) {
                    GuestFsError::DirectoryNotEmpty
                } else {
                    GuestFsError::from(e)
                }
            })?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn rename(
        &self,
        container_id: &str,
        from: &str,
        to: &str,
    ) -> Result<(), GuestFsError> {
        let from_resolved = self.resolve_path(container_id, from)?;
        let to_resolved = self.resolve_path(container_id, to)?;
        blocking(move || {
            std::fs::rename(&from_resolved, &to_resolved)?;
            Ok(())
        })
        .await
    }

    /// Open a file handle scoped to `owner`, enforcing the per-owner handle
    /// limit. Returns an opaque id for use with `read_at`/`write_at`/`close`.
    pub(crate) async fn open(
        &self,
        owner: FsOwnerId,
        container_id: &str,
        path: &str,
        opts: FsOpenOptions,
    ) -> Result<FileHandleId, GuestFsError> {
        let resolved = self.resolve_path(container_id, path)?;

        // Fast path only: skips the open syscall for a caller already at the
        // cap. The enforcing check is the one below, taken under the same lock
        // that inserts -- the lock is released across the blocking open, so a
        // check here alone would let concurrent opens for one owner both pass.
        if self.owner_handle_count(owner).await >= MAX_OPEN_HANDLES_PER_OWNER {
            return Err(GuestFsError::HandleLimitExceeded);
        }

        let file = blocking(move || {
            let mut std_opts = std::fs::OpenOptions::new();
            std_opts
                .read(opts.read)
                .write(opts.write || opts.append)
                .append(opts.append)
                .truncate(opts.truncate && !opts.append)
                .create(opts.create && !opts.create_new)
                .create_new(opts.create_new);
            let f = std_opts.open(&resolved)?;
            Ok(f)
        })
        .await?;

        let id = self.handle_seq.fetch_add(1, Ordering::Relaxed);
        let mut table = self.handles.lock().await;
        if table.by_owner.get(&owner).map_or(0, |s| s.len()) >= MAX_OPEN_HANDLES_PER_OWNER {
            // `file` drops here, closing the descriptor this call opened.
            return Err(GuestFsError::HandleLimitExceeded);
        }
        table.by_owner.entry(owner).or_default().insert(id);
        table.open.insert(
            id,
            OpenFile {
                file: Arc::new(file),
                owner,
            },
        );
        Ok(id)
    }

    async fn owner_handle_count(&self, owner: FsOwnerId) -> usize {
        let table = self.handles.lock().await;
        table.by_owner.get(&owner).map(|s| s.len()).unwrap_or(0)
    }

    fn handle_file(
        &self,
        table: &HandleTable,
        handle: FileHandleId,
    ) -> Result<Arc<std::fs::File>, GuestFsError> {
        table
            .open
            .get(&handle)
            .map(|f| f.file.clone())
            .ok_or(GuestFsError::UnknownHandle)
    }

    pub(crate) async fn read_at(
        &self,
        handle: FileHandleId,
        offset: u64,
        len: usize,
    ) -> Result<Vec<u8>, GuestFsError> {
        if len > MAX_RW_CHUNK_BYTES {
            return Err(GuestFsError::TooLarge);
        }
        let file = {
            let table = self.handles.lock().await;
            self.handle_file(&table, handle)?
        };
        blocking(move || {
            let mut buf = vec![0u8; len];
            let n = file.read_at(&mut buf, offset)?;
            buf.truncate(n);
            Ok(buf)
        })
        .await
    }

    pub(crate) async fn write_at(
        &self,
        handle: FileHandleId,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<usize, GuestFsError> {
        if data.len() > MAX_RW_CHUNK_BYTES {
            return Err(GuestFsError::TooLarge);
        }
        let file = {
            let table = self.handles.lock().await;
            self.handle_file(&table, handle)?
        };
        blocking(move || {
            file.write_at(&data, offset)?;
            Ok(data.len())
        })
        .await
    }

    pub(crate) async fn close(&self, handle: FileHandleId) -> Result<(), GuestFsError> {
        let mut table = self.handles.lock().await;
        let entry = table
            .open
            .remove(&handle)
            .ok_or(GuestFsError::UnknownHandle)?;
        if let Some(set) = table.by_owner.get_mut(&entry.owner) {
            set.remove(&handle);
            if set.is_empty() {
                table.by_owner.remove(&entry.owner);
            }
        }
        Ok(())
    }

    /// Close every handle still open for `owner`. Called on SSH
    /// channel/connection close, disconnect, timeout, or guest shutdown so
    /// no handle outlives its owning session.
    pub(crate) async fn close_all_for_owner(&self, owner: FsOwnerId) {
        let mut table = self.handles.lock().await;
        if let Some(ids) = table.by_owner.remove(&owner) {
            for id in ids {
                table.open.remove(&id);
            }
        }
    }

    #[cfg(test)]
    pub(crate) async fn open_handle_count_for_owner(&self, owner: FsOwnerId) -> usize {
        self.owner_handle_count(owner).await
    }
}

fn libc_enotempty() -> i32 {
    // ENOTEMPTY is 39 on Linux (the only target this crate builds for).
    39
}

async fn blocking<T, F>(f: F) -> Result<T, GuestFsError>
where
    F: FnOnce() -> Result<T, GuestFsError> + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(inner) => inner,
        Err(_join_err) => Err(GuestFsError::Io(std::io::Error::other(
            "blocking filesystem task panicked",
        ))),
    }
}

/// Resolve `requested` to an absolute path confined to `root_dir`,
/// rejecting `..` in the caller-supplied path outright and following
/// symlinks component-by-component so a chain can never resolve outside
/// `root_dir` -- an absolute symlink target is re-anchored at `root_dir`
/// rather than the host's real root.
fn secure_resolve(root_dir: &Path, requested: &str) -> Result<PathBuf, GuestFsError> {
    let requested_path = Path::new(requested);
    if requested_path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(GuestFsError::InvalidPath);
    }

    let root = root_dir.canonicalize()?;

    let mut pending: VecDeque<OsString> = requested_path
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(part) => Some(part.to_os_string()),
            _ => None,
        })
        .collect();

    let mut current = root.clone();
    let mut hops = 0usize;

    while let Some(part) = pending.pop_front() {
        if part == ".." {
            // Only ever produced by symlink-target expansion below (the
            // original request already rejected `..`); walking above the
            // container root is always an escape attempt.
            if current == root {
                return Err(GuestFsError::InvalidPath);
            }
            current.pop();
            continue;
        }

        let candidate = current.join(&part);
        match std::fs::symlink_metadata(&candidate) {
            Ok(meta) if meta.file_type().is_symlink() => {
                hops += 1;
                if hops > MAX_SYMLINK_HOPS {
                    return Err(GuestFsError::InvalidPath);
                }
                let target = std::fs::read_link(&candidate)?;
                if target.is_absolute() {
                    // Re-anchor at the container root: an absolute symlink
                    // target must never resolve against the host's real "/".
                    current = root.clone();
                }
                let mut expanded: VecDeque<OsString> = target
                    .components()
                    .filter_map(|c| match c {
                        std::path::Component::Normal(p) => Some(p.to_os_string()),
                        std::path::Component::ParentDir => Some(OsString::from("..")),
                        _ => None,
                    })
                    .collect();
                expanded.extend(pending.drain(..));
                pending = expanded;
            }
            _ => {
                // Either a plain entry, or nothing exists there yet (fine
                // for a create/mkdir/write target -- nothing left to expand).
                current = candidate;
            }
        }

        if !current.starts_with(&root) {
            return Err(GuestFsError::InvalidPath);
        }
    }

    Ok(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn layout_for(root: &Path) -> GuestLayout {
        GuestLayout::with_base(root)
    }

    fn container_root(layout: &GuestLayout, container_id: &str) -> PathBuf {
        let dir = layout.shared().container(container_id).rootfs_dir();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn resolves_plain_nested_path() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = layout_for(tmp.path());
        let root = container_root(&layout, "c1");
        std::fs::create_dir_all(root.join("a/b")).unwrap();

        let fs = GuestFilesystem::new(layout);
        let resolved = fs.resolve_path("c1", "a/b").unwrap();
        assert_eq!(resolved, root.canonicalize().unwrap().join("a/b"));
    }

    #[tokio::test]
    async fn rejects_dot_dot_in_request() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = layout_for(tmp.path());
        container_root(&layout, "c1");

        let fs = GuestFilesystem::new(layout);
        let err = fs.resolve_path("c1", "../etc/passwd").unwrap_err();
        assert!(matches!(err, GuestFsError::InvalidPath));
    }

    #[tokio::test]
    async fn rejects_symlink_escaping_root() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = layout_for(tmp.path());
        let root = container_root(&layout, "c1");
        let outside = tmp.path().join("outside-secret");
        std::fs::write(&outside, b"secret").unwrap();
        // `outside` is an absolute host path, so this is effectively an
        // absolute-symlink escape attempt: the resolved path must stay
        // confined under the container root (re-anchored, not the real
        // host file) and must never expose the secret's contents.
        symlink(&outside, root.join("escape")).unwrap();

        let fs = GuestFilesystem::new(layout);
        let root_canonical = root.canonicalize().unwrap();
        let resolved = fs.resolve_path("c1", "escape").unwrap();
        assert!(
            resolved.starts_with(&root_canonical),
            "resolved path escaped the root: {resolved:?}"
        );
        assert_ne!(resolved, outside.canonicalize().unwrap_or(outside));
        let err = fs.metadata("c1", "escape", true).await.unwrap_err();
        assert!(matches!(err, GuestFsError::NotFound));
    }

    #[tokio::test]
    async fn rejects_absolute_symlink_pointing_at_host_root() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = layout_for(tmp.path());
        let root = container_root(&layout, "c1");
        // Absolute symlink target must re-anchor at the container root, not
        // the host's real "/etc/passwd" -- and since the container root has
        // no such file, resolving it must not surface the host's file.
        symlink("/etc/passwd", root.join("link")).unwrap();

        let fs = GuestFilesystem::new(layout);
        let root_canonical = root.canonicalize().unwrap();
        let resolved = fs.resolve_path("c1", "link").unwrap();
        assert!(
            resolved.starts_with(&root_canonical),
            "resolved path escaped the root: {resolved:?}"
        );
        assert_ne!(resolved, PathBuf::from("/etc/passwd"));
        let err = fs.metadata("c1", "link", true).await.unwrap_err();
        assert!(matches!(err, GuestFsError::NotFound));
    }

    #[tokio::test]
    async fn allows_relative_symlink_that_stays_inside_root() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = layout_for(tmp.path());
        let root = container_root(&layout, "c1");
        std::fs::create_dir_all(root.join("lib")).unwrap();
        std::fs::create_dir_all(root.join("usr")).unwrap();
        std::fs::write(root.join("lib/libfoo.so.1"), b"lib").unwrap();
        // From usr/bin-link, "../lib/libfoo.so.1" resolves to root/lib/libfoo.so.1.
        symlink("../lib/libfoo.so.1", root.join("usr/bin-link")).unwrap();

        let fs = GuestFilesystem::new(layout);
        let resolved = fs.resolve_path("c1", "usr/bin-link").unwrap();
        assert_eq!(std::fs::read(resolved).unwrap(), b"lib");
    }

    #[tokio::test]
    async fn rejects_symlink_chain_escaping_via_dotdot() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = layout_for(tmp.path());
        let root = container_root(&layout, "c1");
        // A symlink one level deep whose relative target walks past the root.
        std::fs::create_dir_all(root.join("a")).unwrap();
        symlink("../../outside-secret", root.join("a/escape")).unwrap();
        std::fs::write(tmp.path().join("outside-secret"), b"secret").unwrap();

        let fs = GuestFilesystem::new(layout);
        let err = fs.resolve_path("c1", "a/escape").unwrap_err();
        assert!(matches!(err, GuestFsError::InvalidPath));
    }

    #[tokio::test]
    async fn detects_symlink_loop() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = layout_for(tmp.path());
        let root = container_root(&layout, "c1");
        symlink("loop-b", root.join("loop-a")).unwrap();
        symlink("loop-a", root.join("loop-b")).unwrap();

        let fs = GuestFilesystem::new(layout);
        let err = fs.resolve_path("c1", "loop-a").unwrap_err();
        assert!(matches!(err, GuestFsError::InvalidPath));
    }

    #[tokio::test]
    async fn open_read_write_close_round_trip_with_offsets() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = layout_for(tmp.path());
        container_root(&layout, "c1");

        let fs = GuestFilesystem::new(layout);
        let handle = fs
            .open(
                1,
                "c1",
                "file.txt",
                FsOpenOptions {
                    read: true,
                    write: true,
                    create: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        fs.write_at(handle, 0, b"hello ".to_vec()).await.unwrap();
        fs.write_at(handle, 6, b"world".to_vec()).await.unwrap();
        let data = fs.read_at(handle, 0, 11).await.unwrap();
        assert_eq!(data, b"hello world");

        // Offset read starting mid-file.
        let tail = fs.read_at(handle, 6, 5).await.unwrap();
        assert_eq!(tail, b"world");

        fs.close(handle).await.unwrap();
        assert!(matches!(
            fs.read_at(handle, 0, 1).await.unwrap_err(),
            GuestFsError::UnknownHandle
        ));
    }

    #[tokio::test]
    async fn create_new_fails_when_file_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = layout_for(tmp.path());
        let root = container_root(&layout, "c1");
        std::fs::write(root.join("exists.txt"), b"x").unwrap();

        let fs = GuestFilesystem::new(layout);
        let err = fs
            .open(
                1,
                "c1",
                "exists.txt",
                FsOpenOptions {
                    write: true,
                    create_new: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, GuestFsError::AlreadyExists));
    }

    #[tokio::test]
    async fn per_owner_handle_limit_is_enforced() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = layout_for(tmp.path());
        container_root(&layout, "c1");
        let fs = GuestFilesystem::new(layout);

        for i in 0..MAX_OPEN_HANDLES_PER_OWNER {
            fs.open(
                7,
                "c1",
                &format!("f{i}.txt"),
                FsOpenOptions {
                    write: true,
                    create: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }

        let err = fs
            .open(
                7,
                "c1",
                "one-too-many.txt",
                FsOpenOptions {
                    write: true,
                    create: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, GuestFsError::HandleLimitExceeded));
    }

    #[tokio::test]
    async fn concurrent_opens_never_exceed_the_per_owner_handle_limit() {
        // The handles lock is released across the blocking open(), so a cap
        // checked before that await and applied after it is not a cap at all:
        // every concurrent caller passes a check none of them has yet
        // invalidated, and one owner walks past its FD budget.
        let tmp = tempfile::tempdir().unwrap();
        let layout = layout_for(tmp.path());
        container_root(&layout, "c1");
        let fs = Arc::new(GuestFilesystem::new(layout));

        let attempts = MAX_OPEN_HANDLES_PER_OWNER + 64;
        let mut opens = Vec::with_capacity(attempts);
        for i in 0..attempts {
            let fs = fs.clone();
            opens.push(tokio::spawn(async move {
                fs.open(
                    9,
                    "c1",
                    &format!("f{i}.txt"),
                    FsOpenOptions {
                        write: true,
                        create: true,
                        ..Default::default()
                    },
                )
                .await
                .is_ok()
            }));
        }

        let mut granted = 0;
        for open in opens {
            if open.await.unwrap() {
                granted += 1;
            }
        }

        assert_eq!(granted, MAX_OPEN_HANDLES_PER_OWNER);
        assert_eq!(
            fs.open_handle_count_for_owner(9).await,
            MAX_OPEN_HANDLES_PER_OWNER
        );
    }

    #[tokio::test]
    async fn close_all_for_owner_releases_every_handle() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = layout_for(tmp.path());
        container_root(&layout, "c1");
        let fs = GuestFilesystem::new(layout);

        let h1 = fs
            .open(
                3,
                "c1",
                "a.txt",
                FsOpenOptions {
                    write: true,
                    create: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let h2 = fs
            .open(
                3,
                "c1",
                "b.txt",
                FsOpenOptions {
                    write: true,
                    create: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(fs.open_handle_count_for_owner(3).await, 2);

        fs.close_all_for_owner(3).await;
        assert_eq!(fs.open_handle_count_for_owner(3).await, 0);
        assert!(matches!(
            fs.read_at(h1, 0, 1).await.unwrap_err(),
            GuestFsError::UnknownHandle
        ));
        assert!(matches!(
            fs.read_at(h2, 0, 1).await.unwrap_err(),
            GuestFsError::UnknownHandle
        ));
    }

    #[tokio::test]
    async fn read_dir_and_metadata_report_kind_and_size() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = layout_for(tmp.path());
        let root = container_root(&layout, "c1");
        std::fs::write(root.join("f.txt"), b"1234").unwrap();
        std::fs::create_dir(root.join("sub")).unwrap();

        let fs = GuestFilesystem::new(layout);
        let entries = fs.read_dir("c1", ".").await.unwrap();
        let mut names: Vec<_> = entries.iter().map(|e| e.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["f.txt", "sub"]);

        // Assert on `mode`'s type bits: that is the single source of file-type
        // truth this backend reports, and what SFTP `stat`/`lstat` answer from.
        let meta = fs.metadata("c1", "f.txt", true).await.unwrap();
        assert_eq!(meta.mode & nix::libc::S_IFMT, nix::libc::S_IFREG);
        assert_eq!(meta.len, 4);

        let dir_meta = fs.metadata("c1", "sub", true).await.unwrap();
        assert_eq!(dir_meta.mode & nix::libc::S_IFMT, nix::libc::S_IFDIR);
    }

    #[tokio::test]
    async fn mkdir_remove_rename_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = layout_for(tmp.path());
        container_root(&layout, "c1");
        let fs = GuestFilesystem::new(layout);

        fs.create_dir("c1", "a/b/c", true).await.unwrap();
        fs.metadata("c1", "a/b/c", true).await.unwrap();

        fs.rename("c1", "a/b/c", "a/b/renamed").await.unwrap();
        let err = fs.metadata("c1", "a/b/c", true).await.unwrap_err();
        assert!(matches!(err, GuestFsError::NotFound));
        fs.metadata("c1", "a/b/renamed", true).await.unwrap();

        fs.remove_dir("c1", "a/b/renamed").await.unwrap();
        let err = fs.metadata("c1", "a/b/renamed", true).await.unwrap_err();
        assert!(matches!(err, GuestFsError::NotFound));
    }

    #[tokio::test]
    async fn remove_file_rejects_directory_target() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = layout_for(tmp.path());
        let root = container_root(&layout, "c1");
        std::fs::create_dir(root.join("dir")).unwrap();

        let fs = GuestFilesystem::new(layout);
        let err = fs.remove_file("c1", "dir").await.unwrap_err();
        assert!(matches!(err, GuestFsError::IsADirectory));
    }

    #[tokio::test]
    async fn remove_dir_rejects_non_empty_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = layout_for(tmp.path());
        let root = container_root(&layout, "c1");
        std::fs::create_dir(root.join("dir")).unwrap();
        std::fs::write(root.join("dir/f.txt"), b"x").unwrap();

        let fs = GuestFilesystem::new(layout);
        let err = fs.remove_dir("c1", "dir").await.unwrap_err();
        assert!(matches!(err, GuestFsError::DirectoryNotEmpty));
    }

    #[tokio::test]
    async fn read_write_chunk_over_limit_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = layout_for(tmp.path());
        container_root(&layout, "c1");
        let fs = GuestFilesystem::new(layout);

        let handle = fs
            .open(
                1,
                "c1",
                "big.txt",
                FsOpenOptions {
                    write: true,
                    create: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        let err = fs
            .write_at(handle, 0, vec![0u8; MAX_RW_CHUNK_BYTES + 1])
            .await
            .unwrap_err();
        assert!(matches!(err, GuestFsError::TooLarge));

        let err = fs
            .read_at(handle, 0, MAX_RW_CHUNK_BYTES + 1)
            .await
            .unwrap_err();
        assert!(matches!(err, GuestFsError::TooLarge));
    }
}
