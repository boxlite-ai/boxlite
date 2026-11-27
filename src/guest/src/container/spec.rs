//! Container launch plan and image user/device resolution.

use super::capabilities::CapabilitySet;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use boxlite_shared::{
    ContainerDevice as ProtoContainerDevice, ContainerResources as ProtoContainerResources,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Component, Path, PathBuf};

/// Host-resolved source/options override for one of the guest's own standard
/// mounts. Which mount is a separate concern, handled at the RPC boundary
/// (`container::mount_override`) before this is ever built — by the time
/// one of these exists, its two fields are already known to belong to `/sys`,
/// so the type itself doesn't need to say so.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MountOverride {
    pub source: String,
    pub options: Vec<String>,
}

/// Host-resolved cgroup choices for the container. The default is the
/// historical shape: no namespace, no mount, no limits.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContainerCgroup {
    /// Unshare a cgroup namespace and mount cgroup2 read-only at
    /// `/sys/fs/cgroup`, so the container sees its own cgroup as the root.
    pub namespace: bool,
    /// Limits written to the container cgroup; `None` leaves it unlimited.
    pub limits: Option<CgroupLimits>,
}

/// Literal cgroup v2 limits; 0 leaves a controller at the kernel default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CgroupLimits {
    pub cpu_quota_us: i64,
    pub cpu_period_us: u64,
    pub memory_limit_bytes: i64,
    pub pids_limit: i64,
}

impl ContainerCgroup {
    /// An older host sends neither field: that keeps the historical shape.
    pub fn from_proto(namespace: bool, resources: Option<ProtoContainerResources>) -> Self {
        let limits = resources
            .map(|r| CgroupLimits {
                cpu_quota_us: r.cpu_quota_us,
                cpu_period_us: r.cpu_period_us,
                memory_limit_bytes: r.memory_limit_bytes,
                pids_limit: r.pids_limit,
            })
            .filter(|l| l.cpu_quota_us > 0 || l.memory_limit_bytes > 0 || l.pids_limit > 0);
        Self { namespace, limits }
    }
}

/// User-specified bind mount for container
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserMount {
    /// Source path in guest VM
    pub source: String,
    /// Destination path in container
    pub destination: String,
    /// Read-only mount
    pub read_only: bool,
    /// Owner UID of host directory (for auto-idmap)
    pub owner_uid: u32,
    /// Owner GID of host directory (for auto-idmap)
    pub owner_gid: u32,
}

/// Device nodes the host asked to republish inside the container, resolved
/// against the guest VM's own `/dev` and validated on the way in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Device {
    pub path: PathBuf,
    pub block: bool,
    pub major: u64,
    pub minor: u64,
    pub mode: u32,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContainerDevices(pub(super) Vec<Device>);

impl ContainerDevices {
    pub fn from_proto(devices: Vec<ProtoContainerDevice>) -> BoxliteResult<Self> {
        devices
            .into_iter()
            .map(resolve_device)
            .collect::<BoxliteResult<Vec<_>>>()
            .map(Self)
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }
}

/// Read a guest device node's type and numbers, and describe it as the OCI
/// device the container should get.
fn resolve_device(device: ProtoContainerDevice) -> BoxliteResult<Device> {
    // Both ends are confined: the source names a node this guest already
    // publishes under /dev, and the destination names where the workload sees
    // it. Confining only one end would let a caller read a device node from
    // anywhere in the guest filesystem.
    let source = validate_device_path("source", &device.source)?;
    let destination = validate_device_path("destination", &device.destination)?;
    if let Some(file_mode) = device.file_mode {
        if file_mode & !0o777 != 0 {
            return Err(unsupported_device(
                &destination,
                format!("has invalid file mode {file_mode:#o}"),
            ));
        }
    }

    let metadata = std::fs::symlink_metadata(&source)
        .map_err(|error| unsupported_device(&source, format!("is unavailable: {error}")))?;
    let block = metadata.file_type().is_block_device();
    if !block && !metadata.file_type().is_char_device() {
        return Err(unsupported_device(
            &source,
            "is not a character or block device".into(),
        ));
    }
    Ok(Device {
        path: destination,
        block,
        major: nix::sys::stat::major(metadata.rdev()),
        minor: nix::sys::stat::minor(metadata.rdev()),
        mode: device.file_mode.unwrap_or(0o666),
    })
}

