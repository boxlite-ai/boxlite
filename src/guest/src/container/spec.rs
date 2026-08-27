//! OCI runtime specification builder
//!
//! Creates OCI-compliant runtime specifications following the runtime-spec standard.

use super::capabilities::CapabilitySet;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use boxlite_shared::ContainerDevice as ProtoContainerDevice;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Component, Path, PathBuf};

use oci_spec::runtime::{
    LinuxBuilder, LinuxDevice, LinuxDeviceBuilder, LinuxDeviceType, LinuxIdMappingBuilder,
    LinuxNamespaceBuilder, LinuxNamespaceType, Mount, MountBuilder, PosixRlimitBuilder,
    PosixRlimitType, ProcessBuilder, RootBuilder, Spec, SpecBuilder, UserBuilder,
};

/// Host-resolved source/options override for one of the guest's own standard
/// mounts. Which mount is a separate concern, handled at the RPC boundary
/// (`container::mount_override`) before this is ever built — by the time
/// one of these exists, its two fields are already known to belong to `/sys`,
/// so the type itself doesn't need to say so.
#[derive(Debug, Clone)]
pub struct MountOverride {
    pub source: String,
    pub options: Vec<String>,
}

/// User-specified bind mount for container
#[derive(Debug, Clone)]
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
#[derive(Debug, Default)]
pub struct ContainerDevices(Vec<LinuxDevice>);

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

    fn as_slice(&self) -> &[LinuxDevice] {
        &self.0
    }
}

/// Read a guest device node's type and numbers, and describe it as the OCI
/// device the container should get.
fn resolve_device(device: ProtoContainerDevice) -> BoxliteResult<LinuxDevice> {
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
    let typ = if metadata.file_type().is_char_device() {
        LinuxDeviceType::C
    } else if metadata.file_type().is_block_device() {
        LinuxDeviceType::B
    } else {
        return Err(unsupported_device(
            &source,
            "is not a character or block device".to_string(),
        ));
    };
    let rdev = metadata.rdev();
    let (Ok(major), Ok(minor)) = (
        i64::try_from(nix::sys::stat::major(rdev)),
        i64::try_from(nix::sys::stat::minor(rdev)),
    ) else {
        return Err(unsupported_device(
            &source,
            "has unsupported device numbers".to_string(),
        ));
    };

    let mut builder = LinuxDeviceBuilder::default()
        .path(&destination)
        .typ(typ)
        .major(major)
        .minor(minor)
        .uid(0u32)
        .gid(0u32);
    if let Some(file_mode) = device.file_mode {
        builder = builder.file_mode(file_mode);
    }

    builder
        .build()
        .map_err(|error| unsupported_device(&destination, format!("is not mappable: {error}")))
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

/// Create OCI runtime specification with default configuration
///
/// Builds an OCI spec with:
/// - Standard mounts (/proc, /dev, /sys, etc.)
/// - User-specified bind mounts (volumes)
/// - Resolved default and user-requested capabilities
/// - Standard namespaces (pid, ipc, uts, mount)
/// - UID/GID mappings for user namespace
/// - Configurable user (resolved uid/gid)
/// - Resource limits (rlimits)
/// - No new privileges disabled (allows sudo)
///
/// Build an OCI spec from the atomic security choices resolved by the host.
#[allow(clippy::too_many_arguments)]
pub fn create_oci_spec(
    container_id: &str,
    rootfs: &str,
    entrypoint: &[String],
    env: &[String],
    workdir: &str,
    uid: u32,
    gid: u32,
    capabilities: &CapabilitySet,
    readonly_paths: &[String],
    mount_override: &MountOverride,
    bundle_path: &Path,
    user_mounts: &[UserMount],
    tty: bool,
    devices: &ContainerDevices,
) -> BoxliteResult<Spec> {
    let caps = capabilities.to_oci()?;
    tracing::info!(
        container_id,
        mount_source = mount_override.source,
        mount_options = ?mount_override.options,
        readonly_paths_count = readonly_paths.len(),
        "building container spec"
    );
    let namespaces = build_default_namespaces()?;
    let mut mounts = build_standard_mounts(bundle_path, mount_override.clone())?;

    // Add user-specified bind mounts
    for user_mount in user_mounts {
        let options = if user_mount.read_only {
            vec!["bind".to_string(), "ro".to_string()]
        } else {
            vec!["bind".to_string(), "rw".to_string()]
        };

        mounts.push(
            MountBuilder::default()
                .destination(&user_mount.destination)
                .typ("bind")
                .source(&user_mount.source)
                .options(options)
                .build()
                .map_err(|e| {
                    BoxliteError::Internal(format!(
                        "Failed to build user mount {} → {}: {}",
                        user_mount.source, user_mount.destination, e
                    ))
                })?,
        );

        tracing::debug!(
            source = %user_mount.source,
            destination = %user_mount.destination,
            read_only = user_mount.read_only,
            "Added user bind mount to OCI spec"
        );
    }

    let process = build_process_spec(entrypoint, env, workdir, uid, gid, caps, tty)?;
    let root = build_root_spec(rootfs)?;
    let linux = build_linux_spec(
        container_id,
        namespaces,
        devices.as_slice(),
        readonly_paths.to_vec(),
    )?;

    SpecBuilder::default()
        .version("1.0.2")
        .hostname("boxlite")
        .root(root)
        .mounts(mounts)
        .process(process)
        .linux(linux)
        .build()
        .map_err(|e| BoxliteError::Internal(format!("Failed to build OCI spec: {}", e)))
}

/// Destinations of every mount `spec` declares, in spec order.
///
/// Kept next to the builder so the two cannot drift: a mount added above is
/// reported here without anyone having to remember to.
pub(super) fn mount_destinations(spec: &Spec) -> Vec<PathBuf> {
    spec.mounts()
        .iter()
        .flatten()
        .map(|mount| canonical_destination(mount.destination()))
        .collect()
}

/// A mount destination as the path it actually covers.
///
/// `UserMount::destination` is caller-supplied text that reaches the spec
/// unchanged, and the runtime resolves it against the rootfs when it mounts —
/// so `/workspace/../tmp` mounts over `/tmp`. Cached verbatim it would compare
/// equal to neither, and the copy path's reachability check would wave through
/// a write that lands under the mount after all. Collapsing the path here is
/// what keeps that check honest about what is mounted where.
///
/// Lexical on purpose: the kernel's own resolution of a `..` that crosses a
/// symlink can differ, so a destination is normalized, never trusted as proof
/// the mount is where it claims.
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

// ====================
// User Resolution
// ====================

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
            (uid, find_gid_for_uid(rootfs, uid))
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
            Ok(gid) => gid,
            Err(_) => find_group_in_group_file(rootfs, g)?,
        },
        _ => passwd_gid.unwrap_or(0),
    };

    Ok((uid, gid))
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
            return Ok((uid, gid));
        }
    }

    Err(BoxliteError::Internal(format!(
        "User '{}' not found in {}",
        name,
        path.display()
    )))
}

