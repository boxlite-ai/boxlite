//! Subprocess spawning for boxlite-shim binary.

use std::{
    io::{self, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Stdio},
    time::Duration,
};

use crate::jailer::{Jail, JailerBuilder, PathAccess};
use crate::runtime::layout::BoxFilesystemLayout;
use crate::runtime::options::{BoxOptions, NetworkSpec};
use crate::util::configure_library_env;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use tokio::io::AsyncWriteExt;

use super::watchdog;

/// Files `krun_check_nested_virt` reads on Linux to decide whether the loaded
/// KVM module allows nesting. Absent on macOS, where the probe is a syscall.
const NESTED_VIRT_PROBE_PATHS: [&str; 2] = [
    "/sys/module/kvm_intel/parameters/nested",
    "/sys/module/kvm_amd/parameters/nested",
];

const PROTECTED_LAUNCH_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) enum ProtectedSpawnEvent {
    PreparingChild,
    NoChild,
    ChildStarted(u32),
}

pub(super) type ProtectedSpawnRecorder =
    Box<dyn Fn(ProtectedSpawnEvent) -> BoxliteResult<()> + Send>;

/// A shim that was spawned, with its child process handle and optional keepalive.
///
/// The `keepalive` holds the parent side of the watchdog pipe. While it exists,
/// the shim's watchdog thread blocks on `poll()`. Dropping it closes the pipe
/// write end, delivering POLLHUP to the shim and triggering graceful shutdown.
pub struct SpawnedShim {
    pub child: Child,
    /// Parent-side watchdog keepalive. Dropping triggers shim shutdown.
    /// `None` for detached boxes (no watchdog).
    pub keepalive: Option<watchdog::Keepalive>,
}

struct PendingProtectedShim<'a> {
    shim: Option<SpawnedShim>,
    box_id: &'a str,
}

impl Drop for PendingProtectedShim<'_> {
    fn drop(&mut self) {
        if let Some(SpawnedShim { mut child, .. }) = self.shim.take() {
            // Keep the durable reservation until the lifecycle proves this child has exited.
            drop(child.stdin.take());
            let _ = child.kill();
            if let Some(id) = crate::BoxID::parse(self.box_id) {
                crate::jailer::reap_box(&id);
            }
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
}

/// Spawns `boxlite-shim` with full isolation, environment, and watchdog.
///
/// Composes: Jailer (isolation) + watchdog (lifecycle) + env/stdio setup.
///
/// # Fields
///
/// Stable inputs grouped into the struct; variable inputs (`config_json`, `detach`)
/// are passed to [`spawn()`](Self::spawn).
pub struct ShimSpawner<'a> {
    binary_path: &'a Path,
    layout: &'a BoxFilesystemLayout,
    box_id: &'a str,
    options: &'a BoxOptions,
    nested_virtualization: bool,
}

impl<'a> ShimSpawner<'a> {
    pub fn new(
        binary_path: &'a Path,
        layout: &'a BoxFilesystemLayout,
        box_id: &'a str,
        options: &'a BoxOptions,
    ) -> Self {
        Self {
            binary_path,
            layout,
            box_id,
            options,
            nested_virtualization: false,
        }
    }

    #[cfg(target_os = "linux")]
    fn apply_cpu_quota(&self) -> BoxliteResult<()> {
        let Some(limit) = self.options.cpu_count()?.filter(|cpu| cpu.is_fractional()) else {
            return Ok(());
        };
        let security = &self.options.advanced.security;
        if !security.jailer_enabled {
            return Err(BoxliteError::Engine("CPU limit requires the jailer".into()));
        }
        // Best-effort, like cgroup setup and membership: a host without a
        // delegated CPU controller must still be able to start the Box.
        if let Err(error) =
            crate::jailer::cgroup::set_cpu_max(self.box_id, limit, &security.resource_limits)
        {
            tracing::error!(
                box_id = %self.box_id,
                cpus = limit.cores(),
                error = %error,
                "Cannot apply CPU limit; starting the Box without a CPU bandwidth limit"
            );
        }
        Ok(())
    }

