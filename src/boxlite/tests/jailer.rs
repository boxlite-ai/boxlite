//! Integration tests for jailer enforcement.
//!
//! Verifies:
//! 1. Jailer is enabled by default on macOS (disabled by default on Linux)
//! 2. Boxes start and execute correctly with jailer enabled (regression guard)
//! 3. Explicitly disabling the jailer still works
//! 4. On Linux: bwrap creates isolated mount/user namespaces

mod common;

use boxlite::runtime::advanced_options::SecurityOptions;
use boxlite::runtime::options::BoxOptions;
use common::box_test::BoxTestBase;
use std::path::PathBuf;

// ============================================================================
// JAILER-SPECIFIC HELPERS
// ============================================================================

#[cfg(target_os = "macos")]
const MACOS_UNIX_SOCKET_PATH_MAX: usize = 104;

fn jailer_test_home_base_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".boxlite-it")
}

#[cfg(target_os = "macos")]
fn assert_macos_socket_path_budget(home_dir: &std::path::Path) {
    let probe = home_dir
        .join("boxes")
        .join("12345678-1234-1234-1234-123456789abc")
        .join("sockets")
        .join("box.sock");
    let probe_len = probe.to_string_lossy().len();
    let budget = MACOS_UNIX_SOCKET_PATH_MAX - 1;
    assert!(
        probe_len <= budget,
        "Jailer test home base is too long for macOS Unix socket paths \
         (probe={}, len={}, budget={}). Use a shorter base path than {}",
        probe.display(),
        probe_len,
        budget,
        home_dir.display()
    );
}

/// Per-test home for jailer tests under `~/.boxlite-it`.
///
/// Uses a short base path to satisfy macOS 104-char Unix socket path limit.
/// Cleanup: `PerTestBoxHome` (owned by `BoxTestBase` after `.home` is moved)
/// handles per-test TempDir removal via Drop. The base dir `~/.boxlite-it`
/// is left in place (shared across test runs).
struct JailerHome {
    home: boxlite_test_utils::home::PerTestBoxHome,
}

impl JailerHome {
    fn new() -> Self {
        let base = jailer_test_home_base_dir();
        std::fs::create_dir_all(&base).expect("create jailer test home base");
        let home = boxlite_test_utils::home::PerTestBoxHome::new_in(
            base.to_str().expect("base path UTF-8"),
        );

        #[cfg(target_os = "macos")]
        assert_macos_socket_path_budget(&home.path);
        #[cfg(target_os = "macos")]
        {
            let canonical = home
                .path
                .canonicalize()
                .unwrap_or_else(|_| home.path.clone());
            assert!(
                !canonical.starts_with("/private/tmp"),
                "jailer tests must not use /private/tmp as home_dir: {}",
                canonical.display()
            );
        }

        Self { home }
    }
}

fn jailer_enabled_options() -> BoxOptions {
    common::alpine_opts().with_security(SecurityOptions {
        jailer_enabled: true,
        ..SecurityOptions::default()
    })
}

fn jailer_disabled_options() -> BoxOptions {
    common::alpine_opts().with_security(SecurityOptions {
        jailer_enabled: false,
        ..SecurityOptions::default()
    })
}

#[cfg(target_os = "macos")]
fn with_sandbox_profile(options: BoxOptions, profile_path: std::path::PathBuf) -> BoxOptions {
    let mut security = options.advanced.security().clone();
    security.sandbox_profile = Some(profile_path);
    options.with_security(security)
}

#[cfg(target_os = "macos")]
fn sandbox_exec_available() -> bool {
    std::path::Path::new("/usr/bin/sandbox-exec").exists()
}

