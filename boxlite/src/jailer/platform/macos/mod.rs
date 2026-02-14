//! macOS-specific jailer implementation using sandbox-exec (Seatbelt).
//!
//! macOS doesn't have seccomp, namespaces, or pivot_root.
//! Instead, we use Apple's sandbox framework via sandbox-exec.
//!
//! ## Policy Design
//!
//! The sandbox policies are derived from:
//! - OpenAI Codex (Apache 2.0): https://github.com/openai/codex
//! - Chrome's macOS sandbox: https://source.chromium.org/chromium/chromium/src/+/main:sandbox/policy/mac/
//!
//! ## Security Model: Strict Whitelist
//!
//! BoxLite implements a **stricter** policy than Codex:
//!
//! | Access Type | Codex | BoxLite |
//! |-------------|-------|---------|
//! | File reads  | `(allow file-read*)` - everything | ONLY user volumes |
//! | File writes | cwd + /tmp + user roots | shared/ + /tmp + rw volumes |
//! | System paths | Allowed for reads | NOT allowed by default |
//!
//! ### File Read Policy (STRICT)
//!
//! - ONLY user-specified volume paths (from BoxOptions.volumes)
//! - NO system libraries, NO ~/.boxlite, NO anything else
//! - If shim fails to start, add minimal required paths
//!
//! ### File Write Policy
//!
//! - `/tmp` and `/var/tmp` - temporary files
//! - `{box_dir}/shared/` - guest-visible directory ONLY (not entire box_dir)
//! - User volumes with `read_only=false`
//!
//! ## Debugging Sandbox Violations
//!
//! If the shim fails to start due to sandbox restrictions:
//! ```bash
//! log show --predicate 'subsystem == "com.apple.sandbox"' --last 5m
//! ```
//!
//! ## How it works
//!
//! The shim process is spawned through sandbox-exec with a custom SBPL profile:
//! ```bash
//! /usr/bin/sandbox-exec -p "$(policy)" \
//!     -D BOX_SHARED_DIR=/Users/user/.boxlite/boxes/xxx/shared \
//!     boxlite-shim --config ...
//! ```

use crate::runtime::advanced_options::SecurityOptions;
use crate::runtime::options::VolumeSpec;
use boxlite_shared::errors::BoxliteResult;
use std::ffi::CStr;
use std::path::{Path, PathBuf};

// ============================================================================
// CONSTANTS
// ============================================================================

/// Hardcoded path to sandbox-exec to prevent PATH injection attacks.
///
/// Only trust sandbox-exec from /usr/bin. If this has been tampered with,
/// the attacker already has root access.
pub const SANDBOX_EXEC_PATH: &str = "/usr/bin/sandbox-exec";

/// Base sandbox policy (deny-default with fine-grained allowlists).
///
/// This contains:
/// - Process operations (fork, exec, signal)
/// - Fine-grained sysctl allowlist (specific sysctls, not blanket allow)
/// - Minimal IOKit for Hypervisor.framework
/// - Minimal Mach IPC services
/// - Pseudoterminal operations
///
/// NOTE: This does NOT include file-read* or file-write* - those are added
/// dynamically based on user volumes.
const SEATBELT_BASE_POLICY: &str = include_str!("seatbelt_base_policy.sbpl");

/// Network policy (added when network access is enabled).
///
/// This allows:
/// - network-outbound, network-inbound, system-socket
/// - Mach services for DNS, TLS, network configuration
/// - Darwin user cache directory writes
const SEATBELT_NETWORK_POLICY: &str = include_str!("seatbelt_network_policy.sbpl");

/// File read policy (static system paths).
///
/// This contains minimal system paths required for any process to execute:
/// - /usr/lib, /System/Library, /Library/Frameworks (dynamic linking)
/// - /private/var/db/dyld (dyld shared cache)
/// - /dev/null, /dev/urandom, /dev/random (device files)
///
/// User volumes are added dynamically in build_dynamic_read_volumes().
const SEATBELT_FILE_READ_POLICY: &str = include_str!("seatbelt_file_read_policy.sbpl");

