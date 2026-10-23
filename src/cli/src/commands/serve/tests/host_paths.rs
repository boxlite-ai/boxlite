//! `--host-path-root` policy tests: which `volumes[].host_path` a create may
//! bind, and which roots stop the server. Run by `make test:unit:cli`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Json;
use axum::extract::State;

use super::super::AppState;
use super::super::handlers::config::get_config;
use super::super::host_paths::HostPathPolicy;
use super::super::types::VolumeSpecRequest;

fn request(host_path: &str) -> VolumeSpecRequest {
    VolumeSpecRequest {
        managed_volume: None,
        host_path: Some(host_path.to_string()),
        guest_path: "/workspace".to_string(),
        read_only: false,
    }
}

fn policy(root: &Path) -> HostPathPolicy {
    HostPathPolicy::from_roots(&[root.to_path_buf()]).expect("root exists")
}

/// A temp dir by its canonical path. macOS hands out `/var/...`, a link
/// to `/private/var/...`; an escape test built on the link form would be
/// refused for that mismatch alone and could not show the escape check.
fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap();
    (dir, path)
}

fn refusal(policy: &HostPathPolicy, host_path: &str) -> String {
    policy
        .resolve(&[request(host_path)])
        .expect_err("host path must be refused")
        .to_string()
}

#[test]
fn binds_a_directory_under_a_root_with_its_guest_path_and_mode() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("agent-1");
    std::fs::create_dir(&workspace).unwrap();
    let mut volume = request(workspace.to_str().unwrap());
    volume.read_only = true;

    let specs = policy(root.path())
        .resolve(&[volume])
        .expect("inside the root");

    assert_eq!(specs.len(), 1);
    assert_eq!(
        Path::new(&specs[0].host_path),
        workspace.canonicalize().unwrap()
    );
    assert_eq!(specs[0].guest_path, "/workspace");
    assert!(specs[0].read_only);
    assert!(specs[0].managed_volume.is_none());
}

/// Box A binds `root/a1` writable; box B asks for `root/a1/x`. A could then
/// swap `x` for a symlink to `/` and restart B, which the runtime
/// re-resolves at every boot. Only direct children of a root are bound,
/// so no bind can sit inside another.
#[test]
fn refuses_a_path_nested_inside_a_directory_of_the_root() {
    let (_guard, root) = canonical_tempdir();
    let nested = root.join("a1").join("x");
    std::fs::create_dir_all(&nested).unwrap();

    let message = refusal(&policy(&root), nested.to_str().unwrap());

    assert!(message.contains("--host-path-root"), "{message}");
}

/// The root holds every box's directory, so binding it would hand one box
/// all of them, and it would contain every other bind.
#[test]
fn refuses_the_root_itself() {
    let (_guard, root) = canonical_tempdir();

    let message = refusal(&policy(&root), root.to_str().unwrap());

    assert!(message.contains("--host-path-root"), "{message}");
}

#[test]
fn refuses_every_host_path_when_no_root_is_set() {
    let dir = tempfile::tempdir().unwrap();

    let message = refusal(&HostPathPolicy::default(), dir.path().to_str().unwrap());

    assert!(message.contains("--host-path-root"), "{message}");
}

#[test]
fn refuses_a_dot_dot_path_that_leaves_the_root() {
    let (_guard, parent) = canonical_tempdir();
    let root = parent.join("root");
    std::fs::create_dir(&root).unwrap();
    let escape = root.join("..");

    let message = refusal(&policy(&root), escape.to_str().unwrap());

    assert!(
        message.contains("not an existing path directly inside any"),
        "{message}"
    );
}

#[test]
fn refuses_a_symlink_under_the_root_that_points_outside_it() {
    let (_guard, parent) = canonical_tempdir();
    let root = parent.join("root");
    let outside = parent.join("outside");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&outside).unwrap();
    let link = root.join("link");
    std::os::unix::fs::symlink(&outside, &link).unwrap();

    let message = refusal(&policy(&root), link.to_str().unwrap());

    assert!(
        message.contains("not an existing path directly inside any"),
        "{message}"
    );
}

