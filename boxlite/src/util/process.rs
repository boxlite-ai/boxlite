//! Process validation utilities for PID checking and verification.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::path::Path;

/// Read PID from file.
///
/// Reads the PID file written by the shim process in pre_exec.
/// The file contains a PID as a decimal string, optionally with a trailing newline.
///
/// # Arguments
/// * `path` - Path to the PID file
///
/// # Returns
/// * `Ok(pid)` - The PID read from the file
/// * `Err` - If the file cannot be read or parsed
pub fn read_pid_file(path: &Path) -> BoxliteResult<u32> {
    let content = std::fs::read_to_string(path).map_err(|e| {
        BoxliteError::Storage(format!("Failed to read PID file {}: {}", path.display(), e))
    })?;

    content.trim().parse::<u32>().map_err(|e| {
        BoxliteError::Storage(format!(
            "Invalid PID in file {}: '{}' - {}",
            path.display(),
            content.trim(),
            e
        ))
    })
}

/// Kill a process with SIGKILL.
///
/// # Returns
/// * `true` - Process was killed or doesn't exist
/// * `false` - Failed to kill (permission denied)
pub fn kill_process(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, libc::SIGKILL) == 0 || !is_process_alive(pid) }
}

/// Check if a process with the given PID exists.
///
/// Uses `libc::kill(pid, 0)` which sends a null signal to check existence.
/// A zombie/defunct process is treated as not alive.
///
/// # Returns
/// * `true` - Process exists
/// * `false` - Process does not exist or permission denied
pub fn is_process_alive(pid: u32) -> bool {
    if unsafe { libc::kill(pid as i32, 0) } != 0 {
        return false;
    }

    !is_process_zombie(pid)
}

fn is_process_zombie(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        is_process_zombie_linux(pid)
    }

    #[cfg(target_os = "macos")]
    {
        is_process_zombie_macos(pid)
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        false
    }
}

#[cfg(target_os = "linux")]
fn is_process_zombie_linux(pid: u32) -> bool {
    let status_path = format!("/proc/{pid}/status");
    let Ok(status) = std::fs::read_to_string(status_path) else {
        return false;
    };

    status.lines().find_map(|line| {
        line.strip_prefix("State:")
            .and_then(|state| state.trim_start().chars().next())
    }) == Some('Z')
}

#[cfg(target_os = "macos")]
fn is_process_zombie_macos(pid: u32) -> bool {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let expected_size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;

    let bytes = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            expected_size,
        )
    };

    if bytes != expected_size {
        if bytes != 0 {
            return false;
        }

        // On macOS, PROC_PIDTBSDINFO may return 0 for zombies.
        // Distinguish that from live processes by checking whether
        // the executable path is still queryable.
        let mut path_buf = [0 as libc::c_char; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let path_len = unsafe {
            libc::proc_pidpath(
                pid as i32,
                path_buf.as_mut_ptr().cast(),
                path_buf.len() as u32,
            )
        };

        return path_len == 0;
    }

    let info = unsafe { info.assume_init() };
    info.pbi_status == libc::SZOMB
}

/// Verify that a PID belongs to a boxlite-shim process for the given box.
///
/// This prevents PID reuse attacks where a PID is recycled for a different process.
///
/// # Implementation
/// * **Linux**: Read `/proc/{pid}/cmdline` and check for "boxlite-shim" + box_id
/// * **macOS**: Use `sysinfo` crate to get process name and check for "boxlite-shim"
///
/// # Arguments
/// * `pid` - Process ID to verify
/// * `box_id` - Expected box ID in the command line
///
/// # Returns
/// * `true` - PID is our boxlite-shim process
/// * `false` - PID is different process or doesn't exist
pub fn is_same_process(pid: u32, box_id: &str) -> bool {
    #[cfg(target_os = "linux")]
    {
        is_same_process_linux(pid, box_id)
    }

    #[cfg(target_os = "macos")]
    {
        let _ = box_id; // Unused on macOS
        is_same_process_macos(pid)
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        // Fallback: just check if process exists
        // Not ideal but better than nothing
        is_process_alive(pid)
    }
}