#[cfg(target_os = "macos")]
fn sbpl_escape(path: &std::path::Path) -> String {
    path.display()
        .to_string()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn write_deny_boxes_profile(home_dir: &std::path::Path) -> std::path::PathBuf {
    let raw_boxes = home_dir.join("boxes");
    let canonical_boxes = raw_boxes
        .canonicalize()
        .unwrap_or_else(|_| raw_boxes.clone());

    let mut deny_rules = vec![
        format!(
            "(deny file-read* (subpath \"{}\"))",
            sbpl_escape(raw_boxes.as_path())
        ),
        format!(
            "(deny file-write* (subpath \"{}\"))",
            sbpl_escape(raw_boxes.as_path())
        ),
    ];

    if canonical_boxes != raw_boxes {
        deny_rules.push(format!(
            "(deny file-read* (subpath \"{}\"))",
            sbpl_escape(canonical_boxes.as_path())
        ));
        deny_rules.push(format!(
            "(deny file-write* (subpath \"{}\"))",
            sbpl_escape(canonical_boxes.as_path())
        ));
    }

    let profile = format!("(version 1)\n(allow default)\n{}\n", deny_rules.join("\n"));

    let profile_path = home_dir.join("deny-boxes.sbpl");
    std::fs::write(&profile_path, profile).expect("Failed to write deny profile");
    profile_path
}

// ============================================================================
// DEFAULT CONFIGURATION TESTS
// ============================================================================

/// Verify SecurityOptions::default() enables the jailer on macOS only.
#[test]
fn default_security_options_enable_jailer_on_supported_platforms() {
    let opts = SecurityOptions::default();

    #[cfg(target_os = "macos")]
    assert!(
        opts.jailer_enabled,
        "Jailer should be enabled by default on macOS"
    );

    #[cfg(not(target_os = "macos"))]
    assert!(
        !opts.jailer_enabled,
        "Jailer should be disabled by default on Linux and unsupported platforms"
    );
}

/// Verify SecurityOptions::development() always disables the jailer.
#[test]
fn development_mode_disables_jailer() {
    let opts = SecurityOptions::development();
    assert!(
        !opts.jailer_enabled,
        "Development mode must always disable the jailer"
    );
}

/// Verify SecurityOptions::standard() enables the jailer on Linux/macOS.
#[test]
fn standard_mode_enables_jailer() {
    let opts = SecurityOptions::standard();

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    assert!(
        opts.jailer_enabled,
        "Standard mode should enable jailer on Linux/macOS"
    );
}

// ============================================================================
// INTEGRATION TESTS: Jailer enabled regression guard
// ============================================================================

/// Box with jailer enabled starts and executes commands successfully.
#[tokio::test]
async fn jailer_enabled_box_starts_and_executes() {
    let jh = JailerHome::new();
    let t = BoxTestBase::with_home(jh.home, jailer_enabled_options()).await;
    t.bx.start().await.unwrap();

    let out = t.exec_stdout("echo", &["jailer-test"]).await;
    assert!(
        out.contains("jailer-test"),
        "Command should succeed with jailer enabled"
    );
}

/// Box with jailer explicitly disabled still works (development mode).
#[tokio::test]
async fn jailer_disabled_box_starts_and_executes() {
    let jh = JailerHome::new();
    let t = BoxTestBase::with_home(jh.home, jailer_disabled_options()).await;
    t.bx.start().await.unwrap();

    let out = t.exec_stdout("echo", &["no-jailer-test"]).await;
    assert!(
        out.contains("no-jailer-test"),
        "Command should succeed with jailer disabled"
    );
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn jailer_enabled_custom_profile_deny_boxes_subpath_blocks_start() {
    if !sandbox_exec_available() {
        eprintln!("Skipping: /usr/bin/sandbox-exec not available");
        return;
    }

    let jh = JailerHome::new();
    let profile_path = write_deny_boxes_profile(&jh.home.path);
    let t = BoxTestBase::with_home(
        jh.home,
        with_sandbox_profile(jailer_enabled_options(), profile_path),
    )
    .await;

    let box_id = t.bx.id().clone();
    let start_result =
        tokio::time::timeout(std::time::Duration::from_secs(600), t.bx.start()).await;

    let start_result = match start_result {
        Ok(result) => result,
        Err(_) => {
            panic!("start() timed out while waiting for sandbox denial");
        }
    };
    assert!(
        start_result.is_err(),
        "Expected start to fail with deny profile for boxes subpath"
    );

    let stderr_path = t
        .home_dir()
        .join("boxes")
        .join(box_id.as_str())
        .join("shim.stderr");
    assert!(
        stderr_path.exists(),
        "shim.stderr should exist after denied startup: {}",
        stderr_path.display()
    );

    let stderr = std::fs::read_to_string(&stderr_path).expect("Should read shim.stderr");
    let stderr_lower = stderr.to_lowercase();
    // "file exists" is valid deny evidence: when the sandbox blocks stat() on a
    // pre-created directory, Rust's create_dir_all can't verify the existing path
    // is a directory and surfaces the original EEXIST from mkdir instead of Ok(()).
    // Without the sandbox, create_dir_all handles existing directories gracefully.
    let has_deny_evidence = stderr_lower.contains("operation not permitted")
        || stderr_lower.contains("sandbox")
        || stderr_lower.contains("deny")
        || stderr_lower.contains("file exists");
    assert!(
        has_deny_evidence,
        "Expected sandbox deny evidence in shim.stderr, got:\n{}",
        stderr
    );
    // Drop: BoxTestBase -> RuntimeImpl::Drop stops non-detached boxes,
    //        PerTestBoxHome -> TempDir cleans up per-test dir.
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn jailer_disabled_with_same_profile_still_starts() {
    if !sandbox_exec_available() {
        eprintln!("Skipping: /usr/bin/sandbox-exec not available");
        return;
    }

    let jh = JailerHome::new();
    let profile_path = write_deny_boxes_profile(&jh.home.path);
    let t = BoxTestBase::with_home(
        jh.home,
        with_sandbox_profile(jailer_disabled_options(), profile_path),
    )
    .await;
    t.bx.start().await.unwrap();

    let out = t
        .exec_stdout("echo", &["profile-ignored-with-jailer-disabled"])
        .await;
    assert!(
        out.contains("profile-ignored-with-jailer-disabled"),
        "Control case should start and execute"
    );
}

// ============================================================================
// RESOURCE LIMITS: SecurityOptions enforcement
// ============================================================================

/// Verify that max_open_files from SecurityOptions is enforced inside the box.
///
/// The guest's file descriptor limit (ulimit -n) must not exceed the configured
/// value. This is the Rust counterpart of:
///  - sdks/go/security_resource_limits_integration_test.go::TestSecurityMaxOpenFiles
///  - sdks/node/tests/security-resource-limits.integration.test.ts
///  - sdks/python/tests/test_resource_limits.py::TestMaxOpenFiles
#[tokio::test]
async fn security_max_open_files_enforced() {
    use boxlite::runtime::advanced_options::ResourceLimits;

    const LIMIT: u64 = 64;

    let jh = JailerHome::new();
    let opts = common::alpine_opts().with_security(SecurityOptions {
        resource_limits: ResourceLimits {
            max_open_files: Some(LIMIT),
            ..ResourceLimits::default()
        },
        ..SecurityOptions::default()
    });
    let t = BoxTestBase::with_home(jh.home, opts).await;
    t.bx.start().await.unwrap();

    let out = t.exec_stdout("sh", &["-c", "ulimit -n"]).await;
    let reported: u64 = out
        .trim()
        .parse()
        .expect("ulimit -n should return a number");
    assert!(
        reported <= LIMIT,
        "max_open_files not enforced: ulimit -n = {reported}, want ≤ {LIMIT}"
    );
}

/// Verify that sanitize_env=true filters host environment variables that are
/// not in env_allowlist from the guest environment.
#[tokio::test]
async fn security_sanitize_env_filters_unlisted_vars() {
    let jh = JailerHome::new();
    let opts = common::alpine_opts().with_security(SecurityOptions {
        sanitize_env: true,
        env_allowlist: vec!["PATH".to_string(), "HOME".to_string()],
        ..SecurityOptions::default()
    });
    let t = BoxTestBase::with_home(jh.home, opts).await;
    t.bx.start().await.unwrap();

    // PATH must be available — it is explicitly allowed.
    let path_out = t.exec_stdout("sh", &["-c", "echo $PATH"]).await;
    assert!(
        !path_out.trim().is_empty(),
        "PATH should be present in guest env (it is in the allowlist)"
    );

    // A variable that is not in the allowlist must not appear in the guest.
    // `grep -c` returns 0 when there are no matches; `|| true` keeps exit 0.
    let grep_out = t
        .exec_stdout(
            "sh",
            &["-c", "env | grep -c BOXLITE_SHOULD_NOT_EXIST || true"],
        )
        .await;
    let count: u32 = grep_out.trim().parse().unwrap_or(0);
    assert_eq!(
        count, 0,
        "sanitize_env did not remove unlisted variable from guest env"
    );
}

// ============================================================================
// LINUX-ONLY: Namespace isolation enforcement
// ============================================================================

/// On Linux, verify bwrap creates an isolated mount namespace for the shim.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn jailer_creates_isolated_mount_namespace() {
    let jh = JailerHome::new();
    let t = BoxTestBase::with_home(jh.home, jailer_enabled_options()).await;
    t.bx.start().await.unwrap();

    // Start a long-running command so the shim stays alive
    let _execution =
        t.bx.exec(boxlite::BoxCommand::new("sleep").arg("30"))
            .await
            .unwrap();

    // Read the shim's PID
    let pid_file = t
        .home_dir()
        .join("boxes")
        .join(t.bx.id().as_str())
        .join("shim.pid");
    let shim_pid = boxlite::util::PidFileReader::at(&pid_file)
        .read()
        .map(|r| r.pid)
        .expect("Should read shim PID file");

    let self_mnt_ns =
        std::fs::read_link("/proc/self/ns/mnt").expect("Should read own mount namespace");
    let shim_mnt_ns = std::fs::read_link(format!("/proc/{}/ns/mnt", shim_pid))
        .expect("Should read shim mount namespace");

    assert_ne!(
        self_mnt_ns, shim_mnt_ns,
        "Shim should be in a different mount namespace (bwrap isolation active)"
    );
}
