//! Shared execution helpers.
//!
//! POSIX exit-code classification for spawn-time failures. The guest's
//! container executor (libcontainer/youki) detects two *user* command
//! errors during container build — before the process is ever exec'd —
//! and reports them as plain strings:
//!
//! - executable not found on `$PATH`         → POSIX exit code **127**
//! - executable found but not executable     → POSIX exit code **126**
//!
//! Both are caught by youki's workload validator
//! (`crates/libcontainer/src/workload/default.rs`) and surfaced as the
//! `detail` of a `spawn_failed` `ExecError`. This helper maps that detail
//! back to the canonical POSIX exit code so the host can present the
//! failure as a *completed execution* (exit 127/126) instead of a 5xx —
//! matching how a real shell behaves when you run a missing command.
//! (The literal is youki's own `format!` text, *not* a `strerror` message,
//! so it is locale-independent.)
//!
//! Returns `None` for any other spawn failure (cgroup setup, OOM, init
//! death, IPC corruption, …). Those are genuine errors and must NOT be
//! laundered into a fake exit code. The non-container "guest direct-spawn"
//! executor does NOT classify — its failures stay honest `Internal`/500.

// SYNC: these two literals are youki/libcontainer internals, pinned via the
// `libcontainer` git `rev` in the workspace `Cargo.toml` (currently rev
// 4b2f0e0). They are youki's own `format!` text (NOT locale-translated
// `strerror` output), so they are language-independent — but a libcontainer
// submodule/rev bump can reword them. On ANY libcontainer bump, re-verify both
// against `crates/libcontainer/src/workload/default.rs` (lines 74 and 88) and
// keep the command-not-found / not-executable e2e tests green in CI: a silent
// wording drift here regresses P0-5 back to a 5xx.

/// youki literal for "executable not found on PATH" (exit 127).
/// Source: `workload/default.rs:74` → `"executable '{}' not found in $PATH"`.
const NOT_FOUND_MARKER: &str = "not found in $PATH";

/// youki literal for "found but lacks execute permission" (exit 126).
/// Source: `workload/default.rs:88` → `"... does not have correct permissions"`.
const NOT_EXECUTABLE_MARKER: &str = "does not have correct permissions";

/// Map a guest spawn-failure `detail` string to its POSIX exit code, if it
/// is a recognizable *user* command error.
///
/// `Some(127)` — command not found; `Some(126)` — found but not executable;
/// `None` — not a user command error (surface as a real failure).
pub fn posix_exit_code_for_spawn_failure(detail: &str) -> Option<i32> {
    if detail.contains(NOT_FOUND_MARKER) {
        Some(127)
    } else if detail.contains(NOT_EXECUTABLE_MARKER) {
        Some(126)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_found_in_path_maps_to_127() {
        // The exact shape produced by the container executor for a missing
        // binary: youki's validator fails the build before fork/exec.
        let detail = "build failed: failed to create container: exec process \
                      failed with error executable 'this-binary-does-not-exist-2026' \
                      not found in $PATH (code=1)";
        assert_eq!(posix_exit_code_for_spawn_failure(detail), Some(127));
    }

    #[test]
    fn not_executable_permissions_maps_to_126() {
        let detail = "build failed: executable '/data/script.sh' at path \
                      '\"/data/script.sh\"' does not have correct permissions";
        assert_eq!(posix_exit_code_for_spawn_failure(detail), Some(126));
    }

    #[test]
    fn genuine_platform_failure_is_unclassified() {
        // A cgroup error mentioning "permission denied" must NOT be mistaken
        // for the 126 case — we match youki's full phrase, not "permission".
        let detail = "build failed: failed to create container: cgroup setup \
                      error: permission denied creating /sys/fs/cgroup/boxlite";
        assert_eq!(posix_exit_code_for_spawn_failure(detail), None);
    }

    #[test]
    fn container_not_found_is_unclassified() {
        assert_eq!(
            posix_exit_code_for_spawn_failure("Container not found: abc123"),
            None
        );
    }

    #[test]
    fn empty_detail_is_unclassified() {
        assert_eq!(posix_exit_code_for_spawn_failure(""), None);
    }
}
