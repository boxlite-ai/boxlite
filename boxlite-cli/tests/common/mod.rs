use assert_cmd::Command;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

/// images pre-pull (manually maintained to avoid Docker Hub rate limits)
const TEST_IMAGES: &[&str] = &["alpine:latest", "python:alpine"];

// Prevents "Failed to acquire runtime lock" errors since all tests share the same home dir
static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static SHARED_HOME: OnceLock<PathBuf> = OnceLock::new();

pub struct TestContext {
    pub cmd: Command,
    #[allow(dead_code)]
    pub home: &'static PathBuf,
    // Hold the lock until the test is done
    #[allow(dead_code)]
    pub _guard: MutexGuard<'static, ()>,
}

impl TestContext {
    /// sharing the same context (home dir and lock)
    pub fn new_cmd(&self) -> Command {
        let bin_path = env!("CARGO_BIN_EXE_boxlite");
        let mut cmd = Command::new(bin_path);
        cmd.timeout(Duration::from_secs(60));
        cmd.arg("--home").arg(self.home);
        cmd
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

        // Pre-pull test images to avoid Docker Hub rate limits
        let bin_path = env!("CARGO_BIN_EXE_boxlite");
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

    let bin_path = env!("CARGO_BIN_EXE_boxlite");
    let mut cmd = Command::new(bin_path);
    // You can override this with .timeout(Duration::from_secs(N))
    cmd.timeout(Duration::from_secs(60));
    cmd.arg("--home").arg(home);

    TestContext {
        cmd,
        home,
        _guard: guard,
    }
}
