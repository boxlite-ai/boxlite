//! Real guest alias coverage, deliberately outside the no-VM `::tests::` filter.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use boxlite::SshStatus;
use boxlite_test_utils::home::PerTestBoxHome;

use super::install_support::install;
use crate::ssh_cloud_fixture::cli;

struct GuestCleanup<'a> {
    home: &'a Path,
    config: &'a Path,
}

impl Drop for GuestCleanup<'_> {
    fn drop(&mut self) {
        let _ = cli(self.home)
            .timeout(Duration::from_secs(60))
            .arg("--config")
            .arg(self.config)
            .args(["rm", "--force", "dev"])
            .output();
    }
}

fn status(home: &Path, config: &Path) -> SshStatus {
    let output = cli(home)
        .arg("--config")
        .arg(config)
        .args(["ssh", "--status", "dev"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    serde_json::from_slice(&output.stdout).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_local_install_config() {
    let home = PerTestBoxHome::new();
    let user_home = tempfile::tempdir().unwrap();
    let config: PathBuf = home.path.join("test-runtime-config.json");
    std::fs::write(
        &config,
        serde_json::to_vec(&serde_json::json!({
            "image_registries": boxlite_test_utils::test_registries()
        }))
        .unwrap(),
    )
    .unwrap();
    let created = cli(&home.path)
        .timeout(Duration::from_secs(60))
        .arg("--config")
        .arg(&config)
        .args([
            "run",
            "-d",
            "--name",
            "dev",
            "alpine:latest",
            "sleep",
            "600",
        ])
        .output()
        .unwrap();
    assert!(created.status.success(), "{created:?}");
    let _cleanup = GuestCleanup {
        home: &home.path,
        config: &config,
    };
    let id = String::from_utf8(created.stdout).unwrap().trim().to_owned();
    let flags = [
        "--config",
        config.to_str().unwrap(),
        "--alias",
        "installed-ssh",
    ];
    install(&home.path, user_home.path(), &flags).await.unwrap();
    let first = status(&home.path, &config);
    assert!(first.enabled);
    let keys = home.path.join("boxes").join(id).join("ssh");
    let client_key = std::fs::read(keys.join("client_key")).unwrap();
    let host_key = std::fs::read(keys.join("host_key")).unwrap();
    let managed = std::fs::read(user_home.path().join(".boxlite/ssh/config")).unwrap();
    let root = std::fs::read(user_home.path().join(".ssh/config")).unwrap();

    let shell = Command::new("ssh")
        .arg("-F")
        .arg(user_home.path().join(".ssh/config"))
        .args(["installed-ssh", "printf 'installed-ssh-ok\\n'; exit 42"])
        .output()
        .unwrap();
    assert_eq!(shell.status.code(), Some(42), "{shell:?}");
    assert_eq!(shell.stdout, b"installed-ssh-ok\n");

    install(&home.path, user_home.path(), &flags).await.unwrap();
    assert_eq!(
        status(&home.path, &config),
        first,
        "healthy reinstall changed SSH"
    );
    assert_eq!(std::fs::read(keys.join("client_key")).unwrap(), client_key);
    assert_eq!(std::fs::read(keys.join("host_key")).unwrap(), host_key);
    assert_eq!(
        std::fs::read(user_home.path().join(".boxlite/ssh/config")).unwrap(),
        managed
    );
    assert_eq!(
        std::fs::read(user_home.path().join(".ssh/config")).unwrap(),
        root
    );
}
