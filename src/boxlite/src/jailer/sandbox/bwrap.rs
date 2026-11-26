//! BwrapSandbox — Linux isolation via bubblewrap.
//!
//! Implements the [`Sandbox`] trait using bubblewrap (bwrap) for
//! namespace isolation, bind mounts, and environment sanitization.

use super::{Sandbox, SandboxContext};
use crate::jailer::{bwrap, cgroup};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::process::Command;

/// Linux sandbox using bubblewrap for namespace isolation.
#[derive(Debug)]
pub struct BwrapSandbox;

impl BwrapSandbox {
    pub fn new() -> Self {
        Self
    }
}

impl Default for BwrapSandbox {
    fn default() -> Self {
        Self::new()
    }
}

impl Sandbox for BwrapSandbox {
    fn is_available(&self) -> bool {
        bwrap::is_available()
    }

    fn setup(&self, ctx: &SandboxContext) -> BoxliteResult<()> {
        // Preflight: verify bwrap can create user namespaces before proceeding.
        if bwrap::is_available()
            && let Err(diagnostic) = bwrap::can_create_user_namespace()
        {
            // The fix commands and the `SecurityOptions::disabled()` escape hatch
            // need a host shell — operator-only. The tenant gets one sentence.
            tracing::error!(
                "Sandbox preflight failed: bwrap cannot create user namespaces.\n{}\n\
                 To skip the sandbox (development only): SecurityOptions::disabled()",
                diagnostic.operator()
            );
            return Err(BoxliteError::Config(diagnostic.into_client()));
        }

        let cgroup_config = cgroup::CgroupConfig::from(ctx.resource_limits);

        match cgroup::setup_cgroup(ctx.id, &cgroup_config) {
            Ok(path) => {
                tracing::info!(id = %ctx.id, path = %path.display(), "Cgroup created");
            }
            Err(e) => {
                tracing::warn!(id = %ctx.id, error = %e,
                    "Cgroup setup failed (continuing without cgroup limits)");
            }
        }

        Ok(())
    }