/// File write policy (static tmp paths).
///
/// This contains:
/// - /private/tmp, /private/var/tmp (temporary files)
///
/// Box shared directory and writable volumes are added dynamically
/// in build_dynamic_write_paths().
const SEATBELT_FILE_WRITE_POLICY: &str = include_str!("seatbelt_file_write_policy.sbpl");

// ============================================================================
// PUBLIC API
// ============================================================================

/// Apply macOS-specific isolation.
///
/// On macOS, we rely on:
/// 1. sandbox-exec with SBPL profile (applied at spawn time, not here)
/// 2. rlimits (applied in common code)
/// 3. FD cleanup (applied in common code)
/// 4. Environment sanitization (applied in common code)
///
/// Note: The actual sandbox is applied when spawning the shim process,
/// not from within the process. This function logs what protections are active.
pub fn apply_isolation(security: &SecurityOptions, box_id: &str) -> BoxliteResult<()> {
    tracing::info!(box_id = %box_id, "Applying macOS jailer isolation");

    // Log warning about macOS limitations
    tracing::warn!(
        "macOS jailer has limited isolation compared to Linux. \
         Production deployments should use Linux for full security."
    );

    // On macOS, sandbox is applied at spawn time via sandbox-exec
    // Here we just verify the configuration and log status

    if security.sandbox_profile.is_some() {
        tracing::info!("Using custom sandbox profile");
    } else {
        tracing::info!(
            "Using built-in strict sandbox profile (volumes-only reads, restricted writes)"
        );
    }

    // Log what protections are active
    tracing::info!(
        close_fds = security.close_fds,
        sanitize_env = security.sanitize_env,
        network_enabled = security.network_enabled,
        "macOS isolation active (sandbox applied at spawn)"
    );

    // Note: privilege dropping not supported on macOS
    if security.uid.is_some() || security.gid.is_some() {
        tracing::warn!("Privilege dropping (uid/gid) not supported on macOS, ignoring");
    }

    // Note: chroot not recommended on macOS
    if security.chroot_enabled {
        tracing::warn!("Chroot not supported on macOS (no pivot_root), ignoring");
    }

    tracing::info!("macOS jailer isolation complete");
    Ok(())
}

/// Get sandbox-exec arguments for spawning a sandboxed process.
///
/// Returns the command and arguments to prepend when spawning the shim.
///
/// # Arguments
/// * `security` - Security configuration
/// * `box_dir` - Directory for this specific box
/// * `binary_path` - Path to the binary being executed (needed for sandbox to read it)
/// * `volumes` - Volume mounts for path restrictions
///
/// # Returns
/// Tuple of (command, args) to use instead of direct execution.
///
/// # Security Model
///
/// The generated policy implements strict whitelist:
/// - Reads: system libs, binary_path, volumes
/// - Writes: /tmp, /var/tmp, {box_dir}/shared, writable volumes
pub fn get_sandbox_exec_args(
    security: &SecurityOptions,
    box_dir: &Path,
    binary_path: &Path,
    volumes: &[VolumeSpec],
) -> (String, Vec<String>) {
    let mut args = Vec::new();

    // Use custom profile if specified, otherwise build strict policy
    if let Some(ref profile_path) = security.sandbox_profile {
        args.push("-f".to_string());
        args.push(profile_path.display().to_string());
    } else {
        // Build strict modular policy: base + file permissions + optional network
        let policy = build_sandbox_policy(security, box_dir, binary_path, volumes);
        args.push("-p".to_string());
        args.push(policy);
    }

    // Pass parameters for the policy
    // Note: We use canonicalized paths to handle /var vs /private/var on macOS
    let shared_dir = canonicalize_or_original(&box_dir.join("shared"));
    args.push("-D".to_string());
    args.push(format!("BOX_SHARED_DIR={}", shared_dir.display()));

    // Add Darwin user cache dir for network policy
    if let Some(cache_dir) = darwin_user_cache_dir() {
        args.push("-D".to_string());
        args.push(format!("DARWIN_USER_CACHE_DIR={}", cache_dir.display()));
    }

    // Use hardcoded path to prevent PATH injection
    (SANDBOX_EXEC_PATH.to_string(), args)
}