#[test]
fn refuses_a_sibling_that_only_shares_the_root_as_a_string_prefix() {
    let (_guard, parent) = canonical_tempdir();
    let root = parent.join("agents");
    let sibling = parent.join("agents-old");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&sibling).unwrap();

    let message = refusal(&policy(&root), sibling.to_str().unwrap());

    assert!(
        message.contains("not an existing path directly inside any"),
        "{message}"
    );
}

/// A caller must not learn whether a path outside the roots exists: a
/// missing path and an existing one outside every root are refused alike,
/// and no OS error reaches the response.
#[test]
fn a_missing_path_and_one_outside_every_root_get_the_same_refusal() {
    let (_guard, parent) = canonical_tempdir();
    let root = parent.join("root");
    let outside = parent.join("outside");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&outside).unwrap();
    let missing = parent.join("missing");
    let policy = policy(&root);
    let (outside, missing) = (outside.to_str().unwrap(), missing.to_str().unwrap());

    let for_outside = refusal(&policy, outside).replace(outside, "<path>");
    let for_missing = refusal(&policy, missing).replace(missing, "<path>");

    assert_eq!(for_outside, for_missing);
    assert!(!for_missing.contains("os error"), "{for_missing}");
}

#[test]
fn refuses_a_relative_host_path() {
    let root = tempfile::tempdir().unwrap();

    let message = refusal(&policy(root.path()), "agent-1");

    assert!(message.contains("absolute"), "{message}");
}

#[test]
fn still_refuses_a_managed_volume() {
    let root = tempfile::tempdir().unwrap();
    let volume = VolumeSpecRequest {
        managed_volume: Some("vol_1".to_string()),
        host_path: None,
        guest_path: "/data".to_string(),
        read_only: false,
    };

    let message = policy(root.path())
        .resolve(&[volume])
        .expect_err("no volume backend")
        .to_string();

    assert!(
        message.contains("managed volumes are not supported"),
        "{message}"
    );
}

/// With roots `/srv` and `/srv/x/agents`, `/srv/x` is bindable and holds
/// every bind under the inner root, so nested roots stop the server.
#[test]
fn nested_roots_stop_the_server() {
    let (_guard, outer) = canonical_tempdir();
    let inner = outer.join("x").join("agents");
    std::fs::create_dir_all(&inner).unwrap();

    let error = HostPathPolicy::from_roots(&[outer.clone(), inner])
        .expect_err("a root inside another root must fail startup");

    assert!(error.to_string().contains("--host-path-root"), "{error}");
}

#[test]
fn a_missing_root_stops_the_server() {
    let parent = tempfile::tempdir().unwrap();

    let error = HostPathPolicy::from_roots(&[parent.path().join("missing")])
        .expect_err("a root that does not exist must fail startup");

    assert!(error.to_string().contains("--host-path-root"), "{error}");
}

/// SDK clients send a host path only to a server whose `GET /v1/config` says
/// it binds one, so the flag must follow `--host-path-root` exactly.
#[tokio::test]
async fn config_advertises_host_paths_only_when_a_root_is_set() {
    let root = tempfile::tempdir().unwrap();

    assert_eq!(advertised(policy(root.path())).await, true);
    assert_eq!(advertised(HostPathPolicy::default()).await, false);
}

async fn advertised(host_paths: HostPathPolicy) -> serde_json::Value {
    let state = AppState {
        runtime: boxlite::BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(
            "http://127.0.0.1:1".to_string(),
        ))
        .expect("rest runtime"),
        boxes: Default::default(),
        executions: Default::default(),
        api_key: None,
        host_paths,
        lifecycle: Default::default(),
        last_activity: Default::default(),
    };
    let Json(config) = get_config(State(Arc::new(state))).await;
    serde_json::to_value(config).unwrap()["capabilities"]["host_path_volumes_enabled"].clone()
}
