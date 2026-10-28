//! Caller-owned storage retention and explicit local resource bindings.
use super::pair::{CheckpointDependencies, ObjectReference, ShareDependency, invalid};
use async_trait::async_trait;
use boxlite_shared::errors::BoxliteResult;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

#[derive(Debug)]
pub struct CheckpointExportRequest {
    pub shares: Vec<ShareDependency>,
    /// Duplicated source objects in share/object order, including recipe objects.
    pub objects: Vec<File>,
}

#[expect(
    clippy::double_must_use,
    reason = "async_trait adds must_use to future-returning methods"
)]
#[async_trait]
pub trait CheckpointExportProvider: Send + Sync {
    /// Retain external objects for the caller-defined checkpoint lifetime,
    /// including after source destruction. Return external references only.
    async fn prepare(
        &self,
        request: CheckpointExportRequest,
    ) -> BoxliteResult<Vec<Vec<ObjectReference>>>;
}

/// A provider lease complements durable references; process-local FDs alone
/// never satisfy retention across runtime shutdown and future cold starts.
pub trait CheckpointLease: std::fmt::Debug + Send + Sync {}
impl CheckpointLease for () {}

#[derive(Debug)]
pub struct BoundShare {
    pub root: PathBuf,
    /// Saved object order; None is allowed only for a saved unlinked regular file.
    pub objects: Vec<Option<File>>,
    /// Missing descriptions may be omitted only for saved unlinked regular files.
    pub handles: BTreeMap<u64, File>,
    pub dax: Vec<(u64, bool, File)>,
}

#[derive(Debug)]
pub struct CheckpointBindings {
    pub shares: Vec<BoundShare>,
    /// Exact readonly boot content, or None to use the verified runtime cache.
    pub boot_disk: Option<PathBuf>,
    pub lease: Arc<dyn CheckpointLease>,
}

fn status_flags(flags: i32) -> i32 {
    let mask = libc::O_ACCMODE
        | libc::O_APPEND
        | libc::O_NONBLOCK
        | libc::O_DSYNC
        | libc::O_SYNC
        | libc::O_DIRECTORY
        | libc::O_ASYNC;
    #[cfg(target_os = "linux")]
    let mask = mask | libc::O_DIRECT | libc::O_NOATIME;
    flags & mask
}

fn mount_id(file: &File) -> BoxliteResult<u64> {
    #[cfg(target_os = "linux")]
    {
        let mut metadata = std::mem::MaybeUninit::<libc::statx>::uninit();
        // SAFETY: the borrowed FD is live and statx initializes the output.
        if unsafe {
            libc::statx(
                file.as_raw_fd(),
                c"".as_ptr(),
                libc::AT_EMPTY_PATH | libc::AT_SYMLINK_NOFOLLOW,
                libc::STATX_MNT_ID,
                metadata.as_mut_ptr(),
            )
        } != 0
        {
            return Err(invalid(std::io::Error::last_os_error()));
        }
        // SAFETY: successful statx initialized metadata.
        let metadata = unsafe { metadata.assume_init() };
        if metadata.stx_mask & libc::STATX_MNT_ID == 0 {
            return Err(invalid("binding mount identity unavailable"));
        }
        Ok(metadata.stx_mnt_id)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = file;
        Ok(0)
    }
}

