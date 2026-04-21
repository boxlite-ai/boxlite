//! Windows Job Object sandbox for process isolation.
//!
//! Job Objects are the Windows equivalent of cgroups + namespaces:
//! - Memory limits (hard cap)
//! - Process count limits
//! - Kill-on-close (all processes terminated when handle dropped)
//! - CPU rate control
//!
//! # Current Status
//!
//! Infrastructure-only. The Windows WHPX VM runs in-process via `krun_start()`,
//! so no shim subprocess exists yet. This sandbox is ready for when a Windows
//! shim is introduced — it creates a properly configured Job Object that can
//! be assigned to a child process via `AssignProcessToJobObject`.
//!
//! `PlatformSandbox` remains `NoopSandbox` on Windows until the shim is ready.

#![cfg(target_os = "windows")]

use super::{Sandbox, SandboxContext};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::process::Command;
use std::sync::Mutex;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_JOB_MEMORY,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject,
};

/// Job Object-based sandbox for Windows process isolation.
///
/// Creates a Windows Job Object with resource limits derived from
/// [`SandboxContext::resource_limits`]. The Job Object enforces:
///
/// - **Kill-on-close**: All processes terminate when the handle drops.
/// - **Memory limit**: Hard cap on committed memory (from `max_memory`).
/// - **Process limit**: Maximum active processes (from `max_processes`).
///
/// # Future
///
/// When a Windows shim process is introduced, `post_spawn()` will be added
/// to assign the child process to this Job Object.
pub struct JobSandbox {
    /// Job Object handle, set after `setup()`. Protected by Mutex for
    /// Send+Sync (HANDLE is a raw pointer type).
    job_handle: Mutex<HANDLE>,
}

impl JobSandbox {
    pub fn new() -> Self {
        Self {
            job_handle: Mutex::new(INVALID_HANDLE_VALUE),
        }
    }

    /// Create a Job Object with limits from the sandbox context.
    fn create_job_object(ctx: &SandboxContext) -> BoxliteResult<HANDLE> {
        // Create unnamed Job Object
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(BoxliteError::Internal(
                "Failed to create Windows Job Object".into(),
            ));
        }

        // Configure limits
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        let mut limit_flags: u32 = 0;

        // Always kill all processes when Job Object handle is closed
        limit_flags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        // Memory limit
        if let Some(max_memory) = ctx.resource_limits.max_memory {
            limit_flags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
            info.JobMemoryLimit = max_memory as usize;
        }

        // Process count limit
        if let Some(max_processes) = ctx.resource_limits.max_processes {
            limit_flags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            info.BasicLimitInformation.ActiveProcessLimit = max_processes as u32;
        }

        info.BasicLimitInformation.LimitFlags = limit_flags;

        let result = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };

        if result == 0 {
            unsafe { CloseHandle(handle) };
            return Err(BoxliteError::Internal(
                "Failed to set Job Object limits".into(),
            ));
        }

        Ok(handle)
    }
}

impl Sandbox for JobSandbox {
    fn is_available(&self) -> bool {
        // Job Objects are available on all supported Windows versions
        true
    }

    fn setup(&self, ctx: &SandboxContext) -> BoxliteResult<()> {
        let handle = Self::create_job_object(ctx)?;
        let mut guard = self
            .job_handle
            .lock()
            .map_err(|e| BoxliteError::Internal(format!("Job Object mutex poisoned: {}", e)))?;
        *guard = handle;
        Ok(())
    }

    fn apply(&self, _ctx: &SandboxContext, _cmd: &mut Command) {
        // No-op for now: Job Object assignment to child process requires
        // `AssignProcessToJobObject` after spawn. This will be wired when
        // the Windows shim subprocess is introduced.
        //
        // The Job Object handle is preserved in self.job_handle for future
        // post_spawn() use.
    }

    fn name(&self) -> &'static str {
        "job-object"
    }
}

impl Drop for JobSandbox {
    fn drop(&mut self) {
        if let Ok(guard) = self.job_handle.lock() {
            let handle = *guard;
            if handle != INVALID_HANDLE_VALUE && !handle.is_null() {
                unsafe { CloseHandle(handle) };
            }
        }
    }
}

// SAFETY: HANDLE is a raw pointer. The Mutex protects concurrent access.
// Job Object handles are valid across threads per Windows documentation.
unsafe impl Send for JobSandbox {}
unsafe impl Sync for JobSandbox {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_job_sandbox_is_available() {
        let sandbox = JobSandbox::new();
        assert!(sandbox.is_available());
    }

    #[test]
    fn test_job_sandbox_name() {
        let sandbox = JobSandbox::new();
        assert_eq!(sandbox.name(), "job-object");
    }

    #[test]
    fn test_create_job_object_succeeds() {
        use crate::runtime::advanced_options::ResourceLimits;

        let limits = ResourceLimits {
            max_memory: Some(512 * 1024 * 1024), // 512 MB
            max_processes: Some(64),
            ..Default::default()
        };

        let ctx = SandboxContext {
            id: "test-box",
            paths: Vec::new(),
            resource_limits: &limits,
            network_enabled: false,
            sandbox_profile: None,
        };

        let handle = JobSandbox::create_job_object(&ctx).unwrap();
        assert!(!handle.is_null(), "Job Object handle should be valid");
        assert_ne!(
            handle, INVALID_HANDLE_VALUE,
            "Handle should not be INVALID_HANDLE_VALUE"
        );
        unsafe { CloseHandle(handle) };
    }
}
