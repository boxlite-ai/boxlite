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
//! ## Security Model: Deny-by-default allowlist
//!
//! BoxLite starts from `(deny default)` and explicitly grants:
//!
//! | Category | Policy source |
//! |----------|---------------|
//! | Base capabilities (process, sysctl, mach, iokit) | `seatbelt_base_policy.sbpl` |
//! | Static system file read/write paths | `seatbelt_file_read_policy.sbpl`, `seatbelt_file_write_policy.sbpl` |
//! | Dynamic file read/write paths | Computed from [`PathAccess`] in `build_sandbox_policy()` |
//! | Unix-domain socket endpoints (always) | Explicit socket paths in [`SandboxContext`] |
//! | IP networking (optional) | `seatbelt_network_policy.sbpl` when `network_enabled=true` |
//!
//! Unix-domain sockets and IP networking are granted separately on purpose:
//! the shim's own control plane is AF_UNIX and must work even for a box with
//! no guest network. See [`build_unix_socket_grants`].
//!
//! ## Debugging Sandbox Violations
//!
//! If the shim fails to start due to sandbox restrictions:
//! ```bash
//! log show --predicate 'subsystem == "com.apple.sandbox"' --last 5m
//! ```

use super::{PathAccess, Sandbox, SandboxContext, UnixSocketAccess};
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

    /// Platform constructor alias (used by [`JailerBuilder`](super::super::JailerBuilder)).
    pub fn platform_new() -> Self {
        Self::new()
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

    fn apply(&self, ctx: &SandboxContext, cmd: &mut Command) {
        let binary = cmd.get_program().to_owned();
        let args: Vec<std::ffi::OsString> = cmd.get_args().map(|a| a.to_owned()).collect();

        let binary_path = std::path::Path::new(&binary);
        let (sandbox_cmd, sandbox_args) = build_sandbox_exec_args(
            &ctx.paths,
            &ctx.unix_sockets,
            binary_path,
            ctx.network_enabled,
            ctx.sandbox_profile,
        );
        let mut new_cmd = Command::new(sandbox_cmd);
        new_cmd.args(sandbox_args);
        new_cmd.arg(&binary);
        new_cmd.args(&args);
        *cmd = new_cmd;
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
    unix_sockets: &UnixSocketAccess,
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
        let policy = build_sandbox_policy(paths, unix_sockets, binary_path, network_enabled);
        if std::env::var_os("BOXLITE_DEBUG_PRINT_SEATBELT").is_some() {
            eprintln!(
                "BOXLITE_DEBUG seatbelt policy for {}:\n{}",
                binary_path.display(),
                policy
            );
        }
        if let Ok(debug_policy_file) = std::env::var("BOXLITE_DEBUG_POLICY_FILE") {
            let _ = std::fs::write(debug_policy_file, &policy);
        }
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
fn build_sandbox_policy(
    paths: &[PathAccess],
    unix_sockets: &UnixSocketAccess,
    binary_path: &Path,
    network_enabled: bool,
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

    // 3. Dynamic file READ (binary path + all pre-computed paths)
    policy.push_str(&build_dynamic_read_paths(binary_path, paths));
    policy.push('\n');

    // 4. Static file WRITE (tmp paths from .sbpl)
    policy.push_str(SEATBELT_FILE_WRITE_POLICY);
    policy.push('\n');

    // 5. Dynamic file WRITE (writable paths only)
    policy.push_str(&build_dynamic_write_paths(paths));
    policy.push('\n');

    // 6. Unix-domain socket endpoints (always — not gated on network_enabled)
    policy.push_str(&build_unix_socket_grants(unix_sockets));
    policy.push('\n');

    // 7. IP networking (optional)
    if network_enabled {
        policy.push_str(SEATBELT_NETWORK_POLICY);
    } else {
        policy.push_str("; IP networking disabled\n");
    }

    // 8. Keep the shim and its cache namespace read-only under writable paths.
    if let Some(bin_dir) = binary_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        let bin_dir = bin_dir
            .canonicalize()
            .unwrap_or_else(|_| canonicalize_or_original(bin_dir));
        let cache_root = bin_dir.parent().filter(|path| path.ends_with("shims"));
        for dir in std::iter::once(bin_dir.as_path()).chain(cache_root) {
            if let Some(literal) = sbpl_path_literal(dir) {
                policy.push_str(&format!(
                    "(deny file-write* (literal {literal}) (subpath {literal}))\n"
                ));
            } else {
                tracing::warn!(path = ?dir, "Skipping non-UTF-8 Seatbelt write denial");
            }
        }
    }

    policy
}

/// Generate dynamic file-read policy for binary path + all pre-computed paths.
fn build_dynamic_read_paths(binary_path: &Path, paths: &[PathAccess]) -> String {
    let mut rules = String::new();

    // Grant access to the shim and the libkrunfw files staged beside it.
    if let Some(bin_dir) = binary_path.parent() {
        let bin_dir = canonicalize_or_original(bin_dir);
        if let Some(literal) = sbpl_path_literal(&bin_dir) {
            rules.push_str(&format!(
                "    (subpath {literal})  ; shim binary + libkrunfw\n"
            ));
        } else {
            tracing::warn!(path = ?bin_dir, "Skipping non-UTF-8 Seatbelt read path");
        }
    } else {
        // Fallback: allow reading the binary itself
        let bin_path = canonicalize_or_original(binary_path);
        if let Some(literal) = sbpl_path_literal(&bin_path) {
            rules.push_str(&format!("    (literal {literal})  ; shim binary\n"));
        } else {
            tracing::warn!(path = ?bin_path, "Skipping non-UTF-8 Seatbelt read path");
        }
    }

    // All pre-computed paths (both rw and ro need read access)
    for pa in paths {
        let path = canonicalize_or_original(&pa.path);
        let Some(literal) = sbpl_path_literal(&path) else {
            tracing::warn!(path = ?path, "Skipping non-UTF-8 Seatbelt file path");
            continue;
        };
        let marker = if pa.writable { "rw" } else { "ro" };
        if pa.path.is_dir() {
            // Directory access needs both:
            // - literal: the directory node itself (open/stat on root)
            // - subpath: descendants inside the directory
            rules.push_str(&format!("    (literal {literal})  ; ({marker}) dir root\n"));
            rules.push_str(&format!("    (subpath {literal})  ; ({marker}) dir tree\n"));
        } else {
            rules.push_str(&format!("    (literal {literal})  ; ({marker})\n"));
        }
    }

    if rules.is_empty() {
        String::from("; Dynamic read grants skipped: no path was representable\n")
    } else {
        format!("; Dynamic readable paths\n(allow file-read*\n{rules})\n")
    }
}

/// Generate dynamic file-write policy for writable paths only.
fn build_dynamic_write_paths(paths: &[PathAccess]) -> String {
    let mut rules = String::new();

    for pa in paths.iter().filter(|p| p.writable) {
        let path = canonicalize_or_original(&pa.path);
        let Some(literal) = sbpl_path_literal(&path) else {
            tracing::warn!(path = ?path, "Skipping non-UTF-8 Seatbelt file path");
            continue;
        };
        if pa.path.is_dir() {
            // See read policy rationale: allow both directory root and descendants.
            rules.push_str(&format!("    (literal {literal})  ; writable dir root\n"));
            rules.push_str(&format!("    (subpath {literal})  ; writable dir tree\n"));
        } else {
            rules.push_str(&format!("    (literal {literal})  ; writable\n"));
        }
    }

    if rules.is_empty() {
        String::from("; Dynamic write grants skipped: no path was representable\n")
    } else {
        format!("; Dynamic write paths\n(allow file-write*\n{rules})\n")
    }
}

/// Grant the shim's own AF_UNIX endpoints, independent of `network_enabled`.
///
/// A box always needs the gRPC control and guest-ready sockets; a box with a
/// network backend additionally needs gvproxy's control and datagram sockets
/// (see [`BoxSockets`](crate::net::socket_path::BoxSockets)). macOS gates
/// AF_UNIX `bind()` under `network-bind` and `connect()` under
/// `network-outbound`; `system-socket` does not apply. Folding these grants into
/// `seatbelt_network_policy.sbpl` therefore made `network_enabled=false` kill
/// every box a millisecond after start (issue #1072).
///
/// Scope: only the exact socket endpoints pre-computed by the jailer. A literal
/// path filter never matches an AF_INET/AF_INET6 socket, so this grants no IP
/// networking, which stays the sole responsibility of `network_enabled`.
fn build_unix_socket_grants(access: &UnixSocketAccess) -> String {
    if access.bind.is_empty() && access.connect.is_empty() {
        return String::from("; No Unix-domain socket endpoints\n");
    }

    let mut policy =
        String::from("; Unix-domain socket endpoints (AF_UNIX only — filtered by path)\n");
    for (operation, paths) in [
        ("network-bind", access.bind.as_slice()),
        ("network-outbound", access.connect.as_slice()),
    ] {
        if paths.is_empty() {
            continue;
        }
        let mut rules = String::new();
        for path in paths {
            let path = canonicalize_or_original(path);
            let Some(literal) = sbpl_path_literal(&path) else {
                tracing::warn!(path = ?path, "Skipping non-UTF-8 Seatbelt socket path");
                continue;
            };
            rules.push_str(&format!("    (literal {literal})\n"));
        }
        if !rules.is_empty() {
            policy.push_str(&format!("(allow {operation}\n{rules})\n"));
        }
    }
    policy
}

// ============================================================================
// Utilities (private)
// ============================================================================

/// Encode a UTF-8 path as a complete SBPL string literal, including quotes.
/// Seatbelt's parser is byte-transparent apart from backslash escapes: escape
/// backslashes and quotes, and hex-encode ASCII controls to keep literals log-safe.
/// Non-UTF-8 paths cannot be represented and are omitted from dynamic grants.
fn sbpl_path_literal(path: &Path) -> Option<String> {
    let path = path.to_str()?;
    let mut literal = String::from("\"");
    for ch in path.chars() {
        match ch {
            '\\' => literal.push_str("\\\\"),
            '"' => literal.push_str("\\\""),
            ch if (ch as u32) < 0x20 || ch == '\u{7f}' => {
                literal.push_str(&format!("\\x{:02x}", ch as u32));
            }
            ch => literal.push(ch),
        }
    }
    literal.push('"');
    Some(literal)
}

/// Canonicalize a path, falling back to the original if canonicalization fails.
///
/// When the path itself or its nearest existing ancestor is a symlink (e.g.
/// `/tmp/bl-{uid}/{box_id}/box.sock`, where `{box_id}` is the binding symlink),
/// only the symlink's parent is canonicalized and its leaf stays literal. The
/// sandbox checks `bind()`/`connect()` against that short symlink location,
/// not its fully-resolved target. Missing descendants are appended afterward.
fn canonicalize_or_original(path: &Path) -> PathBuf {
    let mut existing = path;
    let mut missing = Vec::new();
    while std::fs::symlink_metadata(existing).is_err() {
        let (Some(parent), Some(leaf)) = (existing.parent(), existing.file_name()) else {
            return path.to_path_buf();
        };
        missing.push(leaf.to_os_string());
        existing = parent;
    }

    let is_symlink = std::fs::symlink_metadata(existing)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    let mut canonical = if is_symlink {
        if let (Some(parent), Some(leaf)) = (existing.parent(), existing.file_name())
            && let Ok(canonical_parent) = parent.canonicalize()
        {
            canonical_parent.join(leaf)
        } else {
            existing.to_path_buf()
        }
    } else {
        existing
            .canonicalize()
            .unwrap_or_else(|_| existing.to_path_buf())
    };

    for component in missing.iter().rev() {
        canonical.push(component);
    }
    canonical
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
    fn test_seatbelt_policy_escapes_injected_file_path() {
        let injected_rule = "(allow file-read* (subpath \"/decoy\"))";
        let path = PathBuf::from(format!("/nonexistent/a\") {injected_rule} (\"b"));
        let policy = build_sandbox_policy(
            &[PathAccess {
                path,
                writable: true,
            }],
            &UnixSocketAccess::default(),
            Path::new("/bin/sh"),
            false,
        );

        assert!(
            !policy.contains(injected_rule),
            "raw injected rule must not appear in the policy"
        );
        let literal = r#""/nonexistent/a\") (allow file-read* (subpath \"/decoy\")) (\"b""#;
        assert!(policy.contains(&format!("    (literal {literal})  ; (rw)\n")));
        assert!(policy.contains(&format!("    (literal {literal})  ; writable\n")));
    }

    #[test]
    fn test_seatbelt_policy_path_literal_encoding() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().canonicalize().unwrap();
        for (name, encoded) in [
            ("ordinary ;(path) é", "ordinary ;(path) é"),
            ("back\\slash", r"back\\slash"),
            ("quote\"name", r#"quote\"name"#),
            (
                "line\n\t\r\u{1}\u{1f}\u{7f}af",
                r"line\x0a\x09\x0d\x01\x1f\x7faf",
            ),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, "file").unwrap();
            let policy = build_sandbox_policy(
                &[PathAccess {
                    path,
                    writable: true,
                }],
                &UnixSocketAccess::default(),
                Path::new("/bin/sh"),
                false,
            );
            let literal = format!("\"{}/{encoded}\"", parent.display());
            // Exact, single-line rules also guard ordinary paths against gratuitous escaping.
            assert!(policy.contains(&format!("    (literal {literal})  ; (rw)\n")));
            assert!(policy.contains(&format!("    (literal {literal})  ; writable\n")));
            for line in policy.lines().filter(|line| line.contains("  ; (rw)")) {
                assert_eq!(line, format!("    (literal {literal})  ; (rw)"));
            }
        }
    }

    #[test]
    fn test_seatbelt_policy_escapes_directory_and_binary_paths() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("quoted\"dir");
        std::fs::create_dir(&path).unwrap();
        let literal = format!(
            r#""{}/quoted\"dir""#,
            dir.path().canonicalize().unwrap().display()
        );
        let policy = build_sandbox_policy(
            &[PathAccess {
                path: path.clone(),
                writable: true,
            }],
            &UnixSocketAccess::default(),
            &path.join("shim"),
            false,
        );
        for rule in [
            format!("    (subpath {literal})  ; shim binary + libkrunfw\n"),
            format!("    (literal {literal})  ; (rw) dir root\n"),
            format!("    (subpath {literal})  ; (rw) dir tree\n"),
            format!("    (literal {literal})  ; writable dir root\n"),
            format!("    (subpath {literal})  ; writable dir tree\n"),
        ] {
            assert!(policy.contains(&rule), "missing rule: {rule}");
        }
    }

    #[test]
    fn test_seatbelt_policy_preserves_symlink_canonicalization() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        std::fs::create_dir(&target).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let policy = build_sandbox_policy(
            &[PathAccess {
                path: link,
                writable: true,
            }],
            &UnixSocketAccess::default(),
            Path::new("/bin/sh"),
            false,
        );
        let expected = dir.path().canonicalize().unwrap().join("link");
        assert!(policy.contains(&format!(
            "    (literal \"{}\")  ; (rw) dir root\n",
            expected.display()
        )));
        assert!(policy.contains(&format!(
            "    (subpath \"{}\")  ; writable dir tree\n",
            expected.display()
        )));
        assert!(!policy.contains(target.canonicalize().unwrap().to_str().unwrap()));
    }

    #[test]
    fn test_seatbelt_policy_escapes_unix_socket_paths() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("quote\"socket");
        let policy = build_sandbox_policy(
            &[],
            &UnixSocketAccess {
                bind: vec![socket.clone()],
                connect: vec![socket],
            },
            Path::new("/bin/sh"),
            false,
        );
        let literal = format!(
            r#""{}/quote\"socket""#,
            dir.path().canonicalize().unwrap().display()
        );
        for operation in ["network-bind", "network-outbound"] {
            assert!(policy.contains(&format!("(allow {operation}\n    (literal {literal})\n)")));
        }
    }

    #[test]
    fn test_seatbelt_policy_skips_non_utf8_paths() {
        use std::os::unix::ffi::OsStringExt;
        let path = PathBuf::from(std::ffi::OsString::from_vec(
            b"/nonexistent/invalid-\xff".to_vec(),
        ));
        for binary in [path.join("shim"), PathBuf::from("/bin/sh")] {
            let policy = build_sandbox_policy(
                &[PathAccess {
                    path: path.clone(),
                    writable: true,
                }],
                &UnixSocketAccess {
                    bind: vec![path.clone()],
                    connect: vec![path.clone()],
                },
                &binary,
                false,
            );
            assert!(!policy.contains("invalid-"));
            assert!(!policy.contains('\u{fffd}'));
            assert!(!policy.contains("(allow network-bind"));
            assert!(!policy.contains("(allow network-outbound"));
            // Only the static write fragment may grant writes.
            assert_eq!(
                policy.matches("(allow file-write*").count(),
                SEATBELT_FILE_WRITE_POLICY
                    .matches("(allow file-write*")
                    .count()
            );
            assert!(policy.contains("; Dynamic write grants skipped: no path was representable\n"));
            if binary == path.join("shim") {
                assert!(
                    policy.contains("; Dynamic read grants skipped: no path was representable\n")
                );
            } else {
                assert!(
                    policy.contains("; Dynamic readable paths\n(allow file-read*\n    (subpath ")
                );
            }
            for operation in [
                "file-read*",
                "file-write*",
                "network-bind",
                "network-outbound",
            ] {
                assert!(!policy.contains(&format!("(allow {operation}\n)")));
            }
        }
    }

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
        assert!(SEATBELT_BASE_POLICY.contains("(deny default)"));
        assert!(SEATBELT_BASE_POLICY.contains("(allow process-exec)"));
        assert!(SEATBELT_BASE_POLICY.contains("(allow process-fork)"));
        assert!(SEATBELT_BASE_POLICY.contains("(allow process-info* (target same-sandbox))"));
        assert!(
            SEATBELT_BASE_POLICY.contains("(iokit-registry-entry-class \"RootDomainUserClient\")")
        );
        assert!(
            SEATBELT_BASE_POLICY.contains("com.apple.system.opendirectoryd.libinfo"),
            "Base policy must allow OpenDirectory lookup"
        );
        assert!(
            SEATBELT_BASE_POLICY.contains("com.apple.PowerManagement.control"),
            "Base policy must allow power management lookup"
        );
        assert!(
            SEATBELT_BASE_POLICY.contains("com.apple.logd"),
            "Base policy must allow logd lookup for runtime logging"
        );
        assert!(
            SEATBELT_BASE_POLICY.contains("com.apple.system.notification_center"),
            "Base policy must allow notification center lookup used by macOS runtime components"
        );
        assert!(
            SEATBELT_BASE_POLICY.contains("(allow sysctl-read"),
            "Base policy must include a sysctl allowlist"
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

        let (cmd, _args) = build_sandbox_exec_args(
            &paths,
            &UnixSocketAccess::default(),
            &binary_path,
            true,
            None,
        );

        assert_eq!(cmd, "/usr/bin/sandbox-exec");
    }

    #[test]
    fn test_canonicalize_handles_nonexistent() {
        let nonexistent = Path::new("/this/does/not/exist");
        let result = canonicalize_or_original(nonexistent);
        assert_eq!(result, nonexistent);
    }

    #[test]
    fn test_canonicalize_keeps_symlink_leaf_literal() {
        // Security regression guard: a symlink leaf (the socket binding
        // symlink) must NOT be resolved to its target — the sandbox checks
        // bind()/connect() against the symlink's own location. Resolving
        // through it would emit a rule for the target and deny the bind.
        let tmp = tempfile::TempDir::new().unwrap();
        let target = tmp.path().join("real_sockets");
        std::fs::create_dir_all(&target).unwrap();
        let link = tmp.path().join("binding_link");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let result = canonicalize_or_original(&link);

        assert_eq!(
            result.file_name().unwrap(),
            "binding_link",
            "symlink leaf must stay literal, got {}",
            result.display()
        );
        assert_eq!(
            result.parent().unwrap(),
            tmp.path().canonicalize().unwrap(),
            "parent must be canonicalized"
        );
        assert_ne!(
            result,
            target.canonicalize().unwrap(),
            "must not resolve through the symlink to its target"
        );
    }

    #[test]
    fn test_canonicalize_keeps_symlink_ancestor_literal_for_socket() {
        let tmp = tempfile::TempDir::new().unwrap();
        let target = tmp.path().join("real_sockets");
        std::fs::create_dir_all(&target).unwrap();
        let link = tmp.path().join("binding_link");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let result = canonicalize_or_original(&link.join("box.sock"));

        assert_eq!(
            result,
            tmp.path()
                .canonicalize()
                .unwrap()
                .join("binding_link/box.sock"),
            "socket path must preserve its binding symlink ancestor"
        );
    }

    #[test]
    fn test_build_policy_includes_network_when_enabled() {
        let paths = vec![PathAccess {
            path: PathBuf::from("/tmp/test/boxes/test-box"),
            writable: true,
        }];
        let binary_path = PathBuf::from("/usr/local/bin/boxlite-shim");

        let policy = build_sandbox_policy(&paths, &UnixSocketAccess::default(), &binary_path, true);

        assert!(policy.contains("(allow network-outbound)"));
    }

    #[test]
    fn test_build_policy_excludes_network_when_disabled() {
        let paths = vec![PathAccess {
            path: PathBuf::from("/tmp/test/boxes/test-box"),
            writable: true,
        }];
        let binary_path = PathBuf::from("/usr/local/bin/boxlite-shim");

        let policy =
            build_sandbox_policy(&paths, &UnixSocketAccess::default(), &binary_path, false);

        // Unfiltered grants are the IP-networking ones; they must be absent.
        for grant in [
            "(allow network-outbound)",
            "(allow network-inbound)",
            "(allow system-socket)",
        ] {
            assert!(!policy.contains(grant), "must not emit `{grant}`");
        }
        assert!(policy.contains("IP networking disabled"));
    }

    /// #1072: the shim's AF_UNIX control plane must be granted regardless of
    /// `network_enabled` — it is how the host talks to the box at all.
    #[test]
    fn test_unix_socket_grants_are_independent_of_network_enabled() {
        let dir = tempfile::tempdir().unwrap();
        let sockets_dir = dir.path().join("sockets");
        std::fs::create_dir_all(&sockets_dir).unwrap();
        let bind_socket = sockets_dir.join("box.sock");
        let connect_socket = sockets_dir.join("ready.sock");
        let expected_bind = format!(
            "(literal \"{}\")",
            canonicalize_or_original(&bind_socket).display()
        );
        let expected_connect = format!(
            "(literal \"{}\")",
            canonicalize_or_original(&connect_socket).display()
        );

        let paths = vec![PathAccess {
            path: sockets_dir,
            writable: true,
        }];
        let unix_sockets = UnixSocketAccess {
            bind: vec![bind_socket],
            connect: vec![connect_socket],
        };
        let binary_path = PathBuf::from("/usr/local/bin/boxlite-shim");

        for network_enabled in [true, false] {
            let policy = build_sandbox_policy(&paths, &unix_sockets, &binary_path, network_enabled);
            let socket_grants = policy
                .split("(allow ")
                .filter(|section| {
                    section.starts_with("network-bind\n")
                        || section.starts_with("network-outbound\n")
                })
                .collect::<Vec<_>>();
            assert_eq!(
                socket_grants.len(),
                2,
                "network_enabled={network_enabled} must emit path-filtered \
                 network-bind and network-outbound blocks:\n{policy}"
            );
            assert!(
                policy.contains(&expected_bind) && policy.contains(&expected_connect),
                "network_enabled={network_enabled} must scope each operation to its \
                 exact socket ({expected_bind}, {expected_connect}):\n{policy}"
            );
            assert!(
                !socket_grants.join("\n").contains(&format!(
                    "(subpath \"{}\")",
                    canonicalize_or_original(&paths[0].path).display()
                )),
                "AF_UNIX grants must not cover the entire sockets directory:\n{policy}"
            );
        }
    }

    /// File-write paths must not become bindable just because they are in the
    /// profile. AF_UNIX grants follow the explicit shim socket path list.
    #[test]
    fn test_unix_socket_grants_only_include_explicit_socket_paths() {
        let dir = tempfile::tempdir().unwrap();
        let writable_volume = dir.path().join("volume");
        let sockets_dir = dir.path().join("sockets");
        std::fs::create_dir_all(&writable_volume).unwrap();
        std::fs::create_dir_all(&sockets_dir).unwrap();
        let socket = sockets_dir.join("box.sock");

        let policy = build_sandbox_policy(
            &[PathAccess {
                path: writable_volume.clone(),
                writable: true,
            }],
            &UnixSocketAccess {
                bind: vec![socket.clone()],
                connect: vec![],
            },
            &PathBuf::from("/usr/local/bin/boxlite-shim"),
            false,
        );
        let socket_grant_sections = policy
            .split("(allow ")
            .filter(|section| {
                section.starts_with("network-bind\n") || section.starts_with("network-outbound\n")
            })
            .collect::<Vec<_>>()
            .join("\n");

        assert!(
            !socket_grant_sections.contains(writable_volume.to_string_lossy().as_ref()),
            "writable non-socket path received AF_UNIX grant: {policy}"
        );
        assert!(
            socket_grant_sections.contains(socket.to_string_lossy().as_ref()),
            "explicit socket path missing: {policy}"
        );
        assert!(
            !socket_grant_sections.contains(&format!(
                "(subpath \"{}\")",
                canonicalize_or_original(&sockets_dir).display()
            )),
            "socket grant must not include its whole directory: {policy}"
        );
    }

    #[test]
    fn test_file_read_policy_structure() {
        assert!(SEATBELT_FILE_READ_POLICY.contains("(subpath \"/usr/lib\")"));
        assert!(SEATBELT_FILE_READ_POLICY.contains("(subpath \"/System/Library\")"));
        assert!(SEATBELT_FILE_READ_POLICY.contains("(literal \"/tmp\")"));
        assert!(SEATBELT_FILE_READ_POLICY.contains("(literal \"/dev/null\")"));
        assert!(!SEATBELT_FILE_READ_POLICY.contains("(subpath \"/usr\")"));
    }

    #[test]
    fn test_file_write_policy_structure() {
        assert!(SEATBELT_FILE_WRITE_POLICY.contains("(subpath \"/private/tmp\")"));
        assert!(SEATBELT_FILE_WRITE_POLICY.contains("(subpath \"/private/var/tmp\")"));
    }

    #[test]
    fn test_shared_shim_write_denials_follow_write_grants() {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let shims = home.path().join("shims");
        let generation = shims.join("0123456789abcdef");
        std::fs::create_dir_all(&generation).unwrap();
        let paths = [PathAccess {
            path: home.path().to_path_buf(),
            writable: true,
        }];
        let policy = build_sandbox_policy(
            &paths,
            &UnixSocketAccess::default(),
            &generation.join("boxlite-shim"),
            true,
        );

        let tmp_grant = policy.find("(subpath \"/private/tmp\")").unwrap();
        let (grants, denials) = policy.rsplit_once("(allow file-write*").unwrap();
        assert!(tmp_grant < grants.len());
        assert!(grants.contains("; Dynamic write paths"));
        for dir in [&shims, &generation] {
            let path = dir.canonicalize().unwrap();
            let literal = sbpl_path_literal(&path).unwrap();
            assert!(
                denials.contains(&format!(
                    "(deny file-write* (literal {literal}) (subpath {literal}))"
                )),
                "missing write denial for {} after the write grants",
                path.display()
            );
        }
    }

    /// The static write policy must NOT grant the whole per-user temp/cache
    /// tree (`/private/var/folders`, a.k.a. `$TMPDIR` / `DARWIN_USER_*_DIR`).
    /// The shim's TMPDIR is redirected to a box-scoped path by
    /// `configure_env()` in `vmm/controller/spawn.rs`, so no blanket grant is
    /// needed under the built-in profile. If you re-add a grant here, scope it
    /// to a single subpath (`-D` parameter), not the whole tree.
    #[test]
    fn test_file_write_policy_excludes_per_user_temp_tree() {
        // Match the grant form, not bare mentions in doc comments. SBPL
        // comments start with `;` so we look for `(subpath "..."` which is
        // unambiguously a live allow expression.
        for grant in [
            "(subpath \"/private/var/folders\")",
            "(subpath \"/private/var/folders/",
        ] {
            assert!(
                !SEATBELT_FILE_WRITE_POLICY.contains(grant),
                "static file-write policy must not grant `{grant}`; \
                 shim TMPDIR is redirected to box-scoped tmp by \
                 vmm/controller/spawn.rs::configure_env"
            );
        }
    }

    #[test]
    fn test_dynamic_read_paths_empty() {
        let generation = "/var/lib/boxlite/shims/0123456789abcdef";
        let binary_path = Path::new(generation).join("boxlite-shim");
        let policy = build_dynamic_read_paths(&binary_path, &[]);

        assert!(policy.contains("(allow file-read*"));
        assert!(policy.contains(generation));
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

        let policy =
            build_sandbox_policy(&paths, &UnixSocketAccess::default(), &binary_path, false);

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
    fn test_dynamic_read_paths_do_not_include_parent_traversal_literals() {
        let binary_path = PathBuf::from("/usr/local/bin/boxlite-shim");
        let dir = tempfile::tempdir().unwrap();
        let shared_dir = dir.path().join("case/boxes/box-1/shared");
        std::fs::create_dir_all(&shared_dir).unwrap();
        let shared_dir = canonicalize_or_original(&shared_dir);
        let box_dir = shared_dir.parent().unwrap();
        let boxes_dir = box_dir.parent().unwrap();
        let case_dir = boxes_dir.parent().unwrap();

        let paths = vec![PathAccess {
            path: shared_dir.clone(),
            writable: true,
        }];

        let policy = build_dynamic_read_paths(&binary_path, &paths);

        // Dynamic read policy should include explicit target path grants.
        assert!(
            policy.contains(&format!("(literal \"{}\")", shared_dir.display())),
            "Expected target directory literal grant: {policy}"
        );
        assert!(
            policy.contains(&format!("(subpath \"{}\")", shared_dir.display())),
            "Expected target directory subpath grant: {policy}"
        );

        // Parent traversal literals are intentionally omitted.
        assert!(
            !policy.contains(&format!("(literal \"{}\")", box_dir.display())),
            "Did not expect parent traversal literal for box directory: {policy}"
        );
        assert!(
            !policy.contains(&format!("(literal \"{}\")", boxes_dir.display())),
            "Did not expect parent traversal literal for boxes directory: {policy}"
        );
        assert!(
            !policy.contains(&format!("(literal \"{}\")", case_dir.display())),
            "Did not expect parent traversal literal for case directory: {policy}"
        );
    }

    #[test]
    fn test_seatbelt_sandbox_name() {
        let sandbox = SeatbeltSandbox::new();
        assert_eq!(sandbox.name(), "seatbelt");
    }

    /// Empty path lists must not produce unrestricted, unfiltered allow rules.
    #[test]
    fn test_dynamic_write_paths_empty_list() {
        let policy = build_dynamic_write_paths(&[]);

        assert_eq!(
            policy,
            "; Dynamic write grants skipped: no path was representable\n"
        );
        assert!(!policy.contains("(allow file-write*"));
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
            FsLayoutConfig::with_bind_mount(),
            true,
        );
        let mounts_base = layout.shared_layout().base().to_path_buf();

        // Create mounts_dir on disk (it exists but should be excluded)
        std::fs::create_dir_all(&mounts_base).unwrap();
        // Also create dirs that SHOULD appear
        std::fs::create_dir_all(layout.sockets_dir()).unwrap();
        std::fs::create_dir_all(layout.logs_dir()).unwrap();

        let paths = crate::jailer::build_path_access(&layout, &[], &[]);
        let binary = PathBuf::from("/usr/local/bin/boxlite-shim");
        let policy = build_sandbox_policy(&paths, &UnixSocketAccess::default(), &binary, false);

        let mounts_str = mounts_base.to_string_lossy().to_string();
        assert!(
            !policy.contains(&mounts_str),
            "mounts_dir path must not appear anywhere in sandbox policy\nmounts_dir={}\npolicy=\n{}",
            mounts_str,
            policy
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

    #[cfg(target_os = "macos")]
    fn run_sandboxed_sh(
        paths: &[PathAccess],
        shell_snippet: &str,
        arg: &std::path::Path,
    ) -> std::process::Output {
        let (sandbox_cmd, sandbox_args) = build_sandbox_exec_args(
            paths,
            &UnixSocketAccess::default(),
            std::path::Path::new("/bin/sh"),
            false,
            None,
        );
        std::process::Command::new(sandbox_cmd)
            .args(sandbox_args)
            .arg("/bin/sh")
            .arg("-c")
            .arg(shell_snippet)
            .arg("sh")
            .arg(arg)
            .output()
            .expect("Failed to execute sandboxed shell command")
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_seatbelt_runtime_quoted_and_backslash_files_are_readable() {
        assert!(
            is_sandbox_available(),
            "sandbox-exec required for regression probe"
        );
        let dir = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        for name in ["quote\"file", "back\\slash"] {
            let path = dir.path().join(name);
            std::fs::write(&path, "readable").unwrap();
            let output = run_sandboxed_sh(
                &[PathAccess {
                    path: path.clone(),
                    writable: false,
                }],
                "cat \"$1\"",
                &path,
            );
            assert!(
                output.status.success(),
                "read failed for {name:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(output.stdout, b"readable");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_seatbelt_runtime_control_byte_path_matches_exactly() {
        assert!(
            is_sandbox_available(),
            "sandbox-exec required for regression probe"
        );
        let dir = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        let path = dir.path().join("line\n4141");
        let sibling = dir.path().join("line4141");
        let contents = b"control-byte file contents\n";
        let sibling_contents = b"private sibling contents\n";
        std::fs::write(&path, contents).unwrap();
        std::fs::write(&sibling, sibling_contents).unwrap();
        let paths = [PathAccess {
            path: path.clone(),
            writable: false,
        }];

        let output = run_sandboxed_sh(&paths, "cat \"$1\"", &path);
        assert!(
            output.status.success(),
            "control-byte file read failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, contents);
        assert!(!sibling_contents.starts_with(&output.stdout));

        let output = run_sandboxed_sh(&paths, "cat \"$1\"", &sibling);
        assert!(
            !output.status.success(),
            "control-byte grant must not allow reading the sibling"
        );
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("Operation not permitted"),
            "expected kernel denial, not a profile parse error: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stdout.is_empty(), "sibling contents must not leak");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_seatbelt_runtime_injected_path_cannot_read_decoy() {
        assert!(
            is_sandbox_available(),
            "sandbox-exec required for regression probe"
        );
        let dir = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        let decoy_dir = dir.path().join("decoy");
        std::fs::create_dir(&decoy_dir).unwrap();
        let decoy = decoy_dir.join("secret");
        std::fs::write(&decoy, "secret").unwrap();
        let decoy_parent = decoy_dir.canonicalize().unwrap();
        for payload in [
            // Balance the surrounding allow block so raw interpolation would
            // produce a valid profile that actually grants access to the decoy.
            format!(
                "a\")) (allow file-read* (subpath \"{}\")) (allow file-read* (literal \"b",
                decoy_parent.display()
            ),
            format!(
                "a\") (allow file-read* (subpath \"{}\")) (\"b",
                decoy_parent.display()
            ),
        ] {
            let output = run_sandboxed_sh(
                &[PathAccess {
                    path: dir.path().join(payload),
                    writable: false,
                }],
                "cat \"$1\" >/dev/null",
                &decoy,
            );
            assert!(
                !output.status.success(),
                "injected path must not grant decoy read access"
            );
            assert!(
                String::from_utf8_lossy(&output.stderr).contains("Operation not permitted"),
                "expected kernel denial, not a profile parse error: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_seatbelt_runtime_allows_write_to_writable_path() {
        if !is_sandbox_available() {
            eprintln!("Skipping: sandbox-exec not available");
            return;
        }

        let cwd = std::env::current_dir().expect("cwd");
        let dir = tempfile::tempdir_in(cwd).expect("tempdir in workspace");
        let allowed_dir = dir.path().join("allowed");
        std::fs::create_dir_all(&allowed_dir).expect("create allowed dir");
        let allowed_file = allowed_dir.join("ok.txt");

        let paths = vec![PathAccess {
            path: allowed_dir.clone(),
            writable: true,
        }];

        let output = run_sandboxed_sh(&paths, "echo ok > \"$1\"", &allowed_file);
        assert!(
            output.status.success(),
            "Expected write to allowed path to succeed, stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let written = std::fs::read_to_string(&allowed_file).expect("read allowed file");
        assert_eq!(written, "ok\n");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_seatbelt_runtime_allows_exec_from_tmp_dynamic_path() {
        if !is_sandbox_available() {
            eprintln!("Skipping: sandbox-exec not available");
            return;
        }

        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir_in("/tmp").expect("tempdir in /tmp");
        let script_path = dir.path().join("probe.sh");
        std::fs::write(&script_path, "#!/bin/sh\necho tmp-exec-ok\n").expect("write /tmp script");
        std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755))
            .expect("set exec bit");

        let paths = vec![PathAccess {
            path: dir.path().to_path_buf(),
            writable: false,
        }];

        let (sandbox_cmd, sandbox_args) = build_sandbox_exec_args(
            &paths,
            &UnixSocketAccess::default(),
            std::path::Path::new("/bin/sh"),
            false,
            None,
        );
        let output = std::process::Command::new(sandbox_cmd)
            .args(sandbox_args)
            .arg("/bin/sh")
            .arg(&script_path)
            .output()
            .expect("Failed to execute sandboxed /tmp script");
        assert!(
            output.status.success(),
            "Expected /tmp script exec to succeed, stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout), "tmp-exec-ok\n");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_seatbelt_runtime_denies_writes_to_shared_shims_in_tmp() {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let shims = home.path().join("shims");
        let generation = shims.join("0123456789abcdef");
        std::fs::create_dir_all(&generation).unwrap();
        let shim = generation.join("boxlite-shim");
        std::fs::write(&shim, b"shim").unwrap();
        let paths = [PathAccess {
            path: PathBuf::from("/bin"),
            writable: false,
        }];
        let (sandbox_cmd, sandbox_args) =
            build_sandbox_exec_args(&paths, &UnixSocketAccess::default(), &shim, false, None);
        let allowed = home.path().join("allowed");
        let run = |path: &Path| {
            Command::new(&sandbox_cmd)
                .args(&sandbox_args)
                .args(["/bin/sh", "-c", "echo written > \"$1\"", "sh"])
                .arg(path)
                .output()
                .unwrap()
        };

        let output = run(&allowed);
        assert!(output.status.success(), "{:?}", output);
        for blocked in [&shim, &shims.join("another-shim")] {
            let output = run(blocked);
            assert!(!output.status.success(), "write succeeded for {blocked:?}");
            assert!(
                String::from_utf8_lossy(&output.stderr).contains("Operation not permitted"),
                "{output:?}"
            );
        }
        assert_eq!(std::fs::read(&shim).unwrap(), b"shim");
        assert!(!shims.join("another-shim").exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_seatbelt_runtime_denies_write_outside_writable_path() {
        if !is_sandbox_available() {
            eprintln!("Skipping: sandbox-exec not available");
            return;
        }

        let cwd = std::env::current_dir().expect("cwd");
        let dir = tempfile::tempdir_in(cwd).expect("tempdir in workspace");
        let allowed_dir = dir.path().join("allowed");
        std::fs::create_dir_all(&allowed_dir).expect("create allowed dir");
        let blocked_file = dir.path().join("blocked.txt");

        let paths = vec![PathAccess {
            path: allowed_dir,
            writable: true,
        }];

        let output = run_sandboxed_sh(&paths, "echo blocked > \"$1\"", &blocked_file);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success(),
            "Expected write outside allowlist to fail"
        );
        assert!(
            stderr.contains("Operation not permitted"),
            "Expected sandbox denial, got stderr: {}",
            stderr
        );
        assert!(
            !blocked_file.exists(),
            "Blocked file must not be created outside writable allowlist"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_seatbelt_runtime_denies_read_outside_allowlist() {
        if !is_sandbox_available() {
            eprintln!("Skipping: sandbox-exec not available");
            return;
        }

        let cwd = std::env::current_dir().expect("cwd");
        let dir = tempfile::tempdir_in(cwd).expect("tempdir in workspace");
        let allowed_dir = dir.path().join("allowed");
        std::fs::create_dir_all(&allowed_dir).expect("create allowed dir");
        let blocked_file = dir.path().join("secret.txt");
        std::fs::write(&blocked_file, "secret").expect("write blocked file");

        let paths = vec![PathAccess {
            path: allowed_dir,
            writable: true,
        }];

        let output = run_sandboxed_sh(&paths, "cat \"$1\" >/dev/null", &blocked_file);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !output.status.success(),
            "Expected read outside allowlist to fail"
        );
        assert!(
            stderr.contains("Operation not permitted"),
            "Expected sandbox denial, got stderr: {}",
            stderr
        );
    }

    /// Listener probe binary. Part of the macOS base system; the probes skip
    /// themselves rather than misreport a denial if it is ever absent.
    #[cfg(target_os = "macos")]
    const PROBE_BIN: &str = "/usr/bin/nc";

    /// What a listener probe did under a generated profile.
    #[cfg(target_os = "macos")]
    enum ProbeOutcome {
        /// Acquired the socket and kept running.
        Listening,
        /// Exited immediately; carries the probe's stderr.
        Denied(String),
    }

    /// Run `/usr/bin/nc` as a listener under a generated profile.
    ///
    /// `nc` blocks once it owns the socket and exits at once when the sandbox
    /// denies the bind, so the two outcomes are unambiguous. `bound_marker` is
    /// the node that appears on success, letting the allow case finish as soon
    /// as it shows up instead of waiting out the deadline.
    #[cfg(target_os = "macos")]
    fn probe_listener(
        paths: &[PathAccess],
        unix_sockets: &UnixSocketAccess,
        network_enabled: bool,
        nc_args: &[&str],
        bound_marker: Option<&Path>,
    ) -> ProbeOutcome {
        use std::io::Read;
        use std::time::{Duration, Instant};

        let (sandbox_cmd, sandbox_args) = build_sandbox_exec_args(
            paths,
            unix_sockets,
            Path::new(PROBE_BIN),
            network_enabled,
            None,
        );
        let mut child = Command::new(sandbox_cmd)
            .args(sandbox_args)
            .arg(PROBE_BIN)
            .args(nc_args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn sandbox-exec");

        let deadline = Instant::now() + Duration::from_secs(5);
        let outcome = loop {
            if bound_marker.is_some_and(|marker| marker.exists()) {
                break ProbeOutcome::Listening;
            }
            match child.try_wait().expect("poll nc") {
                Some(_) => {
                    let mut stderr = String::new();
                    if let Some(mut pipe) = child.stderr.take() {
                        let _ = pipe.read_to_string(&mut stderr);
                    }
                    break ProbeOutcome::Denied(stderr.trim().to_string());
                }
                None if Instant::now() >= deadline => break ProbeOutcome::Listening,
                None => std::thread::sleep(Duration::from_millis(20)),
            }
        };

        let _ = child.kill();
        let _ = child.wait();
        outcome
    }

    /// Regression guard for #1072: `security.network_enabled = false` must not
    /// take the shim's own AF_UNIX control plane down with it. Before the fix
    /// this bind failed with EPERM and every box died ~1ms after start.
    ///
    /// Probes under `/private/tmp` for two reasons: `sun_path` caps the whole
    /// socket path at 104 bytes, and it keeps the probe off the deep workspace
    /// path a checkout may sit under.
    #[cfg(target_os = "macos")]
    #[test]
    fn test_seatbelt_runtime_allows_unix_socket_bind_without_network() {
        if !is_sandbox_available() || !Path::new(PROBE_BIN).exists() {
            eprintln!("Skipping: sandbox-exec or {PROBE_BIN} not available");
            return;
        }

        let dir = tempfile::tempdir_in("/private/tmp").expect("tempdir");
        let sockets_dir = dir.path().join("sockets");
        std::fs::create_dir_all(&sockets_dir).expect("create sockets dir");
        let binding_dir = dir.path().join("binding");
        std::os::unix::fs::symlink(&sockets_dir, &binding_dir).expect("create binding symlink");
        let sock = binding_dir.join("net.sock");
        let real_sock = sockets_dir.join("net.sock");
        assert!(
            sock.as_os_str().len() < 104,
            "probe path must fit sun_path: {}",
            sock.display()
        );

        let paths = vec![
            PathAccess {
                path: sockets_dir,
                writable: true,
            },
            PathAccess {
                path: binding_dir.clone(),
                writable: true,
            },
            PathAccess {
                path: dir.path().to_path_buf(),
                writable: false,
            },
        ];

        match probe_listener(
            &paths,
            &UnixSocketAccess {
                bind: vec![sock.clone(), real_sock.clone()],
                connect: vec![],
            },
            false,
            &["-lU", sock.to_str().expect("utf-8 socket path")],
            Some(&sock),
        ) {
            ProbeOutcome::Listening => assert!(
                sock.exists(),
                "probe kept running but bound no socket at {}",
                sock.display()
            ),
            ProbeOutcome::Denied(stderr) => panic!(
                "network_enabled=false denied the AF_UNIX bind at {}: {stderr}",
                sock.display()
            ),
        }

        let blocked = binding_dir.join("unexpected.sock");
        match probe_listener(
            &paths,
            &UnixSocketAccess {
                bind: vec![sock, real_sock],
                connect: vec![],
            },
            false,
            &["-lU", blocked.to_str().expect("utf-8 socket path")],
            Some(&blocked),
        ) {
            ProbeOutcome::Denied(stderr) => assert!(
                stderr.contains("Operation not permitted"),
                "expected exact-path sandbox denial, got: {stderr}"
            ),
            ProbeOutcome::Listening => panic!(
                "exact AF_UNIX grant must deny a sibling socket at {}",
                blocked.display()
            ),
        }
    }

    /// The Unix-domain grants are filtered by path, so they must not smuggle
    /// in IP networking — `network_enabled` stays the only switch for that.
    #[cfg(target_os = "macos")]
    #[test]
    fn test_seatbelt_runtime_still_denies_tcp_without_network() {
        if !is_sandbox_available() || !Path::new(PROBE_BIN).exists() {
            eprintln!("Skipping: sandbox-exec or {PROBE_BIN} not available");
            return;
        }

        let dir = tempfile::tempdir_in("/private/tmp").expect("tempdir");
        let sockets_dir = dir.path().join("sockets");
        std::fs::create_dir_all(&sockets_dir).expect("create sockets dir");

        let paths = vec![PathAccess {
            path: sockets_dir,
            writable: true,
        }];
        let port_guard =
            std::net::TcpListener::bind("127.0.0.1:0").expect("reserve TCP probe port");
        let port = port_guard
            .local_addr()
            .expect("read TCP probe port")
            .port()
            .to_string();

        match probe_listener(
            &paths,
            &UnixSocketAccess {
                bind: vec![paths[0].path.join("net.sock")],
                connect: vec![],
            },
            false,
            &["-l", "127.0.0.1", &port],
            None,
        ) {
            ProbeOutcome::Denied(stderr) => assert!(
                stderr.contains("Operation not permitted"),
                "expected a sandbox denial, got: {stderr}"
            ),
            ProbeOutcome::Listening => {
                panic!("network_enabled=false must still deny TCP listeners")
            }
        }
    }
}
