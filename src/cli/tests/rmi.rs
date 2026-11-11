use assert_cmd::Command;
use predicates::prelude::*;

fn command(home: &std::path::Path) -> Command {
    let mut command = Command::new(assert_cmd::cargo::cargo_bin!("boxlite"));
    command
        .env_remove("BOXLITE_REST_URL")
        .env_remove("BOXLITE_API_KEY")
        .arg("--home")
        .arg(home);
    command
}

#[test]
fn rmi_removes_eligible_targets_and_reports_individual_failures() {
    let mut fixture = boxlite::LocalImageFixture::new();
    let other_id = format!("sha256:{}", "a".repeat(64));
    fixture.add_image_id(&other_id, "other.example/app:latest");
    fixture.release_runtime();
    let output = command(fixture.home.path())
        .args(["rmi", "ffffffffffff", &fixture.image_id[7..19], &other_id])
        .assert()
        .failure()
        .get_output()
        .clone();
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("{}\n", fixture.image_id)
    );
    let errors = String::from_utf8(output.stderr).unwrap();
    assert!(errors.contains("not found:"));
    assert!(errors.contains("other.example/app:latest"));
    assert!(errors.contains("Reclaimed space:"));
    assert!(!fixture.manifest_path.exists());
    assert!(fixture.has_reference("other.example/app:latest"));
}

#[test]
fn rmi_keeps_the_original_ambiguity_after_an_earlier_target_is_removed() {
    let mut fixture = boxlite::LocalImageFixture::new();
    let prefix = fixture.image_id[7..8].to_string();
    let other_id = format!("sha256:{prefix}{}", "0".repeat(63));
    assert_ne!(other_id, fixture.image_id);
    let reference = format!("other.example/app@{other_id}");
    fixture.add_image_id(&other_id, &reference);
    fixture.release_runtime();
    command(fixture.home.path())
        .args(["rmi", &fixture.image_id, &prefix])
        .assert()
        .failure()
        .stdout(format!("{}\n", fixture.image_id))
        .stderr(predicate::str::contains("ambiguous image ID:"));
    assert!(fixture.has_reference(&reference));
}

#[test]
fn rmi_reports_zero_for_an_empty_target_and_refuses_a_remote_backend() {
    let mut fixture = boxlite::LocalImageFixture::new();
    let paths = fixture.home.path().join("images");
    std::fs::remove_dir_all(&paths).unwrap();
    fixture.release_runtime();
    command(fixture.home.path())
        .args(["rmi", &fixture.image_id])
        .assert()
        .success()
        .stdout(format!("{}\n", fixture.image_id))
        .stderr(predicate::str::contains("Reclaimed space: 0 bytes"));
    command(fixture.home.path())
        .args(["--url", "http://127.0.0.1:1", "rmi", "123"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("unsupported:"));
}

#[test]
fn rmi_is_in_help_and_shell_completion_and_requires_a_target() {
    let home = tempfile::tempdir().unwrap();
    command(home.path())
        .args(["rmi", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("IMAGE_ID"));
    command(home.path()).arg("rmi").assert().failure();
    Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
        .args(["completion", "zsh"])
        .assert()
        .success()
        .stdout(predicate::str::contains("rmi"));
}
