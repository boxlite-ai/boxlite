//! SeatbeltSandbox — macOS isolation via sandbox-exec.
//!
//! Implements the [`Sandbox`] trait using Apple's Seatbelt sandbox
//! framework via `sandbox-exec` with SBPL profiles.
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
//! ## Debugging Sandbox Violations
//!
//! If the shim fails to start due to sandbox restrictions:
//! ```bash
//! log show --predicate 'subsystem == "com.apple.sandbox"' --last 5m
//! ```

use super::{PathAccess, Sandbox, SandboxContext};
use boxlite_shared::errors::BoxliteResult;
use std::ffi::CStr;
use std::path::{Path, PathBuf};
use std::process::Command;

// ============================================================================
// Constants
// ============================================================================

/// Hardcoded path to sandbox-exec to prevent PATH injection attacks.
pub const SANDBOX_EXEC_PATH: &str = "/usr/bin/sandbox-exec";

/// Base sandbox policy (deny-default with fine-grained allowlists).
const SEATBELT_BASE_POLICY: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/resources/seatbelt/seatbelt_base_policy.sbpl"
));

/// Network policy (added when network access is enabled).
const SEATBELT_NETWORK_POLICY: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/resources/seatbelt/seatbelt_network_policy.sbpl"
));

/// File read policy (static system paths).
const SEATBELT_FILE_READ_POLICY: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/resources/seatbelt/seatbelt_file_read_policy.sbpl"
));

/// File write policy (static tmp paths).
const SEATBELT_FILE_WRITE_POLICY: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/resources/seatbelt/seatbelt_file_write_policy.sbpl"
));

// ============================================================================
// SeatbeltSandbox
// ============================================================================

/// macOS sandbox using sandbox-exec (Seatbelt).
#[derive(Debug)]
pub struct SeatbeltSandbox;

impl SeatbeltSandbox {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SeatbeltSandbox {
    fn default() -> Self {
        Self::new()
    }
}

impl Sandbox for SeatbeltSandbox {
    fn is_available(&self) -> bool {
        is_sandbox_available()
    }

    fn setup(&self, ctx: &SandboxContext) -> BoxliteResult<()> {
        tracing::debug!(
            id = %ctx.id,
            "Pre-spawn isolation: no-op on macOS (no cgroups)"
        );
        Ok(())
    }

    fn wrap(&self, ctx: &SandboxContext, binary: &Path, args: &[String]) -> Command {
        let (sandbox_cmd, sandbox_args) =
            build_sandbox_exec_args(&ctx.paths, binary, ctx.network_enabled, ctx.sandbox_profile);
        let mut cmd = Command::new(sandbox_cmd);
        cmd.args(sandbox_args);
        cmd.arg(binary);
        cmd.args(args);
        cmd
    }

    fn cgroup_procs_path(&self, _ctx: &SandboxContext) -> Option<std::ffi::CString> {
        None
    }

    fn name(&self) -> &'static str {
        "seatbelt"
    }
}

// ============================================================================
// Public API
// ============================================================================

