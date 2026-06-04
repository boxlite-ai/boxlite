//! On-disk record of a running shim's identity (`shim.pid`).
//!
//! Three cohesive types:
//! * [`PidRecord`] — the on-disk format. Owns encode/decode and the
//!   "capture current process" factory. All methods on it are
//!   async-signal-safe except [`PidRecord::decode`], which allocates.
//! * [`PidFileReader`] — parent-side handle for reading and managing
//!   the file. May allocate, log, take locks.
//! * [`PidFileWriter`] — pre-allocated, async-signal-safe writer.
//!   Construct via [`PidFileWriter::at`] in the parent before fork; the
//!   resulting handle is safe to capture in a `pre_exec` closure and
//!   invoke from the child without further allocation.
//!
//! ## Format
//!
//! ```text
//! <pid>
//! <start_time>           (optional; absent in legacy files)
//! ```
//!
//! Line 2 is the OS-reported process start-time fingerprint captured at
//! spawn. Recovery compares it against the live PID's current
//! start-time — a mismatch reliably detects PID reuse.

use std::ffi::CString;
use std::path::{Path, PathBuf};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

/// Max bytes any encoded [`PidRecord`] can produce. PID is u32 (≤10
/// digits), start-time is u64 (≤20 digits), plus two newlines.
pub const PID_RECORD_MAX_BYTES: usize = 48;

// ============================================================================
// PID RECORD — the codec
// ============================================================================

/// On-disk identity of a shim process: its PID and (optionally) the
/// start-time fingerprint captured at spawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PidRecord {
    pub pid: u32,
    /// Start-time fingerprint. `None` for legacy single-line files;
    /// `Some` for the new two-line format.
    pub start_time: Option<u64>,
}

impl PidRecord {
    /// Capture the current process's PID + start-time.
    ///
    /// Async-signal-safe: uses only `getpid()` and a stack-buffer parse
    /// of `/proc/self/stat` (Linux) or `proc_pidinfo` (macOS). Safe to
    /// call from a `pre_exec` closure.
    pub fn current() -> Self {
        let pid = unsafe { libc::getpid() } as u32;
        let start_time = read_self_start_time_raw();
        Self { pid, start_time }
    }

    /// Parse bytes into a record. Accepts both single-line (`PID\n`)
    /// and two-line (`PID\nSTART_TIME\n`) formats. Returns
    /// [`BoxliteError::Storage`] for empty or unparseable input.
    pub fn decode(bytes: &[u8]) -> BoxliteResult<Self> {
        let text = std::str::from_utf8(bytes)
            .map_err(|e| BoxliteError::Storage(format!("PID file is not valid UTF-8: {e}")))?;
        let mut lines = text.lines();
        let pid_line = lines.next().unwrap_or("").trim();
        let pid: u32 = pid_line
            .parse()
            .map_err(|e| BoxliteError::Storage(format!("Invalid PID '{pid_line}': {e}")))?;
        // A garbled second line downgrades to legacy (None) rather than
        // failing — the PID is still trustworthy.
        let start_time = lines
            .next()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(|s| s.parse::<u64>().ok());
        Ok(Self { pid, start_time })
    }

    /// Encode into a caller-provided stack buffer; returns bytes written.
    ///
    /// Async-signal-safe. The buffer must be at least
    /// [`PID_RECORD_MAX_BYTES`] long.
    pub fn encode(&self, buf: &mut [u8]) -> usize {
        debug_assert!(buf.len() >= PID_RECORD_MAX_BYTES);
        let mut pos = format_u64(self.pid as u64, buf, 0);
        buf[pos] = b'\n';
        pos += 1;
        if let Some(st) = self.start_time {
            pos = format_u64(st, buf, pos);
            buf[pos] = b'\n';
            pos += 1;
        }
        pos
    }
}

// ============================================================================
// PID FILE READER — parent-side I/O
// ============================================================================

