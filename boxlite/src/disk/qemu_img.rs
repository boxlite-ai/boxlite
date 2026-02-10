//! Wrapper around the `qemu-img` command-line tool.
//!
//! Used for operations that require full QCOW2 block-level manipulation
//! (flattening COW chains, snapshots) which cannot be done with the
//! header-only `qcow2-rs` crate.

use std::path::Path;
use std::process::Command;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

/// Check if `qemu-img` is available on the system.
pub fn is_available() -> bool {
    Command::new("qemu-img")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success())
}

/// Ensure `qemu-img` is available, returning a clear error if not.
fn require_qemu_img() -> BoxliteResult<()> {
    if !is_available() {
        return Err(BoxliteError::Storage(
            "qemu-img is required but not found. \
             Install it via: apt install qemu-utils (Debian/Ubuntu), \
             dnf install qemu-img (Fedora/RHEL), \
             or brew install qemu (macOS)."
                .to_string(),
        ));
    }
    Ok(())
}

/// Convert a QCOW2 disk image to a standalone file (flatten COW chain).
///
/// This flattens a QCOW2 file with a backing chain into a single standalone
/// file with no backing reference. The output format is QCOW2 by default.
///
/// Equivalent to: `qemu-img convert -O qcow2 <src> <dst>`
pub fn convert(src: &Path, dst: &Path) -> BoxliteResult<()> {
    require_qemu_img()?;

    tracing::info!(
        src = %src.display(),
        dst = %dst.display(),
        "Flattening QCOW2 disk image"
    );

    let output = Command::new("qemu-img")
        .args(["convert", "-O", "qcow2"])
        .arg(src)
        .arg(dst)
        .output()
        .map_err(|e| BoxliteError::Storage(format!("Failed to run qemu-img convert: {}", e)))?;

    if !output.status.success() {
        return Err(BoxliteError::Storage(format!(
            "qemu-img convert failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    Ok(())
}

/// Create a full copy of a disk image (no COW, standalone).
///
/// Used for clone and export operations. Produces a completely independent copy
/// with no backing file references.
///
/// Equivalent to: `qemu-img convert -O qcow2 <src> <dst>`
pub fn full_copy(src: &Path, dst: &Path) -> BoxliteResult<()> {
    convert(src, dst)
}
