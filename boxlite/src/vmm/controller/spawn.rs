//! Subprocess spawning for boxlite-shim binary.

use std::{
    path::Path,
    process::{Child, Stdio},
};

use crate::jailer::Jailer;
use crate::runtime::layout::FilesystemLayout;
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
/// * `home_dir` - BoxLite home directory
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
    home_dir: &Path,
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

    // Create filesystem layout and box directory
    use crate::runtime::layout::FsLayoutConfig;
    let layout = FilesystemLayout::new(home_dir.to_path_buf(), FsLayoutConfig::default());
    let box_dir = layout.boxes_dir().join(box_id);

    // Create Jailer with security options and volumes
    let jailer = Jailer::new(box_id, &box_dir)
        .with_security(options.security.clone())
        .with_volumes(options.volumes.clone());

    // Setup pre-spawn isolation (cgroups on Linux, no-op on macOS)
    jailer.setup_pre_spawn()?;

    // Build isolated command (includes pre_exec FD cleanup hook)
    let mut cmd = jailer.build_command(binary_path, &shim_args);

    // Pass debugging environment variables to subprocess
    if let Ok(rust_log) = std::env::var("RUST_LOG") {
        cmd.env("RUST_LOG", rust_log);
    }
    if let Ok(rust_backtrace) = std::env::var("RUST_BACKTRACE") {
        cmd.env("RUST_BACKTRACE", rust_backtrace);
    }

    // Set library search paths for bundled dependencies
    configure_library_env(&mut cmd, krun_create_ctx as *const libc::c_void);

    // Use null for all stdio to support detach/reattach without pipe issues.
    // - stdin: prevents libkrun from affecting parent's stdin
    // - stdout/stderr: prevents SIGPIPE when LogStreamHandler is dropped on detach
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());

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