/// Parent-side reader for a `shim.pid` file. Read-only; lifecycle ops
/// (existence checks, removal) are direct filesystem calls on the path.
#[derive(Debug, Clone)]
pub struct PidFileReader {
    path: PathBuf,
}

impl PidFileReader {
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn read(&self) -> BoxliteResult<PidRecord> {
        let bytes = std::fs::read(&self.path).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to read PID file {}: {e}",
                self.path.display(),
            ))
        })?;
        PidRecord::decode(&bytes)
    }

    /// Read the PID file and classify the recorded process against the
    /// live OS view. `Absent` collapses three failure modes (file gone,
    /// process dead, fingerprint mismatch) — all map to "nothing to act on".
    pub fn process_identity(&self) -> ProcessIdentity {
        let Ok(record) = self.read() else {
            return ProcessIdentity::Absent;
        };
        if !crate::util::is_process_alive(record.pid) {
            return ProcessIdentity::Absent;
        }
        match record.start_time {
            None => ProcessIdentity::Legacy(record.pid),
            Some(expected) if crate::util::process_start_time(record.pid) == Some(expected) => {
                ProcessIdentity::Verified(record.pid)
            }
            Some(_) => ProcessIdentity::Absent,
        }
    }
}

// ============================================================================
// PROCESS IDENTITY — classification of a recorded PID against the live OS
// ============================================================================

/// Result of comparing a recorded `shim.pid` entry to the live OS state.
///
/// Variants carry the PID only when it's safe to act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessIdentity {
    /// Alive + recorded start-time matches the OS reading.
    Verified(u32),
    /// Alive + no start-time recorded (pre-fingerprint legacy file).
    /// Safe to adopt with a warning; cannot prove identity.
    Legacy(u32),
    /// No actionable shim: file missing, process dead, or fingerprint
    /// differs (PID reuse).
    Absent,
}

// ============================================================================
// PID FILE WRITER — pre-allocated, async-signal-safe child-side I/O
// ============================================================================

/// Async-signal-safe writer for a `shim.pid` file.
///
/// Construct in the parent before fork via [`PidFileWriter::at`]; the
/// returned handle owns a pre-allocated `CString` for the path. Capture
/// the handle in a `pre_exec` closure and call [`PidFileWriter::write`]
/// from the child — no further allocation is performed.
#[derive(Debug, Clone)]
pub struct PidFileWriter {
    path: CString,
}

impl PidFileWriter {
    /// Validate the path and pre-allocate its `CString` form. Call from
    /// the parent before fork; fails if the path contains interior NUL.
    pub fn at(path: &Path) -> BoxliteResult<Self> {
        let cstr = CString::new(path.to_string_lossy().as_bytes()).map_err(|e| {
            BoxliteError::Storage(format!(
                "PID file path {} contains interior NUL: {e}",
                path.display(),
            ))
        })?;
        Ok(Self { path: cstr })
    }

    /// Write `record` to the file. Async-signal-safe: uses only
    /// `open`/`write`/`close` syscalls and a stack buffer.
    pub fn write(&self, record: &PidRecord) -> Result<(), i32> {
        let mut buf = [0u8; PID_RECORD_MAX_BYTES];
        let len = record.encode(&mut buf);
        unsafe {
            let fd = libc::open(
                self.path.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC,
                0o644 as libc::c_uint,
            );
            if fd < 0 {
                return Err(errno());
            }
            let written = libc::write(fd, buf.as_ptr() as *const libc::c_void, len);
            let write_errno = if written < 0 { Some(errno()) } else { None };
            libc::close(fd);
            if let Some(e) = write_errno {
                return Err(e);
            }
        }
        Ok(())
    }
}

// ============================================================================
// PRIVATE HELPERS — all async-signal-safe
// ============================================================================

/// `errno()` for the current thread; async-signal-safe.
unsafe fn errno() -> i32 {
    #[cfg(target_os = "linux")]
    unsafe {
        *libc::__errno_location()
    }
    #[cfg(target_os = "macos")]
    unsafe {
        *libc::__error()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        0
    }
}