/// Find primary GID for numeric UID in /etc/passwd. Returns None if not found.
///
/// Best-effort: numeric UIDs work without /etc/passwd (GID defaults to 0).
/// Docker silently ignores missing passwd for numeric UIDs. We do the same.
fn find_gid_for_uid(rootfs: &str, uid: u32) -> Option<u32> {
    let path = Path::new(rootfs).join("etc/passwd");
    let content = std::fs::read_to_string(&path).ok()?;
    // Scan for a passwd entry whose UID field (fields[2]) matches,
    // then return its primary GID (fields[3]).
    for line in content.lines() {
        let f: Vec<&str> = line.splitn(7, ':').collect();
        if f.len() >= 4 {
            if let Ok(entry_uid) = f[2].parse::<u32>() {
                if entry_uid == uid {
                    return f[3].parse().ok();
                }
            }
        }
    }
    None
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
            return f[2].parse::<u32>().map_err(|_| {
                BoxliteError::Internal(format!(
                    "Invalid GID '{}' for group '{}' in {}",
                    f[2],
                    name,
                    path.display()
                ))
            });
        }
    }

    Err(BoxliteError::Internal(format!(
        "Group '{}' not found in {}",
        name,
        path.display()
    )))
}

// ====================
// Spec Component Builders
// ====================

/// Build default namespaces for container isolation.
///
/// No cgroup namespace: tested and found unnecessary for DinD (see
/// docs/architecture/privileged-mode-design.md, Trade-offs) — `dockerd`
/// tolerates writing cgroup limits without a private cgroup namespace view.
fn build_default_namespaces() -> BoxliteResult<Vec<oci_spec::runtime::LinuxNamespace>> {
    Ok(vec![
        build_namespace(LinuxNamespaceType::Pid)?,
        build_namespace(LinuxNamespaceType::Ipc)?,
        build_namespace(LinuxNamespaceType::Uts)?,
        build_namespace(LinuxNamespaceType::Mount)?,
        // build_namespace(LinuxNamespaceType::User)?,
    ])
}

