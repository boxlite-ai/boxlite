//! Subprocess spawning for boxlite-shim binary.

use std::{
    path::Path,
    process::{Child, Stdio},
};

use crate::jailer::{Jail, JailerBuilder};
use crate::runtime::layout::BoxFilesystemLayout;
use crate::runtime::options::BoxOptions;
use crate::util::configure_library_env;
use crate::vmm::VmmKind;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use libkrun_sys::krun_create_ctx;

/// Spawns a subprocess with jailer isolation.
///
/// # Arguments
/// * `binary_path` - Path to the boxlite-shim binary
/// * `engine_type` - Type of VM engine to use
/// * `config_json` - Serialized BoxConfig
/// * `layout` - Box filesystem layout (provides paths for box directory, stderr, etc.)
/// * `box_id` - Unique box identifier
/// * `options` - Box options (includes security and volumes)
///
/// # Returns
/// * `Ok(Child)` - Successfully spawned subprocess
/// * `Err(...)` - Failed to spawn subprocess
pub(crate) fn spawn_subprocess(
    binary_path: &Path,
    engine_type: VmmKind,
    config_json: &str,
    layout: &BoxFilesystemLayout,
    box_id: &str,
    options: &BoxOptions,
) -> BoxliteResult<Child> {
    // Build shim arguments
    let shim_args = vec![
        "--engine".to_string(),
        format!("{:?}", engine_type),
        "--config".to_string(),
        config_json.to_string(),
    ];

    // Create Jailer with security options and volumes
    let jail = JailerBuilder::new()
        .with_box_id(box_id)
        .with_layout(layout.clone())
        .with_security(options.advanced.security.clone())
        .with_volumes(options.volumes.clone())
        .build()?;

    // Setup pre-spawn isolation (cgroups on Linux, no-op on macOS)
    jail.prepare()?;

    // Build isolated command (includes pre_exec FD cleanup hook)
    let mut cmd = jail.command(binary_path, &shim_args);

    // Pass debugging environment variables to subprocess
    if let Ok(rust_log) = std::env::var("RUST_LOG") {
        cmd.env("RUST_LOG", rust_log);
    }
    if let Ok(rust_backtrace) = std::env::var("RUST_BACKTRACE") {
        cmd.env("RUST_BACKTRACE", rust_backtrace);
    }

    // Set library search paths for bundled dependencies
    configure_library_env(&mut cmd, krun_create_ctx as *const libc::c_void);

    // Create stderr file BEFORE spawn to capture ALL errors including pre-main dyld errors.
    // This is critical: dyld errors happen before main() and would go to /dev/null otherwise.
    let stderr_file_path = layout.stderr_file_path();
    let stderr_file = std::fs::File::create(&stderr_file_path).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to create stderr file {}: {}",
            stderr_file_path.display(),
            e
        ))
    })?;

    // Use null for stdin/stdout to support detach/reattach without pipe issues.
    // - stdin: prevents libkrun from affecting parent's stdin
    // - stdout: prevents SIGPIPE when LogStreamHandler is dropped on detach
    // - stderr: captured to file for crash diagnostics
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::from(stderr_file));

    cmd.spawn().map_err(|e| {
        let err_msg = format!(
            "Failed to spawn VM subprocess at {}: {}",
            binary_path.display(),
            e
        );
        tracing::error!("{}", err_msg);
        BoxliteError::Engine(err_msg)
    })
}
