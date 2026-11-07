use super::*;
use sha2::{Digest, Sha256};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::Path;

const CONTAINER: &str = "c1";
const BINARY: &[u8] = b"#!/bin/sh\necho fake opencode\n";

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A host binary to install, in its own folder outside the share.
fn host_binary(dir: &tempfile::TempDir) -> std::path::PathBuf {
    let path = dir.path().join("opencode");
    std::fs::write(&path, BINARY).unwrap();
    path
}

fn entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

#[test]
fn place_copies_the_file_read_only_under_its_digest() {
    let share = tempfile::tempdir().unwrap();
    let host = tempfile::tempdir().unwrap();
    let digest = sha256_hex(BINARY);

    let placed = AgentShare::new(share.path(), CONTAINER)
        .place("opencode", &host_binary(&host))
        .unwrap();

    assert_eq!(placed.sha256, digest);
    assert_eq!(
        placed.dir_in_box,
        format!("/opt/boxlite/agents/opencode/{digest}")
    );
    let file = share.path().join(format!(
        "containers/{CONTAINER}/volumes/agents/opencode/{digest}/opencode"
    ));
    assert_eq!(std::fs::read(&file).unwrap(), BINARY);
    let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o555, "{mode:o}");
}

#[test]
fn placing_the_same_file_again_keeps_one_copy_and_no_staging() {
    let share = tempfile::tempdir().unwrap();
    let host = tempfile::tempdir().unwrap();
    let agents = AgentShare::new(share.path(), CONTAINER);
    let binary = host_binary(&host);

    let first = agents.place("opencode", &binary).unwrap();
    let second = agents.place("opencode", &binary).unwrap();

    assert_eq!(first.sha256, second.sha256);
    let agent_dir = share
        .path()
        .join(format!("containers/{CONTAINER}/volumes/agents/opencode"));
    assert_eq!(entries(&agent_dir), vec![first.sha256]);
}

/// The guest can write the share, so it can swap any folder on the path for a
/// link to a host folder. Placement must refuse it and write nothing there.
#[test]
fn place_refuses_a_link_at_every_level_and_writes_nothing_through_it() {
    let digest = sha256_hex(BINARY);
    let levels = [
        "containers".to_owned(),
        format!("containers/{CONTAINER}"),
        format!("containers/{CONTAINER}/volumes"),
        format!("containers/{CONTAINER}/volumes/agents"),
        format!("containers/{CONTAINER}/volumes/agents/opencode"),
        format!("containers/{CONTAINER}/volumes/agents/opencode/{digest}"),
    ];
    for level in levels {
        let share = tempfile::tempdir().unwrap();
        let host = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let link = share.path().join(&level);
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        symlink(outside.path(), &link).unwrap();

        let result =
            AgentShare::new(share.path(), CONTAINER).place("opencode", &host_binary(&host));

        assert!(result.is_err(), "{level}: placed through a link");
        assert!(
            entries(outside.path()).is_empty(),
            "{level}: wrote outside the share"
        );
    }
}

#[test]
fn place_refuses_an_agent_name_that_is_not_one_folder() {
    let share = tempfile::tempdir().unwrap();
    let host = tempfile::tempdir().unwrap();
    let agents = AgentShare::new(share.path(), CONTAINER);

    for name in ["", ".", "..", "../x", "a/b"] {
        assert!(
            agents.place(name, &host_binary(&host)).is_err(),
            "{name:?} was accepted"
        );
    }
    assert!(entries(share.path()).is_empty());
}

#[test]
fn place_fails_for_a_missing_host_file_and_leaves_no_staging() {
    let share = tempfile::tempdir().unwrap();
    let host = tempfile::tempdir().unwrap();

    let result =
        AgentShare::new(share.path(), CONTAINER).place("opencode", &host.path().join("absent"));

    assert!(result.is_err());
    let agent_dir = share
        .path()
        .join(format!("containers/{CONTAINER}/volumes/agents/opencode"));
    assert!(!agent_dir.exists() || entries(&agent_dir).is_empty());
}

#[test]
fn the_record_survives_a_reload_and_starts_empty() {
    let box_dir = tempfile::tempdir().unwrap();
    let digest = sha256_hex(BINARY);

    assert_eq!(
        InstallRecord::new(box_dir.path()).get("opencode").unwrap(),
        None
    );
    InstallRecord::new(box_dir.path())
        .insert("opencode", &digest)
        .unwrap();

    let reloaded = InstallRecord::new(box_dir.path());
    assert_eq!(reloaded.get("opencode").unwrap(), Some(digest));
    assert_eq!(reloaded.get("codex").unwrap(), None);
}

/// The digest goes into a shell `PATH` in the Box, so a record whose value is
/// not a SHA-256 must never come back from `get`.
#[test]
fn a_recorded_digest_that_is_not_sha256_hex_is_refused() {
    let box_dir = tempfile::tempdir().unwrap();
    let digest = sha256_hex(BINARY);
    for bad in [
        "x; rm -rf /".to_owned(),
        digest.to_uppercase(),
        digest[..63].to_owned(),
        format!("{digest}0"),
    ] {
        let record = serde_json::json!({ "opencode": bad }).to_string();
        std::fs::write(box_dir.path().join(RECORD_FILE), record).unwrap();

        assert!(
            InstallRecord::new(box_dir.path()).get("opencode").is_err(),
            "{bad:?} was accepted"
        );
    }
}

#[test]
fn a_corrupt_record_is_an_error_not_an_empty_one() {
    let box_dir = tempfile::tempdir().unwrap();
    std::fs::write(box_dir.path().join(RECORD_FILE), b"{not json").unwrap();

    assert!(InstallRecord::new(box_dir.path()).get("opencode").is_err());
}