/// Build a single namespace specification
fn build_namespace(typ: LinuxNamespaceType) -> BoxliteResult<oci_spec::runtime::LinuxNamespace> {
    LinuxNamespaceBuilder::default()
        .typ(typ)
        .build()
        .map_err(|e| BoxliteError::Internal(format!("Failed to build {:?} namespace: {}", typ, e)))
}

/// Build process specification
fn build_process_spec(
    entrypoint: &[String],
    env: &[String],
    workdir: &str,
    uid: u32,
    gid: u32,
    caps: oci_spec::runtime::LinuxCapabilities,
    tty: bool,
) -> BoxliteResult<oci_spec::runtime::Process> {
    let user = UserBuilder::default()
        .uid(uid)
        .gid(gid)
        .build()
        .map_err(|e| BoxliteError::Internal(format!("Failed to build user spec: {}", e)))?;

    // Build rlimits
    // Set NOFILE to 1048576 to match Docker's defaults
    // This allows applications to open many files/connections (databases, web servers, etc.)
    #[allow(unused)]
    let rlimits = vec![PosixRlimitBuilder::default()
        .typ(PosixRlimitType::RlimitNofile)
        .hard(1024u64 * 1024u64)
        .soft(1024u64 * 1024u64)
        .build()
        .map_err(|e| BoxliteError::Internal(format!("Failed to build rlimit: {}", e)))?];

    ProcessBuilder::default()
        // OCI `process.terminal`: with it set, the runtime allocates a PTY for
        // init and passes the master back over the console socket.
        .terminal(tty)
        .user(user)
        .args(entrypoint.to_vec())
        .env(env)
        .cwd(workdir)
        .capabilities(caps)
        .rlimits(rlimits)
        .no_new_privileges(false) // Allow privilege escalation (needed for sudo)
        .build()
        .map_err(|e| BoxliteError::Internal(format!("Failed to build process spec: {}", e)))
}

/// Build an OCI `Process` for a TTY tenant exec, with `terminal=true`.
///
/// libcontainer 0.6's `check_terminal` rejects a console socket unless the
/// process declares `terminal=true` (and the build is detached). The tenant
/// builder has no per-exec terminal setter, so this Process is serialized to a
/// process.json and passed via `ContainerBuilder::with_process`. Same shape as
/// `build_process_spec` but with the terminal flag on.
pub(crate) fn build_tty_exec_process(
    args: &[String],
    env: &[String],
    cwd: &str,
    uid: u32,
    gid: u32,
    capabilities: CapabilitySet,
) -> BoxliteResult<oci_spec::runtime::Process> {
    let user = UserBuilder::default()
        .uid(uid)
        .gid(gid)
        .build()
        .map_err(|e| BoxliteError::Internal(format!("Failed to build user spec: {}", e)))?;

    ProcessBuilder::default()
        .terminal(true)
        .user(user)
        .args(args.to_vec())
        .env(env)
        .cwd(cwd)
        .capabilities(capabilities.to_oci()?)
        .no_new_privileges(false)
        .build()
        .map_err(|e| BoxliteError::Internal(format!("Failed to build tty exec process: {}", e)))
}

/// Build root filesystem specification
fn build_root_spec(rootfs: &str) -> BoxliteResult<oci_spec::runtime::Root> {
    RootBuilder::default()
        .path(rootfs)
        .readonly(false)
        .build()
        .map_err(|e| BoxliteError::Internal(format!("Failed to build root spec: {}", e)))
}

