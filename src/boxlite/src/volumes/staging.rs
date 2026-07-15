//! Host-side staging for single-file volume mounts.

use std::path::{Path, PathBuf};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

/// Stage a single file into `staging_dir` so virtio-fs can share a directory
/// that contains only that file (never the file's host siblings).
///
/// A read-write mount is hard-linked so guest edits flow back to the host file.
/// It cannot cross filesystems (`EXDEV`), so a rw source on a different
/// filesystem than the staging dir is a hard error — a copy would silently drop
/// the guest's writes at teardown.
///
/// A read-only mount is copied: the staged file is a separate inode, so the host
/// source can never be modified through the mount. That makes it a boot-time
/// snapshot (host edits afterward don't reach the guest), which is fine for
/// read-only config. Idempotent — re-staging replaces any existing entry.
pub fn stage_single_file(
    staging_dir: &Path,
    source: &Path,
    file_name: &str,
    read_only: bool,
) -> BoxliteResult<PathBuf> {
    std::fs::create_dir_all(staging_dir).map_err(|e| {
        BoxliteError::Config(format!(
            "Failed to create volume staging dir '{}': {}",
            staging_dir.display(),
            e
        ))
    })?;

    let staged = staging_dir.join(file_name);

    if read_only {
        tracing::warn!(
            source = %source.display(),
            "read-only single-file volume is staged as a boot-time snapshot; \
             host edits after box start won't reach the guest"
        );
        return copy_into_staging(source, &staged);
    }

    if staged.exists() {
        std::fs::remove_file(&staged).map_err(|e| {
            BoxliteError::Config(format!(
                "Failed to clear staged volume file '{}': {}",
                staged.display(),
                e
            ))
        })?;
    }

    match std::fs::hard_link(source, &staged) {
        Ok(()) => Ok(staged),
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => Err(BoxliteError::Config(format!(
            "Cannot mount read-write single file '{}': it is on a different filesystem than \
             the box storage, so it cannot be hard-linked and a copy would silently drop the \
             guest's writes. Mount its parent directory instead, or place the file on the same \
             filesystem as the box home.",
            source.display()
        ))),
        Err(e) => Err(BoxliteError::Config(format!(
            "Failed to stage volume file '{}': {}",
            source.display(),
            e
        ))),
    }
}

/// Copy `source` to `staged` via a temp file + atomic rename, so a box reading
/// the staged path mid-copy can never see a half-written file.
fn copy_into_staging(source: &Path, staged: &Path) -> BoxliteResult<PathBuf> {
    let tmp = staged.with_file_name(format!(
        "{}.staging-tmp",
        staged.file_name().and_then(|n| n.to_str()).unwrap_or("vol")
    ));
    std::fs::copy(source, &tmp).map_err(|e| {
        BoxliteError::Config(format!(
            "Failed to copy volume file '{}' into staging: {}",
            source.display(),
            e
        ))
    })?;
    std::fs::rename(&tmp, staged).map_err(|e| {
        BoxliteError::Config(format!(
            "Failed to publish staged volume file '{}': {}",
            staged.display(),
            e
        ))
    })?;
    Ok(staged.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    #[test]
    fn read_write_file_is_hardlinked_into_staging_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("app.conf");
        std::fs::write(&source, "key=value\n").unwrap();
        let staging = tmp.path().join("staging").join("uservol0");

        let staged = stage_single_file(&staging, &source, "app.conf", false).unwrap();

        assert_eq!(staged, staging.join("app.conf"));
        assert_eq!(std::fs::read_to_string(&staged).unwrap(), "key=value\n");
        // Read-write => hard link => same inode => edits flow both ways.
        assert_eq!(
            std::fs::metadata(&staged).unwrap().ino(),
            std::fs::metadata(&source).unwrap().ino()
        );
    }

    #[test]
    fn read_only_file_is_copied_so_writes_never_reach_source() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("secret.conf");
        std::fs::write(&source, "sensitive=true\n").unwrap();
        let staging = tmp.path().join("staging");

        let staged = stage_single_file(&staging, &source, "app.conf", true).unwrap();

        assert_eq!(
            std::fs::read_to_string(&staged).unwrap(),
            "sensitive=true\n"
        );
        // Separate inode: a write to the staged file must not reach the source.
        assert_ne!(
            std::fs::metadata(&staged).unwrap().ino(),
            std::fs::metadata(&source).unwrap().ino()
        );
        std::fs::write(&staged, "TAMPERED\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(&source).unwrap(),
            "sensitive=true\n"
        );
    }

    #[test]
    fn re_staging_replaces_existing_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let staging = tmp.path().join("staging");

        let first = tmp.path().join("first.conf");
        std::fs::write(&first, "one").unwrap();
        stage_single_file(&staging, &first, "app.conf", false).unwrap();

        let second = tmp.path().join("second.conf");
        std::fs::write(&second, "two").unwrap();
        let staged = stage_single_file(&staging, &second, "app.conf", false).unwrap();

        assert_eq!(std::fs::read_to_string(&staged).unwrap(), "two");
    }
}