    /// Grant the confined shim the host files libkrun probes before enabling
    /// nested virtualization. The caller passes the value from the VM request
    /// it is about to serialize, which is the authority on what the shim runs.
    pub fn with_nested_virtualization(mut self, enabled: bool) -> Self {
        self.nested_virtualization = enabled;
        self
    }

    /// Host files this shim's VM request needs to read. Empty unless the box
    /// asked for nesting, so an ordinary box widens its sandbox by nothing.
    fn required_probe_paths(&self) -> &'static [&'static str] {
        if self.nested_virtualization {
            &NESTED_VIRT_PROBE_PATHS
        } else {
            &[]
        }
    }

    /// Filesystem grants beyond the jailer's standard set: read-only, and only
    /// the probes this host actually has — bwrap refuses to bind a missing one.
    fn additional_path_access(&self) -> Vec<PathAccess> {
        self.required_probe_paths()
            .iter()
            .map(PathBuf::from)
            .filter(|path| path.exists())
            .map(|path| PathAccess {
                path,
                writable: false,
            })
            .collect()
    }

    /// Spawn the shim subprocess with jailer isolation and optional watchdog.
    ///
    /// When `detach` is false, creates a watchdog pipe so the shim detects
    /// parent death via POLLHUP. When `detach` is true, no watchdog is created.
    ///
    /// # Returns
    /// * `SpawnedShim` containing the child process and optional keepalive
    pub fn spawn(&self, config_json: &str, detach: bool) -> BoxliteResult<SpawnedShim> {
        let mut shim = self.spawn_child(detach, None)?;
        if let Some(mut stdin) = shim.child.stdin.take() {
            stdin.write_all(config_json.as_bytes()).map_err(|e| {
                BoxliteError::Engine(format!("Failed to write config to shim stdin: {e}"))
            })?;
        }
        Ok(shim)
    }

    pub(super) async fn spawn_protected(
        &self,
        config_json: &str,
        detach: bool,
        record_spawn: ProtectedSpawnRecorder,
    ) -> BoxliteResult<SpawnedShim> {
        let shim = self.spawn_child(detach, Some(&*record_spawn))?;
        let mut pending = PendingProtectedShim {
            shim: Some(shim),
            box_id: self.box_id,
        };
        let child = &mut pending.shim.as_mut().expect("pending protected shim").child;
        record_spawn(ProtectedSpawnEvent::ChildStarted(child.id()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| BoxliteError::Engine("Missing protected shim launch pipe".into()))?;
        write_protected_config(stdin, config_json.as_bytes(), PROTECTED_LAUNCH_TIMEOUT)
            .await
            .map_err(|e| {
                BoxliteError::Engine(format!("Failed to write protected shim config: {e}"))
            })?;
        Ok(pending.shim.take().expect("pending protected shim"))
    }

    fn spawn_child(
        &self,
        detach: bool,
        record_spawn: Option<&dyn Fn(ProtectedSpawnEvent) -> BoxliteResult<()>>,
    ) -> BoxliteResult<SpawnedShim> {
        // 1. Create watchdog pipe (non-detached only)
        let (keepalive, child_setup) = if !detach {
            let (k, s) = watchdog::create()?;
            (Some(k), Some(s))
        } else {
            (None, None)
        };

        // 2. Build jailer with optional FD preservation for watchdog pipe.
        // `with_detach(detach)` threads the lifecycle choice into the
        // jailer's pre_exec chain (setsid vs. process_group).
        let mut builder = JailerBuilder::new()
            .with_box_id(self.box_id)
            .with_layout(self.layout.clone())
            .with_security(self.options.advanced.security.clone())
            .with_volumes(self.options.volumes.clone())
            .with_mounts(self.options.mounts.clone())
            .with_additional_path_access(self.additional_path_access())
            .with_network_backend_enabled(matches!(
                &self.options.network,
                NetworkSpec::Enabled { .. }
            ))
            .with_detach(detach);

        if let Some(ref setup) = child_setup {
            builder = builder.with_preserved_fd(setup.raw_fd(), watchdog::PIPE_FD);
        }

        let jail = builder.build()?;

        // 3. Setup pre-spawn isolation (cgroups on Linux, no-op on macOS)
        jail.prepare()?;
        #[cfg(target_os = "linux")]
        self.apply_cpu_quota()?;

        // 4. Build isolated command — no CLI args, config sent via stdin pipe
        let no_args: &[String] = &[];
        let mut cmd = jail.command(self.binary_path, no_args);

        // 5. Configure environment
        self.configure_env(&mut cmd);

        // 6. Configure stdio
        // stdin=piped: config JSON is sent via stdin to avoid /proc/cmdline exposure
        // (config contains CA private keys and secret values)
        let stderr_file = self.create_stderr_file()?;
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::from(stderr_file));

        // 7. Spawn
        if let Some(record_spawn) = record_spawn {
            record_spawn(ProtectedSpawnEvent::PreparingChild)?;
        }
        let child = match cmd.spawn() {
            Ok(child) => child,
            Err(error) => {
                // On Unix, Command::spawn waits for the failed child before returning an exec error.
                if let Some(record_spawn) = record_spawn {
                    record_spawn(ProtectedSpawnEvent::NoChild)?;
                }
                let message = format!(
                    "Failed to spawn VM subprocess at {}: {error}",
                    self.binary_path.display()
                );
                tracing::error!("{message}");
                return Err(BoxliteError::Engine(message));
            }
        };

        // Close the parent's copy of the watchdog read end.
        drop(child_setup);

        Ok(SpawnedShim { child, keepalive })
    }

    fn configure_env(&self, cmd: &mut std::process::Command) {
        // Non-sensitive process marker used by recovery to validate shim PIDs
        // without putting the full InstanceSpec back into /proc/<pid>/cmdline.
        cmd.env("BOXLITE_BOX_ID", self.box_id);

        // Pass debugging environment variables to subprocess
        if let Ok(rust_log) = std::env::var("RUST_LOG") {
            cmd.env("RUST_LOG", rust_log);
        }
        if let Ok(rust_backtrace) = std::env::var("RUST_BACKTRACE") {
            cmd.env("RUST_BACKTRACE", rust_backtrace);
        }

        // Keep temp artifacts inside the box-scoped allowlist when using the
        // built-in macOS seatbelt profile. libkrun may create a transient
        // `krun-empty-root-*` under `env::temp_dir()` when booting from block
        // devices; under deny-default seatbelt this must resolve to an
        // explicitly granted path.
        if self.options.advanced.security.jailer_enabled
            && self.options.advanced.security.sandbox_profile.is_none()
        {
            let tmp_dir = self.layout.tmp_dir();
            cmd.env("TMPDIR", &tmp_dir);
            cmd.env("TMP", &tmp_dir);
            cmd.env("TEMP", &tmp_dir);
        }

        // Set library search paths for bundled dependencies (e.g., libkrunfw.so)
        configure_library_env(cmd, std::ptr::null());
    }

    fn create_stderr_file(&self) -> BoxliteResult<std::fs::File> {
        // Create stderr file BEFORE spawn to capture ALL errors including pre-main dyld errors.
        // This is critical: dyld errors happen before main() and would go to /dev/null otherwise.
        let stderr_file_path = self.layout.stderr_file_path();
        std::fs::File::create(&stderr_file_path).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create stderr file {}: {}",
                stderr_file_path.display(),
                e
            ))
        })
    }
}