impl CheckpointBindings {
    pub(crate) fn validate(&self, dependencies: &CheckpointDependencies) -> BoxliteResult<()> {
        if self.shares.len() != dependencies.shares.len() {
            return Err(invalid("share binding count differs"));
        }
        let mut aliases = BTreeMap::new();
        let mut identities = BTreeMap::new();
        for (share, bound) in dependencies.shares.iter().zip(&self.shares) {
            if share.vm_owned {
                if !bound.objects.is_empty() {
                    return Err(invalid("boot recipe cannot bind external objects"));
                }
                continue;
            }
            if !bound.root.is_absolute() || bound.objects.len() != share.objects.len() {
                return Err(invalid("share root or retained object count differs"));
            }
            let root_file = path_object(&bound.root, Path::new("."), object_flags())?;
            let root_mount = mount_id(&root_file)?;
            let root = root_file.metadata().map_err(invalid)?;
            if !root.is_dir() {
                return Err(invalid("bound share root is not a directory"));
            }
            for (saved, object) in share.objects.iter().zip(&bound.objects) {
                let identity = object
                    .as_ref()
                    .map(|file| file.metadata().map(|st| (st.dev(), st.ino())))
                    .transpose()
                    .map_err(invalid)?;
                if aliases
                    .insert(saved.alias, identity)
                    .is_some_and(|old| old != identity)
                {
                    return Err(invalid("cross-share object presence or alias mismatch"));
                }
                let Some(object) = object else {
                    if !saved.allows_missing() {
                        return Err(invalid(
                            "missing object was not a saved unlinked regular file",
                        ));
                    }
                    continue;
                };
                let st = object.metadata().map_err(invalid)?;
                let identity = (st.dev(), st.ino());
                if st.mode() & 0o170000 != saved.kind
                    || saved.recipe.is_some()
                    || saved.reference.is_none()
                    || mount_id(object)? != root_mount
                    || identities
                        .insert(identity, saved.alias)
                        .is_some_and(|old| old != saved.alias)
                {
                    return Err(invalid(
                        "retained object type, reference or cross-share alias mismatch",
                    ));
                }
                #[cfg(target_os = "linux")]
                // SAFETY: live borrowed descriptor; fcntl only returns flags.
                if unsafe { libc::fcntl(object.as_raw_fd(), libc::F_GETFL) } & libc::O_PATH == 0 {
                    return Err(invalid(
                        "retained object requires a pinned O_PATH descriptor",
                    ));
                }
            }
            if let Some(nodes) = share.state["nodes"].as_array() {
                for node in nodes {
                    if node["inode"] == 1 {
                        let index = node["object"]
                            .as_u64()
                            .ok_or_else(|| invalid("root object index invalid"))?
                            as usize;
                        let object = bound
                            .objects
                            .get(index)
                            .and_then(Option::as_ref)
                            .ok_or_else(|| invalid("root object missing"))?
                            .metadata()
                            .map_err(invalid)?;
                        if (object.dev(), object.ino()) != (root.dev(), root.ino()) {
                            return Err(invalid("bound root differs from saved root object"));
                        }
                    }
                }
            }
            let handles = share.state["handles"]
                .as_array()
                .ok_or_else(|| invalid("saved handle table missing"))?;
            let handle_ids: std::collections::BTreeSet<_> = handles
                .iter()
                .filter_map(|handle| handle["handle"].as_u64())
                .collect();
            if bound.handles.keys().any(|id| !handle_ids.contains(id)) {
                return Err(invalid("extra independent handle binding"));
            }
            for handle in handles {
                let id = handle["handle"]
                    .as_u64()
                    .ok_or_else(|| invalid("invalid handle ID"))?;
                let index = handle["object"]
                    .as_u64()
                    .ok_or_else(|| invalid("invalid handle object"))?
                    as usize;
                let saved = share
                    .objects
                    .get(index)
                    .ok_or_else(|| invalid("handle object absent"))?;
                let expected: i32 =
                    serde_json::from_value(handle["flags"].clone()).map_err(invalid)?;
                if expected & (libc::O_CREAT | libc::O_TRUNC | libc::O_EXCL) != 0 {
                    return Err(invalid("unsafe saved handle creation flags"));
                }
                let Some(file) = bound.handles.get(&id) else {
                    if !saved.allows_missing() {
                        return Err(invalid("retained handle FD absent"));
                    }
                    continue;
                };
                let object = bound
                    .objects
                    .get(index)
                    .and_then(Option::as_ref)
                    .ok_or_else(|| invalid("handle object absent"))?
                    .metadata()
                    .map_err(invalid)?;
                let st = file.metadata().map_err(invalid)?;
                // SAFETY: file is a live borrowed descriptor.
                let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
                if (st.dev(), st.ino()) != (object.dev(), object.ino())
                    || status_flags(flags) != status_flags(expected)
                    || mount_id(file)? != root_mount
                {
                    return Err(invalid(
                        "independent handle identity/access/status flags mismatch",
                    ));
                }
            }
            let mut expected = std::collections::BTreeSet::new();
            for mapping in share.state["dax"]["mappings"]
                .as_array()
                .into_iter()
                .flatten()
            {
                let file = &mapping["kind"]["file"];
                if let Some(object) = file["object"].as_u64() {
                    if bound
                        .objects
                        .get(object as usize)
                        .and_then(Option::as_ref)
                        .is_none()
                    {
                        return Err(invalid("missing object has an existing DAX mapping"));
                    }
                    expected.insert((
                        object,
                        file["writable"]
                            .as_bool()
                            .ok_or_else(|| invalid("DAX role invalid"))?,
                    ));
                }
            }
            let mut actual = std::collections::BTreeSet::new();
            for (index, writable, file) in &bound.dax {
                let object = bound
                    .objects
                    .get(*index as usize)
                    .and_then(Option::as_ref)
                    .ok_or_else(|| invalid("DAX object absent"))?
                    .metadata()
                    .map_err(invalid)?;
                let st = file.metadata().map_err(invalid)?;
                // SAFETY: file is a live borrowed descriptor.
                let access = status_flags(unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) });
                if !actual.insert((*index, *writable))
                    || (st.dev(), st.ino()) != (object.dev(), object.ino())
                    || mount_id(file)? != root_mount
                    || access
                        != if *writable {
                            libc::O_RDWR
                        } else {
                            libc::O_RDONLY
                        }
                {
                    return Err(invalid("DAX identity/access role mismatch"));
                }
            }
            if actual != expected {
                return Err(invalid("file DAX roles missing or extra"));
            }
        }
        Ok(())
    }
}

