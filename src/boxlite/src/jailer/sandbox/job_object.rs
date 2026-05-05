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
//! Active. The Windows WHPX shim runs as a subprocess (`boxlite-shim.exe`).
//! `post_spawn()` assigns the child process to the Job Object after spawn,
//! enforcing kill-on-close and resource limits.

#![cfg(target_os = "windows")]

use super::{Sandbox, SandboxContext};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::process::Command;
use std::sync::Mutex;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_JOB_MEMORY,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_UILIMIT_DESKTOP,
    JOB_OBJECT_UILIMIT_DISPLAYSETTINGS, JOB_OBJECT_UILIMIT_EXITWINDOWS,
    JOB_OBJECT_UILIMIT_GLOBALATOMS, JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS,
    JOBOBJECT_BASIC_UI_RESTRICTIONS, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicUIRestrictions, JobObjectExtendedLimitInformation, SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

/// Job Object-based sandbox for Windows process isolation.
///
/// Creates a Windows Job Object with resource limits derived from
/// [`SandboxContext::resource_limits`]. The Job Object enforces:
///
/// - **Kill-on-close**: All processes terminate when the handle drops.
/// - **Memory limit**: Hard cap on committed memory (from `max_memory`).
/// - **Process limit**: Maximum active processes (from `max_processes`).
#[derive(Debug)]
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

    /// Platform constructor alias (used by [`JailerBuilder`](super::super::JailerBuilder)).
    pub fn platform_new() -> Self {
        Self::new()
    }

    /// Create a Job Object with limits from the sandbox context.
    fn create_job_object(ctx: &SandboxContext) -> BoxliteResult<HANDLE> {
        // Create unnamed Job Object
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(BoxliteError::Internal(format!(
                "Failed to create Windows Job Object: {}",
                std::io::Error::last_os_error()
            )));
        }

        // Configure limits
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        let mut limit_flags: u32 = 0;

        // Always kill all processes when Job Object handle is closed
        limit_flags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        // Terminate processes that trigger unhandled exceptions instead of
        // showing the Windows Error Reporting dialog (blocks the process)
        limit_flags |= JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;

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
            let err = std::io::Error::last_os_error();
            unsafe { CloseHandle(handle) };
            return Err(BoxliteError::Internal(format!(
                "Failed to set Job Object limits: {}",
                err
            )));
        }

        // Apply UI restrictions to prevent sandbox escape via desktop/display manipulation
        let ui_restrictions = JOBOBJECT_BASIC_UI_RESTRICTIONS {
            UIRestrictionsClass: JOB_OBJECT_UILIMIT_DESKTOP
                | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS
                | JOB_OBJECT_UILIMIT_EXITWINDOWS
                | JOB_OBJECT_UILIMIT_GLOBALATOMS
                | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS,
        };

        let result = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectBasicUIRestrictions,
                &ui_restrictions as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32,
            )
        };

        if result == 0 {
            let err = std::io::Error::last_os_error();
            unsafe { CloseHandle(handle) };
            return Err(BoxliteError::Internal(format!(
                "Failed to set Job Object UI restrictions: {}",
                err
            )));
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
        // No pre-spawn command modifications needed.
        // Job Object assignment happens in post_spawn() after the child is spawned.
    }

    fn post_spawn(&self, child: &std::process::Child) -> BoxliteResult<()> {
        let job_handle = self
            .job_handle
            .lock()
            .map_err(|e| BoxliteError::Internal(format!("Job Object mutex poisoned: {e}")))?;

        if *job_handle == INVALID_HANDLE_VALUE || (*job_handle).is_null() {
            return Err(BoxliteError::Internal(
                "Job Object not initialized (setup() not called)".into(),
            ));
        }

        let access = PROCESS_SET_QUOTA | PROCESS_TERMINATE;
        let child_handle = unsafe { OpenProcess(access, 0, child.id()) };
        if child_handle.is_null() {
            return Err(BoxliteError::Internal(format!(
                "Failed to open child process {}: {}",
                child.id(),
                std::io::Error::last_os_error()
            )));
        }

        let result = unsafe { AssignProcessToJobObject(*job_handle, child_handle) };
        unsafe { CloseHandle(child_handle) };

        if result == 0 {
            return Err(BoxliteError::Internal(format!(
                "AssignProcessToJobObject failed for PID {}: {}",
                child.id(),
                std::io::Error::last_os_error()
            )));
        }

        Ok(())
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
    fn test_post_spawn_without_setup_fails() {
        let sandbox = JobSandbox::new();
        let child = std::process::Command::new("cmd")
            .arg("/c")
            .arg("echo test")
            .spawn()
            .unwrap();
        let result = sandbox.post_spawn(&child);
        assert!(result.is_err(), "post_spawn without setup should fail");
    }

    #[test]
    fn test_post_spawn_assigns_to_job_object() {
        use crate::runtime::advanced_options::ResourceLimits;

        let sandbox = JobSandbox::new();
        let limits = ResourceLimits::default();
        let ctx = SandboxContext {
            id: "test-post-spawn",
            paths: Vec::new(),
            resource_limits: &limits,
            network_enabled: false,
            sandbox_profile: None,
        };

        sandbox.setup(&ctx).unwrap();

        // Spawn a short-lived child process
        let child = std::process::Command::new("cmd")
            .arg("/c")
            .arg("echo hello")
            .spawn()
            .unwrap();

        let result = sandbox.post_spawn(&child);
        assert!(
            result.is_ok(),
            "post_spawn should succeed after setup: {result:?}"
        );
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

    #[test]
    fn test_job_object_has_die_on_exception_and_kill_on_close() {
        use crate::runtime::advanced_options::ResourceLimits;

        let limits = ResourceLimits::default();
        let ctx = SandboxContext {
            id: "test-flags",
            paths: Vec::new(),
            resource_limits: &limits,
            network_enabled: false,
            sandbox_profile: None,
        };

        let handle = JobSandbox::create_job_object(&ctx).unwrap();

        // Query the extended limit information to verify flags
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        let mut ret_len: u32 = 0;
        let ok = unsafe {
            QueryInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                &mut ret_len,
            )
        };
        assert_ne!(ok, 0, "QueryInformationJobObject should succeed");

        let flags = info.BasicLimitInformation.LimitFlags;
        assert_ne!(
            flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            0,
            "KILL_ON_JOB_CLOSE flag must be set"
        );
        assert_ne!(
            flags & JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
            0,
            "DIE_ON_UNHANDLED_EXCEPTION flag must be set"
        );

        unsafe { CloseHandle(handle) };
    }

    #[test]
    fn test_job_object_has_ui_restrictions() {
        use crate::runtime::advanced_options::ResourceLimits;

        let limits = ResourceLimits::default();
        let ctx = SandboxContext {
            id: "test-ui",
            paths: Vec::new(),
            resource_limits: &limits,
            network_enabled: false,
            sandbox_profile: None,
        };

        let handle = JobSandbox::create_job_object(&ctx).unwrap();

        // Query UI restrictions
        let mut ui_info: JOBOBJECT_BASIC_UI_RESTRICTIONS = unsafe { std::mem::zeroed() };
        let mut ret_len: u32 = 0;
        let ok = unsafe {
            QueryInformationJobObject(
                handle,
                JobObjectBasicUIRestrictions,
                &mut ui_info as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32,
                &mut ret_len,
            )
        };
        assert_ne!(ok, 0, "QueryInformationJobObject should succeed");

        let ui_flags = ui_info.UIRestrictionsClass;
        assert_ne!(
            ui_flags & JOB_OBJECT_UILIMIT_DESKTOP,
            0,
            "UILIMIT_DESKTOP must be set"
        );
        assert_ne!(
            ui_flags & JOB_OBJECT_UILIMIT_DISPLAYSETTINGS,
            0,
            "UILIMIT_DISPLAYSETTINGS must be set"
        );
        assert_ne!(
            ui_flags & JOB_OBJECT_UILIMIT_EXITWINDOWS,
            0,
            "UILIMIT_EXITWINDOWS must be set"
        );
        assert_ne!(
            ui_flags & JOB_OBJECT_UILIMIT_GLOBALATOMS,
            0,
            "UILIMIT_GLOBALATOMS must be set"
        );
        assert_ne!(
            ui_flags & JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS,
            0,
            "UILIMIT_SYSTEMPARAMETERS must be set"
        );

        unsafe { CloseHandle(handle) };
    }
}