#[cfg(target_os = "linux")]
fn is_same_process_linux(pid: u32, box_id: &str) -> bool {
    use std::fs;

    let cmdline_path = format!("/proc/{}/cmdline", pid);

    match fs::read_to_string(&cmdline_path) {
        Ok(cmdline) => {
            // cmdline is null-separated, split by \0 for proper parsing
            let args: Vec<&str> = cmdline.split('\0').collect();

            // Check if any arg contains "boxlite-shim" and cmdline contains box_id
            args.iter().any(|arg| arg.contains("boxlite-shim")) && cmdline.contains(box_id)
        }
        Err(_) => false, // Process doesn't exist or no permission
    }
}

#[cfg(target_os = "macos")]
fn is_same_process_macos(pid: u32) -> bool {
    use sysinfo::{Pid, System};

    let mut sys = System::new();
    let pid_obj = Pid::from_u32(pid);

    sys.refresh_process(pid_obj);

    if let Some(process) = sys.process(pid_obj) {
        // Process::name() returns &str
        let name = process.name();
        name.contains("boxlite-shim")
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_process_alive_current() {
        // Current process should always be alive
        let current_pid = std::process::id();
        assert!(is_process_alive(current_pid));
    }

    #[test]
    fn test_is_process_alive_invalid() {
        // Use very high PIDs unlikely to exist
        // Note: u32::MAX becomes -1 when cast to i32, which has special meaning in kill()
        // Note: PID 0 might exist on some systems (kernel/scheduler)
        assert!(!is_process_alive(999999999));
        assert!(!is_process_alive(888888888));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn test_is_process_alive_false_for_zombie() {
        use std::time::{Duration, Instant};

        struct PidReaper {
            pid: libc::pid_t,
        }

        impl Drop for PidReaper {
            fn drop(&mut self) {
                let mut status = 0;
                let _ = unsafe { libc::waitpid(self.pid, &mut status, 0) };
            }
        }

        let child_pid = unsafe { libc::fork() };
        assert!(child_pid >= 0, "fork() failed");
        if child_pid == 0 {
            unsafe { libc::_exit(0) };
        }

        let _reaper = PidReaper { pid: child_pid };
        let child_pid = child_pid as u32;

        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            let raw_exists = unsafe { libc::kill(child_pid as i32, 0) == 0 };

            if !raw_exists {
                // Some environments auto-reap exited children immediately.
                // In that case there is no zombie window to assert against.
                return;
            }

            if !is_process_alive(child_pid) {
                return;
            }

            std::thread::sleep(Duration::from_millis(10));
        }

        panic!("Exited child remained reported as alive while still existing");
    }

    #[test]
    fn test_is_same_process_current() {
        let current_pid = std::process::id();

        // Current process is not boxlite-shim, so should return false
        let result = is_same_process(current_pid, "test123");

        // On non-Linux/macOS systems, this will return true (fallback)
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        assert!(!result);
    }

    #[test]
    fn test_is_same_process_invalid() {
        // Invalid PID should return false
        assert!(!is_same_process(0, "test123"));
        assert!(!is_same_process(u32::MAX, "test123"));
    }

    #[test]
    fn test_read_pid_file_valid() {
        use std::io::Write;
        use tempfile::NamedTempFile;

        // Create a temp file with a valid PID
        let mut file = NamedTempFile::new().unwrap();
        writeln!(file, "12345").unwrap();

        let pid = read_pid_file(file.path()).expect("Should parse valid PID");
        assert_eq!(pid, 12345);
    }

    #[test]
    fn test_read_pid_file_no_newline() {
        use std::io::Write;
        use tempfile::NamedTempFile;

        // PID without trailing newline should also work
        let mut file = NamedTempFile::new().unwrap();
        write!(file, "67890").unwrap();

        let pid = read_pid_file(file.path()).expect("Should parse PID without newline");
        assert_eq!(pid, 67890);
    }

    #[test]
    fn test_read_pid_file_invalid() {
        use std::io::Write;
        use tempfile::NamedTempFile;

        // Invalid content should return error
        let mut file = NamedTempFile::new().unwrap();
        writeln!(file, "not-a-pid").unwrap();

        let result = read_pid_file(file.path());
        assert!(result.is_err());
    }

    #[test]
    fn test_read_pid_file_missing() {
        // Non-existent file should return error
        let result = read_pid_file(Path::new("/nonexistent/path/to/pid.file"));
        assert!(result.is_err());
    }
}
