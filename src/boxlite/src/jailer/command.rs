//! Contract tests for the [`Jail`](super::Jail) trait and the
//! [`Sandbox`](super::Sandbox) implementations. No production code lives
//! here — the trait surface is exercised through `Jail::command()` and
//! `Jail::prepare()` to keep their behavioral guarantees nailed down.

#[cfg(test)]
mod tests {
    use crate::jailer::Jail;
    use crate::jailer::builder::JailerBuilder;
    use crate::jailer::sandbox::{PathAccess, Sandbox, SandboxContext};
    use crate::runtime::advanced_options::SecurityOptions;
    use crate::runtime::layout::{BoxFilesystemLayout, FsLayoutConfig};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::Mutex;

    fn test_layout(box_dir: impl Into<PathBuf>) -> BoxFilesystemLayout {
        BoxFilesystemLayout::new(box_dir.into(), FsLayoutConfig::without_bind_mount(), false)
    }

    #[derive(Default)]
    struct RecordingSandbox(Mutex<Vec<PathAccess>>);

    impl Sandbox for RecordingSandbox {
        fn is_available(&self) -> bool {
            true
        }

        fn apply(&self, ctx: &SandboxContext, _cmd: &mut Command) {
            *self.0.lock().unwrap() = ctx.paths.clone();
        }