async fn write_protected_config(
    stdin: ChildStdin,
    config: &[u8],
    timeout: Duration,
) -> io::Result<()> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut stdin = tokio::process::ChildStdin::from_std(stdin)?;
    tokio::time::timeout_at(deadline, stdin.write_all(config))
        .await
        .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))??;
    if tokio::time::Instant::now() >= deadline {
        return Err(io::ErrorKind::TimedOut.into());
    }
    // Closing the writer lets the shim decode the one complete record.
    Ok(())
}

#[cfg(all(test, target_os = "linux"))]
#[path = "tests/fractional_cpus_membership.rs"]
mod fractional_cpus_membership_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::layout::{BoxFilesystemLayout, FsLayoutConfig};
    use std::ffi::OsStr;

    #[tokio::test(flavor = "current_thread")]
    async fn outbound_bootstrap_stalled_pipe_yields_and_times_out() {
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "head -c 1; exec sleep 30"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let started = std::time::Instant::now();
        let stdin = child.stdin.take().unwrap();
        let completed = std::cell::Cell::new(false);
        let (result, writer_completed_before_sibling) = tokio::join!(
            biased;
            async {
                let result = write_protected_config(stdin, &vec![b'x'; 2 << 20], Duration::from_secs(1)).await;
                completed.set(true);
                result
            },
            async {
                tokio::task::yield_now().await;
                completed.get()
            },
        );
        let _ = child.kill();
        child.wait().unwrap();
        let mut observed = Vec::new();
        std::io::Read::read_to_end(&mut child.stdout.take().unwrap(), &mut observed).unwrap();
        assert_eq!(observed, b"x");
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(
            !writer_completed_before_sibling,
            "stalled shim starved the current-thread Runtime"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn outbound_bootstrap_pipe_cancellation_reaps_the_pending_child() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let pid = child.id();
        let stdin = child.stdin.take().unwrap();
        let launch = async move {
            let _pending = PendingProtectedShim {
                shim: Some(SpawnedShim {
                    child,
                    keepalive: None,
                }),
                box_id: "",
            };
            write_protected_config(stdin, &vec![b'x'; 2 << 20], Duration::from_secs(5)).await
        };
        tokio::select! {
            biased;
            result = launch => panic!("pipe unexpectedly completed before cancellation: {result:?}"),
            () = tokio::task::yield_now() => {}
        }
        tokio::time::timeout(Duration::from_secs(2), async {
            while crate::util::is_process_alive(pid) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("pending protected child should exit after cancellation");
    }

    fn test_layout() -> BoxFilesystemLayout {
        BoxFilesystemLayout::new(
            PathBuf::from("/tmp/box"),
            FsLayoutConfig::without_bind_mount(),
            false,
        )
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn fractional_cpus_quota_write_failure_does_not_block_start() {
        let layout = test_layout();
        let mut options = BoxOptions::default();
        options.advanced.security.jailer_enabled = false;
        let unlimited = ShimSpawner::new(Path::new("/unused"), &layout, "test-box", &options);
        assert!(unlimited.apply_cpu_quota().is_ok());
        options.cpus = Some(2.0);
        let integer = ShimSpawner::new(Path::new("/unused"), &layout, "test-box", &options);
        assert!(integer.apply_cpu_quota().is_ok());
        options.cpus = Some(0.125);
        let limited = ShimSpawner::new(Path::new("/unused"), &layout, "test-box", &options);
        assert!(
            limited.apply_cpu_quota().is_err(),
            "disabled jailer still rejects a fractional allocation"
        );
        options.advanced.security.jailer_enabled = true;
        let limited = ShimSpawner::new(
            Path::new("/unused"),
            &layout,
            "missing-fractional-cpus-test",
            &options,
        );
        assert!(
            limited.apply_cpu_quota().is_ok(),
            "a failed cpu.max write must not block start"
        );
    }

    #[test]
    fn test_build_shim_args() {
        let layout = test_layout();
        let options = BoxOptions::default();

        let spawner = ShimSpawner::new(
            Path::new("/usr/bin/boxlite-shim"),
            &layout,
            "test-box",
            &options,
        );

        // No CLI args — config is sent via stdin pipe
        // Just verify the spawner was created without error
        assert_eq!(spawner.box_id, "test-box");
    }

    /// The probe grant widens the shim's sandbox, so only a box that asked for
    /// nesting may request it.
    ///
    /// Asserted on the requested set rather than the resolved grants: the
    /// grants are filtered by what this host has, which would make the
    /// off-by-default half vacuously true anywhere `/sys/module/kvm_*` is
    /// absent — every macOS dev machine.
    #[test]
    fn only_nested_virtualization_requests_the_probe_paths() {
        let layout = test_layout();
        let options = BoxOptions::default();
        let spawner = ShimSpawner::new(
            Path::new("/usr/bin/boxlite-shim"),
            &layout,
            "test-box",
            &options,
        );

        assert!(
            spawner.required_probe_paths().is_empty(),
            "a box that did not ask for nesting must request no extra paths"
        );
        assert_eq!(
            spawner
                .with_nested_virtualization(true)
                .required_probe_paths(),
            NESTED_VIRT_PROBE_PATHS,
        );
    }

    /// Whatever survives the host filter must be read-only and inside the probe
    /// set — a grant is sandbox surface, so it may never widen beyond that.
    #[test]
    fn probe_path_grants_are_read_only_and_confined() {
        let layout = test_layout();
        let options = BoxOptions::default();

        for grant in ShimSpawner::new(
            Path::new("/usr/bin/boxlite-shim"),
            &layout,
            "test-box",
            &options,
        )
        .with_nested_virtualization(true)
        .additional_path_access()
        {
            assert!(!grant.writable, "probe grants must be read-only: {grant:?}");
            assert!(
                grant.path.exists(),
                "must not grant a path that is not there: {grant:?}"
            );
            assert!(
                NESTED_VIRT_PROBE_PATHS
                    .iter()
                    .any(|probe| Path::new(probe) == grant.path),
                "must not grant anything outside the probe set: {grant:?}"
            );
        }
    }

    #[test]
    fn test_configure_env_sets_box_scoped_temp_dir() {
        use crate::runtime::advanced_options::{AdvancedBoxOptions, SecurityOptions};
        use crate::runtime::layout::{BoxFilesystemLayout, FsLayoutConfig};
        use std::path::PathBuf;

        let layout = BoxFilesystemLayout::new(
            PathBuf::from("/tmp/box"),
            FsLayoutConfig::without_bind_mount(),
            false,
        );
        let mut advanced = AdvancedBoxOptions::default();
        advanced.security = SecurityOptions {
            jailer_enabled: true,
            ..SecurityOptions::default()
        };
        let options = BoxOptions {
            advanced,
            ..BoxOptions::default()
        };

        let spawner = ShimSpawner::new(
            Path::new("/usr/bin/boxlite-shim"),
            &layout,
            "test-box",
            &options,
        );

        let mut cmd = std::process::Command::new("/usr/bin/true");
        spawner.configure_env(&mut cmd);

        let envs: std::collections::HashMap<_, _> = cmd.get_envs().collect();
        let expected = layout.tmp_dir();

        assert_eq!(
            envs.get(OsStr::new("BOXLITE_BOX_ID")).and_then(|v| *v),
            Some(OsStr::new("test-box"))
        );
        assert_eq!(
            envs.get(OsStr::new("TMPDIR")).and_then(|v| *v),
            Some(expected.as_os_str())
        );
        assert_eq!(
            envs.get(OsStr::new("TMP")).and_then(|v| *v),
            Some(expected.as_os_str())
        );
        assert_eq!(
            envs.get(OsStr::new("TEMP")).and_then(|v| *v),
            Some(expected.as_os_str())
        );
    }

    #[test]
    fn test_configure_env_does_not_override_temp_for_custom_profile() {
        use crate::runtime::advanced_options::{AdvancedBoxOptions, SecurityOptions};
        use crate::runtime::layout::{BoxFilesystemLayout, FsLayoutConfig};
        use std::path::PathBuf;

        let layout = BoxFilesystemLayout::new(
            PathBuf::from("/tmp/box"),
            FsLayoutConfig::without_bind_mount(),
            false,
        );
        let mut advanced = AdvancedBoxOptions::default();
        advanced.security = SecurityOptions {
            jailer_enabled: true,
            sandbox_profile: Some(PathBuf::from("/tmp/custom.sbpl")),
            ..SecurityOptions::default()
        };
        let options = BoxOptions {
            advanced,
            ..BoxOptions::default()
        };

        let spawner = ShimSpawner::new(
            Path::new("/usr/bin/boxlite-shim"),
            &layout,
            "test-box",
            &options,
        );

        let mut cmd = std::process::Command::new("/usr/bin/true");
        spawner.configure_env(&mut cmd);

        let envs: std::collections::HashMap<_, _> = cmd.get_envs().collect();
        assert!(!envs.contains_key(OsStr::new("TMPDIR")));
        assert!(!envs.contains_key(OsStr::new("TMP")));
        assert!(!envs.contains_key(OsStr::new("TEMP")));
    }

    /// Detached spawn must produce a child that is its own session
    /// leader. Without `setsid`, a SIGHUP to the parent's controlling
    /// terminal cascades into the daemon — breaking detach.
    ///
    /// Revert procedure: comment out the
    /// `.with_detach(detach)` builder call in `spawn()`.
    /// This test must then fail with `child_sid == parent_sid`.
    #[cfg(unix)]
    #[test]
    fn shim_spawner_detached_creates_new_session() {
        use crate::runtime::advanced_options::SecurityOptions;
        use crate::runtime::layout::{BoxFilesystemLayout, FsLayoutConfig};
        use std::time::Duration;
        use tempfile::TempDir;

        let parent_sid = unsafe { libc::getsid(0) };

        let tmp = TempDir::new_in("/tmp").expect("tempdir");
        let box_dir = tmp.path().join("box");
        std::fs::create_dir_all(&box_dir).expect("mkdir box");
        let layout = BoxFilesystemLayout::new(box_dir, FsLayoutConfig::without_bind_mount(), false);
        // Disable jailer: on macOS the default wraps the child in
        // sandbox-exec, which would block the `/usr/bin/yes` stand-in.
        // The setsid pre_exec hook is unaffected by sandbox state.
        let mut options = BoxOptions::default();
        options.advanced.security = SecurityOptions::disabled();
        let spawner = ShimSpawner::new(
            std::path::Path::new("/usr/bin/yes"),
            &layout,
            "shimspawnertest",
            &options,
        );

        let spawned = spawner.spawn("", true).expect("spawn detached");
        let pid = spawned.child.id();

        std::thread::sleep(Duration::from_millis(100));
        let child_sid = unsafe { libc::getsid(pid as i32) };

        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
            libc::waitpid(pid as i32, std::ptr::null_mut(), 0);
        }

        assert_eq!(
            child_sid, pid as i32,
            "detached ShimSpawner::spawn must produce a session-leader child. \
             Got sid={child_sid}, expected {pid}. parent_sid={parent_sid}. \
             Without setsid, a SIGHUP to the parent's controlling terminal \
             would cascade into the detached shim."
        );
        assert_ne!(
            child_sid, parent_sid,
            "shim's session id must differ from parent's"
        );
    }

    /// Non-detached spawn must produce a child that is its own
    /// process-group leader so `killpg(shim_pid, SIGKILL)` reaps the
    /// shim + grandchildren (libkrun threads, gvproxy) atomically.
    ///
    /// Revert procedure: comment out the
    /// `.with_detach(detach)` builder call in `spawn()`.
    /// This test must then fail with `child_pgid == parent_pgid`.
    #[cfg(unix)]
    #[test]
    fn shim_spawner_non_detached_creates_new_pgroup() {
        use crate::runtime::advanced_options::SecurityOptions;
        use crate::runtime::layout::{BoxFilesystemLayout, FsLayoutConfig};
        use std::time::Duration;
        use tempfile::TempDir;

        let parent_pgid = unsafe { libc::getpgid(0) };

        let tmp = TempDir::new_in("/tmp").expect("tempdir");
        let box_dir = tmp.path().join("box");
        std::fs::create_dir_all(&box_dir).expect("mkdir box");
        let layout = BoxFilesystemLayout::new(box_dir, FsLayoutConfig::without_bind_mount(), false);
        let mut options = BoxOptions::default();
        options.advanced.security = SecurityOptions::disabled();
        let spawner = ShimSpawner::new(
            std::path::Path::new("/usr/bin/yes"),
            &layout,
            "shimspawnertest",
            &options,
        );

        let spawned = spawner.spawn("", false).expect("spawn non-detached");
        let pid = spawned.child.id();

        std::thread::sleep(Duration::from_millis(100));
        let child_pgid = unsafe { libc::getpgid(pid as i32) };

        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
            libc::waitpid(pid as i32, std::ptr::null_mut(), 0);
        }

        assert_eq!(
            child_pgid, pid as i32,
            "non-detached ShimSpawner::spawn must produce a pgroup-leader child. \
             Got pgid={child_pgid}, expected {pid}. parent_pgid={parent_pgid}. \
             Without process_group(0), killpg(shim_pid) would target the \
             parent's pgroup."
        );
        assert_ne!(
            child_pgid, parent_pgid,
            "shim's pgid must differ from parent's"
        );
    }
}