    fn apply(&self, ctx: &SandboxContext, cmd: &mut Command) {
        let binary = cmd.get_program().to_owned();
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let shim_plan =
            crate::jailer::shim_cache::plan_bwrap_shim_mounts(std::path::Path::new(&binary));

        let mut bwrap_cmd = bwrap::BwrapCommand::new();

        // =====================================================================
        // Namespace and session isolation
        // =====================================================================
        bwrap_cmd.with_default_namespaces();
        // A detached box (`run -d`) must outlive the launching process: bwrap's
        // --die-with-parent (PR_SET_PDEATHSIG) would otherwise kill the shim/VM
        // the instant the launcher returns, so the box is born Stopped. Only
        // foreground boxes — which should die with their launcher — get it.
        if !ctx.detached {
            bwrap_cmd.with_die_with_parent();
        }
        bwrap_cmd.with_new_session();

        // =====================================================================
        // System directories (read-only)
        // =====================================================================
        bwrap_cmd
            .ro_bind_if_exists("/usr", "/usr")
            .ro_bind_if_exists("/lib", "/lib")
            .ro_bind_if_exists("/lib64", "/lib64")
            .ro_bind_if_exists("/bin", "/bin")
            .ro_bind_if_exists("/sbin", "/sbin")
            // DNS resolver config: gvproxy runs in this shim. It forwards the
            // guest's DNS queries to the host resolver, and it re-resolves
            // every `allow_net` hostname at connect time to decide where to
            // dial. Both read these, for the box's whole lifetime. Without
            // them the sandbox has no /etc/resolv.conf, every lookup fails,
            // and allow-listed hosts neither resolve nor connect — the
            // allowlist silently blocks everything whenever the jailer is
            // enabled (#645).
            .ro_bind_if_exists("/etc/resolv.conf", "/etc/resolv.conf")
            .ro_bind_if_exists("/etc/hosts", "/etc/hosts")
            .ro_bind_if_exists("/etc/nsswitch.conf", "/etc/nsswitch.conf");

        // =====================================================================
        // Devices and special mounts
        // =====================================================================
        bwrap_cmd
            .with_dev()
            .dev_bind_if_exists("/dev/kvm", "/dev/kvm")
            .dev_bind_if_exists("/dev/net/tun", "/dev/net/tun")
            .with_proc()
            .tmpfs("/tmp");

        // =====================================================================
        // Bind all pre-computed paths (system dirs + user volumes)
        // =====================================================================
        for pa in ctx.writable_paths() {
            bwrap_cmd.bind(&pa.path, &pa.path);
            tracing::debug!(path = %pa.path.display(), "bwrap: bind (rw)");
        }
        for pa in ctx.readonly_paths() {
            bwrap_cmd.ro_bind(&pa.path, &pa.path);
            tracing::debug!(path = %pa.path.display(), "bwrap: ro-bind");
        }
        for (src, dest) in &shim_plan.ro_binds {
            bwrap_cmd.ro_bind(src, dest);
            tracing::debug!(
                src = %src.display(),
                dest = %dest.display(),
                "bwrap: ro-bind shim runtime"
            );
        }

        // =====================================================================
        // Environment sanitization
        // =====================================================================
        // The statically-linked shim dlopen's libkrunfw via LD_LIBRARY_PATH (its
        // `$ORIGIN` rpath is ineffective), and `--clearenv` wipes it — without
        // this the VM fails to start ("Couldn't find or load libkrunfw.so.5",
        // libkrun status=-2). The staged shim and libkrunfw share a read-only
        // binding at `<home>/shims/<digest>`. When falling back to a symlinked
        // `runtime/` layout, resolved targets are mounted into a synthetic
        // read-only `/run/boxlite-shim` directory so symlinks do not dangle.
        bwrap_cmd
            .with_clearenv()
            .setenv("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .setenv("HOME", "/root")
            .setenv("LD_LIBRARY_PATH", shim_plan.ld_library_path.as_str());

        // Preserve debugging environment variables
        if let Ok(rust_log) = std::env::var("RUST_LOG") {
            bwrap_cmd.setenv("RUST_LOG", rust_log);
        }
        if let Ok(rust_backtrace) = std::env::var("RUST_BACKTRACE") {
            bwrap_cmd.setenv("RUST_BACKTRACE", rust_backtrace);
        }
        apply_thp_env(&mut bwrap_cmd, std::env::var_os("KRUN_USE_THP").as_deref());

        bwrap_cmd.chdir("/");

        // Replace the command with bwrap-wrapped version.
        *cmd = bwrap_cmd.build(&shim_plan.executable, &args);

        // Add cgroup join as a pre_exec hook (async-signal-safe).
        if let Some(cgroup_procs) = cgroup::build_cgroup_procs_path(ctx.id) {
            use std::os::unix::process::CommandExt;
            unsafe {
                cmd.pre_exec(move || {
                    let _ = cgroup::add_self_to_cgroup_raw(&cgroup_procs);
                    Ok(())
                });
            }
        }
    }

    fn name(&self) -> &'static str {
        "bwrap"
    }
}

