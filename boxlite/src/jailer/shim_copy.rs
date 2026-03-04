//! Shim binary copy utility (Firecracker pattern).
//!
//! This module implements Firecracker's security isolation pattern:
//! copy (not hard-link) the shim binary into the jail directory to ensure
//! complete memory isolation between boxes.
//!
//! Bundled libraries (libkrunfw, libgvproxy) are **symlinked** (not copied)
//! into `bin/` so that `dlopen` can find them via the shim's rpath without
//! duplicating multi-MB files per box.
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

/// Library file name prefixes to symlink alongside the shim binary.
///
/// On macOS, libkrun is statically linked so only libkrunfw (dlopen'd at
/// runtime) and libgvproxy need to be present.  On Linux all three are
/// dynamically linked.
#[cfg(target_os = "linux")]
const BUNDLED_LIB_PREFIXES: &[&str] = &["libkrun.", "libkrunfw.", "libgvproxy."];

#[cfg(target_os = "macos")]
const BUNDLED_LIB_PREFIXES: &[&str] = &["libkrunfw.", "libgvproxy."];

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
const BUNDLED_LIB_PREFIXES: &[&str] = &[];

/// Copy shim binary to box directory for jail isolation.
///
/// This follows Firecracker's approach: copy (not hard-link) the shim binary
/// into the jail directory to ensure complete memory isolation between boxes.
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

    // Symlink bundled libraries so dlopen can find them via the shim's rpath.
    // Symlinks are near-zero cost compared to copying multi-MB dylibs.
    if let Some(shim_dir) = shim_path.parent() {
        symlink_bundled_libraries(shim_dir, &bin_dir)?;
    }

    Ok(dest_shim)
}

/// Create symlinks for bundled libraries (libkrunfw, libgvproxy) in `dest_dir`.
///
/// Unlike the shim binary (which is copied for memory isolation), libraries
/// are symlinked because:
/// - They are loaded via `dlopen`, not `exec` — no `.text` sharing concern
/// - Symlinks avoid duplicating multi-MB files per box
/// - The shim's rpath resolves symlinks transparently
fn symlink_bundled_libraries(src_dir: &Path, dest_dir: &Path) -> BoxliteResult<()> {
    let entries = match std::fs::read_dir(src_dir) {
        Ok(entries) => entries,
        Err(e) => {
            tracing::warn!(
                src_dir = %src_dir.display(),
                error = %e,
                "Could not read source directory for bundled libraries"
            );
            return Ok(());
        }
    };

    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        if BUNDLED_LIB_PREFIXES.iter().any(|p| name_str.starts_with(p)) {
            let src_path = entry.path();
            let dest_path = dest_dir.join(&name);

            // Remove stale symlink or file before creating a fresh one
            if dest_path.exists() || dest_path.symlink_metadata().is_ok() {
                let _ = std::fs::remove_file(&dest_path);
            }

            #[cfg(unix)]
            std::os::unix::fs::symlink(&src_path, &dest_path).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to symlink library {} -> {}: {}",
                    dest_path.display(),
                    src_path.display(),
                    e
                ))
            })?;

            tracing::debug!(
                lib = %name_str,
                src = %src_path.display(),
                dst = %dest_path.display(),
                "Symlinked bundled library to box directory"
            );
        }
    }

    Ok(())
}