fn unsupported_device(path: &Path, problem: String) -> BoxliteError {
    BoxliteError::Unsupported(format!("container device {} {problem}", path.display()))
}

/// A device path must be absolute, free of `.`/`..`, and name something strictly
/// below `/dev` — never `/dev` itself, which is the directory, not a node.
fn validate_device_path(field: &str, value: &str) -> BoxliteResult<PathBuf> {
    let path = Path::new(value);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::RootDir | Component::Normal(_)))
    {
        return Err(BoxliteError::Unsupported(format!(
            "container device {field} must be a normalized absolute path: {value}"
        )));
    }
    if path == Path::new("/dev") || !path.starts_with("/dev") {
        return Err(BoxliteError::Unsupported(format!(
            "container device {field} must be below /dev: {value}"
        )));
    }

    Ok(path.to_path_buf())
}

/// In-memory launch plan. The runner only accepts the process and mount types
/// produced here, not an arbitrary OCI configuration from disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct InitSpec {
    pub rootfs: PathBuf,
    pub process: ProcessSpec,
    pub mounts: Vec<MountSpec>,
    pub devices: ContainerDevices,
    pub readonly_paths: Vec<String>,
    pub cgroup: ContainerCgroup,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ProcessSpec {
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub cwd: PathBuf,
    pub uid: u32,
    pub gid: u32,
    pub capabilities: CapabilitySet,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct MountSpec {
    pub destination: PathBuf,
    pub source: PathBuf,
    pub kind: Option<String>, // None denotes a bind mount
    pub options: Vec<String>,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn init_spec(
    rootfs: &Path,
    process: ProcessSpec,
    readonly_paths: &[String],
    sys: &MountOverride,
    bundle: &Path,
    user_mounts: &[UserMount],
    devices: &ContainerDevices,
    cgroup: ContainerCgroup,
) -> InitSpec {
    let mount =
        |destination: &str, source: PathBuf, kind: Option<&str>, options: &[&str]| MountSpec {
            destination: canonical_destination(Path::new(destination)),
            source,
            kind: kind.map(str::to_owned),
            options: options.iter().map(|option| (*option).into()).collect(),
        };
    let fs = |dest, kind: &str, data: &[&str]| mount(dest, kind.into(), Some(kind), data);
    let mut mounts = vec![
        fs("/proc", "proc", &[]),
        fs(
            "/dev",
            "tmpfs",
            &["nosuid", "strictatime", "mode=755", "size=65536k"],
        ),
        fs(
            "/dev/pts",
            "devpts",
            &[
                "nosuid",
                "noexec",
                "newinstance",
                "ptmxmode=0666",
                "mode=0620",
            ],
        ),
        fs(
            "/dev/shm",
            "tmpfs",
            &["nosuid", "noexec", "nodev", "mode=1777", "size=65536k"],
        ),
        MountSpec {
            destination: "/sys".into(),
            source: sys.source.clone().into(),
            kind: None,
            options: sys.options.clone(),
        },
        fs("/tmp", "tmpfs", &["nosuid", "nodev", "mode=1777"]),
    ];
    if cgroup.namespace {
        mounts.push(fs(
            "/sys/fs/cgroup",
            "cgroup2",
            &["nosuid", "noexec", "nodev", "ro"],
        ));
    }
    for file in ["hostname", "hosts", "resolv.conf"] {
        mounts.push(mount(
            &format!("/etc/{file}"),
            bundle.join(file),
            None,
            &["rbind", "rprivate"],
        ));
    }
    for user_mount in user_mounts {
        mounts.push(mount(
            &user_mount.destination,
            (&user_mount.source).into(),
            None,
            &["bind", if user_mount.read_only { "ro" } else { "rw" }],
        ));
    }
    InitSpec {
        rootfs: rootfs.into(),
        process,
        mounts,
        devices: devices.clone(),
        readonly_paths: readonly_paths.to_vec(),
        cgroup,
    }
}

fn canonical_destination(destination: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for component in destination.components() {
        match component {
            Component::Normal(part) => out.push(part),
            // `/..` has nowhere to go: the runtime cannot mount above the
            // rootfs, so the destination clamps at the root rather than
            // escaping it.
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir | Component::RootDir | Component::Prefix(_) => continue,
        }
    }
    out
}

/// Resolve user string to (uid, gid) using container's /etc/passwd and /etc/group.
///
/// Matches Docker/Podman USER behavior:
/// - `""` → (0, 0) — root
/// - `"uid"` → (uid, passwd_gid or 0)
/// - `"uid:gid"` → (uid, gid)
/// - `"name"` → resolve from /etc/passwd
/// - `"name:group"` → resolve from /etc/passwd + /etc/group
/// - Mixed numeric/name formats supported
pub(super) fn resolve_user(rootfs: &str, user: &str) -> BoxliteResult<(u32, u32)> {
    if user.is_empty() {
        return Ok((0, 0));
    }

    let (user_part, group_part) = match user.split_once(':') {
        Some((u, g)) => (u, Some(g)),
        None => (user, None),
    };

    // Resolve UID
    let (uid, passwd_gid) = match user_part.parse::<u32>() {
        Ok(uid) => {
            // Numeric UID: try /etc/passwd for primary GID (Docker behavior)
            let uid = validate_credential_id(uid, "UID")?;
            (uid, find_gid_for_uid(rootfs, uid)?)
        }
        Err(_) => {
            // Username: must exist in /etc/passwd
            let (uid, gid) = find_user_in_passwd(rootfs, user_part)?;
            (uid, Some(gid))
        }
    };

    // Resolve GID: explicit group overrides passwd GID.
    // Empty or absent group → use passwd primary GID, or 0 if not in passwd.
    // Docker treats "1000:" (trailing colon, empty group) same as "1000".
    let gid = match group_part {
        Some(g) if !g.is_empty() => match g.parse::<u32>() {
            Ok(gid) => validate_credential_id(gid, "GID")?,
            Err(_) => find_group_in_group_file(rootfs, g)?,
        },
        _ => passwd_gid.unwrap_or(0),
    };

    Ok((uid, gid))
}

fn validate_credential_id(id: u32, kind: &str) -> BoxliteResult<u32> {
    // setresuid/setresgid treat (uid_t)-1 as "leave unchanged", not an ID.
    if id == u32::MAX {
        return Err(BoxliteError::InvalidArgument(format!(
            "Invalid {kind} '{id}': reserved credential ID"
        )));
    }
    Ok(id)
}

/// Look up username in {rootfs}/etc/passwd. Returns (uid, gid).
///
/// /etc/passwd format: name:x:uid:gid:gecos:home:shell
fn find_user_in_passwd(rootfs: &str, name: &str) -> BoxliteResult<(u32, u32)> {
    let path = Path::new(rootfs).join("etc/passwd");
    let content = std::fs::read_to_string(&path).map_err(|e| {
        BoxliteError::Internal(format!(
            "Cannot resolve user '{}': failed to read {}: {}",
            name,
            path.display(),
            e
        ))
    })?;

    // /etc/passwd fields: name:password:uid:gid:gecos:home:shell
    // We only need fields[0] (name), fields[2] (uid), fields[3] (gid).
    for line in content.lines() {
        let f: Vec<&str> = line.splitn(7, ':').collect();
        if f.len() >= 4 && f[0] == name {
            let uid = f[2].parse::<u32>().map_err(|_| {
                BoxliteError::Internal(format!(
                    "Invalid UID '{}' for user '{}' in {}",
                    f[2],
                    name,
                    path.display()
                ))
            })?;
            let gid = f[3].parse::<u32>().map_err(|_| {
                BoxliteError::Internal(format!(
                    "Invalid GID '{}' for user '{}' in {}",
                    f[3],
                    name,
                    path.display()
                ))
            })?;
            return Ok((
                validate_credential_id(uid, "UID")?,
                validate_credential_id(gid, "GID")?,
            ));
        }
    }

    Err(BoxliteError::InvalidArgument(format!(
        "User '{}' not found in {}",
        name,
        path.display()
    )))
}

/// Find primary GID for numeric UID in /etc/passwd. Returns None if not found.
///
/// Best-effort: numeric UIDs work without /etc/passwd (GID defaults to 0).
/// Docker silently ignores missing passwd for numeric UIDs. We do the same.
fn find_gid_for_uid(rootfs: &str, uid: u32) -> BoxliteResult<Option<u32>> {
    let path = Path::new(rootfs).join("etc/passwd");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Ok(None);
    };
    // Scan for a passwd entry whose UID field (fields[2]) matches,
    // then return its primary GID (fields[3]).
    for line in content.lines() {
        let f: Vec<&str> = line.splitn(7, ':').collect();
        if f.len() >= 4 {
            if let Ok(entry_uid) = f[2].parse::<u32>() {
                if entry_uid == uid {
                    return f[3]
                        .parse()
                        .ok()
                        .map(|gid| validate_credential_id(gid, "GID"))
                        .transpose();
                }
            }
        }
    }
    Ok(None)
}

/// Look up group name in {rootfs}/etc/group. Returns gid.
///
/// /etc/group format: name:x:gid:members
fn find_group_in_group_file(rootfs: &str, name: &str) -> BoxliteResult<u32> {
    let path = Path::new(rootfs).join("etc/group");
    let content = std::fs::read_to_string(&path).map_err(|e| {
        BoxliteError::Internal(format!(
            "Cannot resolve group '{}': failed to read {}: {}",
            name,
            path.display(),
            e
        ))
    })?;

    // /etc/group fields: name:password:gid:members
    // We only need fields[0] (name) and fields[2] (gid).
    for line in content.lines() {
        let f: Vec<&str> = line.splitn(4, ':').collect();
        if f.len() >= 3 && f[0] == name {
            let gid = f[2].parse::<u32>().map_err(|_| {
                BoxliteError::Internal(format!(
                    "Invalid GID '{}' for group '{}' in {}",
                    f[2],
                    name,
                    path.display()
                ))
            })?;
            return validate_credential_id(gid, "GID");
        }
    }

    Err(BoxliteError::InvalidArgument(format!(
        "Group '{}' not found in {}",
        name,
        path.display()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// The device the container sees must carry the *source* node's type and
    /// numbers, read from the guest VM, under the requested destination path.
    #[test]
    fn device_mapping_resolves_the_source_node() {
        let source = fs::metadata("/dev/null").unwrap().rdev();
        let devices = ContainerDevices::from_proto(vec![ProtoContainerDevice {
            source: "/dev/null".to_string(),
            destination: "/dev/test-device".to_string(),
            file_mode: Some(0o666),
        }])
        .unwrap();

        let device = &devices.0[0];
        assert_eq!(device.path, Path::new("/dev/test-device"));
        assert!(!device.block);
        assert_eq!(device.major, nix::sys::stat::major(source));
        assert_eq!(device.minor, nix::sys::stat::minor(source));
        assert_eq!(device.mode, 0o666);
    }

    #[test]
    fn device_mapping_rejects_unusable_requests() {
        let regular_file = tempfile::NamedTempFile::new().unwrap();
        let cases = [
            // A directory, so it clears the /dev confinement and is refused by
            // the node-type check instead. If a runner lacks /dev/shm the error
            // becomes "is unavailable" and this case fails loudly rather than
            // passing for the wrong reason.
            (
                "not a character or block device",
                "/dev/shm".to_string(),
                "/dev/test-device".to_string(),
                None,
            ),
            // Source is confined too, so a path outside /dev is refused before
            // its node type is ever inspected.
            (
                "source must be below /dev",
                regular_file.path().display().to_string(),
                "/dev/test-device".to_string(),
                None,
            ),
            (
                "must be below /dev",
                "/dev/null".to_string(),
                "/tmp/test-device".to_string(),
                None,
            ),
            (
                "normalized absolute path",
                "/dev/null".to_string(),
                "/dev/../etc/passwd".to_string(),
                None,
            ),
            (
                "invalid file mode",
                "/dev/null".to_string(),
                "/dev/test-device".to_string(),
                Some(0o4666),
            ),
        ];

        for (expected, source, destination, file_mode) in cases {
            let error = ContainerDevices::from_proto(vec![ProtoContainerDevice {
                source,
                destination,
                file_mode,
            }])
            .unwrap_err();

            assert!(matches!(error, BoxliteError::Unsupported(_)), "{error:?}");
            assert!(error.to_string().contains(expected), "{error}");
        }
    }

    /// Create a temp rootfs with /etc/passwd and /etc/group for testing.
    ///
    /// Covers: root, regular users, system users (www-data, nobody),
    /// special chars in names (dash, underscore, dot), duplicate entries.
    fn make_test_rootfs() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let etc = dir.path().join("etc");
        fs::create_dir_all(&etc).unwrap();

        fs::write(
            etc.join("passwd"),
            "root:x:0:0:root:/root:/bin/bash\n\
             abc:x:1000:1001::/home/abc:/bin/sh\n\
             node:x:500:500::/home/node:/bin/bash\n\
             www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\n\
             nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n\
             dash-user:x:2000:2000::/home/dash-user:/bin/sh\n\
             under_score:x:2001:2001::/home/under_score:/bin/sh\n\
             dot.user:x:2002:2002::/home/dot.user:/bin/sh\n\
             dupe:x:3000:3000:first:/home/dupe1:/bin/sh\n\
             dupe:x:3001:3001:second:/home/dupe2:/bin/sh\n",
        )
        .unwrap();

        fs::write(
            etc.join("group"),
            "root:x:0:\n\
             staff:x:50:\n\
             abc:x:1001:\n\
             www-data:x:33:\n\
             nogroup:x:65534:\n\
             dash-group:x:2100:\n\
             under_group:x:2101:\n\
             dot.group:x:2102:\n",
        )
        .unwrap();

        dir
    }

    #[test]
    fn test_resolve_user_empty_defaults_to_root() {
        let rootfs = make_test_rootfs();
        assert_eq!(
            resolve_user(rootfs.path().to_str().unwrap(), "").unwrap(),
            (0, 0)
        );
    }

    // ==================
    // Username only
    // ==================

    #[test]
    fn test_resolve_user_name() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        assert_eq!(resolve_user(r, "root").unwrap(), (0, 0));
        assert_eq!(resolve_user(r, "abc").unwrap(), (1000, 1001));
        assert_eq!(resolve_user(r, "node").unwrap(), (500, 500));
    }

    #[test]
    fn test_resolve_user_common_system_users() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        assert_eq!(resolve_user(r, "www-data").unwrap(), (33, 33));
        assert_eq!(resolve_user(r, "nobody").unwrap(), (65534, 65534));
    }

    #[test]
    fn test_resolve_user_special_chars_in_names() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        assert_eq!(resolve_user(r, "dash-user").unwrap(), (2000, 2000));
        assert_eq!(resolve_user(r, "under_score").unwrap(), (2001, 2001));
        assert_eq!(resolve_user(r, "dot.user").unwrap(), (2002, 2002));
    }

    // ==================
    // Numeric UID only
    // ==================

    #[test]
    fn test_resolve_user_numeric_zero() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        assert_eq!(resolve_user(r, "0").unwrap(), (0, 0));
    }

    #[test]
    fn test_resolve_user_numeric_uid_with_passwd_gid() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        assert_eq!(resolve_user(r, "1000").unwrap(), (1000, 1001));
        assert_eq!(resolve_user(r, "500").unwrap(), (500, 500));
    }

    #[test]
    fn test_resolve_user_numeric_uid_not_in_passwd() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        assert_eq!(resolve_user(r, "9999").unwrap(), (9999, 0));
    }

    #[test]
    fn test_resolve_user_boundary_uids() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        // 65534 (nobody) exists in passwd with GID 65534
        assert_eq!(resolve_user(r, "65534").unwrap(), (65534, 65534));
        // 65535 not in passwd → GID defaults to 0
        assert_eq!(resolve_user(r, "65535").unwrap(), (65535, 0));
    }

    // ==================
    // UID:GID both numeric
    // ==================

    #[test]
    fn test_resolve_user_uid_gid_both_numeric() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        assert_eq!(resolve_user(r, "0:0").unwrap(), (0, 0));
        assert_eq!(resolve_user(r, "1000:1001").unwrap(), (1000, 1001));
        assert_eq!(resolve_user(r, "9999:8888").unwrap(), (9999, 8888));
    }

    #[test]
    fn test_resolve_user_boundary_uid_gid() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        assert_eq!(resolve_user(r, "65534:65534").unwrap(), (65534, 65534));
        assert_eq!(resolve_user(r, "65535:65535").unwrap(), (65535, 65535));
    }

    // ==================
    // Name:group
    // ==================

    #[test]
    fn test_resolve_user_name_group() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        assert_eq!(resolve_user(r, "abc:staff").unwrap(), (1000, 50));
        assert_eq!(resolve_user(r, "abc:root").unwrap(), (1000, 0));
    }

    #[test]
    fn test_resolve_user_name_group_same() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        assert_eq!(resolve_user(r, "www-data:www-data").unwrap(), (33, 33));
    }

    #[test]
    fn test_resolve_user_special_chars_name_group() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        assert_eq!(
            resolve_user(r, "dash-user:dash-group").unwrap(),
            (2000, 2100)
        );
        assert_eq!(
            resolve_user(r, "under_score:under_group").unwrap(),
            (2001, 2101)
        );
        assert_eq!(resolve_user(r, "dot.user:dot.group").unwrap(), (2002, 2102));
    }

    // ==================
    // Name:numeric GID
    // ==================

    #[test]
    fn test_resolve_user_name_numeric_gid() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        assert_eq!(resolve_user(r, "abc:99").unwrap(), (1000, 99));
    }

    #[test]
    fn test_resolve_user_name_numeric_gid_boundary() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        assert_eq!(resolve_user(r, "root:65534").unwrap(), (0, 65534));
    }

    // ==================
    // Numeric UID:group name
    // ==================

    #[test]
    fn test_resolve_user_numeric_uid_group_name() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        assert_eq!(resolve_user(r, "1000:staff").unwrap(), (1000, 50));
    }

    #[test]
    fn test_resolve_user_numeric_uid_group_name_variants() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        assert_eq!(resolve_user(r, "0:www-data").unwrap(), (0, 33));
        assert_eq!(resolve_user(r, "9999:root").unwrap(), (9999, 0));
    }

    // ==================
    // Trailing colon (empty group)
    // ==================

    #[test]
    fn test_resolve_user_trailing_colon() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        // Docker treats "uid:" as "uid" — empty group falls back to passwd GID or 0
        assert_eq!(resolve_user(r, "1000:").unwrap(), (1000, 1001));
        assert_eq!(resolve_user(r, "0:").unwrap(), (0, 0));
        assert_eq!(resolve_user(r, "abc:").unwrap(), (1000, 1001));
        assert_eq!(resolve_user(r, "9999:").unwrap(), (9999, 0));
    }

    // ==================
    // Duplicate passwd entries (first match wins)
    // ==================

    #[test]
    fn test_resolve_user_duplicate_passwd_first_wins() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        // "dupe" appears twice: uid=3000 first, uid=3001 second
        assert_eq!(resolve_user(r, "dupe").unwrap(), (3000, 3000));
        // Numeric UID 3000 also matches first entry
        assert_eq!(resolve_user(r, "3000").unwrap(), (3000, 3000));
    }

    // ==================
    // Multiple colons (split_once handles correctly)
    // ==================

    #[test]
    fn test_resolve_user_multiple_colons() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        // "1000:1001:extra" → split_once gives user="1000", group="1001:extra"
        // "1001:extra" fails u32 parse → tries group lookup → errors
        assert!(resolve_user(r, "1000:1001:extra").is_err());
    }

    // ==================
    // Error: unknown user/group
    // ==================

    #[test]
    fn test_resolve_user_unknown_name_errors() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        let err = resolve_user(r, "nonexistent").unwrap_err();
        assert!(
            matches!(err, BoxliteError::InvalidArgument(_)),
            "got: {err:?}"
        );
        let err = err.to_string();
        assert!(err.contains("User 'nonexistent' not found"), "got: {}", err);
    }

    #[test]
    fn test_resolve_user_unknown_group_errors() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        let err = resolve_user(r, "abc:nonexistent_group").unwrap_err();
        assert!(
            matches!(err, BoxliteError::InvalidArgument(_)),
            "got: {err:?}"
        );
        let err = err.to_string();
        assert!(
            err.contains("Group 'nonexistent_group' not found"),
            "got: {}",
            err
        );
    }

    // ==================
    // Error: leading colon / just colon
    // ==================

    #[test]
    fn test_resolve_user_leading_colon_errors() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        // ":1000" → user_part="" → u32 parse fails → tries find_user_in_passwd("") → not found
        let err = resolve_user(r, ":1000").unwrap_err();
        assert!(
            matches!(err, BoxliteError::InvalidArgument(_)),
            "got: {err:?}"
        );
    }

    #[test]
    fn test_resolve_user_just_colon_errors() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        // ":" → user_part="", group_part="" → user lookup fails
        let err = resolve_user(r, ":").unwrap_err();
        assert!(
            matches!(err, BoxliteError::InvalidArgument(_)),
            "got: {err:?}"
        );
    }

    // ==================
    // Whitespace rejected
    // ==================

    #[test]
    fn test_resolve_user_whitespace_rejected() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        // Leading/trailing whitespace: u32 parse rejects, name not in passwd
        assert!(resolve_user(r, " root").is_err());
        assert!(resolve_user(r, "root ").is_err());
        assert!(resolve_user(r, " 1000").is_err());
        assert!(resolve_user(r, "1000 ").is_err());
    }

    // ==================
    // Missing /etc/passwd
    // ==================

    #[test]
    fn test_resolve_user_no_passwd_numeric_ok() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path().to_str().unwrap();
        assert_eq!(resolve_user(r, "").unwrap(), (0, 0));
        assert_eq!(resolve_user(r, "0").unwrap(), (0, 0));
        assert_eq!(resolve_user(r, "1000:1000").unwrap(), (1000, 1000));
    }

    #[test]
    fn test_resolve_user_no_passwd_name_errors() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path().to_str().unwrap();
        let err = resolve_user(r, "abc").unwrap_err().to_string();
        assert!(err.contains("failed to read"), "got: {}", err);
    }

    // ==================
    // Empty /etc/passwd file
    // ==================

    #[test]
    fn test_resolve_user_empty_passwd_file() {
        let dir = tempfile::tempdir().unwrap();
        let etc = dir.path().join("etc");
        fs::create_dir_all(&etc).unwrap();
        fs::write(etc.join("passwd"), "").unwrap();
        let r = dir.path().to_str().unwrap();

        // Numeric UID: passwd exists but empty → GID defaults to 0
        assert_eq!(resolve_user(r, "1000").unwrap(), (1000, 0));
        // Name lookup: passwd exists but user not found
        let err = resolve_user(r, "abc").unwrap_err().to_string();
        assert!(err.contains("User 'abc' not found"), "got: {}", err);
    }

    // ==================
    // Malformed /etc/passwd lines
    // ==================

    #[test]
    fn test_resolve_user_malformed_passwd_lines_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let etc = dir.path().join("etc");
        fs::create_dir_all(&etc).unwrap();

        // Mix of malformed and valid lines
        fs::write(
            etc.join("passwd"),
            "short\n\
             :::\n\
             onlyname:x\n\
             abc:x:1000:1001::/home/abc:/bin/sh\n",
        )
        .unwrap();

        let r = dir.path().to_str().unwrap();
        // Valid entry after malformed lines should still be found
        assert_eq!(resolve_user(r, "abc").unwrap(), (1000, 1001));
        // Malformed entries are silently skipped (not enough fields to match)
        let err = resolve_user(r, "short").unwrap_err().to_string();
        assert!(err.contains("User 'short' not found"), "got: {}", err);
    }

    // ==================
    // Privileged (DinD) plumbing
    // ==================

    #[test]
    fn cgroup_limits_from_proto() {
        assert_eq!(ContainerCgroup::from_proto(true, None).limits, None);
        let zero = ProtoContainerResources::default();
        assert_eq!(ContainerCgroup::from_proto(true, Some(zero)).limits, None);

        let cgroup = ContainerCgroup::from_proto(
            true,
            Some(ProtoContainerResources {
                cpu_quota_us: 50_000,
                cpu_period_us: 100_000,
                memory_limit_bytes: 1 << 30,
                pids_limit: 0,
            }),
        );
        assert!(cgroup.namespace);
        assert_eq!(
            cgroup.limits,
            Some(CgroupLimits {
                cpu_quota_us: 50_000,
                cpu_period_us: 100_000,
                memory_limit_bytes: 1 << 30,
                pids_limit: 0,
            })
        );
    }

    #[test]
    fn a_mount_destination_names_the_path_the_runtime_covers() {
        assert_eq!(
            canonical_destination(Path::new("/workspace/../tmp")),
            PathBuf::from("/tmp")
        );
        assert_eq!(
            canonical_destination(Path::new("/tmp/./inner")),
            PathBuf::from("/tmp/inner")
        );
        // Nowhere above the rootfs to go, so it clamps rather than escapes.
        assert_eq!(
            canonical_destination(Path::new("/../../etc")),
            PathBuf::from("/etc")
        );
        // A destination already canonical is returned unchanged.
        assert_eq!(
            canonical_destination(Path::new("/dev/shm")),
            PathBuf::from("/dev/shm")
        );
    }
}