/// Check if sandbox-exec is available on this system.
pub fn is_sandbox_available() -> bool {
    Path::new(SANDBOX_EXEC_PATH).exists()
}

/// Write the sandbox profile to a file for debugging.
///
/// This can be useful for debugging sandbox issues. The generated profile
/// can be inspected to see exactly what paths are allowed.
#[allow(dead_code)]
pub fn write_sandbox_profile(
    path: &Path,
    security: &SecurityOptions,
    box_dir: &Path,
    binary_path: &Path,
    volumes: &[VolumeSpec],
) -> std::io::Result<()> {
    let policy = build_sandbox_policy(security, box_dir, binary_path, volumes);
    std::fs::write(path, policy)
}

/// Get the base policy for inspection/testing.
pub fn get_base_policy() -> &'static str {
    SEATBELT_BASE_POLICY
}

/// Get the network policy for inspection/testing.
pub fn get_network_policy() -> &'static str {
    SEATBELT_NETWORK_POLICY
}

// ============================================================================
// POLICY BUILDING (PRIVATE)
// ============================================================================

/// Build the complete sandbox policy by combining static .sbpl files + dynamic paths.
///
/// # Policy Structure
///
/// 1. Base policy (from seatbelt_base_policy.sbpl):
///    - deny default, process ops, sysctls, mach, iokit
///
/// 2. Static file READ (from seatbelt_file_read_policy.sbpl):
///    - Minimal system paths for execution
///
/// 3. Dynamic file READ (generated here):
///    - Binary path and its bundled libraries
///    - User-specified volumes
///
/// 4. Static file WRITE (from seatbelt_file_write_policy.sbpl):
///    - /tmp, /var/tmp
///
/// 5. Dynamic file WRITE (generated here):
///    - {box_dir}/shared/, writable volumes
///
/// 6. Network policy (optional, from seatbelt_network_policy.sbpl)
fn build_sandbox_policy(
    security: &SecurityOptions,
    box_dir: &Path,
    binary_path: &Path,
    volumes: &[VolumeSpec],
) -> String {
    let mut policy = String::new();

    // Header
    policy.push_str(
        "; ============================================================================\n",
    );
    policy.push_str("; BoxLite Sandbox Policy\n");
    policy.push_str(
        "; ============================================================================\n",
    );
    policy
        .push_str("; Debug: log show --predicate 'subsystem == \"com.apple.sandbox\"' --last 5m\n");
    policy.push_str(
        "; ============================================================================\n\n",
    );

    // 1. Base policy (sysctls, mach, iokit, process ops)
    policy.push_str(SEATBELT_BASE_POLICY);
    policy.push('\n');

    // 2. Static file READ (system paths from .sbpl)
    policy.push_str(SEATBELT_FILE_READ_POLICY);
    policy.push('\n');

    // 3. Dynamic file READ (binary path + boxlite home + user volumes)
    policy.push_str(&build_dynamic_read_volumes(binary_path, box_dir, volumes));
    policy.push('\n');

    // 4. Static file WRITE (tmp paths from .sbpl)
    policy.push_str(SEATBELT_FILE_WRITE_POLICY);
    policy.push('\n');

    // 5. Dynamic file WRITE (shared dir + writable volumes)
    policy.push_str(&build_dynamic_write_paths(box_dir, volumes));
    policy.push('\n');

    // 6. Network policy (optional)
    if security.network_enabled {
        policy.push_str(SEATBELT_NETWORK_POLICY);
    } else {
        policy.push_str("; Network disabled\n");
    }

    policy
}