/// Format a u64 in decimal into `buf` starting at `offset`; returns the
/// new write position. Async-signal-safe, no allocation.
fn format_u64(mut value: u64, buf: &mut [u8], offset: usize) -> usize {
    if value == 0 {
        buf[offset] = b'0';
        return offset + 1;
    }
    let mut tmp = [0u8; 24];
    let mut len = 0;
    while value > 0 {
        tmp[len] = b'0' + (value % 10) as u8;
        value /= 10;
        len += 1;
    }
    let mut pos = offset;
    for i in 0..len {
        buf[pos] = tmp[len - 1 - i];
        pos += 1;
    }
    pos
}

#[cfg(target_os = "linux")]
fn read_self_start_time_raw() -> Option<u64> {
    let path = c"/proc/self/stat";
    unsafe {
        let fd = libc::open(path.as_ptr(), libc::O_RDONLY);
        if fd < 0 {
            return None;
        }
        let mut buf = [0u8; 1024];
        let n = libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len());
        libc::close(fd);
        if n <= 0 {
            return None;
        }
        parse_start_time_from_stat(&buf[..n as usize])
    }
}

#[cfg(target_os = "linux")]
fn parse_start_time_from_stat(slice: &[u8]) -> Option<u64> {
    // /proc/PID/stat: PID (COMM) STATE PPID ... START_TIME(22) ...
    // COMM may contain spaces/close-parens; split on the LAST `)`.
    let close = slice.iter().rposition(|&b| b == b')')?;
    let tail = &slice[close + 1..];
    let mut field_idx = 0usize;
    let mut i = 0;
    while i < tail.len() {
        while i < tail.len() && tail[i] == b' ' {
            i += 1;
        }
        let start = i;
        while i < tail.len() && tail[i] != b' ' && tail[i] != b'\n' {
            i += 1;
        }
        if start == i {
            return None;
        }
        field_idx += 1;
        // STARTTIME is field 22 in the full line; tail consumed pid+comm,
        // so it's field 20 here.
        if field_idx == 20 {
            let mut value: u64 = 0;
            for &b in &tail[start..i] {
                if !b.is_ascii_digit() {
                    return None;
                }
                value = value.checked_mul(10)?.checked_add((b - b'0') as u64)?;
            }
            return Some(value);
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn read_self_start_time_raw() -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let expected_size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let bytes = unsafe {
        libc::proc_pidinfo(
            libc::getpid(),
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            expected_size,
        )
    };
    if bytes != expected_size {
        return None;
    }
    let info = unsafe { info.assume_init() };
    Some(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn read_self_start_time_raw() -> Option<u64> {
    None
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn temp_with(content: &str) -> NamedTempFile {
        let mut f = NamedTempFile::new().expect("tempfile");
        f.write_all(content.as_bytes()).expect("write");
        f.flush().expect("flush");
        f
    }

    // ---- PidRecord codec ----------------------------------------------------

    #[test]
    fn decode_two_line_format() {
        let r = PidRecord::decode(b"1234\n98765432\n").expect("decode");
        assert_eq!(r.pid, 1234);
        assert_eq!(r.start_time, Some(98765432));
    }

    #[test]
    fn decode_legacy_one_line_format() {
        let r = PidRecord::decode(b"4321\n").expect("decode");
        assert_eq!(r.pid, 4321);
        assert_eq!(r.start_time, None);
    }

    #[test]
    fn decode_no_trailing_newline() {
        let r = PidRecord::decode(b"67890").expect("decode");
        assert_eq!(r.pid, 67890);
        assert_eq!(r.start_time, None);
    }

    #[test]
    fn decode_corrupt_start_time_downgrades() {
        let r = PidRecord::decode(b"5555\nnot-a-number\n").expect("decode");
        assert_eq!(r.pid, 5555);
        assert_eq!(r.start_time, None);
    }

    #[test]
    fn decode_leading_whitespace_pid() {
        let r = PidRecord::decode(b"  12345\n  88  \n").expect("decode");
        assert_eq!(r.pid, 12345);
        assert_eq!(r.start_time, Some(88));
    }

    #[test]
    fn decode_max_linux_pid() {
        let r = PidRecord::decode(b"4194304\n").expect("decode");
        assert_eq!(r.pid, 4194304);
    }

    #[test]
    fn decode_negative_pid_rejected() {
        assert!(PidRecord::decode(b"-1\n").is_err());
    }

    #[test]
    fn decode_overflow_pid_rejected() {
        assert!(PidRecord::decode(b"99999999999\n").is_err());
    }

    #[test]
    fn decode_invalid_pid_rejected() {
        assert!(PidRecord::decode(b"not-a-pid\n").is_err());
    }

    #[test]
    fn decode_empty_rejected() {
        assert!(PidRecord::decode(b"").is_err());
    }

    #[test]
    fn encode_round_trips_with_start_time() {
        let r = PidRecord {
            pid: 12345,
            start_time: Some(67890),
        };
        let mut buf = [0u8; PID_RECORD_MAX_BYTES];
        let len = r.encode(&mut buf);
        assert_eq!(&buf[..len], b"12345\n67890\n");
        assert_eq!(PidRecord::decode(&buf[..len]).unwrap(), r);
    }

    #[test]
    fn encode_round_trips_legacy() {
        let r = PidRecord {
            pid: 7,
            start_time: None,
        };
        let mut buf = [0u8; PID_RECORD_MAX_BYTES];
        let len = r.encode(&mut buf);
        assert_eq!(&buf[..len], b"7\n");
        assert_eq!(PidRecord::decode(&buf[..len]).unwrap(), r);
    }

    #[test]
    fn current_captures_self() {
        let r = PidRecord::current();
        assert_eq!(r.pid, std::process::id());
        // start_time may be None on unsupported OS; on Linux/macOS must
        // be present.
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        assert!(r.start_time.is_some(), "start_time must be captured");
    }

    // ---- PidFileReader ------------------------------------------------------

    #[test]
    fn reader_read_round_trips() {
        let f = temp_with("1234\n98765432\n");
        let r = PidFileReader::at(f.path()).read().expect("read");
        assert_eq!(r.pid, 1234);
        assert_eq!(r.start_time, Some(98765432));
    }

    #[test]
    fn reader_missing_file_is_storage_error() {
        let err = PidFileReader::at("/nonexistent/shim.pid")
            .read()
            .unwrap_err();
        assert!(matches!(err, BoxliteError::Storage(_)));
    }

    // ---- PidFileWriter ------------------------------------------------------

    #[test]
    fn writer_writes_record_readable_by_reader() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("shim.pid");
        let writer = PidFileWriter::at(&path).expect("at");
        let record = PidRecord {
            pid: 999,
            start_time: Some(424242),
        };
        writer.write(&record).expect("write");

        let read_back = PidFileReader::at(&path).read().expect("read");
        assert_eq!(read_back, record);
    }

    #[test]
    fn writer_truncates_on_repeated_write() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("shim.pid");
        let writer = PidFileWriter::at(&path).expect("at");
        writer
            .write(&PidRecord {
                pid: 111111,
                start_time: Some(1),
            })
            .expect("first write");
        writer
            .write(&PidRecord {
                pid: 22,
                start_time: None,
            })
            .expect("second write");

        let read_back = PidFileReader::at(&path).read().expect("read");
        assert_eq!(read_back.pid, 22);
        assert_eq!(read_back.start_time, None);
    }

    #[test]
    fn writer_rejects_path_with_interior_nul() {
        // PathBuf::new() with a NUL byte; CString::new will reject.
        let p = std::path::PathBuf::from("/tmp/\0bad");
        let err = PidFileWriter::at(&p).unwrap_err();
        assert!(matches!(err, BoxliteError::Storage(_)));
    }
}
