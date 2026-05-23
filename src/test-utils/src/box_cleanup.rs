//! RAII cleanup guard for detached boxes (`boxlite run -d`).
//!
//! Drop SIGKILLs the box's live libkrun VM by scanning `/proc/*/fd` for
//! FDs that still reference `<home>/boxes/<box_id>/...` — the only
//! reliable fingerprint at Drop time because:
//!
//! 1. `boxlite run -d` daemonizes and removes the on-disk handoff state
//!    (`<home>/boxes/<box_id>/shim.pid`) shortly after the FDs migrate
//!    into the libkrun VM process. Reading the pid from disk is racy
//!    and usually empty by the time cleanup runs.
//! 2. `boxlite rm -f` is deliberately NOT used: its recovery path in
//!    `src/boxlite/src/runtime/rt_impl.rs` mis-identifies the live shim
//!    as dead and removes the pid file without killing the process
//!    (see the May 2026 incident — `project_rm_force_running_flaky`).
//!
//! Drop runs on panic too, so an assertion failure in the rest of the
//! test doesn't leak a libkrun VM that would block the next test run.
//!
//! # When to use
//!
//! Wrap every box id returned from `boxlite run -d ...` in a
//! `BoxCleanup`. Bind it to a `_name`-prefixed local so Rust keeps it
//! alive until the end of the scope. Order matters: declare it AFTER
//! the `PerTestBoxHome` whose path it references, so reverse-order
//! drop tears down the box BEFORE the home dir is removed (otherwise
//! `/proc/*/fd` symlinks no longer match `<home>/boxes/...` and the
//! kill silently no-ops).

use std::path::PathBuf;
use std::process::Command;

pub struct BoxCleanup {
    pub home_path: PathBuf,
    pub box_id: String,
}

impl Drop for BoxCleanup {
    fn drop(&mut self) {
        let needle = format!("/boxes/{}/", self.box_id);
        let home_prefix = self.home_path.to_string_lossy().into_owned();
        let mut killed = Vec::<u32>::new();
        if let Ok(procs) = std::fs::read_dir("/proc") {
            for proc_entry in procs.flatten() {
                let Some(name) = proc_entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                let Ok(pid) = name.parse::<u32>() else {
                    continue;
                };
                let fd_dir = proc_entry.path().join("fd");
                let Ok(fds) = std::fs::read_dir(&fd_dir) else {
                    continue;
                };
                let matched = fds.flatten().any(|fd| {
                    std::fs::read_link(fd.path())
                        .map(|tgt| {
                            let s = tgt.to_string_lossy();
                            s.starts_with(&home_prefix) && s.contains(&needle)
                        })
                        .unwrap_or(false)
                });
                if matched {
                    let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
                    killed.push(pid);
                }
            }
        }
        eprintln!("[cleanup] box {} SIGKILL'd pids={:?}", self.box_id, killed);
    }
}
