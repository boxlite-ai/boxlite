//! Per-test fixture: runtime + running box + one-word helpers.
//!
//! Like RocksDB's `DBTestBase` — constructor does all setup, Drop does cleanup.
//!
//! # Example
//!
//! ```ignore
//! use boxlite_test_utils::box_test::BoxTestBase;
//!
//! #[tokio::test]
//! async fn exec_echo() {
//!     let t = BoxTestBase::new().await;
//!     let out = t.exec_stdout("echo", &["hello"]).await;
//!     assert_eq!(out.trim(), "hello");
//! }
//! ```

use boxlite::runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec};
use boxlite::{BoxCommand, BoxliteRuntime, ExecResult, LiteBox};
use futures::StreamExt as _;

use crate::home::PerTestBoxHome;
use crate::test_registries;

/// Per-test fixture with runtime, running box, and one-word helpers.
///
/// Constructor creates a runtime, creates a box, and starts it.
/// Drop stops the box, removes it, and shuts down the runtime.
///
/// Drop order: `bx` → `runtime` → `_home` (ensures cleanup before dir removal).
pub struct BoxTestBase {
    /// The boxlite runtime for this test.
    pub runtime: BoxliteRuntime,
    /// The running box handle.
    pub bx: LiteBox,
    _home: PerTestBoxHome,
}

impl BoxTestBase {
    /// Create a new test fixture with `alpine:latest` and default options.
    ///
    /// Returns a **running** box. Triggers shared cache initialization on first call.
    pub async fn new() -> Self {
        let t = Self::with_options(BoxOptions {
            rootfs: RootfsSpec::Image("alpine:latest".into()),
            auto_remove: false,
            ..Default::default()
        })
        .await;
        t.bx.start().await.expect("start BoxTestBase box");
        t
    }

    /// Create a new test fixture with custom `BoxOptions`.
    ///
    /// Returns a **created-but-not-started** box. Call `bx.start().await` when ready.
    pub async fn with_options(options: BoxOptions) -> Self {
        let home = PerTestBoxHome::new();
        Self::with_home(home, options).await
    }

    /// Create a test fixture with a pre-built home directory and custom options.
    ///
    /// Useful for tests that need a custom home (e.g., short path for macOS socket limits).
    /// Returns a **created-but-not-started** box. Call `bx.start().await` when ready.
    pub async fn with_home(home: PerTestBoxHome, options: BoxOptions) -> Self {
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: test_registries(),
        })
        .expect("create BoxTestBase runtime");

        let bx = runtime
            .create(options, None)
            .await
            .expect("create BoxTestBase box");

        Self {
            runtime,
            bx,
            _home: home,
        }
    }

    /// Create a fixture without warm cache (for non-VM tests that still need the struct shape).
    pub async fn isolated() -> Self {
        let home = PerTestBoxHome::isolated();
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: test_registries(),
        })
        .expect("create isolated BoxTestBase runtime");

        let bx = runtime
            .create(
                BoxOptions {
                    rootfs: RootfsSpec::Image("alpine:latest".into()),
                    auto_remove: false,
                    ..Default::default()
                },
                None,
            )
            .await
            .expect("create isolated BoxTestBase box");

        Self {
            runtime,
            bx,
            _home: home,
        }
    }

    /// Path to this test's home directory.
    pub fn home_dir(&self) -> &std::path::Path {
        &self._home.path
    }

    // ────────────────────────────────────────────────────────────────────────
    // One-word helpers
    // ────────────────────────────────────────────────────────────────────────

    /// Run a command and return stdout as a string.
    ///
    /// Asserts exit code is 0. Panics on error.
    pub async fn exec_stdout(&self, cmd: &str, args: &[&str]) -> String {
        let command = BoxCommand::new(cmd).args(args.iter().copied());
        let mut run = self
            .bx
            .exec(command)
            .await
            .unwrap_or_else(|e| panic!("exec_stdout({cmd}): failed: {e}"));

        let mut stdout = String::new();
        if let Some(mut stream) = run.stdout() {
            while let Some(chunk) = stream.next().await {
                stdout.push_str(&chunk);
            }
        }

        let result = run
            .wait()
            .await
            .unwrap_or_else(|e| panic!("exec_stdout({cmd}): wait failed: {e}"));
        assert_eq!(
            result.exit_code, 0,
            "exec_stdout({cmd}): non-zero exit code {}",
            result.exit_code
        );
        stdout
    }

    /// Run a command and return the exit code.
    ///
    /// Does not assert on exit code — returns it for the caller to check.
    pub async fn exec_exit_code(&self, cmd: &str, args: &[&str]) -> i32 {
        let command = BoxCommand::new(cmd).args(args.iter().copied());
        let mut run = self
            .bx
            .exec(command)
            .await
            .unwrap_or_else(|e| panic!("exec_exit_code({cmd}): failed: {e}"));

        let result = run
            .wait()
            .await
            .unwrap_or_else(|e| panic!("exec_exit_code({cmd}): wait failed: {e}"));
        result.exit_code
    }

    /// Run a command and return the full `ExecResult`.
    ///
    /// Does not assert on exit code.
    pub async fn exec_result(&self, cmd: &str, args: &[&str]) -> ExecResult {
        let command = BoxCommand::new(cmd).args(args.iter().copied());
        let mut run = self
            .bx
            .exec(command)
            .await
            .unwrap_or_else(|e| panic!("exec_result({cmd}): failed: {e}"));

        run.wait()
            .await
            .unwrap_or_else(|e| panic!("exec_result({cmd}): wait failed: {e}"))
    }

    /// Write a file inside the box.
    pub async fn write_file(&self, path: &str, content: &str) {
        let escaped = content.replace('\'', "'\\''");
        let shell_cmd = format!("printf '%s' '{escaped}' > {path}");
        let command = BoxCommand::new("sh").args(["-c", &shell_cmd]);
        let mut run = self
            .bx
            .exec(command)
            .await
            .unwrap_or_else(|e| panic!("write_file({path}): failed: {e}"));
        let result = run
            .wait()
            .await
            .unwrap_or_else(|e| panic!("write_file({path}): wait failed: {e}"));
        assert_eq!(
            result.exit_code, 0,
            "write_file({path}): non-zero exit code"
        );
    }

    /// Read a file from inside the box.
    pub async fn read_file(&self, path: &str) -> String {
        self.exec_stdout("cat", &[path]).await
    }

    /// Stop and restart the box with new options.
    ///
    /// Like RocksDB's `Reopen()`. Stops the current box, removes it,
    /// creates a new one with the given options, and starts it.
    pub async fn restart(&mut self, options: BoxOptions) {
        let _ = self.bx.stop().await;
        let _ = self.runtime.remove(self.bx.id().as_str(), true).await;

        let bx = self
            .runtime
            .create(options, None)
            .await
            .expect("restart: create box");
        bx.start().await.expect("restart: start box");
        self.bx = bx;
    }

    /// Assert that the box is in a running/active state.
    pub fn assert_running(&self) {
        let info = self.bx.info();
        assert!(
            info.status.is_active(),
            "expected box to be running, got: {:?}",
            info.status
        );
    }

    /// Assert that the box is stopped.
    pub fn assert_stopped(&self) {
        let info = self.bx.info();
        assert!(
            !info.status.is_active(),
            "expected box to be stopped, got: {:?}",
            info.status
        );
    }
}

// Drop: RuntimeImpl::Drop calls shutdown_sync() automatically when the
// last Arc reference is released. No explicit cleanup needed — the runtime's
// safety net handles stopping non-detached boxes.
