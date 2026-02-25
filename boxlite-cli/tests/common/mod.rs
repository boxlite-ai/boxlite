#![allow(dead_code)]

use assert_cmd::Command;
use boxlite_test_utils::{TEST_REGISTRIES, warm_temp_dir};
use std::path::PathBuf;
use std::time::Duration;
use tempfile::TempDir;

fn apply_registries(cmd: &mut Command) {
    for reg in TEST_REGISTRIES {
        cmd.arg("--registry").arg(reg);
    }
}

pub struct TestContext {
    pub cmd: Command,
    pub home: PathBuf,
    _tmp_dir: TempDir,
}

impl TestContext {
    /// Create a new command sharing the same home directory.
    pub fn new_cmd(&self) -> Command {
        let bin_path = env!("CARGO_BIN_EXE_boxlite");
        let mut cmd = Command::new(bin_path);
        cmd.timeout(Duration::from_secs(60));
        cmd.arg("--home").arg(&self.home);
        apply_registries(&mut cmd);
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

/// Create a TestContext without default registries.
/// Use this when the test needs full control over which registries are used.
pub fn boxlite_bare() -> TestContext {
    let (tmp_dir, home) = warm_temp_dir();
    let bin_path = env!("CARGO_BIN_EXE_boxlite");
    let mut cmd = Command::new(bin_path);
    cmd.timeout(Duration::from_secs(60));
    cmd.arg("--home").arg(&home);

    TestContext {
        cmd,
        home,
        _tmp_dir: tmp_dir,
    }
}

pub fn boxlite() -> TestContext {
    let (tmp_dir, home) = warm_temp_dir();
    let bin_path = env!("CARGO_BIN_EXE_boxlite");
    let mut cmd = Command::new(bin_path);
    cmd.timeout(Duration::from_secs(60));
    cmd.arg("--home").arg(&home);
    apply_registries(&mut cmd);

    TestContext {
        cmd,
        home,
        _tmp_dir: tmp_dir,
    }
}
