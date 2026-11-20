//! Shim binary and libkrunfw copy utility (Firecracker pattern).
//!
//! This module implements Firecracker's security isolation pattern:
//! copy (not hard-link) the shim binary into the jail directory to ensure
//! complete memory isolation between boxes.
//!
//! `libkrunfw` is also copied because libkrun loads it via `dlopen` at
//! runtime, and the shim's rpath resolves to `bin/`.  Other bundled
//! libraries (libkrun, libgvproxy) are **not** copied — libkrun is
//! statically linked on macOS, and libgvproxy is a separate process.
//!
//! # Why Copy Instead of Hard-Link?
//!
//! 1. **Memory Isolation**: Hard-linked binaries share the same inode,
//!    which means they share the same `.text` section in memory.
//!    A vulnerability in one box could potentially exploit shared code.
//!
//! 2. **Independent Updates**: Each box has its own copy, so updates
//!    to the shim don't affect running boxes.
//!
//! # Usage
//!
//! ```ignore
//! use boxlite::jailer::shim_copy::copy_shim_to_box;
//!
//! let copied_shim = copy_shim_to_box(&shim_path, &box_dir)?;
//! // copied_shim is now at box_dir/bin/boxlite-shim
//! ```

use crate::jailer::common::fs::copy_if_newer;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::path::{Path, PathBuf};

/// Library file name prefixes to copy alongside the shim binary.
///
/// Only `libkrunfw` is needed: libkrun `dlopen`s it at runtime and the
/// shim's rpath resolves to `bin/`.  On Linux, `libkrunfw` is also
/// dynamically loaded via `dlopen`.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const LIBKRUNFW_PREFIX: &str = "libkrunfw.";

/// Copy shim binary and libkrunfw to box directory for jail isolation.
///
/// This follows Firecracker's approach: copy (not hard-link) the shim binary
/// into the jail directory to ensure complete memory isolation between boxes.
/// `libkrunfw` is also copied so that libkrun's `dlopen` can find it via
/// the shim's rpath.
///
/// # Arguments
///
/// * `shim_path` - Path to the original shim binary
/// * `box_dir` - Path to the box directory (e.g., `~/.boxlite/boxes/{box_id}`)
///
/// # Returns
///
/// Path to the copied shim binary (inside `box_dir/bin/`).
///
/// # Errors
///
/// Returns [`BoxliteError::Storage`] if:
/// - Failed to create the `bin/` directory
/// - Failed to copy the shim binary
/// - Failed to copy libkrunfw
///
/// # Example
///
/// ```ignore
/// let copied_shim = copy_shim_to_box(&shim_path, &box_dir)?;
/// // Use copied_shim instead of original shim_path
/// ```
pub fn copy_shim_to_box(shim_path: &Path, box_dir: &Path) -> BoxliteResult<PathBuf> {
    let bin_dir = box_dir.join("bin");
    std::fs::create_dir_all(&bin_dir).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to create bin directory {}: {}",
            bin_dir.display(),
            e
        ))
    })?;

    // Copy shim binary
    let shim_name = shim_path.file_name().unwrap_or_default();
    let dest_shim = bin_dir.join(shim_name);

    let copied = copy_if_newer(shim_path, &dest_shim).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to copy shim {} to {}: {}",
            shim_path.display(),
            dest_shim.display(),
            e
        ))
    })?;

    if copied {
        tracing::debug!(
            src = %shim_path.display(),
            dst = %dest_shim.display(),
            "Copied shim binary to box directory"
        );
    }

    ensure_shim_permissions(shim_path, &dest_shim, copied)?;

    // Copy libkrunfw so dlopen can find it via the shim's rpath.
    if let Some(shim_dir) = shim_path.parent() {
        copy_libkrunfw(shim_dir, &bin_dir)?;
    }

    Ok(dest_shim)
}

/// Synchronize or validate the box-local shim permissions after copying.
fn ensure_shim_permissions(
    source_path: &Path,
    shim_path: &Path,
    copied: bool,
) -> BoxliteResult<()> {
    let source_permissions = read_shim_permissions(source_path, "source")?;
    let destination_permissions = read_shim_permissions(shim_path, "destination")?;
    let permissions_are_equal = permissions_match(&source_permissions, &destination_permissions);

    if !permissions_are_equal {
        if copied {
            return Err(BoxliteError::Storage(format!(
                "Copied shim permissions do not match: source {}, destination {}",
                source_path.display(),
                shim_path.display()
            )));
        }

        std::fs::set_permissions(shim_path, source_permissions).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to copy permissions from shim {} to {}: {}",
                source_path.display(),
                shim_path.display(),
                e
            ))
        })?;

        tracing::debug!(
            src = %source_path.display(),
            dst = %shim_path.display(),
            "Synchronized shim permissions"
        );
    }

    Ok(())
}

