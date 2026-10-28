//! Concrete local paths for checkpoint dependencies; no descriptors outlive an operation.
use super::pair::{CheckpointDependencies, ObjectReference, ShareDependency, invalid};
use boxlite_shared::errors::BoxliteResult;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

const LOCAL_REFERENCE: &str = "local-path-v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LocalPaths {
    pub version: u32,
    pub shares: BTreeMap<String, LocalRoot>,
    pub boot_disk: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LocalRoot {
    pub path: PathBuf,
    pub device: u64,
    pub inode: u64,
}

impl LocalPaths {
    pub(crate) fn capture(spec: &crate::vmm::InstanceSpec) -> BoxliteResult<Self> {
        let shares = spec
            .fs_shares
            .shares()
            .iter()
            .map(|share| Ok((share.tag.clone(), LocalRoot::capture(&share.host_path)?)))
            .collect::<BoxliteResult<_>>()?;
        let crate::rootfs::guest::Strategy::Disk { disk_path, .. } = &spec.guest_rootfs.strategy
        else {
            return Err(invalid("local checkpoint needs a readonly boot disk"));
        };
        Ok(Self {
            version: 1,
            shares,
            boot_disk: disk_path.canonicalize().map_err(invalid)?,
        })
    }
}

impl LocalRoot {
    pub(crate) fn capture(path: &Path) -> BoxliteResult<Self> {
        let path = path.canonicalize().map_err(invalid)?;
        let file = path_object(&path, Path::new("."), object_flags())?;
        let stat = file.metadata().map_err(invalid)?;
        Ok(Self {
            path,
            device: stat.dev(),
            inode: stat.ino(),
        })
    }
}

#[derive(Debug)]
pub(crate) struct BoundShare {
    pub root: PathBuf,
    pub objects: Vec<Option<File>>,
    pub handles: BTreeMap<u64, File>,
    pub dax: Vec<(u64, bool, File)>,
}

#[derive(Debug)]
pub(crate) struct CheckpointBindings {
    pub shares: Vec<BoundShare>,
}