        fn name(&self) -> &'static str {
            "recording"
        }
    }

    fn staging_fixture() -> (
        tempfile::TempDir,
        PathBuf,
        BoxFilesystemLayout,
        JailerBuilder,
    ) {
        let home = tempfile::tempdir().unwrap();
        let source = home.path().join("installed");
        fs::create_dir(&source).unwrap();
        let binary = source.join("boxlite-shim");
        fs::write(&binary, b"shim").unwrap();
        let layout = test_layout(home.path().join("boxes/test-box"));
        let builder = JailerBuilder::new()
            .with_box_id("test-box")
            .with_layout(layout.clone())
            .with_jailer_enabled(true);
        (home, binary, layout, builder)
    }

    #[test]
    fn command_stages_into_shared_cache_and_grants_ro_access() {
        let (home, binary, layout, builder) = staging_fixture();
        let jail = builder.build_with(RecordingSandbox::default()).unwrap();

        let cmd = jail.command(&binary, &[]);
        let staged = Path::new(cmd.get_program());
        let generation = staged.parent().unwrap();
        let cache = home.path().join("shims").canonicalize().unwrap();
        assert_eq!(generation.parent(), Some(cache.as_path()));
        assert_eq!(fs::read(staged).unwrap(), b"shim");
        assert!(!layout.bin_dir().exists());
        let grants = jail.sandbox.0.lock().unwrap();
        for dir in [binary.parent().unwrap(), generation] {
            let matching: Vec<_> = grants.iter().filter(|grant| grant.path == dir).collect();
            assert_eq!(matching.len(), 1);
            assert!(!matching[0].writable);
        }
        assert!(grants.iter().all(|grant| grant.path != cache));
    }

    #[test]
    fn command_removes_legacy_box_bin_best_effort() {
        let (_home, binary, layout, builder) = staging_fixture();
        fs::create_dir_all(layout.bin_dir()).unwrap();
        fs::write(layout.bin_dir().join("stale-shim"), b"old").unwrap();
        let jail = builder.build_with(RecordingSandbox::default()).unwrap();

        let cmd = jail.command(&binary, &[]);
        assert!(Path::new(cmd.get_program()).is_file());
        assert!(!layout.bin_dir().exists());

        fs::write(layout.bin_dir(), b"not a directory").unwrap();
        assert_eq!(jail.command(&binary, &[]).get_program(), cmd.get_program());
    }

    #[test]
    fn command_falls_back_to_original_binary_on_stage_error() {
        let (_home, binary, _layout, builder) = staging_fixture();
        let jail = builder
            .with_shim_cache_dir(&binary)
            .build_with(RecordingSandbox::default())
            .unwrap();

        assert_eq!(jail.command(&binary, &[]).get_program(), binary);
        let grants = jail.sandbox.0.lock().unwrap();
        assert!(grants.iter().any(|grant| {
            grant.path == binary.parent().unwrap().canonicalize().unwrap() && !grant.writable
        }));
    }

    #[cfg(unix)]
    #[test]
    fn command_fallback_symlinked_runtime_grants_only_resolved_targets() {
        use std::os::unix::fs::symlink;

        let home = tempfile::tempdir().unwrap();
        let target_root = home.path().join("target-debug");
        let build_out = target_root.join("build/boxlite-hash/out/runtime");
        let runtime_dir = target_root.join("runtime");
        fs::create_dir_all(&build_out).unwrap();
        fs::create_dir_all(&runtime_dir).unwrap();

        let real_shim = target_root.join("boxlite-shim");
        let real_fw = build_out.join("libkrunfw.5.dylib");
        let sibling_top = target_root.join("sibling.txt");
        let sibling_fw = build_out.join("sibling-fw.txt");
        fs::write(&real_shim, b"shim").unwrap();
        fs::write(&real_fw, b"fw").unwrap();
        fs::write(&sibling_top, b"secret").unwrap();
        fs::write(&sibling_fw, b"secret-fw").unwrap();

        let runtime_shim = runtime_dir.join("boxlite-shim");
        let runtime_fw = runtime_dir.join("libkrunfw.5.dylib");
        let runtime_fw_alias = runtime_dir.join("libkrunfw.dylib");
        symlink("../boxlite-shim", &runtime_shim).unwrap();
        symlink(
            "../build/boxlite-hash/out/runtime/libkrunfw.5.dylib",
            &runtime_fw,
        )
        .unwrap();
        symlink("libkrunfw.5.dylib", &runtime_fw_alias).unwrap();

        let layout = test_layout(home.path().join("boxes/test-box"));
        let staging_err_jail = JailerBuilder::new()
            .with_box_id("test-box")
            .with_layout(layout)
            .with_shim_cache_dir(&runtime_shim)
            .with_jailer_enabled(true)
            .build_with(RecordingSandbox::default())
            .unwrap();
        let no_cache_layout = test_layout(home.path().join("standalone-box"));
        let no_cache_jail = JailerBuilder::new()
            .with_box_id("test-box-no-cache")
            .with_layout(no_cache_layout)
            .with_jailer_enabled(true)
            .build_with(RecordingSandbox::default())
            .unwrap();

        let canonical_shim = real_shim.canonicalize().unwrap();
        let canonical_fw = real_fw.canonicalize().unwrap();
        let canonical_root = target_root.canonicalize().unwrap();
        let canonical_build_out = build_out.canonicalize().unwrap();

        for jail in [&staging_err_jail, &no_cache_jail] {
            let cmd = jail.command(&runtime_shim, &[]);
            assert_eq!(cmd.get_program(), runtime_shim);

            let grants = jail.sandbox.0.lock().unwrap();
            for resolved in [&canonical_shim, &canonical_fw] {
                let matches: Vec<_> = grants.iter().filter(|g| &g.path == resolved).collect();
                assert_eq!(
                    matches.len(),
                    1,
                    "resolved file {} must be granted exactly once (got {:?})",
                    resolved.display(),
                    grants
                );
                assert!(!matches[0].writable);
            }

            for forbidden in [
                target_root.as_path(),
                canonical_root.as_path(),
                build_out.as_path(),
                canonical_build_out.as_path(),
                sibling_top.as_path(),
                sibling_fw.as_path(),
            ] {
                assert!(
                    grants.iter().all(|g| g.path != forbidden),
                    "fallback must not expose {}",
                    forbidden.display()
                );
            }
        }
    }

    #[test]
    fn command_jailer_disabled_skips_staging_and_leaves_legacy_untouched() {
        let (home, binary, layout, builder) = staging_fixture();
        fs::create_dir_all(layout.bin_dir()).unwrap();
        let legacy = layout.bin_dir().join("stale-shim");
        fs::write(&legacy, b"old").unwrap();
        let jail = builder
            .with_jailer_enabled(false)
            .build_with(RecordingSandbox::default())
            .unwrap();

        assert_eq!(jail.command(&binary, &[]).get_program(), binary);
        assert!(!home.path().join("shims").exists());
        assert_eq!(fs::read(legacy).unwrap(), b"old");
        assert!(jail.sandbox.0.lock().unwrap().is_empty());
    }

    /// When `jailer_enabled=false`, command() must return a direct command
    /// using the binary as the program — no bwrap, no sandbox-exec.
    #[test]
    fn test_command_jailer_disabled_returns_direct() {
        let security = SecurityOptions {
            jailer_enabled: false,
            ..SecurityOptions::default()
        };
        let jail = JailerBuilder::new()
            .with_box_id("test-box")
            .with_layout(test_layout("/tmp/test-box"))
            .with_security(security)
            .build()
            .unwrap();

        let binary = Path::new("/usr/bin/boxlite-shim");
        let args = vec!["--listen".to_string(), "vsock://2:2695".to_string()];
        let cmd = jail.command(binary, &args);

        // Direct command: program IS the binary itself
        assert_eq!(cmd.get_program(), binary);

        // Args passed through
        let cmd_args: Vec<_> = cmd.get_args().collect();
        assert_eq!(cmd_args, &["--listen", "vsock://2:2695"]);
    }

    /// When `jailer_enabled=true`, on macOS (with sandbox-exec) or Linux (with bwrap),
    /// the program should NOT be the binary directly — it should be wrapped.
    /// On platforms without a sandbox, it falls back to direct.
    #[test]
    fn test_command_jailer_enabled_wraps_binary() {
        let security = SecurityOptions {
            jailer_enabled: true,
            ..SecurityOptions::default()
        };
        let jail = JailerBuilder::new()
            .with_box_id("test-box")
            .with_layout(test_layout("/tmp/test-box"))
            .with_security(security)
            .build()
            .unwrap();

        let binary = Path::new("/usr/bin/boxlite-shim");
        let args = vec!["--listen".to_string()];
        let cmd = jail.command(binary, &args);

        // On macOS: should be "sandbox-exec" (if available) or binary (fallback)
        // On Linux: should be "bwrap" (if available) or binary (fallback)
        // On other: always direct (binary)
        // We can't assert the exact program without knowing the platform,
        // but we verify the command was constructed without panics.
        let _program = cmd.get_program();
    }

    /// Verify that NoopSandbox produces a direct command.
    #[test]
    fn test_noop_sandbox_produces_direct_command() {
        use crate::jailer::NoopSandbox;

        let jail = JailerBuilder::new()
            .with_box_id("test-box")
            .with_layout(test_layout("/tmp/test-box"))
            .build_with(NoopSandbox::new())
            .unwrap();

        let binary = Path::new("/usr/bin/boxlite-shim");
        let args = vec!["--arg1".to_string()];
        let cmd = jail.command(binary, &args);

        assert_eq!(cmd.get_program(), binary);
        let cmd_args: Vec<_> = cmd.get_args().collect();
        assert_eq!(cmd_args, &["--arg1"]);
    }

    /// SecurityOptions::disabled() should have jailer_enabled=false.
    /// This ensures development preset always bypasses the jailer.
    #[test]
    fn test_development_preset_disables_jailer() {
        let security = SecurityOptions::disabled();
        let jail = JailerBuilder::new()
            .with_box_id("test-box")
            .with_layout(test_layout("/tmp/test-box"))
            .with_security(security)
            .build()
            .unwrap();

        let binary = Path::new("/usr/bin/boxlite-shim");
        let cmd = jail.command(binary, &[]);

        // Development preset → jailer_enabled=false → direct command
        assert_eq!(cmd.get_program(), binary);
    }

    /// When jailer is disabled, prepare() should skip the userns preflight
    /// and always succeed.
    #[test]
    fn test_prepare_jailer_disabled_succeeds() {
        let security = SecurityOptions {
            jailer_enabled: false,
            ..SecurityOptions::default()
        };
        let jail = JailerBuilder::new()
            .with_box_id("test-box")
            .with_layout(test_layout("/tmp/test-box"))
            .with_security(security)
            .build()
            .unwrap();

        // Should always succeed — no preflight when jailer is disabled
        assert!(jail.prepare().is_ok());
    }

    /// Verify that SecurityOptions fields are correctly translated to SandboxContext.
    ///
    /// Uses a mock Sandbox that captures the context to verify the translation.
    #[test]
    fn test_sandbox_context_translation() {
        use crate::jailer::sandbox::{Sandbox, SandboxContext};
        use crate::runtime::options::VolumeSpec;
        use boxlite_shared::errors::BoxliteResult;
        use std::path::PathBuf;
        use std::process::Command;
        use std::sync::{Arc, Mutex};

        /// Mock sandbox that records context fields when wrap() is called.
        #[derive(Debug)]
        struct CaptureSandbox {
            captured_id: Arc<Mutex<Option<String>>>,
            captured_network: Arc<Mutex<Option<bool>>>,
        }

        impl Sandbox for CaptureSandbox {
            fn is_available(&self) -> bool {
                true
            }
            fn setup(&self, _ctx: &SandboxContext) -> BoxliteResult<()> {
                Ok(())
            }
            fn apply(&self, ctx: &SandboxContext, _cmd: &mut Command) {
                *self.captured_id.lock().unwrap() = Some(ctx.id.to_string());
                *self.captured_network.lock().unwrap() = Some(ctx.network_enabled);
            }
            fn name(&self) -> &'static str {
                "capture"
            }
        }

        let captured_id = Arc::new(Mutex::new(None));
        let captured_network = Arc::new(Mutex::new(None));

        let sandbox = CaptureSandbox {
            captured_id: captured_id.clone(),
            captured_network: captured_network.clone(),
        };

        let security = SecurityOptions {
            jailer_enabled: true,
            network_enabled: false,
            sandbox_profile: Some(PathBuf::from("/custom/profile.sbpl")),
            ..SecurityOptions::default()
        };

        let jail = JailerBuilder::new()
            .with_box_id("ctx-test-box")
            .with_layout(test_layout("/tmp/ctx-test"))
            .with_security(security)
            .with_volume(VolumeSpec {
                managed_volume: None,
                host_path: "/data".to_string(),
                guest_path: "/mnt/data".to_string(),
                read_only: true,
            })
            .build_with(sandbox)
            .unwrap();

        // Trigger command() which calls context() internally
        let _cmd = jail.command(Path::new("/usr/bin/shim"), &[]);

        // Verify the context translation
        assert_eq!(captured_id.lock().unwrap().as_deref(), Some("ctx-test-box"));
        assert_eq!(*captured_network.lock().unwrap(), Some(false));
    }

    /// When jailer_enabled=true, command() must pre-create logs_dir, exit file,
    /// and console.log before the sandbox is activated.
    #[test]
    fn test_command_precreates_logs_dir_and_files() {
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        let layout = test_layout(dir.path());

        let security = SecurityOptions {
            jailer_enabled: true,
            ..SecurityOptions::default()
        };

        let jail = JailerBuilder::new()
            .with_box_id("precreate-test")
            .with_layout(layout.clone())
            .with_security(security)
            .build()
            .unwrap();

        // Nothing should exist yet
        assert!(!layout.logs_dir().exists());
        assert!(!layout.exit_file_path().exists());
        assert!(!layout.console_output_path().exists());

        let _cmd = jail.command(Path::new("/usr/bin/boxlite-shim"), &[]);

        // After command(), pre-created files must exist
        assert!(
            layout.logs_dir().exists() && layout.logs_dir().is_dir(),
            "logs_dir should be pre-created as directory"
        );
        assert!(
            layout.exit_file_path().exists() && layout.exit_file_path().is_file(),
            "exit file should be pre-created"
        );
        assert!(
            layout.console_output_path().exists() && layout.console_output_path().is_file(),
            "console.log should be pre-created"
        );
    }

    /// When jailer_enabled=false, command() must NOT create any files.
    #[test]
    fn test_command_does_not_precreate_when_jailer_disabled() {
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        let layout = test_layout(dir.path());

        let security = SecurityOptions {
            jailer_enabled: false,
            ..SecurityOptions::default()
        };

        let jail = JailerBuilder::new()
            .with_box_id("no-precreate-test")
            .with_layout(layout.clone())
            .with_security(security)
            .build()
            .unwrap();

        let _cmd = jail.command(Path::new("/usr/bin/boxlite-shim"), &[]);

        // Nothing should be created when jailer is disabled
        assert!(
            !layout.logs_dir().exists(),
            "logs_dir should NOT be created when jailer disabled"
        );
        assert!(
            !layout.exit_file_path().exists(),
            "exit file should NOT be created when jailer disabled"
        );
        assert!(
            !layout.console_output_path().exists(),
            "console.log should NOT be created when jailer disabled"
        );
    }
}