fn read_shim_permissions(path: &Path, description: &str) -> BoxliteResult<std::fs::Permissions> {
    std::fs::metadata(path)
        .map(|metadata| metadata.permissions())
        .map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to read {description} shim permissions from {}: {e}",
                path.display()
            ))
        })
}

#[cfg(unix)]
fn permissions_match(source: &std::fs::Permissions, destination: &std::fs::Permissions) -> bool {
    use std::os::unix::fs::PermissionsExt;
    source.mode() == destination.mode()
}

#[cfg(not(unix))]
fn permissions_match(source: &std::fs::Permissions, destination: &std::fs::Permissions) -> bool {
    source.readonly() == destination.readonly()
}

/// Copy libkrunfw from the shim's directory to `dest_dir`.
///
/// libkrun loads libkrunfw via `dlopen` at runtime.  On macOS the shim's
/// rpath resolves to its own directory (`bin/`), and `DYLD_*` env vars are
/// stripped by SIP when going through `sandbox-exec`.  Copying the library
/// into `bin/` ensures `dlopen` can always find it.
///
/// Uses copy-if-newer to avoid unnecessary copies on subsequent starts.
fn copy_libkrunfw(src_dir: &Path, dest_dir: &Path) -> BoxliteResult<()> {
    let entries = match std::fs::read_dir(src_dir) {
        Ok(entries) => entries,
        Err(e) => {
            tracing::warn!(
                src_dir = %src_dir.display(),
                error = %e,
                "Could not read source directory for libkrunfw"
            );
            return Ok(());
        }
    };

    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        if name_str.starts_with(LIBKRUNFW_PREFIX) {
            let src_path = entry.path();
            let dest_path = dest_dir.join(&name);

            let copied = copy_if_newer(&src_path, &dest_path).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to copy libkrunfw {} to {}: {}",
                    src_path.display(),
                    dest_path.display(),
                    e
                ))
            })?;

            if copied {
                tracing::debug!(
                    lib = %name_str,
                    dst = %dest_path.display(),
                    "Copied libkrunfw to box directory"
                );
            }
        }
    }

    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    fn write_shim(path: &Path, mode: u32) {
        fs::write(path, "shim").unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }

    fn assert_same_permissions(source: &Path, destination: &Path) {
        assert_eq!(
            fs::metadata(source).unwrap().permissions().mode(),
            fs::metadata(destination).unwrap().permissions().mode()
        );
    }

    #[test]
    fn copy_shim_preserves_permissions_when_destination_is_up_to_date() {
        let dir = tempdir().unwrap();
        let source_dir = dir.path().join("source");
        let box_dir = dir.path().join("box");
        fs::create_dir_all(&source_dir).unwrap();

        let source = source_dir.join("boxlite-shim");
        write_shim(&source, 0o755);

        let destination = box_dir.join("bin/boxlite-shim");
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        write_shim(&destination, 0o644);

        let copied = copy_shim_to_box(&source, &box_dir).unwrap();

        assert_eq!(copied, destination);
        assert_same_permissions(&source, &destination);
    }

    #[test]
    fn copy_shim_preserves_permissions_when_destination_is_missing() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("boxlite-shim");
        let box_dir = dir.path().join("box");
        write_shim(&source, 0o755);

        let destination = copy_shim_to_box(&source, &box_dir).unwrap();

        assert_same_permissions(&source, &destination);
    }

    #[test]
    fn rejects_copied_shim_with_mismatched_permissions() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("source-shim");
        let destination = dir.path().join("destination-shim");
        write_shim(&source, 0o755);
        write_shim(&destination, 0o644);

        let error = ensure_shim_permissions(&source, &destination, true).unwrap_err();
        let message = error.to_string();

        assert!(message.contains(&source.display().to_string()));
        assert!(message.contains(&destination.display().to_string()));
    }
}