#[expect(
    clippy::double_must_use,
    reason = "async_trait adds must_use to future-returning methods"
)]
#[async_trait]
pub trait CheckpointImportProvider: Send + Sync {
    /// Prepare persistent roots, available objects and independent access descriptions.
    /// Only saved unlinked regular objects/handles may be explicitly absent.
    /// Roots and recovery points must remain available for the box's lifetime.
    async fn bind(
        &self,
        dependencies: &CheckpointDependencies,
    ) -> BoxliteResult<CheckpointBindings>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, untagged)]
pub enum LocalObject {
    Path {
        path: PathBuf,
    },
    Fd {
        fd: i32,
        #[serde(default)]
        handles: BTreeMap<u64, i32>,
        #[serde(default)]
        dax_read: Option<i32>,
        #[serde(default)]
        dax_write: Option<i32>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalResource {
    pub recovery_point: String,
    pub root: PathBuf,
    /// Source-side locators may differ from a prepared recovery root.
    pub source_root: Option<PathBuf>,
    pub objects: BTreeMap<String, LocalObject>,
}

/// Explicit input configuration, never a third checkpoint artifact. No search,
/// tree walk, filesystem content copying, or retention daemon is performed.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalCheckpointProvider {
    pub shares: BTreeMap<String, String>,
    pub resources: BTreeMap<String, LocalResource>,
    #[serde(default)]
    pub boot_disks: BTreeMap<String, PathBuf>,
}

fn duplicate(fd: i32) -> std::io::Result<File> {
    // SAFETY: fcntl validates an inherited integer descriptor and returns a new
    // owned description reference; it does not dereference application memory.
    let copy = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if copy < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: successful fcntl returned an owned descriptor.
    Ok(unsafe { File::from_raw_fd(copy) })
}

fn path_object(root: &Path, path: &Path, flags: i32) -> BoxliteResult<File> {
    if !root.is_absolute() {
        return Err(invalid("binding root must be absolute"));
    }
    #[cfg(target_os = "linux")]
    let directory_flags = libc::O_PATH | libc::O_DIRECTORY;
    #[cfg(not(target_os = "linux"))]
    let directory_flags = libc::O_RDONLY | libc::O_DIRECTORY;
    let mut directory = OpenOptions::new()
        .read(true)
        .custom_flags(directory_flags | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)
        .map_err(invalid)?;
    let mut parts = path.components().peekable();
    while let Some(component) = parts.next() {
        let name = match component {
            Component::Normal(name) => name,
            Component::CurDir if parts.peek().is_none() => std::ffi::OsStr::new("."),
            _ => {
                return Err(invalid(
                    "object locator must be relative without symlink escape or parent traversal",
                ));
            }
        };
        use std::os::unix::ffi::OsStrExt;
        let name = std::ffi::CString::new(name.as_bytes()).map_err(invalid)?;
        let requested = if parts.peek().is_none() {
            flags
        } else {
            directory_flags
        };
        // SAFETY: a pinned directory and NUL-terminated single path component.
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                requested | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(invalid(std::io::Error::last_os_error()));
        }
        // SAFETY: openat returned a newly owned descriptor.
        directory = unsafe { File::from_raw_fd(fd) };
        if parts.peek().is_none() {
            return Ok(directory);
        }
    }
    Err(invalid("empty object locator"))
}

