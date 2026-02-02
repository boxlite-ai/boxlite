//! OCI runtime specification builder
//!
//! Creates OCI-compliant runtime specifications following the runtime-spec standard.

use super::capabilities::all_capabilities;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::path::Path;

use oci_spec::runtime::{
    LinuxBuilder, LinuxCapabilitiesBuilder, LinuxIdMappingBuilder, LinuxNamespaceBuilder,
    LinuxNamespaceType, Mount, MountBuilder, PosixRlimitBuilder, PosixRlimitType, ProcessBuilder,
    RootBuilder, Spec, SpecBuilder, UserBuilder,
};

/// User-specified bind mount for container
#[derive(Debug, Clone)]
pub struct UserMount {
    /// Source path in guest VM
    pub source: String,
    /// Destination path in container
    pub destination: String,
    /// Read-only mount
    pub read_only: bool,
}

/// Create OCI runtime specification with default configuration
///
/// Builds an OCI spec with:
/// - Standard mounts (/proc, /dev, /sys, etc.)
/// - User-specified bind mounts (volumes)
/// - Default capabilities (matching runc defaults)
/// - Standard namespaces (pid, ipc, uts, mount)
/// - UID/GID mappings for user namespace
/// - Configurable user (resolved uid/gid)
/// - Resource limits (rlimits)
/// - No new privileges disabled (allows sudo)
///
/// NOTE: Cgroups are disabled for performance (~105ms savings on container startup).
/// Since we're inside a VM with single-tenant isolation, cgroup resource limits
/// provide minimal benefit. See comments in build_default_namespaces() and
/// build_standard_mounts() to re-enable if needed.
#[allow(clippy::too_many_arguments)]
pub fn create_oci_spec(
    container_id: &str,
    rootfs: &str,
    entrypoint: &[String],
    env: &[String],
    workdir: &str,
    uid: u32,
    gid: u32,
    bundle_path: &Path,
    user_mounts: &[UserMount],
) -> BoxliteResult<Spec> {
    let caps = build_default_capabilities()?;
    let namespaces = build_default_namespaces()?;
    let mut mounts = build_standard_mounts(bundle_path)?;

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

    let process = build_process_spec(entrypoint, env, workdir, uid, gid, caps)?;
    let root = build_root_spec(rootfs)?;
    let linux = build_linux_spec(container_id, namespaces)?;

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

/// Build default Linux capabilities
///
/// Uses all 41 capabilities from the shared capabilities module.
/// This provides maximum compatibility but reduced security isolation.
fn build_default_capabilities() -> BoxliteResult<oci_spec::runtime::LinuxCapabilities> {
    let caps = all_capabilities();

    LinuxCapabilitiesBuilder::default()
        .bounding(caps.clone())
        .effective(caps.clone())
        .inheritable(caps.clone())
        .permitted(caps.clone())
        .ambient(caps)
        .build()
        .map_err(|e| BoxliteError::Internal(format!("Failed to build capabilities: {}", e)))
}

/// Build default namespaces for container isolation
fn build_default_namespaces() -> BoxliteResult<Vec<oci_spec::runtime::LinuxNamespace>> {
    Ok(vec![
        build_namespace(LinuxNamespaceType::Pid)?,
        build_namespace(LinuxNamespaceType::Ipc)?,
        build_namespace(LinuxNamespaceType::Uts)?,
        build_namespace(LinuxNamespaceType::Mount)?,
        // NOTE: Cgroup namespace disabled for performance
        // Mounting cgroup2 filesystem takes ~105ms due to kernel initialization overhead.
        // Since we're inside a VM with single-tenant isolation, cgroup namespace provides
        // minimal additional security benefit. Re-enable if resource limits are needed.
        // build_namespace(LinuxNamespaceType::Cgroup)?,
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
        .terminal(false)
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

/// Build root filesystem specification
fn build_root_spec(rootfs: &str) -> BoxliteResult<oci_spec::runtime::Root> {
    RootBuilder::default()
        .path(rootfs)
        .readonly(false)
        .build()
        .map_err(|e| BoxliteError::Internal(format!("Failed to build root spec: {}", e)))
}

/// Build Linux-specific configuration
fn build_linux_spec(
    container_id: &str,
    namespaces: Vec<oci_spec::runtime::LinuxNamespace>,
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

    // Masked paths for security (hide sensitive /proc and /sys entries)
    #[allow(unused)]
    let masked_paths = vec![
        "/proc/acpi".to_string(),
        "/proc/asound".to_string(),
        "/proc/kcore".to_string(),
        "/proc/keys".to_string(),
        "/proc/latency_stats".to_string(),
        "/proc/timer_list".to_string(),
        "/proc/timer_stats".to_string(),
        "/proc/sched_debug".to_string(),
        "/sys/firmware".to_string(),
        "/sys/devices/virtual/powercap".to_string(),
    ];

    // Readonly paths
    #[allow(unused)]
    let readonly_paths = [
        "/proc/bus".to_string(),
        "/proc/fs".to_string(),
        "/proc/irq".to_string(),
        "/proc/sys".to_string(),
        "/proc/sysrq-trigger".to_string(),
    ];

    // NOTE: Cgroup path disabled for performance (see cgroup mount comment above)
    // Re-enable together with cgroup namespace and mount if resource limits are needed.
    // let cgroups_path = format!("/boxlite/{}", container_id);
    let _ = container_id; // Suppress unused warning

    LinuxBuilder::default()
        .namespaces(namespaces)
        .uid_mappings(uid_mappings)
        .gid_mappings(gid_mappings)
        // .masked_paths(masked_paths)
        // .readonly_paths(readonly_paths)
        // .cgroups_path(cgroups_path)
        .build()
        .map_err(|e| BoxliteError::Internal(format!("Failed to build linux spec: {}", e)))
}

/// Build standard mounts for container filesystem
fn build_standard_mounts(bundle_path: &Path) -> BoxliteResult<Vec<Mount>> {
    let mut mounts = vec![
        // /proc - Process information
        MountBuilder::default()
            .destination("/proc")
            .typ("proc")
            .source("proc")
            .build()
            .map_err(|e| BoxliteError::Internal(format!("Failed to build /proc mount: {}", e)))?,
        // /dev - Device filesystem
        MountBuilder::default()
            .destination("/dev")
            .typ("tmpfs")
            .source("tmpfs")
            .options(vec![
                "nosuid".to_string(),
                "strictatime".to_string(),
                "mode=755".to_string(),
                "size=65536k".to_string(),
            ])
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
        // /sys - Sysfs (readonly)
        MountBuilder::default()
            .destination("/sys")
            .typ("none")
            .source("/sys")
            .options(vec![
                "rbind".to_string(),
                "nosuid".to_string(),
                "noexec".to_string(),
                "nodev".to_string(),
                "ro".to_string(),
            ])
            .build()
            .map_err(|e| BoxliteError::Internal(format!("Failed to build /sys mount: {}", e)))?,
        // NOTE: /sys/fs/cgroup mount disabled for performance
        // Mounting cgroup2 filesystem takes ~105ms due to kernel cgroup hierarchy initialization.
        // This is the main bottleneck in container startup. Since we're inside a VM with
        // single-tenant isolation, cgroup resource limits provide minimal benefit.
        // Re-enable if you need to enforce CPU/memory limits within the container.
        //
        // MountBuilder::default()
        //     .destination("/sys/fs/cgroup")
        //     .typ("cgroup")
        //     .source("cgroup")
        //     .options(vec![
        //         "nosuid".to_string(),
        //         "noexec".to_string(),
        //         "nodev".to_string(),
        //         "relatime".to_string(),
        //         "ro".to_string(),
        //     ])
        //     .build()
        //     .map_err(|e| {
        //         BoxliteError::Internal(format!("Failed to build /sys/fs/cgroup mount: {}", e))
        //     })?,
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

    // Add /etc/hostname bind mount
    let hostname_path = bundle_path.join("hostname");
    mounts.push(
        MountBuilder::default()
            .destination("/etc/hostname")
            .typ("bind")
            .source(hostname_path.to_str().ok_or_else(|| {
                BoxliteError::Internal(format!(
                    "Invalid hostname path: {}",
                    hostname_path.display()
                ))
            })?)
            .options(vec!["bind".to_string(), "ro".to_string()])
            .build()
            .map_err(|e| {
                BoxliteError::Internal(format!("Failed to build /etc/hostname mount: {}", e))
            })?,
    );

    // Add /etc/hosts bind mount
    let hosts_path = bundle_path.join("hosts");
    mounts.push(
        MountBuilder::default()
            .destination("/etc/hosts")
            .typ("bind")
            .source(hosts_path.to_str().ok_or_else(|| {
                BoxliteError::Internal(format!("Invalid hosts path: {}", hosts_path.display()))
            })?)
            .options(vec!["bind".to_string(), "ro".to_string()])
            .build()
            .map_err(|e| {
                BoxliteError::Internal(format!("Failed to build /etc/hosts mount: {}", e))
            })?,
    );

    // Add /etc/resolv.conf bind mount
    let resolv_conf_path = bundle_path.join("resolv.conf");
    mounts.push(
        MountBuilder::default()
            .destination("/etc/resolv.conf")
            .typ("bind")
            .source(resolv_conf_path.to_str().ok_or_else(|| {
                BoxliteError::Internal(format!(
                    "Invalid resolv.conf path: {}",
                    resolv_conf_path.display()
                ))
            })?)
            .options(vec!["bind".to_string(), "ro".to_string()])
            .build()
            .map_err(|e| {
                BoxliteError::Internal(format!("Failed to build /etc/resolv.conf mount: {}", e))
            })?,
    );

    Ok(mounts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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
}