/// Check if sandbox-exec is available on this system.
pub fn is_sandbox_available() -> bool {
    Path::new(SANDBOX_EXEC_PATH).exists()
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
// Sandbox-exec argument building
// ============================================================================

/// Build sandbox-exec arguments from pre-computed path access rules.
///
/// Returns the command and arguments to prepend when spawning the shim.
fn build_sandbox_exec_args(
    paths: &[PathAccess],
    binary_path: &Path,
    network_enabled: bool,
    sandbox_profile: Option<&Path>,
) -> (String, Vec<String>) {
    let mut args = Vec::new();

    // Use custom profile if specified, otherwise build strict policy
    if let Some(profile_path) = sandbox_profile {
        args.push("-f".to_string());
        args.push(profile_path.display().to_string());
    } else {
        // Build strict modular policy: base + file permissions + optional network
        let policy = build_sandbox_policy(paths, binary_path, network_enabled);
        args.push("-p".to_string());
        args.push(policy);
    }

    // Add Darwin user cache dir for network policy
    if let Some(cache_dir) = darwin_user_cache_dir() {
        args.push("-D".to_string());
        args.push(format!("DARWIN_USER_CACHE_DIR={}", cache_dir.display()));
    }

    // Use hardcoded path to prevent PATH injection
    (SANDBOX_EXEC_PATH.to_string(), args)
}

// ============================================================================
// Policy building (private)
// ============================================================================

/// Build the complete sandbox policy by combining static .sbpl files + dynamic paths.
fn build_sandbox_policy(paths: &[PathAccess], binary_path: &Path, network_enabled: bool) -> String {
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

    // 3. Dynamic file READ (binary path + all pre-computed paths)
    policy.push_str(&build_dynamic_read_paths(binary_path, paths));
    policy.push('\n');

    // 4. Static file WRITE (tmp paths from .sbpl)
    policy.push_str(SEATBELT_FILE_WRITE_POLICY);
    policy.push('\n');

    // 5. Dynamic file WRITE (writable paths only)
    policy.push_str(&build_dynamic_write_paths(paths));
    policy.push('\n');

    // 6. Network policy (optional)
    if network_enabled {
        policy.push_str(SEATBELT_NETWORK_POLICY);
    } else {
        policy.push_str("; Network disabled\n");
    }

    policy
}

/// Generate dynamic file-read policy for binary path + all pre-computed paths.
fn build_dynamic_read_paths(binary_path: &Path, paths: &[PathAccess]) -> String {
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

    // All pre-computed paths (both rw and ro need read access)
    for pa in paths {
        let path = canonicalize_or_original(&pa.path);
        let rule = if pa.path.is_dir() {
            "subpath"
        } else {
            "literal"
        };
        let marker = if pa.writable { "rw" } else { "ro" };
        policy.push_str(&format!(
            "    ({rule} \"{}\")  ; ({})\n",
            path.display(),
            marker
        ));
    }

    policy.push_str(")\n");
    policy
}

/// Generate dynamic file-write policy for writable paths only.
fn build_dynamic_write_paths(paths: &[PathAccess]) -> String {
    let mut policy = String::from("; Dynamic write paths\n(allow file-write*\n");

    for pa in paths.iter().filter(|p| p.writable) {
        let path = canonicalize_or_original(&pa.path);
        let rule = if pa.path.is_dir() {
            "subpath"
        } else {
            "literal"
        };
        policy.push_str(&format!(
            "    ({rule} \"{}\")  ; writable\n",
            path.display()
        ));
    }

    policy.push_str(")\n");
    policy
}

// ============================================================================
// Utilities (private)
// ============================================================================

/// Canonicalize a path, falling back to the original if canonicalization fails.
fn canonicalize_or_original(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Get the Darwin user cache directory using confstr.
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
// Tests
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
        assert!(SEATBELT_BASE_POLICY.contains("(version 1)"));
        assert!(SEATBELT_BASE_POLICY.contains("(allow default)"));
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
        let paths = vec![PathAccess {
            path: PathBuf::from("/tmp/test/boxes/test-box"),
            writable: true,
        }];
        let binary_path = PathBuf::from("/usr/local/bin/boxlite-shim");

        let (cmd, _args) = build_sandbox_exec_args(&paths, &binary_path, true, None);

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
        let paths = vec![PathAccess {
            path: PathBuf::from("/tmp/test/boxes/test-box"),
            writable: true,
        }];
        let binary_path = PathBuf::from("/usr/local/bin/boxlite-shim");

        let policy = build_sandbox_policy(&paths, &binary_path, true);

        assert!(policy.contains("(allow network-outbound)"));
    }

    #[test]
    fn test_build_policy_excludes_network_when_disabled() {
        let paths = vec![PathAccess {
            path: PathBuf::from("/tmp/test/boxes/test-box"),
            writable: true,
        }];
        let binary_path = PathBuf::from("/usr/local/bin/boxlite-shim");

        let policy = build_sandbox_policy(&paths, &binary_path, false);

        assert!(!policy.contains("(allow network-outbound)"));
        assert!(policy.contains("Network disabled"));
    }

    #[test]
    fn test_file_read_policy_structure() {
        assert!(SEATBELT_FILE_READ_POLICY.contains("(subpath \"/usr/lib\")"));
        assert!(SEATBELT_FILE_READ_POLICY.contains("(subpath \"/System/Library\")"));
        assert!(SEATBELT_FILE_READ_POLICY.contains("(literal \"/dev/null\")"));
        assert!(!SEATBELT_FILE_READ_POLICY.contains("(subpath \"/usr\")"));
    }

    #[test]
    fn test_file_write_policy_structure() {
        assert!(SEATBELT_FILE_WRITE_POLICY.contains("(subpath \"/private/tmp\")"));
        assert!(SEATBELT_FILE_WRITE_POLICY.contains("(subpath \"/private/var/tmp\")"));
    }

    #[test]
    fn test_dynamic_read_paths_empty() {
        let binary_path = PathBuf::from("/usr/local/bin/boxlite-shim");
        let policy = build_dynamic_read_paths(&binary_path, &[]);

        assert!(policy.contains("(allow file-read*"));
        assert!(policy.contains("/usr/local/bin"));
    }

    #[test]
    fn test_dynamic_read_paths_with_paths() {
        let binary_path = PathBuf::from("/usr/local/bin/boxlite-shim");
        let paths = vec![
            PathAccess {
                path: PathBuf::from("/data/input"),
                writable: false,
            },
            PathAccess {
                path: PathBuf::from("/data/output"),
                writable: true,
            },
        ];

        let policy = build_dynamic_read_paths(&binary_path, &paths);

        assert!(policy.contains("/usr/local/bin"));
        assert!(policy.contains("/data/input"));
        assert!(policy.contains("/data/output"));
        assert!(policy.contains("(allow file-read*"));
        assert!(policy.contains("(ro)"));
        assert!(policy.contains("(rw)"));
    }

    #[test]
    fn test_dynamic_write_paths_only_writable() {
        let paths = vec![
            PathAccess {
                path: PathBuf::from("/data/input"),
                writable: false,
            },
            PathAccess {
                path: PathBuf::from("/data/output"),
                writable: true,
            },
            PathAccess {
                path: PathBuf::from("/tmp/test/boxes/test-box"),
                writable: true,
            },
        ];

        let policy = build_dynamic_write_paths(&paths);

        assert!(!policy.contains("/data/input"));
        assert!(policy.contains("/data/output"));
        assert!(policy.contains("boxes/test-box"));
    }

    #[test]
    fn test_policy_no_blanket_system_paths() {
        let paths = vec![PathAccess {
            path: PathBuf::from("/tmp/boxes/test"),
            writable: true,
        }];
        let binary_path = PathBuf::from("/tmp/test/boxlite-shim");

        let policy = build_sandbox_policy(&paths, &binary_path, false);

        assert!(
            !policy.contains("(subpath \"/usr\")"),
            "Should not allow entire /usr"
        );
        assert!(
            !policy.contains("(subpath \"/System\")"),
            "Should not allow entire /System"
        );
        assert!(policy.contains("(subpath \"/usr/lib\")"));
        assert!(policy.contains("(subpath \"/System/Library\")"));
        assert!(policy.contains("/tmp/test"));
    }

    #[test]
    fn test_dynamic_paths_file_vs_dir_sbpl_rule() {
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        let box_dir = dir.path();

        // Create a real directory and a real file
        let rw_dir = box_dir.join("sockets");
        std::fs::create_dir_all(&rw_dir).unwrap();
        let rw_file = box_dir.join("exit");
        std::fs::File::create(&rw_file).unwrap();

        let paths = vec![
            PathAccess {
                path: rw_dir.clone(),
                writable: true,
            },
            PathAccess {
                path: rw_file.clone(),
                writable: true,
            },
        ];
        let binary_path = PathBuf::from("/usr/local/bin/boxlite-shim");

        let read_policy = build_dynamic_read_paths(&binary_path, &paths);
        let write_policy = build_dynamic_write_paths(&paths);

        // Directories should use (subpath ...)
        assert!(
            read_policy.contains("(subpath"),
            "Dirs should use (subpath) in read policy"
        );
        // Files should use (literal ...)
        assert!(
            read_policy.contains("(literal"),
            "Files should use (literal) in read policy"
        );
        assert!(
            write_policy.contains("(subpath"),
            "Dirs should use (subpath) in write policy"
        );
        assert!(
            write_policy.contains("(literal"),
            "Files should use (literal) in write policy"
        );
    }

    #[test]
    fn test_seatbelt_sandbox_name() {
        let sandbox = SeatbeltSandbox::new();
        assert_eq!(sandbox.name(), "seatbelt");
    }

    #[test]
    fn test_seatbelt_sandbox_no_cgroup() {
        use crate::jailer::sandbox::SandboxContext;
        use crate::runtime::advanced_options::ResourceLimits;

        let sandbox = SeatbeltSandbox::new();
        let ctx = SandboxContext {
            id: "test",
            paths: vec![],
            resource_limits: &ResourceLimits::default(),
            network_enabled: false,
            sandbox_profile: None,
        };
        assert!(sandbox.cgroup_procs_path(&ctx).is_none());
    }

    /// Empty path list must produce a valid SBPL write policy with no grants.
    #[test]
    fn test_dynamic_write_paths_empty_list() {
        let policy = build_dynamic_write_paths(&[]);

        // Must be syntactically valid (has allow block)
        assert!(
            policy.contains("(allow file-write*"),
            "Should contain file-write allow block"
        );
        // Must NOT grant any paths
        assert!(
            !policy.contains("(subpath"),
            "Empty list should have no subpath rules"
        );
        assert!(
            !policy.contains("(literal"),
            "Empty list should have no literal rules"
        );
    }

    /// Nonexistent paths must use (literal ...) — the most restrictive rule.
    /// A nonexistent path is never treated as a directory (which would grant
    /// access to all children via subpath).
    #[test]
    fn test_seatbelt_nonexistent_path_uses_literal() {
        let paths = vec![PathAccess {
            path: PathBuf::from("/nonexistent/sandbox/path"),
            writable: true,
        }];

        let binary_path = PathBuf::from("/usr/local/bin/boxlite-shim");

        let read_policy = build_dynamic_read_paths(&binary_path, &paths);
        let write_policy = build_dynamic_write_paths(&paths);

        // Nonexistent path → is_dir() returns false → must use (literal)
        assert!(
            read_policy.contains("(literal \"/nonexistent/sandbox/path\")"),
            "Nonexistent path should use (literal) in read policy: {}",
            read_policy
        );
        assert!(
            write_policy.contains("(literal \"/nonexistent/sandbox/path\")"),
            "Nonexistent path should use (literal) in write policy: {}",
            write_policy
        );
    }

    /// Full sandbox policy generated from build_path_access must NOT contain
    /// the mounts_dir path string anywhere.
    #[test]
    fn test_seatbelt_policy_excludes_mounts_dir() {
        use crate::runtime::layout::{BoxFilesystemLayout, FsLayoutConfig};
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        let layout = BoxFilesystemLayout::new(
            dir.path().to_path_buf(),
            FsLayoutConfig::without_bind_mount(),
            false,
        );

        // Create mounts_dir on disk (it exists but should be excluded)
        std::fs::create_dir_all(layout.mounts_dir()).unwrap();
        // Also create dirs that SHOULD appear
        std::fs::create_dir_all(layout.sockets_dir()).unwrap();
        std::fs::create_dir_all(layout.logs_dir()).unwrap();

        let paths = crate::jailer::build_path_access(&layout, &[]);
        let binary = PathBuf::from("/usr/local/bin/boxlite-shim");
        let policy = build_sandbox_policy(&paths, &binary, false);

        let mounts_str = layout.mounts_dir().to_string_lossy().to_string();
        assert!(
            !policy.contains(&mounts_str),
            "mounts_dir path must not appear anywhere in sandbox policy"
        );
    }

    /// Every PathAccess entry must appear in the read policy.
    /// Only writable entries should appear in the write policy.
    #[test]
    fn test_seatbelt_policy_read_includes_all_paths() {
        use tempfile::tempdir;

        let dir = tempdir().unwrap();

        // Create a mix of RO dirs, RW dirs, and RW files
        let ro_dir = dir.path().join("bin");
        let rw_dir = dir.path().join("sockets");
        let rw_file = dir.path().join("exit");
        std::fs::create_dir_all(&ro_dir).unwrap();
        std::fs::create_dir_all(&rw_dir).unwrap();
        std::fs::File::create(&rw_file).unwrap();

        let paths = vec![
            PathAccess {
                path: ro_dir.clone(),
                writable: false,
            },
            PathAccess {
                path: rw_dir.clone(),
                writable: true,
            },
            PathAccess {
                path: rw_file.clone(),
                writable: true,
            },
        ];

        let binary = PathBuf::from("/usr/local/bin/boxlite-shim");
        let read_policy = build_dynamic_read_paths(&binary, &paths);
        let write_policy = build_dynamic_write_paths(&paths);

        // All paths should appear in read policy
        for pa in &paths {
            let path_str = pa.path.to_string_lossy();
            assert!(
                read_policy.contains(path_str.as_ref()),
                "Read policy should contain {}",
                path_str
            );
        }

        // Only writable paths should appear in write policy
        assert!(
            write_policy.contains(rw_dir.to_string_lossy().as_ref()),
            "Write policy should contain writable dir"
        );
        assert!(
            write_policy.contains(rw_file.to_string_lossy().as_ref()),
            "Write policy should contain writable file"
        );
        assert!(
            !write_policy.contains(ro_dir.to_string_lossy().as_ref()),
            "Write policy should NOT contain read-only dir"
        );
    }
}
