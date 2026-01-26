#![allow(dead_code)]

use assert_cmd::Command;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

/// images pre-pull (manually maintained to avoid Docker Hub rate limits)
const TEST_IMAGES: &[&str] = &["alpine:latest", "python:alpine"];

// Prevents "Failed to acquire runtime lock" errors since all tests share the same home dir
static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static SHARED_HOME: OnceLock<PathBuf> = OnceLock::new();

pub enum TestGuard {
    Shared(MutexGuard<'static, ()>),
    Isolated,
}

pub struct TestContext {
    pub cmd: Command,
    pub home: PathBuf,
    pub _guard: TestGuard,
    pub _temp_dir: Option<tempfile::TempDir>,
}

impl TestContext {
    /// sharing the same context (home dir and lock)
    pub fn new_cmd(&self) -> Command {
        let bin_path = env!("CARGO_BIN_EXE_boxlite");
        let mut cmd = Command::new(bin_path);
        cmd.timeout(Duration::from_secs(60));
        cmd.arg("--home").arg(&self.home);
        cmd
    }

    pub fn cleanup_box(&self, name: &str) {
        let mut cmd = self.new_cmd();
        cmd.args(["rm", "--force", name]);
        let _ = cmd.ok();
    }

    pub fn cleanup_boxes(&self, names: &[&str]) {
        for name in names {
            self.cleanup_box(name);
        }
    }
}

pub fn boxlite() -> TestContext {
    let lock = TEST_LOCK.get_or_init(|| Mutex::new(()));
    let guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    let home = SHARED_HOME.get_or_init(|| {
        eprintln!("Initializing shared test environment...");

        // Use a very short path in /tmp to avoid SUN_LEN limits for Unix sockets (104-108 chars)
        // Project folders can be very deep, exceeding this limit when appended with /boxes/.../sockets/ready.sock
        let test_home = PathBuf::from("/tmp/bl");
        std::fs::create_dir_all(&test_home).expect("Failed to create /tmp/bl directory");

        let home = test_home;
        let bin_path = env!("CARGO_BIN_EXE_boxlite");

        // Clean up any stale containers from previous interrupted test runs (Ctrl+C, kill, etc.)
        eprintln!("Cleaning up stale containers...");
        let _ = std::process::Command::new(bin_path)
            .args(["--home", home.to_str().unwrap(), "rm", "-fa"])
            .output();

        // Pre-pull test images to avoid Docker Hub rate limits
        eprintln!("Pre-pulling {} test image(s)...", TEST_IMAGES.len());

        for image in TEST_IMAGES {
            let result = std::process::Command::new(bin_path)
                .args(["--home", home.to_str().unwrap(), "pull", image])
                .output();

            match result {
                Ok(output) if output.status.success() => {
                    eprintln!("  ✓ {}", image);
                }
                _ => {
                    eprintln!("  ⚠ {} (will pull on-demand)", image);
                }
            }
        }

        eprintln!("Test environment ready");
        home
    });

    let bin_path: &str = env!("CARGO_BIN_EXE_boxlite");
    let mut cmd = Command::new(bin_path);
    // You can override this with .timeout(Duration::from_secs(N))
    cmd.timeout(Duration::from_secs(60));
    cmd.arg("--home").arg(home);

    TestContext {
        cmd,
        home: home.clone(),
        _guard: TestGuard::Shared(guard),
        _temp_dir: None,
    }
}

/// Create an isolated test context with its own temporary home directory.
/// No pre-pulling is performed.  For destructive tests.
pub fn boxlite_isolated() -> TestContext {
    let temp_dir = tempfile::TempDir::new().expect("Failed to create temp directory");
    let home = temp_dir.path().to_path_buf();

    let bin_path: &str = env!("CARGO_BIN_EXE_boxlite");
    let mut cmd = Command::new(bin_path);
    cmd.timeout(Duration::from_secs(120));
    cmd.arg("--home").arg(&home);

    TestContext {
        cmd,
        home,
        _guard: TestGuard::Isolated,
        _temp_dir: Some(temp_dir),
    }
}
