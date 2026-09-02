#![allow(dead_code)]

pub mod serve;

use assert_cmd::Command;
use boxlite_test_utils::TEST_REGISTRIES;
use boxlite_test_utils::home::PerTestBoxHome;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

fn write_registry_config(home: &std::path::Path) -> PathBuf {
    let path = home.join("test-runtime-config.json");
    let registries = TEST_REGISTRIES
        .iter()
        .map(|host| serde_json::json!({ "host": host, "search": true }))
        .collect::<Vec<_>>();
    let config = serde_json::to_vec(&serde_json::json!({ "image_registries": registries }))
        .expect("serialize test runtime config");
    fs::write(&path, config).expect("write test runtime config");
    path
}

pub struct TestContext {
    pub cmd: Command,
    pub home: PathBuf,
    registry_config: Option<PathBuf>,
    _home: PerTestBoxHome,
}

impl TestContext {
    /// Create a new command sharing the same home directory.
    pub fn new_cmd(&self) -> Command {
        let bin_path = env!("CARGO_BIN_EXE_boxlite");
        let mut cmd = Command::new(bin_path);
        cmd.timeout(Duration::from_secs(60));
        cmd.arg("--home").arg(&self.home);
        if let Some(config) = &self.registry_config {
            cmd.arg("--config").arg(config);
        }
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

impl Drop for TestContext {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            return;
        }

        for box_id in box_ids_under_home(&self.home) {
            let mut cmd = self.new_cmd();
            cmd.timeout(Duration::from_secs(30));
            cmd.args(["rm", "--force", &box_id]);
            let _ = cmd.ok();
        }
    }
}

fn box_ids_under_home(home: &std::path::Path) -> Vec<String> {
    let boxes = home.join("boxes");
    let Ok(entries) = fs::read_dir(boxes) else {
        return Vec::new();
    };

    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }
            entry.file_name().into_string().ok()
        })
        .filter(|name| name.chars().all(|c| c.is_ascii_alphanumeric()))
        .collect()
}

/// Create a TestContext without default registries.
/// Use this when the test needs full control over which registries are used.
pub fn boxlite_bare() -> TestContext {
    let home_dir = PerTestBoxHome::new();
    let home = home_dir.path.clone();
    let bin_path = env!("CARGO_BIN_EXE_boxlite");
    let mut cmd = Command::new(bin_path);
    cmd.timeout(Duration::from_secs(60));
    cmd.arg("--home").arg(&home);

    TestContext {
        cmd,
        home,
        registry_config: None,
        _home: home_dir,
    }
}

pub fn boxlite() -> TestContext {
    let home_dir = PerTestBoxHome::new();
    let home = home_dir.path.clone();
    let bin_path = env!("CARGO_BIN_EXE_boxlite");
    let mut cmd = Command::new(bin_path);
    cmd.timeout(Duration::from_secs(60));
    cmd.arg("--home").arg(&home);
    let registry_config = write_registry_config(&home);
    cmd.arg("--config").arg(&registry_config);

    TestContext {
        cmd,
        home,
        registry_config: Some(registry_config),
        _home: home_dir,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn box_ids_under_home_lists_box_shaped_dirs_only() {
        let temp = tempfile::TempDir::new().unwrap();
        let boxes = temp.path().join("boxes");
        fs::create_dir_all(&boxes).unwrap();
        fs::create_dir(boxes.join("abc123")).unwrap();
        fs::create_dir(boxes.join("not-a-box")).unwrap();
        fs::write(boxes.join("file123"), "").unwrap();

        assert_eq!(box_ids_under_home(temp.path()), vec!["abc123".to_string()]);
    }
}
