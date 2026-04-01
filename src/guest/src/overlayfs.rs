//! Overlayfs mounting logic
//! Linux-specific module for mounting overlayfs

#![allow(dead_code)]

use boxlite_shared::errors::BoxliteResult;

#[cfg(target_os = "linux")]
/// Ensure a directory exists and is clean.
///
/// Removes the directory if it exists, then recreates it.
/// Useful for directories that must be empty (e.g., overlayfs work_dir).
fn ensure_clean_dir(path: &str) -> BoxliteResult<()> {
    let _ = std::fs::remove_dir_all(path); // Ignore errors if doesn't exist
    std::fs::create_dir_all(path)
        .map_err(|e| format!("Failed to create directory {}: {}", path, e).into())
}

#[cfg(target_os = "linux")]
/// Mount overlayfs from explicit paths.
///
/// This is the primary API used by Guest.Init handler.
/// Guest doesn't understand what these paths mean - it just mounts.
///
/// # Arguments
/// * `lower_dirs` - Paths to lower layers (bottom to top order)
/// * `upper_dir` - Writable upper layer path
/// * `work_dir` - Overlayfs work directory path
/// * `merged_dir` - Final merged mount point
pub fn mount_overlayfs_direct(
    lower_dirs: &[String],
    upper_dir: &str,
    work_dir: &str,
    merged_dir: &str,
) -> BoxliteResult<()> {
    if lower_dirs.is_empty() {
        return Err("Cannot mount overlayfs with no lower directories".into());
    }

    // Build lowerdir string: top layer first (reverse of input order)
    // overlayfs lowerdir format: topmost:...:bottommost
    let lowerdir = lower_dirs
        .iter()
        .rev()
        .cloned()
        .collect::<Vec<_>>()
        .join(":");

    tracing::info!("Mounting overlayfs:");
    tracing::info!("  lowerdir: {}", lowerdir);
    tracing::info!("  upperdir: {}", upper_dir);
    tracing::info!("  workdir:  {}", work_dir);
    tracing::info!("  merged:   {}", merged_dir);

    // Ensure directories exist and are clean
    // work_dir MUST be empty for overlayfs to mount successfully
    ensure_clean_dir(work_dir)?;
    ensure_clean_dir(upper_dir)?;
    ensure_clean_dir(merged_dir)?;

    // Mount overlayfs using nix API
    use std::ffi::CString;
    use std::path::Path;

    let source = CString::new("overlay").unwrap();
    let target = Path::new(merged_dir);
    let fstype = CString::new("overlay").unwrap();
    let flags = nix::mount::MsFlags::empty();
    let data = CString::new(format!(
        "lowerdir={},upperdir={},workdir={}",
        lowerdir, upper_dir, work_dir
    ))
    .unwrap();

    nix::mount::mount(Some(&*source), target, Some(&*fstype), flags, Some(&*data))
        .map_err(|e| format!("Failed to mount overlayfs: {}", e))?;

    tracing::info!("✅ Overlayfs mounted at {}", merged_dir);

    Ok(())
}