fn object_flags() -> i32 {
    #[cfg(target_os = "linux")]
    {
        libc::O_PATH
    }
    #[cfg(not(target_os = "linux"))]
    {
        libc::O_RDONLY
    }
}

impl LocalObject {
    fn open(
        &self,
        root: &Path,
        flags: i32,
        role: Option<(u64, Option<bool>)>,
    ) -> BoxliteResult<File> {
        self.open_available(root, flags, role, false)?
            .ok_or_else(|| invalid("retained descriptor absent"))
    }

    fn open_available(
        &self,
        root: &Path,
        flags: i32,
        role: Option<(u64, Option<bool>)>,
        allow_missing: bool,
    ) -> BoxliteResult<Option<File>> {
        match self {
            Self::Path { path } => path_object(root, path, flags).map(Some),
            Self::Fd {
                fd,
                handles,
                dax_read,
                dax_write,
            } => {
                let fd = match role {
                    None => Some(*fd),
                    Some((handle, None)) => handles.get(&handle).copied(),
                    Some((_, Some(writable))) => {
                        if writable {
                            *dax_write
                        } else {
                            *dax_read
                        }
                    }
                };
                let Some(fd) = fd else {
                    return if allow_missing {
                        Ok(None)
                    } else {
                        Err(invalid("independently supplied handle/DAX FD absent"))
                    };
                };
                if fd < 0 {
                    return Err(invalid("inherited descriptor must be nonnegative"));
                }
                match duplicate(fd) {
                    Ok(file) => Ok(Some(file)),
                    Err(error) if allow_missing && error.raw_os_error() == Some(libc::EBADF) => {
                        Ok(None)
                    }
                    Err(error) => Err(invalid(format!("inherited descriptor {fd}: {error}"))),
                }
            }
        }
    }
}

#[async_trait]
impl CheckpointExportProvider for LocalCheckpointProvider {
    async fn prepare(
        &self,
        request: CheckpointExportRequest,
    ) -> BoxliteResult<Vec<Vec<ObjectReference>>> {
        let mut files = request.objects.into_iter();
        let mut result = Vec::new();
        for share in request.shares {
            let mut references = Vec::new();
            for object in share.objects {
                let file = files
                    .next()
                    .ok_or_else(|| invalid("prepared object FD count differs"))?;
                if object.recipe.is_some() {
                    continue;
                }
                let resource_id = self.shares.get(&share.tag).ok_or_else(|| {
                    invalid(format!("missing resource binding for share {}", share.tag))
                })?;
                let resource = self
                    .resources
                    .get(resource_id)
                    .ok_or_else(|| invalid("missing resource configuration"))?;
                let root = resource.source_root.as_ref().unwrap_or(&resource.root);
                let source = file.metadata().map_err(invalid)?;
                let mut key = None;
                for (candidate, locator) in &resource.objects {
                    let bound = locator
                        .open(root, object_flags(), None)?
                        .metadata()
                        .map_err(invalid)?;
                    if (bound.dev(), bound.ino()) == (source.dev(), source.ino()) {
                        key = Some(candidate.clone());
                        break;
                    }
                }
                references.push(ObjectReference { resource_id: resource_id.clone(), recovery_point: resource.recovery_point.clone(),
                    object_key: key.ok_or_else(|| invalid(format!("share {} retained object has no explicit locator; retain an unlinked object with an FD", share.tag)))? });
            }
            result.push(references);
        }
        if files.next().is_some() {
            return Err(invalid("unused prepared object FDs"));
        }
        Ok(result)
    }
}

