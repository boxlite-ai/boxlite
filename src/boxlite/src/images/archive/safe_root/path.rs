//! Pure path helpers.
//!
//! These functions do not touch the filesystem — they only manipulate path
//! strings lexically. They are the single source of truth for
//! containment-check logic used by every backend.

use std::path::{Component, Path, PathBuf};

/// Normalize a path that should be relative to an extraction root:
/// strips any leading `/` or prefix, resolves `.` and `..`, rejects on
/// underflow. Returns `None` if the path would escape.
pub(super) fn normalize_relative(path: &Path) -> Option<PathBuf> {
    let mut components = Vec::new();
    for comp in path.components() {
        match comp {
            Component::RootDir | Component::Prefix(_) => continue,
            Component::CurDir => {}
            Component::ParentDir => {
                components.pop()?;
            }
            Component::Normal(c) => components.push(c.to_os_string()),
        }
    }
    Some(components.into_iter().collect())
}

/// Lexically normalize a path by resolving `.` and `..` without touching the
/// filesystem (no symlink following). Returns `None` on underflow.
pub(super) fn lexical_normalize(path: &Path) -> Option<PathBuf> {
    let mut root = PathBuf::new();
    let mut components = Vec::new();
    for comp in path.components() {
        match comp {
            Component::Prefix(p) => root.push(p.as_os_str()),
            Component::RootDir => root.push("/"),
            Component::CurDir => {}
            Component::ParentDir => {
                components.pop()?;
            }
            Component::Normal(c) => components.push(c.to_os_string()),
        }
    }
    let mut result = root;
    for c in components {
        result.push(c);
    }
    Some(result)
}

/// Check whether a symlink at `link_rel` with target `target` would stay
/// within `root`. Absolute targets always fail (they reference the host
/// filesystem during extraction — the kernel applies no chroot). Relative
/// targets are resolved from the symlink's parent directory.
pub(super) fn is_symlink_target_safe(root: &Path, link_rel: &Path, target: &Path) -> bool {
    if target.is_absolute() {
        return false;
    }
    let link_abs = root.join(link_rel);
    let Some(parent) = link_abs.parent() else {
        return false;
    };
    let combined = parent.join(target);
    let Some(normalized) = lexical_normalize(&combined) else {
        return false;
    };
    normalized.starts_with(root)
}
