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
/// - Configurable user (parsed from OCI user string, defaults to root)
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
    user: &str,
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

    let process = build_process_spec(entrypoint, env, workdir, user, caps)?;
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
// User Parsing
// ====================

/// Parse OCI user string into (uid, gid).
///
/// Supports formats:
/// - `"uid"` → (uid, 0)
/// - `"uid:gid"` → (uid, gid)
///
/// Non-numeric usernames (e.g., "nginx") are not resolved here;
/// username-to-uid resolution requires reading /etc/passwd inside the rootfs.
fn parse_user_string(user: &str) -> BoxliteResult<(u32, u32)> {
    if user.is_empty() {
        return Ok((0, 0));
    }

    if let Some((uid_str, gid_str)) = user.split_once(':') {
        let uid = uid_str.parse::<u32>().map_err(|_| {
            BoxliteError::Internal(format!(
                "Non-numeric UID '{}' in user '{}'. Use numeric UID:GID format (e.g., '1000:1000')",
                uid_str, user
            ))
        })?;
        let gid = gid_str.parse::<u32>().map_err(|_| {
            BoxliteError::Internal(format!(
                "Non-numeric GID '{}' in user '{}'. Use numeric UID:GID format (e.g., '1000:1000')",
                gid_str, user
            ))
        })?;
        Ok((uid, gid))
    } else {
        let uid = user.parse::<u32>().map_err(|_| {
            BoxliteError::Internal(format!(
                "Non-numeric user '{}'. Use numeric UID or UID:GID format (e.g., '1000' or '1000:1000')",
                user
            ))
        })?;
        Ok((uid, 0))
    }
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
    user_str: &str,
    caps: oci_spec::runtime::LinuxCapabilities,
) -> BoxliteResult<oci_spec::runtime::Process> {
    let (uid, gid) = parse_user_string(user_str)?;
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

    #[test]
    fn test_parse_user_empty_defaults_to_root() {
        assert_eq!(parse_user_string("").unwrap(), (0, 0));
    }

    #[test]
    fn test_parse_user_uid_only() {
        assert_eq!(parse_user_string("1000").unwrap(), (1000, 0));
    }

    #[test]
    fn test_parse_user_uid_gid() {
        assert_eq!(parse_user_string("1000:1000").unwrap(), (1000, 1000));
    }

    #[test]
    fn test_parse_user_root_explicit() {
        assert_eq!(parse_user_string("0:0").unwrap(), (0, 0));
    }

    #[test]
    fn test_parse_user_non_numeric_name_errors() {
        let err = parse_user_string("nginx").unwrap_err().to_string();
        assert!(err.contains("Non-numeric user 'nginx'"), "got: {}", err);
    }

    #[test]
    fn test_parse_user_non_numeric_gid_errors() {
        let err = parse_user_string("1000:nginx").unwrap_err().to_string();
        assert!(err.contains("Non-numeric GID 'nginx'"), "got: {}", err);
    }

    #[test]
    fn test_parse_user_non_numeric_uid_in_pair_errors() {
        let err = parse_user_string("abc:123").unwrap_err().to_string();
        assert!(err.contains("Non-numeric UID 'abc'"), "got: {}", err);
    }
}