/// Build Linux-specific configuration
///
/// `readonly_paths` is a host-resolved literal OCI value, assigned verbatim —
/// the guest no longer decides what "unconfined" means for it (see
/// docs/architecture/privileged-mode-design.md, Trade-offs, option F).
/// Masked paths are deliberately absent here: nothing in the DinD workflow
/// reads a masked path, so this never calls `.masked_paths(..)` at all and
/// the builder fills its own oci-spec default, unconditionally, exactly as it
/// did before `privileged` existed.
fn build_linux_spec(
    container_id: &str,
    namespaces: Vec<oci_spec::runtime::LinuxNamespace>,
    devices: &[LinuxDevice],
    readonly_paths: Vec<String>,
) -> BoxliteResult<oci_spec::runtime::Linux> {
    // UID/GID mappings for user namespace
    // Map full range of UIDs/GIDs to allow non-root users (nginx=33, etc.)
    let uid_mappings = vec![LinuxIdMappingBuilder::default()
        .host_id(0u32)
        .container_id(0u32)
        .size(65536u32)  // Map 0-65535 to cover all common users
        .build()
        .map_err(|e| BoxliteError::Internal(format!("Failed to build UID mapping: {}", e)))?];

    let gid_mappings = vec![LinuxIdMappingBuilder::default()
        .host_id(0u32)
        .container_id(0u32)
        .size(65536u32)  // Map 0-65535 to cover all common groups
        .build()
        .map_err(|e| BoxliteError::Internal(format!("Failed to build GID mapping: {}", e)))?];

    // The cgroup namespace gets its view from the guest init's cgroup2 mount;
    // no per-container resource limits are configured by this OCI spec.
    let _ = container_id; // Suppress unused warning

    let mut builder = LinuxBuilder::default()
        .namespaces(namespaces)
        .uid_mappings(uid_mappings)
        .gid_mappings(gid_mappings)
        .readonly_paths(readonly_paths);

    // No device-cgroup rule: tested and found unnecessary for DinD (see
    // docs/architecture/privileged-mode-design.md, Trade-offs) — the guest
    // never enforced a restrictive device-cgroup default in the first place.

    // Leave `devices` unset when empty so the spec keeps its historical shape.
    if !devices.is_empty() {
        builder = builder.devices(devices.to_vec());
    }

    builder
        // .cgroups_path(cgroups_path)
        .build()
        .map_err(|e| BoxliteError::Internal(format!("Failed to build linux spec: {}", e)))
}

