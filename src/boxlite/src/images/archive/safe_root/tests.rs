//! Tests for the SafeRoot public API and the pure path helpers.
//!
//! Pure helper tests run on every platform (they don't touch the fs).
//! SafeRoot tests exercise whichever backend was chosen at compile time.

use super::SafeRoot;
use super::path::{is_symlink_target_safe, normalize_relative};
use std::path::{Path, PathBuf};

// ---------- pure path helpers ----------

#[test]
fn symlink_target_absolute_escapes() {
    let root = Path::new("/tmp/extract");
    assert!(!is_symlink_target_safe(
        root,
        Path::new("link"),
        Path::new("/etc")
    ));
}

#[test]
fn symlink_target_relative_in_root_ok() {
    let root = Path::new("/tmp/extract");
    assert!(is_symlink_target_safe(
        root,
        Path::new("lib"),
        Path::new("usr/lib")
    ));
}

#[test]
fn symlink_target_parent_traversal_escapes() {
    let root = Path::new("/tmp/extract");
    assert!(!is_symlink_target_safe(
        root,
        Path::new("escape"),
        Path::new("../../../etc"),
    ));
}

#[test]
fn symlink_target_pnpm_pattern_ok() {
    let root = Path::new("/tmp/extract");
    assert!(is_symlink_target_safe(
        root,
        Path::new(".pnpm/foo@1.0.0/node_modules/bar"),
        Path::new("../../bar@1.0.0/node_modules/bar"),
    ));
}

#[test]
fn normalize_relative_rejects_underflow() {
    assert!(normalize_relative(Path::new("a/../..")).is_none());
    assert_eq!(
        normalize_relative(Path::new("a/b/../c")).unwrap(),
        PathBuf::from("a/c"),
    );
}

// ---------- SafeRoot ----------

#[test]
fn open_creates_missing_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let dest = tmp.path().join("new_dir");
    assert!(!dest.exists());
    SafeRoot::open(&dest).unwrap();
    assert!(dest.is_dir());
}

#[test]
fn rejects_unsafe_symlink() {
    let tmp = tempfile::tempdir().unwrap();
    let dest = tmp.path().join("extract");
    let root = SafeRoot::open(&dest).unwrap();
    let abs_target = tmp.path().to_path_buf(); // absolute -> escapes
    assert!(
        root.create_symlink(Path::new("escape"), &abs_target)
            .is_err()
    );
    assert!(!dest.join("escape").exists());
}

#[test]
fn allows_in_root_symlink() {
    let tmp = tempfile::tempdir().unwrap();
    let dest = tmp.path().join("extract");
    let root = SafeRoot::open(&dest).unwrap();
    std::fs::write(dest.join("target.txt"), b"x").unwrap();
    root.create_symlink(Path::new("link"), Path::new("target.txt"))
        .unwrap();
    assert!(dest.join("link").is_symlink());
}

#[test]
fn is_symlink_target_safe_method_matches_pure_helper() {
    let tmp = tempfile::tempdir().unwrap();
    let dest = tmp.path().join("extract");
    let root = SafeRoot::open(&dest).unwrap();
    assert!(!root.is_symlink_target_safe(Path::new("x"), Path::new("/etc")));
    assert!(root.is_symlink_target_safe(Path::new("lib"), Path::new("usr/lib")));
}

/// Bug #3: `create_hardlink` on the fallback backend joins `target_rel`
/// lexically (`root.join(target_rel)`) without rejecting `..` underflow,
/// so `fs::hard_link` sees a path that the kernel resolves to a location
/// outside `root`. The API should either normalize the relative target
/// or reject paths that escape containment.
#[test]
fn create_hardlink_rejects_escaping_target_rel() {
    use std::os::unix::fs::MetadataExt;

    let tmp = tempfile::tempdir().unwrap();
    let dest = tmp.path().join("extract");
    let host_side = tmp.path().join("host");
    std::fs::create_dir_all(&host_side).unwrap();
    let host_file = host_side.join("secret");
    std::fs::write(&host_file, b"secret data").unwrap();

    let root = SafeRoot::open(&dest).unwrap();
    let host_ino = std::fs::metadata(&host_file).unwrap().ino();

    // Attempt to hardlink to an out-of-root target via `..`.
    // Safe behavior is: either return Err, or skip creation entirely.
    let result = root.create_hardlink(Path::new("link"), Path::new("../host/secret"));

    let link = dest.join("link");
    if let Ok(meta) = std::fs::symlink_metadata(&link) {
        assert_ne!(
            meta.ino(),
            host_ino,
            "create_hardlink produced a hardlink to a file outside root \
             (inode {} == host inode {}) — API must validate target_rel",
            meta.ino(),
            host_ino,
        );
    } else {
        // Call must have errored — that's fine.
        assert!(
            result.is_err(),
            "create_hardlink silently did nothing and returned Ok"
        );
    }
}
