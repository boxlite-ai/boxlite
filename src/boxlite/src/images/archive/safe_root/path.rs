//! Rooted path resolution — containerd `fs.RootPath` equivalent.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::collections::VecDeque;
use std::io;
use std::path::{Component, Path, PathBuf};

/// Normalize a relative path: strip leading `/`, resolve `.` and `..`.
/// Returns `None` if `..` underflows past root.
pub(super) fn normalize_relative(path: &Path) -> Option<PathBuf> {
    let mut components = Vec::new();
    for comp in path.components() {
        match comp {
            Component::RootDir | Component::Prefix(_) | Component::CurDir => {}
            Component::ParentDir => {
                components.pop()?;
            }
            Component::Normal(c) => components.push(c.to_os_string()),
        }
    }
    Some(components.into_iter().collect())
}

/// Resolve `rel` within `root` by walking each component, following
/// symlinks and re-anchoring absolute targets. All components including
/// the final one are followed (matching containerd's `fs.RootPath`).
///
/// Non-existent components are returned as-is (joined under root),
/// matching containerd's `walkLink` ENOENT behavior.
pub(super) fn resolve_walk(root: &Path, rel: &Path) -> BoxliteResult<PathBuf> {
    let mut resolved = PathBuf::new();
    let mut hops: u32 = 0;

    let mut remaining: VecDeque<std::ffi::OsString> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_os_string()),
            Component::ParentDir => Some(std::ffi::OsString::from("..")),
            _ => None,
        })
        .collect();

    while let Some(comp) = remaining.pop_front() {
        if comp == ".." {
            resolved.pop();
            continue;
        }
        resolved.push(&comp);

        let full = root.join(&resolved);
        match std::fs::symlink_metadata(&full) {
            Ok(meta) if meta.file_type().is_symlink() => {
                hops += 1;
                if hops > 255 {
                    return Err(BoxliteError::Storage(format!(
                        "Symlink hop limit exceeded resolving {}",
                        rel.display()
                    )));
                }
                let target = std::fs::read_link(&full).map_err(|e| {
                    BoxliteError::Storage(format!("readlink {}: {}", full.display(), e))
                })?;
                resolved.pop();
                if target.is_absolute() {
                    resolved = PathBuf::new();
                }
                // Prepend target components to remaining
                let parts: Vec<std::ffi::OsString> = target
                    .components()
                    .filter_map(|c| match c {
                        Component::Normal(s) => Some(s.to_os_string()),
                        Component::ParentDir => Some(std::ffi::OsString::from("..")),
                        _ => None,
                    })
                    .collect();
                for part in parts.into_iter().rev() {
                    remaining.push_front(part);
                }
            }
            Ok(_) => {}
            Err(e)
                if e.kind() == io::ErrorKind::NotFound
                    || e.raw_os_error() == Some(libc::ENOTDIR) => {}
            Err(e) => {
                return Err(BoxliteError::Storage(format!(
                    "resolve {} under {}: {}",
                    rel.display(),
                    root.display(),
                    e
                )));
            }
        }
    }

    Ok(root.join(resolved))
}