// Reject these before opening: saved handles must never create or truncate.
pub(crate) fn check_handle_flags(flags: i32) -> BoxliteResult<()> {
    let creation = libc::O_CREAT | libc::O_TRUNC | libc::O_EXCL;
    #[cfg(target_os = "linux")]
    let creation = creation | (libc::O_TMPFILE & !libc::O_DIRECTORY);
    if flags & creation != 0 {
        return Err(invalid("unsafe saved handle creation flags"));
    }
    Ok(())
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
                check_handle_flags(expected)?;
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

/// Stateless adapter: descriptors are opened anew and transferred only for this import.
pub(crate) struct LocalCheckpointProvider;

impl LocalCheckpointProvider {
    pub(crate) fn prepare(
        shares: &[ShareDependency],
        objects: Vec<File>,
        paths: &LocalPaths,
    ) -> BoxliteResult<Vec<Vec<ObjectReference>>> {
        let mut files = objects.into_iter();
        let mut references = Vec::new();
        for share in shares {
            let mut refs = Vec::new();
            for object in &share.objects {
                let source = files
                    .next()
                    .ok_or_else(|| invalid("prepared object FD count differs"))?;
                if share.vm_owned {
                    continue;
                }
                let root = paths
                    .shares
                    .get(&share.tag)
                    .ok_or_else(|| invalid("source share root missing"))?;
                let stat = source.metadata().map_err(invalid)?;
                // nlink, not a procfs name suffix, determines deletion. Never open
                // a former orphan name: it may already name a replacement inode.
                let key = if object.unlinked && stat.nlink() == 0 && stat.is_file() {
                    // An absolute sentinel can never become a valid relative
                    // locator if unlink eligibility is absent or corrupted.
                    "/".to_owned()
                } else {
                    let path = source_path(&source)?;
                    let relative = path.strip_prefix(&root.path).map_err(|_| {
                        invalid(format!(
                            "source object {} is outside share {}",
                            path.display(),
                            root.path.display()
                        ))
                    })?;
                    let relative = if relative.as_os_str().is_empty() {
                        Path::new(".")
                    } else {
                        relative
                    };
                    let reopened = path_object(&root.path, relative, object_flags())?;
                    let found = reopened.metadata().map_err(invalid)?;
                    if (found.dev(), found.ino()) != (stat.dev(), stat.ino()) {
                        return Err(invalid("source path identity changed during capture"));
                    }
                    relative
                        .to_str()
                        .ok_or_else(|| invalid("local checkpoint path is not UTF-8"))?
                        .to_owned()
                };
                refs.push(ObjectReference {
                    resource_id: LOCAL_REFERENCE.into(),
                    recovery_point: format!("{}:{}", stat.dev(), stat.ino()),
                    object_key: key,
                });
            }
            references.push(refs);
        }
        if files.next().is_some() {
            return Err(invalid("unused prepared object FDs"));
        }
        Ok(references)
    }

    pub(crate) fn bind(
        dependencies: &CheckpointDependencies,
        paths: &LocalPaths,
    ) -> BoxliteResult<CheckpointBindings> {
        if paths.version != 1 {
            return Err(invalid("unsupported local checkpoint path schema"));
        }
        let mut shares = Vec::new();
        for share in &dependencies.shares {
            let mut bound = BoundShare {
                root: PathBuf::new(),
                objects: Vec::new(),
                handles: BTreeMap::new(),
                dax: Vec::new(),
            };
            if share.vm_owned {
                shares.push(bound);
                continue;
            }
            let root = paths
                .shares
                .get(&share.tag)
                .ok_or_else(|| invalid("saved local share root missing"))?;
            let root_file = path_object(&root.path, Path::new("."), object_flags())?;
            let root_stat = root_file.metadata().map_err(invalid)?;
            if (root_stat.dev(), root_stat.ino()) != (root.device, root.inode) {
                return Err(invalid("saved local share root identity changed"));
            }
            bound.root = root.path.clone();
            for (index, object) in share.objects.iter().enumerate() {
                let reference = object
                    .reference
                    .as_ref()
                    .ok_or_else(|| invalid("external object reference missing"))?;
                if reference.resource_id != LOCAL_REFERENCE {
                    return Err(invalid(
                        "unsupported provider-era checkpoint references; export a local-path checkpoint",
                    ));
                }
                let missing = object.allows_missing();
                let file = if missing {
                    None
                } else {
                    let file =
                        path_object(&root.path, Path::new(&reference.object_key), object_flags())?;
                    let stat = file.metadata().map_err(invalid)?;
                    if reference.recovery_point != format!("{}:{}", stat.dev(), stat.ino()) {
                        return Err(invalid("saved local object identity changed"));
                    }
                    Some(file)
                };
                bound.objects.push(file);
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
                    check_handle_flags(flags)?;
                    if !missing {
                        bound.handles.insert(
                            id,
                            path_object(&root.path, Path::new(&reference.object_key), flags)?,
                        );
                    }
                }
                let mut roles = std::collections::BTreeSet::new();
                for mapping in share.state["dax"]["mappings"]
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    let file = &mapping["kind"]["file"];
                    if file["object"].as_u64() == Some(index as u64) {
                        roles.insert(
                            file["writable"]
                                .as_bool()
                                .ok_or_else(|| invalid("DAX access invalid"))?,
                        );
                    }
                }
                if missing && !roles.is_empty() {
                    return Err(invalid("missing object has an existing DAX mapping"));
                }
                for writable in roles {
                    bound.dax.push((
                        index as u64,
                        writable,
                        path_object(
                            &root.path,
                            Path::new(&reference.object_key),
                            if writable {
                                libc::O_RDWR
                            } else {
                                libc::O_RDONLY
                            },
                        )?,
                    ));
                }
            }
            shares.push(bound);
        }
        let bindings = CheckpointBindings { shares };
        bindings.validate(dependencies)?;
        Ok(bindings)
    }
}

fn source_path(file: &File) -> BoxliteResult<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).map_err(invalid)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = file;
        Err(invalid("local checkpoint paths require Linux procfs"))
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "tests/provider.rs"]
mod tests;