/// Forward `KRUN_USE_THP=1` into the sanitized sandbox environment only when
/// explicitly enabled on the host, avoiding unvalidated values inside bwrap.
fn apply_thp_env(bwrap_cmd: &mut bwrap::BwrapCommand, krun_use_thp: Option<&std::ffi::OsStr>) {
    if krun_use_thp == Some(std::ffi::OsStr::new("1")) {
        bwrap_cmd.setenv("KRUN_USE_THP", "1");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::advanced_options::ResourceLimits;

    /// The shim is statically linked, so libkrun's `dlopen` of `libkrunfw.so.5`
    /// can only be satisfied via `LD_LIBRARY_PATH` inside the `--clearenv`
    /// sandbox — the shim's `$ORIGIN` rpath is absent and the inherited
    /// `LD_LIBRARY_PATH` is wiped by `--clearenv`. Without this the VM fails to
    /// start ("Couldn't find or load libkrunfw.so.5", libkrun status=-2). This
    /// guards the env var the composable `apply()` dropped relative to the
    /// legacy `build_shim_command`.
    #[test]
    fn apply_sets_ld_library_path_to_shim_dir() {
        if !bwrap::is_available() {
            eprintln!("skipping apply_sets_ld_library_path_to_shim_dir: bwrap not available");
            return;
        }

        let limits = Box::leak(Box::new(ResourceLimits::default()));
        let ctx = SandboxContext {
            id: "test-box",
            paths: vec![],
            unix_sockets: Default::default(),
            resource_limits: limits,
            network_enabled: false,
            sandbox_profile: None,
            shim_cache_dir: None,
            detached: false,
        };

        let shim = "/var/lib/boxlite/shims/0123456789abcdef/boxlite-shim";
        let mut cmd = Command::new(shim);
        BwrapSandbox::new().apply(&ctx, &mut cmd);

        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        let pos = args
            .windows(3)
            .position(|w| w[0] == "--setenv" && w[1] == "LD_LIBRARY_PATH")
            .expect("bwrap must --setenv LD_LIBRARY_PATH so the static shim can dlopen libkrunfw");
        assert_eq!(
            args[pos + 2],
            "/var/lib/boxlite/shims/0123456789abcdef",
            "LD_LIBRARY_PATH must point at the staged shim and firmware directory"
        );
    }

    /// A detached box must outlive the launcher, so it must NOT get bwrap's
    /// `--die-with-parent` (PR_SET_PDEATHSIG kills the shim/VM the instant
    /// `run -d` returns, leaving the box born-Stopped). Foreground boxes keep it
    /// so they die with their launcher.
    #[test]
    fn apply_sets_die_with_parent_only_for_foreground() {
        if !bwrap::is_available() {
            eprintln!(
                "skipping apply_sets_die_with_parent_only_for_foreground: bwrap not available"
            );
            return;
        }

        fn has_die_with_parent(detached: bool) -> bool {
            let limits = Box::leak(Box::new(ResourceLimits::default()));
            let ctx = SandboxContext {
                id: "test-box",
                paths: vec![],
                unix_sockets: Default::default(),
                resource_limits: limits,
                network_enabled: false,
                sandbox_profile: None,
                shim_cache_dir: None,
                detached,
            };
            let mut cmd = Command::new("/var/lib/boxlite/shims/0123456789abcdef/boxlite-shim");
            BwrapSandbox::new().apply(&ctx, &mut cmd);
            cmd.get_args().any(|a| a == "--die-with-parent")
        }

        assert!(
            has_die_with_parent(false),
            "foreground box must get --die-with-parent so it dies with its launcher"
        );
        assert!(
            !has_die_with_parent(true),
            "detached box must not get --die-with-parent or it is killed when run -d returns"
        );
    }

    #[test]
    fn apply_mounts_symlinked_runtime_into_synthetic_shim_dir() {
        use crate::jailer::sandbox::PathAccess;
        use crate::jailer::shim_cache::BWRAP_SANDBOX_SHIM_DIR;
        use std::os::unix::fs::{PermissionsExt, symlink};

        if !bwrap::is_available() {
            eprintln!(
                "skipping apply_mounts_symlinked_runtime_into_synthetic_shim_dir: bwrap not available"
            );
            return;
        }

        let root = tempfile::tempdir().unwrap();
        let target_dir = root.path().join("target/debug");
        let runtime_dir = target_dir.join("runtime");
        let build_out = target_dir.join("build/boxlite-hash/out/runtime");
        std::fs::create_dir_all(&runtime_dir).unwrap();
        std::fs::create_dir_all(&build_out).unwrap();

        let real_shim = target_dir.join("boxlite-shim");
        std::fs::write(
            &real_shim,
            "#!/bin/sh\nif [ \"$#\" -gt 0 ]; then\n  cat \"$1\"\nelse\n  printf '%s:' \"$LD_LIBRARY_PATH\"\n  cat /run/boxlite-shim/libkrunfw.so.5\nfi\n",
        )
        .unwrap();
        std::fs::set_permissions(&real_shim, std::fs::Permissions::from_mode(0o755)).unwrap();

        let real_fw = build_out.join("libkrunfw.so.5.4.0");
        std::fs::write(&real_fw, b"fw-ok").unwrap();
        let sibling = target_dir.join("sibling.txt");
        std::fs::write(&sibling, b"secret").unwrap();

        let runtime_shim = runtime_dir.join("boxlite-shim");
        let runtime_fw = runtime_dir.join("libkrunfw.so.5");
        symlink("../boxlite-shim", &runtime_shim).unwrap();
        symlink(
            "../build/boxlite-hash/out/runtime/libkrunfw.so.5.4.0",
            &runtime_fw,
        )
        .unwrap();

        let canonical_shim = real_shim.canonicalize().unwrap();
        let canonical_fw = real_fw.canonicalize().unwrap();
        let limits = Box::leak(Box::new(ResourceLimits::default()));
        let ctx = SandboxContext {
            id: "test-box",
            paths: vec![
                PathAccess {
                    path: runtime_dir.clone(),
                    writable: false,
                },
                PathAccess {
                    path: canonical_shim.clone(),
                    writable: false,
                },
                PathAccess {
                    path: canonical_fw.clone(),
                    writable: false,
                },
            ],
            unix_sockets: Default::default(),
            resource_limits: limits,
            network_enabled: false,
            sandbox_profile: None,
            shim_cache_dir: None,
            detached: true,
        };

        let mut cmd = Command::new(&runtime_shim);
        BwrapSandbox::new().apply(&ctx, &mut cmd);

        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let expected_shim_dest = format!("{BWRAP_SANDBOX_SHIM_DIR}/boxlite-shim");
        let expected_fw_dest = format!("{BWRAP_SANDBOX_SHIM_DIR}/libkrunfw.so.5");
        let expected_ld = format!("{BWRAP_SANDBOX_SHIM_DIR}:{}", runtime_dir.display());
        assert!(args.windows(3).any(|w| {
            w[0] == "--ro-bind"
                && w[1] == canonical_shim.to_string_lossy()
                && w[2] == expected_shim_dest
        }));
        assert!(args.windows(3).any(|w| {
            w[0] == "--ro-bind"
                && w[1] == canonical_fw.to_string_lossy()
                && w[2] == expected_fw_dest
        }));
        assert!(
            args.windows(3)
                .any(|w| w[0] == "--setenv" && w[1] == "LD_LIBRARY_PATH" && w[2] == expected_ld)
        );
        assert_eq!(
            args.last().map(String::as_str),
            Some(expected_shim_dest.as_str())
        );

        if bwrap::can_create_user_namespace().is_ok() {
            let output = cmd.output().expect("execute bwrap symlinked runtime shim");
            assert!(
                output.status.success(),
                "bwrap execution failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                String::from_utf8_lossy(&output.stdout),
                format!("{expected_ld}:fw-ok")
            );

            let mut sibling_cmd = Command::new(&runtime_shim);
            sibling_cmd.arg(&sibling);
            BwrapSandbox::new().apply(&ctx, &mut sibling_cmd);
            let sibling_out = sibling_cmd.output().expect("execute sibling probe");
            assert!(!sibling_out.status.success());
            assert!(sibling_out.stdout.is_empty());
        }
    }

    #[test]
    fn apply_thp_env_forwards_only_explicit_one() {
        use std::ffi::OsStr;

        let build_args = |val: Option<&OsStr>| -> Vec<String> {
            let mut bwrap_cmd = bwrap::BwrapCommand::new();
            apply_thp_env(&mut bwrap_cmd, val);
            bwrap_cmd.get_args().to_vec()
        };

        let enabled_args = build_args(Some(OsStr::new("1")));
        assert!(
            enabled_args
                .windows(3)
                .any(|w| w[0] == "--setenv" && w[1] == "KRUN_USE_THP" && w[2] == "1")
        );

        for disabled in [
            None,
            Some(OsStr::new("")),
            Some(OsStr::new("0")),
            Some(OsStr::new("true")),
        ] {
            let args = build_args(disabled);
            assert!(
                !args
                    .windows(2)
                    .any(|w| w[0] == "--setenv" && w[1] == "KRUN_USE_THP"),
                "unexpected KRUN_USE_THP for {disabled:?}"
            );
        }
    }
}