#[async_trait]
impl CheckpointImportProvider for LocalCheckpointProvider {
    async fn bind(
        &self,
        dependencies: &CheckpointDependencies,
    ) -> BoxliteResult<CheckpointBindings> {
        let mut shares = Vec::new();
        for share in &dependencies.shares {
            if share.vm_owned {
                shares.push(BoundShare {
                    root: PathBuf::new(),
                    objects: Vec::new(),
                    handles: BTreeMap::new(),
                    dax: Vec::new(),
                });
                continue;
            }
            let resource_id = self
                .shares
                .get(&share.tag)
                .ok_or_else(|| invalid(format!("missing share binding {}", share.tag)))?;
            let resource = self
                .resources
                .get(resource_id)
                .ok_or_else(|| invalid("missing resource binding"))?;
            let mut bound = BoundShare {
                root: resource.root.clone(),
                objects: Vec::new(),
                handles: BTreeMap::new(),
                dax: Vec::new(),
            };
            for (index, object) in share.objects.iter().enumerate() {
                let reference = object
                    .reference
                    .as_ref()
                    .ok_or_else(|| invalid("external object reference missing"))?;
                if reference.resource_id != *resource_id
                    || reference.recovery_point != resource.recovery_point
                {
                    return Err(invalid("resource or recovery point mismatch"));
                }
                let Some(locator) = resource.objects.get(&reference.object_key) else {
                    if object.allows_missing() {
                        bound.objects.push(None);
                        continue;
                    }
                    return Err(invalid("retained object key is not bound"));
                };
                bound.objects.push(locator.open_available(
                    &resource.root,
                    object_flags(),
                    None,
                    object.allows_missing(),
                )?);
                for handle in share.state["handles"]
                    .as_array()
                    .ok_or_else(|| invalid("handle table missing"))?
                {
                    if handle["object"].as_u64() != Some(index as u64) {
                        continue;
                    }
                    let id = handle["handle"]
                        .as_u64()
                        .ok_or_else(|| invalid("handle ID invalid"))?;
                    let flags: i32 =
                        serde_json::from_value(handle["flags"].clone()).map_err(invalid)?;
                    if flags & (libc::O_CREAT | libc::O_TRUNC | libc::O_EXCL) != 0 {
                        return Err(invalid("unsafe saved handle creation flags"));
                    }
                    if let Some(file) = locator.open_available(
                        &resource.root,
                        flags,
                        Some((id, None)),
                        object.allows_missing(),
                    )? {
                        bound.handles.insert(id, file);
                    }
                }
                let mut roles = std::collections::BTreeSet::new();
                if let Some(mappings) = share.state["dax"]["mappings"].as_array() {
                    for mapping in mappings {
                        let file = &mapping["kind"]["file"];
                        if file["object"].as_u64() == Some(index as u64) {
                            roles.insert(
                                file["writable"]
                                    .as_bool()
                                    .ok_or_else(|| invalid("DAX access invalid"))?,
                            );
                        }
                    }
                }
                for writable in roles {
                    bound.dax.push((
                        index as u64,
                        writable,
                        locator.open(
                            &resource.root,
                            if writable {
                                libc::O_RDWR
                            } else {
                                libc::O_RDONLY
                            },
                            Some((0, Some(writable))),
                        )?,
                    ));
                }
            }
            shares.push(bound);
        }
        let boot_disk = dependencies
            .disk_dependencies
            .as_array()
            .into_iter()
            .flatten()
            .find_map(|disk| {
                let bytes: [u8; 32] =
                    serde_json::from_value(disk["external_readonly_boot"]["sha256"].clone())
                        .ok()?;
                self.boot_disks.get(&hex::encode(bytes)).cloned()
            });
        Ok(CheckpointBindings {
            shares,
            boot_disk,
            lease: Arc::new(()),
        })
    }
}

#[cfg(test)]
#[path = "tests/provider.rs"]
mod tests;