/// Build standard mounts for container filesystem
///
/// `mount_override` is the host-resolved, literal source and option list for
/// the `/sys` bind — assigned verbatim, no flag to reinterpret (see
/// docs/architecture/privileged-mode-design.md, Trade-offs, option F).
fn build_standard_mounts(
    bundle_path: &Path,
    mount_override: MountOverride,
) -> BoxliteResult<Vec<Mount>> {
    let dev_mount_options = vec![
        "nosuid".to_string(),
        "strictatime".to_string(),
        "mode=755".to_string(),
        "size=65536k".to_string(),
    ];
    let mut mounts = vec![
        // /proc - Process information
        MountBuilder::default()
            .destination("/proc")
            .typ("proc")
            .source("proc")
            .build()
            .map_err(|e| BoxliteError::Internal(format!("Failed to build /proc mount: {}", e)))?,
        // /dev - Device filesystem. Privileged containers keep the same
        // guest-local tmpfs but receive an allow-all device cgroup rule, so
        // device nodes can be explicitly injected or created in the guest.
        MountBuilder::default()
            .destination("/dev")
            .typ("tmpfs")
            .source("tmpfs")
            .options(dev_mount_options)
            .build()
            .map_err(|e| BoxliteError::Internal(format!("Failed to build /dev mount: {}", e)))?,
        // /dev/pts - Pseudo-terminals
        MountBuilder::default()
            .destination("/dev/pts")
            .typ("devpts")
            .source("devpts")
            .options(vec![
                "nosuid".to_string(),
                "noexec".to_string(),
                "newinstance".to_string(),
                "ptmxmode=0666".to_string(),
                "mode=0620".to_string(),
            ])
            .build()
            .map_err(|e| {
                BoxliteError::Internal(format!("Failed to build /dev/pts mount: {}", e))
            })?,
        // /dev/shm - Shared memory
        MountBuilder::default()
            .destination("/dev/shm")
            .typ("tmpfs")
            .source("shm")
            .options(vec![
                "nosuid".to_string(),
                "noexec".to_string(),
                "nodev".to_string(),
                "mode=1777".to_string(),
                "size=65536k".to_string(),
            ])
            .build()
            .map_err(|e| {
                BoxliteError::Internal(format!("Failed to build /dev/shm mount: {}", e))
            })?,
        // NOTE: /dev/mqueue removed - libkrunfw kernel doesn't have CONFIG_POSIX_MQUEUE
        // Most containers don't need POSIX message queues
        // /sys - Sysfs. Source and options are the host's resolved values
        // verbatim (see the `rro`-vs-`ro` note where the guest's cgroup2
        // submount lives).
        MountBuilder::default()
            .destination("/sys")
            .typ("none")
            .source(mount_override.source)
            .options(mount_override.options)
            .build()
            .map_err(|e| BoxliteError::Internal(format!("Failed to build /sys mount: {}", e)))?,
        // The guest init mounts cgroup2 at /sys/fs/cgroup. It is carried in as
        // a submount of the recursive /sys bind, so it is the `rro` above —
        // not a plain `ro` — that keeps it read-only for an ordinary
        // container; a privileged container gets it writable.
        // /tmp - Temporary filesystem
        MountBuilder::default()
            .destination("/tmp")
            .typ("tmpfs")
            .source("tmpfs")
            .options(vec![
                "nosuid".to_string(),
                "nodev".to_string(),
                "mode=1777".to_string(),
            ])
            .build()
            .map_err(|e| BoxliteError::Internal(format!("Failed to build /tmp mount: {}", e)))?,
    ];

    // Bind-mount /etc/hostname, /etc/hosts, /etc/resolv.conf from the bundle
    // dir into the container. Uses rbind + rprivate (matching Docker defaults).
    let etc_mounts: &[(&str, &str)] = &[
        ("hostname", "/etc/hostname"),
        ("hosts", "/etc/hosts"),
        ("resolv.conf", "/etc/resolv.conf"),
    ];
    for (file, dest) in etc_mounts {
        let source = bundle_path.join(file);
        mounts.push(
            MountBuilder::default()
                .destination(*dest)
                .typ("bind")
                .source(
                    source
                        .to_str()
                        .ok_or_else(|| BoxliteError::Internal(format!("Invalid {} path", file)))?,
                )
                .options(vec!["rbind".to_string(), "rprivate".to_string()])
                .build()
                .map_err(|e| {
                    BoxliteError::Internal(format!("Failed to build {} mount: {}", dest, e))
                })?,
        );
    }

    Ok(mounts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::container::capabilities::CapabilitySet;
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

        let linux = build_linux_spec("test-box", vec![], devices.as_slice(), Vec::new()).unwrap();
        let mapped = linux.devices().as_ref().expect("mapped device");
        assert_eq!(mapped.len(), 1);
        let device = &mapped[0];
        assert_eq!(device.path(), Path::new("/dev/test-device"));
        assert_eq!(device.typ(), LinuxDeviceType::C);
        assert_eq!(device.major() as u64, nix::sys::stat::major(source));
        assert_eq!(device.minor() as u64, nix::sys::stat::minor(source));
        assert_eq!(device.file_mode(), Some(0o666));
        assert_eq!(device.uid(), Some(0));
        assert_eq!(device.gid(), Some(0));
    }

    #[test]
    fn empty_device_mapping_adds_no_devices() {
        let linux = build_linux_spec(
            "test-box",
            vec![],
            ContainerDevices::default().as_slice(),
            Vec::new(),
        )
        .unwrap();

        assert!(linux.devices().is_none());
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
    fn tty_exec_process_uses_resolved_capabilities() {
        let resolved = CapabilitySet::resolve(&["SYS_ADMIN".to_string()], &["NET_RAW".to_string()])
            .expect("resolve capabilities for tty exec");
        let expected = resolved
            .to_oci()
            .expect("build expected OCI capability sets");

        let process = build_tty_exec_process(
            &["sh".to_string()],
            &["PATH=/bin".to_string()],
            "/",
            0,
            0,
            resolved.clone(),
        )
        .expect("build tty exec process");

        assert_eq!(process.terminal(), Some(true));
        let capabilities = process
            .capabilities()
            .as_ref()
            .expect("tty exec process should have capabilities");
        assert_eq!(capabilities.bounding(), expected.bounding());
        assert_eq!(capabilities.effective(), expected.effective());
        assert_eq!(capabilities.permitted(), expected.permitted());
        assert_eq!(capabilities.inheritable(), &None);
        assert_eq!(capabilities.ambient(), &None);
    }

    // ==================
    // Empty / root
    // ==================

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
        let err = resolve_user(r, "nonexistent").unwrap_err().to_string();
        assert!(err.contains("User 'nonexistent' not found"), "got: {}", err);
    }

    #[test]
    fn test_resolve_user_unknown_group_errors() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        let err = resolve_user(r, "abc:nonexistent_group")
            .unwrap_err()
            .to_string();
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
        assert!(resolve_user(r, ":1000").is_err());
    }

    #[test]
    fn test_resolve_user_just_colon_errors() {
        let rootfs = make_test_rootfs();
        let r = rootfs.path().to_str().unwrap();
        // ":" → user_part="", group_part="" → user lookup fails
        assert!(resolve_user(r, ":").is_err());
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

    /// `build_linux_spec` assigns whatever readonly paths it is given,
    /// verbatim — it no longer decides what "unconfined" means for them (see
    /// docs/architecture/privileged-mode-design.md, Trade-offs, option F).
    /// The privileged-vs-hardened decision itself is tested where it's made:
    /// `advanced_options::resolve_container_security`. Masked paths are
    /// deliberately absent from the function's inputs — see the next test.
    #[test]
    fn linux_spec_assigns_host_resolved_readonly_paths_verbatim() {
        let devices = ContainerDevices::default();
        let readonly = vec!["/proc/sys".to_string()];

        let linux = build_linux_spec("c", vec![], devices.as_slice(), readonly.clone()).unwrap();

        assert_eq!(linux.readonly_paths().as_deref(), Some(readonly.as_slice()));
    }

    /// Nothing in the DinD workflow reads a masked path (see
    /// docs/architecture/privileged-mode-design.md, Trade-offs), so
    /// `build_linux_spec` never calls `.masked_paths(..)` at all — this stays
    /// at oci-spec's own default regardless of what `readonly_paths` carries.
    /// Pinned to the exact list for the same no-silent-drift reason as
    /// `advanced_options::unprivileged_resolves_hardened_path_defaults`.
    #[test]
    fn linux_spec_never_touches_masked_paths() {
        let devices = ContainerDevices::default();
        let expected_default = oci_spec::runtime::get_default_maskedpaths();

        let hardened = build_linux_spec(
            "c",
            vec![],
            devices.as_slice(),
            vec!["/proc/sys".to_string()],
        )
        .unwrap();
        let unconfined = build_linux_spec("c", vec![], devices.as_slice(), Vec::new()).unwrap();

        assert_eq!(
            hardened.masked_paths().as_deref(),
            Some(expected_default.as_slice())
        );
        assert_eq!(
            unconfined.masked_paths().as_deref(),
            Some(expected_default.as_slice())
        );

        // Device-cgroup policy no longer varies with path shape either —
        // tested and found unnecessary for DinD; both get whatever oci-spec's
        // own Linux::default() supplies, unmodified.
        assert_eq!(hardened.resources(), unconfined.resources());
    }

    /// `build_standard_mounts` assigns the `/sys` bind's source and options
    /// verbatim — no flag to reinterpret. The actual `rro`-vs-writable
    /// decision is tested where it's made:
    /// `advanced_options::mount_options`.
    #[test]
    fn sys_bind_uses_host_resolved_source_and_options_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        // Deliberately not the real "/sys": proves the value is threaded
        // through rather than hardcoded to coincidentally match.
        let source = "/sys-from-host".to_string();
        let options = vec![
            "rbind".to_string(),
            "nosuid".to_string(),
            "noexec".to_string(),
            "nodev".to_string(),
            "rro".to_string(),
        ];

        let mount_override = MountOverride {
            source: source.clone(),
            options: options.clone(),
        };
        let mounts = build_standard_mounts(dir.path(), mount_override).unwrap();
        let sys = mounts
            .iter()
            .find(|mount| mount.destination().to_str() == Some("/sys"))
            .expect("/sys mount");

        assert_eq!(sys.source().as_deref(), Some(Path::new(&source)));
        assert_eq!(sys.options().as_deref(), Some(options.as_slice()));
    }

    /// Capabilities and the OCI path/mount shape are separate knobs the host
    /// resolves independently: `create_oci_spec` threads `readonly_paths` and
    /// `mount_override` straight through, with no branching of its own —
    /// a full capability set does not silently relax the shape.
    #[test]
    fn create_oci_spec_threads_security_fields_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = dir.path();
        let Ok(full_caps) = CapabilitySet::resolve(&["ALL".to_string()], &[]) else {
            // Reading the kernel ceiling needs a live /proc; skip where absent
            // rather than assert on an environment this test does not control.
            return;
        };

        let spec_for = |readonly_paths: Vec<String>, options: Vec<String>| {
            let mount_override = MountOverride {
                source: "/sys".to_string(),
                options,
            };
            create_oci_spec(
                "c",
                "/rootfs",
                &["/bin/sh".to_string()],
                &[],
                "/",
                0,
                0,
                &full_caps,
                &readonly_paths,
                &mount_override,
                bundle,
                &[],
                false,
                &ContainerDevices::default(),
            )
            .expect("spec builds")
        };

        let hardened = spec_for(
            vec!["/proc/sys".to_string()],
            vec![
                "rbind".to_string(),
                "nosuid".to_string(),
                "noexec".to_string(),
                "nodev".to_string(),
                "rro".to_string(),
            ],
        );
        let linux = hardened.linux().as_ref().expect("linux section");
        assert_eq!(
            linux.readonly_paths().as_deref(),
            Some(["/proc/sys".to_string()].as_slice())
        );

        let unconfined = spec_for(
            Vec::new(),
            vec![
                "rbind".to_string(),
                "nosuid".to_string(),
                "noexec".to_string(),
                "nodev".to_string(),
            ],
        );
        let linux = unconfined.linux().as_ref().expect("linux section");
        assert!(linux
            .readonly_paths()
            .as_ref()
            .is_some_and(|p| p.is_empty()));
        // Masked paths never move with the hardened/unconfined shape — both
        // specs get the same oci-spec default, unconditionally (see
        // linux_spec_never_touches_masked_paths).
        assert_eq!(
            hardened.linux().as_ref().unwrap().masked_paths(),
            linux.masked_paths()
        );

        let sys_mount = unconfined
            .mounts()
            .as_ref()
            .expect("mount list")
            .iter()
            .find(|mount| mount.destination() == Path::new("/sys"))
            .expect("/sys mount");
        assert!(!sys_mount.options().as_ref().is_some_and(|options| options
            .iter()
            .any(|option| option == "ro" || option == "rro")));

        let dev_mount = unconfined
            .mounts()
            .as_ref()
            .expect("mount list")
            .iter()
            .find(|mount| mount.destination() == Path::new("/dev"))
            .expect("/dev mount");
        assert_eq!(dev_mount.typ().as_deref(), Some("tmpfs"));
        assert_eq!(dev_mount.source().as_deref(), Some(Path::new("tmpfs")));
    }

    /// A `..` or `.` in a mount destination reaches the spec unchanged — it is
    /// caller-supplied text — and the runtime resolves it when it mounts. The
    /// cached list has to name the path actually covered, or file transfer's
    /// reachability check compares a request against a destination nothing is
    /// mounted on and waves the write through into the shadow.
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

    /// A container answers `mount_destinations()` from the spec object it built,
    /// not by re-reading `config.json`. The two must name the same mounts, or
    /// file transfer would guard a mount list the runtime never applied.
    ///
    /// Round-tripped through `save`/`load` rather than compared to a literal:
    /// the risk is a field that survives in memory but not on disk, which only
    /// a real serialize/deserialize can show.
    #[test]
    fn mount_destinations_survive_the_config_json_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = dir.path();
        let user_mounts = [UserMount {
            source: "/run/boxlite/volumes/data".to_string(),
            destination: "/workspace/data".to_string(),
            read_only: false,
            owner_uid: 0,
            owner_gid: 0,
        }];

        let spec = create_oci_spec(
            "c",
            "/rootfs",
            &["/bin/sh".to_string()],
            &[],
            "/",
            0,
            0,
            &CapabilitySet::default(),
            &[],
            &MountOverride {
                source: "/sys".to_string(),
                options: vec!["rbind".to_string(), "rro".to_string()],
            },
            bundle,
            &user_mounts,
            false,
            &ContainerDevices::default(),
        )
        .expect("spec builds");

        let config_path = bundle.join("config.json");
        spec.save(&config_path).expect("spec saves");
        let reloaded = Spec::load(&config_path).expect("spec loads");

        assert_eq!(
            mount_destinations(&spec),
            mount_destinations(&reloaded),
            "the cached list must equal what reading config.json back gives"
        );
        // Both halves of what file transfer guards: the standard mounts the
        // guest always applies, and the volume the caller asked for.
        for expected in ["/tmp", "/dev/shm", "/proc", "/sys", "/workspace/data"] {
            assert!(
                mount_destinations(&spec).contains(&PathBuf::from(expected)),
                "{expected} missing from {:?}",
                mount_destinations(&spec)
            );
        }
    }
}
