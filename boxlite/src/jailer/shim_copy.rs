//! Shim binary and library copy utilities (Firecracker pattern).
//!
//! This module implements Firecracker's security isolation pattern:
//! copy (not hard-link) binaries into the jail directory to ensure
//! complete memory isolation between boxes.
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
//! 3. **No External Dependencies**: The jail only needs access to files
//!    inside the box directory, not external paths.
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

/// Library file patterns to copy alongside the shim binary.
#[cfg(target_os = "linux")]
const BUNDLED_LIB_PATTERNS: &[&str] = &["libkrun.so", "libkrunfw.so", "libgvproxy.so"];

#[cfg(target_os = "macos")]
const BUNDLED_LIB_PATTERNS: &[&str] = &["libkrun.dylib", "libkrunfw.dylib", "libgvproxy.dylib"];

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
const BUNDLED_LIB_PATTERNS: &[&str] = &[];

/// Copy shim binary and bundled libraries to box directory for jail isolation.
///
/// This follows Firecracker's approach: copy (not hard-link) binaries into the
/// jail directory to ensure complete memory isolation between boxes.
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
/// - Failed to copy a bundled library
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

    // Copy bundled libraries from shim's directory
    if let Some(shim_dir) = shim_path.parent() {
        copy_bundled_libraries(shim_dir, &bin_dir)?;
    }

    Ok(dest_shim)
}

/// Copy bundled libraries (libkrun, libkrunfw, libgvproxy) to destination.
///
/// Only copies libraries that match the patterns in `BUNDLED_LIB_PATTERNS`.
/// Uses copy-if-newer to avoid unnecessary copies.
///
/// # Arguments
///
/// * `src_dir` - Directory containing the source libraries (same as shim binary)
/// * `dest_dir` - Destination directory (`box_dir/bin/`)
///
/// # Errors
///
/// Returns [`BoxliteError::Storage`] if a library copy fails.
fn copy_bundled_libraries(src_dir: &Path, dest_dir: &Path) -> BoxliteResult<()> {
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

        // Check if this file matches any of our library patterns
        if BUNDLED_LIB_PATTERNS.iter().any(|p| name_str.starts_with(p)) {
            let src_path = entry.path();
            let dest_path = dest_dir.join(&name);

            let copied = copy_if_newer(&src_path, &dest_path).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to copy library {} to {}: {}",
                    src_path.display(),
                    dest_path.display(),
                    e
                ))
            })?;

            if copied {
                tracing::debug!(
                    lib = %name_str,
                    dst = %dest_path.display(),
                    "Copied bundled library to box directory"
                );
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bundled_lib_patterns() {
        #[cfg(target_os = "linux")]
        {
            assert!(BUNDLED_LIB_PATTERNS.contains(&"libkrun.so"));
            assert!(BUNDLED_LIB_PATTERNS.contains(&"libkrunfw.so"));
            assert!(BUNDLED_LIB_PATTERNS.contains(&"libgvproxy.so"));
        }
        #[cfg(target_os = "macos")]
        {
            assert!(BUNDLED_LIB_PATTERNS.contains(&"libkrun.dylib"));
            assert!(BUNDLED_LIB_PATTERNS.contains(&"libkrunfw.dylib"));
            assert!(BUNDLED_LIB_PATTERNS.contains(&"libgvproxy.dylib"));
        }
    }

    #[test]
    fn test_lib_pattern_matching() {
        let patterns = BUNDLED_LIB_PATTERNS;

        #[cfg(target_os = "linux")]
        {
            // Should match
            assert!(patterns.iter().any(|p| "libkrun.so.1.2.3".starts_with(p)));
            assert!(patterns.iter().any(|p| "libkrunfw.so".starts_with(p)));
            assert!(
                patterns
                    .iter()
                    .any(|p| "libgvproxy.so.debug".starts_with(p))
            );

            // Should not match
            assert!(!patterns.iter().any(|p| "libc.so.6".starts_with(p)));
            assert!(!patterns.iter().any(|p| "boxlite-shim".starts_with(p)));
        }

        #[cfg(target_os = "macos")]
        {
            // Should match
            assert!(patterns.iter().any(|p| "libkrun.dylib".starts_with(p)));
            assert!(patterns.iter().any(|p| "libkrunfw.dylib".starts_with(p)));
            assert!(patterns.iter().any(|p| "libgvproxy.dylib".starts_with(p)));

            // Should not match
            assert!(!patterns.iter().any(|p| "libc.dylib".starts_with(p)));
            assert!(!patterns.iter().any(|p| "boxlite-shim".starts_with(p)));
        }
    }
}