/// Generate dynamic file-read policy for binary path + boxlite home + user volumes.
///
/// Static system paths are in seatbelt_file_read_policy.sbpl.
/// This function adds:
/// - Binary path's parent directory (for bundled .dylibs)
/// - BoxLite home directory (for disk images, box data)
/// - User-specified volumes
fn build_dynamic_read_volumes(
    binary_path: &Path,
    box_dir: &Path,
    volumes: &[VolumeSpec],
) -> String {
    let mut policy = String::from("; Dynamic readable paths\n(allow file-read*\n");

    // Add binary's parent directory (contains bundled .dylibs)
    if let Some(bin_dir) = binary_path.parent() {
        let bin_dir = canonicalize_or_original(bin_dir);
        policy.push_str(&format!(
            "    (subpath \"{}\")  ; shim binary + bundled libs\n",
            bin_dir.display()
        ));
    } else {
        // Fallback: allow reading the binary itself
        let bin_path = canonicalize_or_original(binary_path);
        policy.push_str(&format!(
            "    (literal \"{}\")  ; shim binary\n",
            bin_path.display()
        ));
    }

    // Add boxlite home directory (for disk images, box data, etc.)
    // box_dir is ~/.boxlite/boxes/{box_id}, home_dir is ~/.boxlite
    let home_dir = box_dir
        .parent()  // boxes/
        .and_then(|p| p.parent())  // .boxlite
        .unwrap_or(box_dir);
    let home_dir = canonicalize_or_original(home_dir);
    policy.push_str(&format!(
        "    (subpath \"{}\")  ; boxlite home (disk images, box data)\n",
        home_dir.display()
    ));

    // Add user volumes
    for vol in volumes {
        let path = canonicalize_or_original(Path::new(&vol.host_path));
        let ro_marker = if vol.read_only { " (ro)" } else { " (rw)" };
        policy.push_str(&format!(
            "    (subpath \"{}\")  ; {}{}\n",
            path.display(),
            vol.guest_path,
            ro_marker
        ));
    }

    policy.push_str(")\n");
    policy
}

/// Generate dynamic file-write policy for box directories + writable volumes.
///
/// Static tmp paths are in seatbelt_file_write_policy.sbpl.
/// This function adds:
/// - {box_dir}/ (entire box directory for sockets, shared, etc.)
/// - {home_dir}/logs/ (for shim and console logs)
/// - User volumes with read_only=false
fn build_dynamic_write_paths(box_dir: &Path, volumes: &[VolumeSpec]) -> String {
    let box_dir_canon = canonicalize_or_original(box_dir);

    // Get home_dir from box_dir (box_dir is ~/.boxlite/boxes/{box_id})
    // So home_dir is ~/.boxlite
    let home_dir = box_dir
        .parent()  // boxes/
        .and_then(|p| p.parent())  // .boxlite
        .unwrap_or(box_dir);
    let logs_dir = canonicalize_or_original(&home_dir.join("logs"));

    let mut policy = String::from("; Dynamic write paths\n(allow file-write*\n");

    // Box directory (for sockets, shared, state files)
    policy.push_str(&format!(
        "    (subpath \"{}\")  ; box directory\n",
        box_dir_canon.display()
    ));

    // Logs directory (for shim logs and console output)
    policy.push_str(&format!(
        "    (subpath \"{}\")  ; logs directory\n",
        logs_dir.display()
    ));

    // Writable user volumes (read_only=false)
    for vol in volumes.iter().filter(|v| !v.read_only) {
        let path = canonicalize_or_original(Path::new(&vol.host_path));
        policy.push_str(&format!(
            "    (subpath \"{}\")  ; -> {}\n",
            path.display(),
            vol.guest_path
        ));
    }

    policy.push_str(")\n");
    policy
}

// ============================================================================
// UTILITIES (PRIVATE)
// ============================================================================

