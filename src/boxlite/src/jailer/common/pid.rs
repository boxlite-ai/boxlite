//! PID file writing for process tracking.
//!
//! Writes the current process PID to a file in an async-signal-safe manner.
//! This is designed to be called from `pre_exec` hook after fork() but before exec().
//!
//! The PID file serves as the single source of truth for the shim process PID,
//! enabling crash recovery and process tracking.

/// Write current process PID to file - async-signal-safe version for pre_exec.
///
/// This function is designed to be called from a `pre_exec` hook, which runs
/// after `fork()` but before `exec()`. Only async-signal-safe operations are
/// allowed in this context.
///
/// # Safety
///
/// This function only uses async-signal-safe syscalls (getpid, open, write, close).
/// Do NOT add:
/// - Logging (tracing, println)
/// - Memory allocation (Box, Vec, String)
/// - Mutex operations
/// - Most Rust stdlib functions
///
/// # Arguments
/// * `path` - CString path to the PID file (pre-allocated by caller)
///
/// # Returns
/// * `Ok(())` - PID file written successfully
/// * `Err(errno)` - Failed (returns raw errno for io::Error conversion)
pub fn write_pid_file_raw(path: &std::ffi::CStr) -> Result<(), i32> {
    unsafe {
        let pid = libc::getpid();

        // Format PID as string using stack buffer (no allocation)
        let mut buf = [0u8; 16];
        let len = format_pid_to_buffer(pid, &mut buf);

        // Open file: O_WRONLY | O_CREAT | O_TRUNC
        // Mode 0o644: rw-r--r--
        let fd = libc::open(
            path.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC,
            0o644 as libc::c_uint,
        );
        if fd < 0 {
            return Err(super::get_errno());
        }

        // Write PID
        let written = libc::write(fd, buf.as_ptr() as *const libc::c_void, len);
        let write_errno = if written < 0 {
            Some(super::get_errno())
        } else {
            None
        };

        // Always close the file descriptor
        libc::close(fd);

        // Return write error if any
        if let Some(errno) = write_errno {
            return Err(errno);
        }

        Ok(())
    }
}

/// Format i32 PID to buffer without allocation (async-signal-safe).
///
/// Returns the number of bytes written to the buffer.
///
/// # Safety
///
/// Uses only stack operations, no heap allocation.
#[inline]
fn format_pid_to_buffer(mut pid: i32, buf: &mut [u8; 16]) -> usize {
    if pid == 0 {
        buf[0] = b'0';
        buf[1] = b'\n';
        return 2;
    }

    // Handle negative PIDs (shouldn't happen, but be safe)
    let negative = pid < 0;
    if negative {
        pid = -pid;
    }

    // Convert digits in reverse order
    let mut len = 0;
    let mut tmp = [0u8; 16];

    while pid > 0 {
        tmp[len] = b'0' + (pid % 10) as u8;
        pid /= 10;
        len += 1;
    }

    // Add negative sign if needed
    let mut pos = 0;
    if negative {
        buf[pos] = b'-';
        pos += 1;
    }

    // Reverse digits into output buffer
    for i in 0..len {
        buf[pos] = tmp[len - 1 - i];
        pos += 1;
    }

    // Add newline for readability
    buf[pos] = b'\n';
    pos += 1;

    pos
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    #[test]
    fn test_format_pid_to_buffer() {
        let mut buf = [0u8; 16];

        // Test positive PID
        let len = format_pid_to_buffer(12345, &mut buf);
        assert_eq!(&buf[..len], b"12345\n");

        // Test single digit
        let len = format_pid_to_buffer(7, &mut buf);
        assert_eq!(&buf[..len], b"7\n");

        // Test zero
        let len = format_pid_to_buffer(0, &mut buf);
        assert_eq!(&buf[..len], b"0\n");

        // Test larger PID
        let len = format_pid_to_buffer(1234567890, &mut buf);
        assert_eq!(&buf[..len], b"1234567890\n");
    }

    #[test]
    fn test_write_pid_file_raw() {
        use std::io::Read;

        // Create temp file path
        let temp_dir = std::env::temp_dir();
        let pid_file = temp_dir.join("test_pid_file.pid");
        let path = CString::new(pid_file.to_string_lossy().as_bytes()).unwrap();

        // Write PID file
        write_pid_file_raw(&path).expect("Should write PID file");

        // Read and verify
        let mut content = String::new();
        std::fs::File::open(&pid_file)
            .expect("Should open file")
            .read_to_string(&mut content)
            .expect("Should read file");

        let expected_pid = std::process::id();
        let file_pid: u32 = content.trim().parse().expect("Should parse PID");
        assert_eq!(file_pid, expected_pid);

        // Cleanup
        let _ = std::fs::remove_file(&pid_file);
    }
}
