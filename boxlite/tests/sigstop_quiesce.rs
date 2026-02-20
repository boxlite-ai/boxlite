//! Proof-of-concept test for SIGSTOP/SIGCONT VM quiesce.
//!
//! Validates that sending SIGSTOP to the shim process freezes the VM
//! and SIGCONT resumes it without corruption — equivalent to Docker's
//! cgroup freezer pause.
//!
//! Requires a real VM runtime (alpine:latest image). Run with:
//!
//! ```sh
//! cargo test -p boxlite --test sigstop_quiesce -- --ignored
//! ```

use std::time::Duration;

use boxlite::runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec};
use boxlite::{BoxCommand, BoxliteRuntime};
use tempfile::TempDir;

fn test_runtime() -> (BoxliteRuntime, TempDir) {
    // Use /tmp for shorter paths — macOS default TempDir paths exceed SUN_LEN for Unix sockets.
    let temp_dir = TempDir::new_in("/tmp").expect("Failed to create temp dir");
    let options = BoxliteOptions {
        home_dir: temp_dir.path().to_path_buf(),
        image_registries: vec![],
    };
    let runtime = BoxliteRuntime::new(options).expect("Failed to create runtime");
    (runtime, temp_dir)
}

#[tokio::test]
#[ignore] // Requires VM runtime
async fn test_sigstop_sigcont_preserves_vm() {
    let (runtime, _dir) = test_runtime();

    let options = BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".to_string()),
        ..Default::default()
    };

    let litebox = runtime
        .create(options, Some("sigstop-test".to_string()))
        .await
        .expect("Failed to create box");

    litebox.start().await.expect("Failed to start box");

    // Verify box is responsive before SIGSTOP
    let cmd = BoxCommand::new("echo").args(["before-stop"]);
    let mut exec = litebox.exec(cmd).await.expect("exec before SIGSTOP");
    let result = exec.wait().await.expect("wait before SIGSTOP");
    assert_eq!(result.exit_code, 0, "command should succeed before SIGSTOP");

    // Get shim PID
    let info = litebox.info();
    let shim_pid = info.pid.expect("running box should have a PID");

    // --- SIGSTOP: freeze the shim (all vCPUs + virtio backends) ---
    let ret = unsafe { libc::kill(shim_pid as i32, libc::SIGSTOP) };
    assert_eq!(ret, 0, "SIGSTOP should succeed");

    // Give the OS a moment to actually stop the process
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Verify the process is actually stopped
    assert!(
        is_process_stopped(shim_pid),
        "shim process should be in stopped state after SIGSTOP"
    );

    // --- SIGCONT: resume the shim ---
    let ret = unsafe { libc::kill(shim_pid as i32, libc::SIGCONT) };
    assert_eq!(ret, 0, "SIGCONT should succeed");

    // Give the VM a moment to resume
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Verify box is still responsive after SIGCONT
    let cmd = BoxCommand::new("echo").args(["after-resume"]);
    let mut exec = litebox
        .exec(cmd)
        .await
        .expect("exec after SIGCONT — VM should still be responsive");
    let result = exec.wait().await.expect("wait after SIGCONT");
    assert_eq!(
        result.exit_code, 0,
        "command should succeed after SIGCONT resume"
    );

    // Clean shutdown
    litebox.stop().await.expect("Failed to stop box");
}

/// Check if a process is in stopped (T) state.
#[cfg(target_os = "linux")]
fn is_process_stopped(pid: u32) -> bool {
    let status_path = format!("/proc/{}/status", pid);
    if let Ok(contents) = std::fs::read_to_string(&status_path) {
        for line in contents.lines() {
            if let Some(state) = line.strip_prefix("State:") {
                let state = state.trim();
                // T = stopped (by signal), t = tracing stop
                return state.starts_with('T') || state.starts_with('t');
            }
        }
    }
    false
}

/// Check if a process is in stopped (T) state via `ps`.
#[cfg(target_os = "macos")]
fn is_process_stopped(pid: u32) -> bool {
    let output = std::process::Command::new("ps")
        .args(["-o", "state=", "-p", &pid.to_string()])
        .output();

    match output {
        Ok(out) => {
            let state = String::from_utf8_lossy(&out.stdout);
            let state = state.trim();
            // T = stopped by signal
            state.contains('T')
        }
        Err(_) => false,
    }
}