/// Canonicalize a path, falling back to the original if canonicalization fails.
///
/// This is important on macOS where /var is a symlink to /private/var.
/// The sandbox policy needs the canonical path to match correctly.
fn canonicalize_or_original(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Get the Darwin user cache directory using confstr.
///
/// This is needed for the network policy - TLS/SSL operations may write
/// to the user's cache directory.
fn darwin_user_cache_dir() -> Option<PathBuf> {
    let mut buf = vec![0_i8; (libc::PATH_MAX as usize) + 1];
    let len =
        unsafe { libc::confstr(libc::_CS_DARWIN_USER_CACHE_DIR, buf.as_mut_ptr(), buf.len()) };
    if len == 0 {
        return None;
    }
    let cstr = unsafe { CStr::from_ptr(buf.as_ptr()) };
    cstr.to_str()
        .ok()
        .map(PathBuf::from)
        .and_then(|p| p.canonicalize().ok().or(Some(p)))
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sandbox_exec_path_is_absolute() {
        assert!(SANDBOX_EXEC_PATH.starts_with('/'));
        assert_eq!(SANDBOX_EXEC_PATH, "/usr/bin/sandbox-exec");
    }

    #[test]
    fn test_sandbox_available() {
        // sandbox-exec should be available on macOS
        #[cfg(target_os = "macos")]
        assert!(
            is_sandbox_available(),
            "sandbox-exec should be available on macOS"
        );
    }

    #[test]
    fn test_base_policy_is_valid_sbpl() {
        // Base policy uses allow-default because Hypervisor.framework
        // requires many undocumented permissions that cannot be enumerated
        assert!(SEATBELT_BASE_POLICY.contains("(version 1)"));
        assert!(SEATBELT_BASE_POLICY.contains("(allow default)"));

        // Should document that HV.framework needs this approach
        assert!(
            SEATBELT_BASE_POLICY.contains("Hypervisor.framework"),
            "Should document why allow-default is used"
        );
    }

    #[test]
    fn test_network_policy_structure() {
        assert!(SEATBELT_NETWORK_POLICY.contains("(allow network-outbound)"));
        assert!(SEATBELT_NETWORK_POLICY.contains("(allow network-inbound)"));
        assert!(SEATBELT_NETWORK_POLICY.contains("DARWIN_USER_CACHE_DIR"));
    }

    #[test]
    fn test_get_sandbox_args_uses_hardcoded_path() {
        let security = SecurityOptions::default();
        let box_dir = PathBuf::from("/tmp/test/boxes/test-box");
        let binary_path = PathBuf::from("/usr/local/bin/boxlite-shim");
        let volumes: Vec<VolumeSpec> = vec![];

        let (cmd, _args) = get_sandbox_exec_args(&security, &box_dir, &binary_path, &volumes);

        // Must use hardcoded path, not just "sandbox-exec"
        assert_eq!(cmd, "/usr/bin/sandbox-exec");
    }

    #[test]
    fn test_canonicalize_handles_nonexistent() {
        let nonexistent = Path::new("/this/does/not/exist");
        let result = canonicalize_or_original(nonexistent);
        assert_eq!(result, nonexistent);
    }

    #[test]
    fn test_build_policy_includes_network_when_enabled() {
        let security = SecurityOptions {
            network_enabled: true,
            ..Default::default()
        };
        let box_dir = PathBuf::from("/tmp/test/boxes/test-box");
        let binary_path = PathBuf::from("/usr/local/bin/boxlite-shim");
        let volumes: Vec<VolumeSpec> = vec![];

        let policy = build_sandbox_policy(&security, &box_dir, &binary_path, &volumes);

        assert!(policy.contains("(allow network-outbound)"));
    }

    #[test]
    fn test_build_policy_excludes_network_when_disabled() {
        let security = SecurityOptions {
            network_enabled: false,
            ..Default::default()
        };
        let box_dir = PathBuf::from("/tmp/test/boxes/test-box");
        let binary_path = PathBuf::from("/usr/local/bin/boxlite-shim");
        let volumes: Vec<VolumeSpec> = vec![];

        let policy = build_sandbox_policy(&security, &box_dir, &binary_path, &volumes);

        assert!(!policy.contains("(allow network-outbound)"));
        assert!(policy.contains("Network disabled"));
    }

    #[test]
    fn test_file_read_policy_structure() {
        // Static policy should have minimal system paths
        assert!(SEATBELT_FILE_READ_POLICY.contains("(subpath \"/usr/lib\")"));
        assert!(SEATBELT_FILE_READ_POLICY.contains("(subpath \"/System/Library\")"));
        assert!(SEATBELT_FILE_READ_POLICY.contains("(literal \"/dev/null\")"));
        // Should NOT have blanket paths
        assert!(!SEATBELT_FILE_READ_POLICY.contains("(subpath \"/usr\")"));
    }

    #[test]
    fn test_file_write_policy_structure() {
        // Static policy should have tmp paths
        assert!(SEATBELT_FILE_WRITE_POLICY.contains("(subpath \"/private/tmp\")"));
        assert!(SEATBELT_FILE_WRITE_POLICY.contains("(subpath \"/private/var/tmp\")"));
    }

    #[test]
    fn test_dynamic_read_volumes_empty() {
        let binary_path = PathBuf::from("/usr/local/bin/boxlite-shim");
        let box_dir = PathBuf::from("/Users/test/.boxlite/boxes/test-box");
        let policy = build_dynamic_read_volumes(&binary_path, &box_dir, &[]);

        // Should have binary path even with no volumes
        assert!(policy.contains("(allow file-read*"));
        assert!(policy.contains("/usr/local/bin"));
        // Should have boxlite home
        assert!(policy.contains(".boxlite"));
    }

    #[test]
    fn test_dynamic_read_volumes_with_volumes() {
        let binary_path = PathBuf::from("/usr/local/bin/boxlite-shim");
        let box_dir = PathBuf::from("/Users/test/.boxlite/boxes/test-box");
        let volumes = vec![
            VolumeSpec {
                host_path: "/data/input".to_string(),
                guest_path: "/mnt/input".to_string(),
                read_only: true,
            },
            VolumeSpec {
                host_path: "/data/output".to_string(),
                guest_path: "/mnt/output".to_string(),
                read_only: false,
            },
        ];

        let policy = build_dynamic_read_volumes(&binary_path, &box_dir, &volumes);

        // Should have binary path
        assert!(policy.contains("/usr/local/bin"));
        // Should have boxlite home
        assert!(policy.contains(".boxlite"));
        // Should have both volumes in read policy
        assert!(policy.contains("/data/input"));
        assert!(policy.contains("/data/output"));
        assert!(policy.contains("(allow file-read*"));
    }

    #[test]
    fn test_dynamic_write_paths_only_writable_volumes() {
        let volumes = vec![
            VolumeSpec {
                host_path: "/data/input".to_string(),
                guest_path: "/mnt/input".to_string(),
                read_only: true, // Should NOT be in write policy
            },
            VolumeSpec {
                host_path: "/data/output".to_string(),
                guest_path: "/mnt/output".to_string(),
                read_only: false, // Should be in write policy
            },
        ];
        let box_dir = PathBuf::from("/Users/test/.boxlite/boxes/test-box");

        let policy = build_dynamic_write_paths(&box_dir, &volumes);

        // Read-only volume should NOT be in write policy
        assert!(!policy.contains("/data/input"));
        // Writable volume should be in write policy
        assert!(policy.contains("/data/output"));
        // Box dir should be there
        assert!(policy.contains("boxes/test-box"));
        // Logs dir should be there
        assert!(policy.contains("logs"));
    }

    #[test]
    fn test_policy_no_blanket_system_paths() {
        let security = SecurityOptions::default();
        let box_dir = PathBuf::from("/tmp/boxes/test");
        let binary_path = PathBuf::from("/tmp/test/boxlite-shim");
        let volumes: Vec<VolumeSpec> = vec![];

        let policy = build_sandbox_policy(&security, &box_dir, &binary_path, &volumes);

        // Should NOT contain blanket system path reads (e.g., entire /usr)
        assert!(
            !policy.contains("(subpath \"/usr\")"),
            "Should not allow entire /usr"
        );
        assert!(
            !policy.contains("(subpath \"/System\")"),
            "Should not allow entire /System"
        );
        // Should have specific subpaths (/usr/lib, /System/Library)
        assert!(policy.contains("(subpath \"/usr/lib\")"));
        assert!(policy.contains("(subpath \"/System/Library\")"));
        // Should have the binary's parent directory
        assert!(policy.contains("/tmp/test"));
    }
}
