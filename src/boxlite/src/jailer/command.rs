//! Contract tests for the [`Jail`](super::Jail) trait and the
//! [`Sandbox`](super::Sandbox) implementations. No production code lives
//! here — the trait surface is exercised through `Jail::command()` and
//! `Jail::prepare()` to keep their behavioral guarantees nailed down.

#[cfg(test)]
mod tests {
    use crate::jailer::Jail;
    use crate::jailer::builder::JailerBuilder;
    use crate::runtime::advanced_options::SecurityOptions;
    use crate::runtime::layout::{BoxFilesystemLayout, FsLayoutConfig};
    use std::path::{Path, PathBuf};

    fn test_layout(box_dir: impl Into<PathBuf>) -> BoxFilesystemLayout {
        BoxFilesystemLayout::new(box_dir.into(), FsLayoutConfig::without_bind_mount(), false)
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
        let cmd = jail.command(binary, &args).unwrap();

        // Direct command: program IS the binary itself
        assert_eq!(cmd.get_program(), binary);

        // Args passed through
        let cmd_args: Vec<_> = cmd.get_args().collect();
        assert_eq!(cmd_args, &["--listen", "vsock://2:2695"]);
    }

    /// When `jailer_enabled=true`, command() succeeds only when the platform sandbox
    /// is available. On platforms where bwrap/sandbox-exec is present, the binary
    /// is wrapped. On platforms without any sandbox, command() returns an error —
    /// failing open is not an option when isolation was requested.
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
        let result = jail.command(binary, &args);

        // On Linux/macOS (where bwrap/sandbox-exec is available): command succeeds.
        // On other platforms (no sandbox): command returns an error rather than
        // falling back silently to an un-isolated direct command.
        if jail.sandbox_available() {
            assert!(result.is_ok(), "Expected Ok when sandbox is available");
        } else {
            assert!(
                result.is_err(),
                "Expected Err when sandbox is unavailable and jailer_enabled=true"
            );
        }
    }

    /// Verify that NoopSandbox with jailer disabled produces a direct command.
    /// NoopSandbox.is_available() is always false; when jailer_enabled=false the
    /// availability check is skipped and the direct command is returned as expected.
    #[test]
    fn test_noop_sandbox_produces_direct_command() {
        use crate::jailer::NoopSandbox;
        use crate::runtime::advanced_options::SecurityOptions;

        // Explicitly disable the jailer so the NoopSandbox availability check is skipped.
        let security = SecurityOptions {
            jailer_enabled: false,
            ..SecurityOptions::default()
        };

        let jail = JailerBuilder::new()
            .with_box_id("test-box")
            .with_layout(test_layout("/tmp/test-box"))
            .with_security(security)
            .build_with(NoopSandbox::new())
            .unwrap();

        let binary = Path::new("/usr/bin/boxlite-shim");
        let args = vec!["--arg1".to_string()];
        // jailer_enabled=false → availability not checked → Ok(direct command)
        let cmd = jail.command(binary, &args).unwrap();

        assert_eq!(cmd.get_program(), binary);
        let cmd_args: Vec<_> = cmd.get_args().collect();
        assert_eq!(cmd_args, &["--arg1"]);
    }

    /// SecurityOptions::development() should have jailer_enabled=false.
    /// This ensures development preset always bypasses the jailer.
    #[test]
    fn test_development_preset_disables_jailer() {
        let security = SecurityOptions::development();
        let jail = JailerBuilder::new()
            .with_box_id("test-box")
            .with_layout(test_layout("/tmp/test-box"))
            .with_security(security)
            .build()
            .unwrap();

        let binary = Path::new("/usr/bin/boxlite-shim");
        // jailer_enabled=false → no sandbox check → always succeeds
        let cmd = jail.command(binary, &[]).unwrap();

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
                host_path: "/data".to_string(),
                guest_path: "/mnt/data".to_string(),
                read_only: true,
            })
            .build_with(sandbox)
            .unwrap();

        // Trigger command() which calls context() internally.
        // CaptureSandbox.is_available() returns true, so this must succeed.
        let _cmd = jail.command(Path::new("/usr/bin/shim"), &[]).unwrap();

        // Verify the context translation
        assert_eq!(captured_id.lock().unwrap().as_deref(), Some("ctx-test-box"));
        assert_eq!(*captured_network.lock().unwrap(), Some(false));
    }

    /// When jailer_enabled=true and the platform sandbox is available, command() must
    /// pre-create logs_dir, exit file, and console.log before the sandbox is activated.
    /// When the sandbox is unavailable, command() returns Err and no files are created.
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

        let result = jail.command(Path::new("/usr/bin/boxlite-shim"), &[]);

        if jail.sandbox_available() {
            // Sandbox available: command succeeds and must pre-create files.
            assert!(result.is_ok(), "Expected Ok when sandbox is available");
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
        } else {
            // Sandbox unavailable: command must fail closed (no silent bypass).
            assert!(
                result.is_err(),
                "Expected Err when jailer_enabled=true but sandbox is unavailable"
            );
        }
    }

    /// When jailer_enabled=true and the sandbox is unavailable, command() must return
    /// an error rather than silently running the process without isolation.
    #[test]
    fn test_command_fails_closed_when_jailer_enabled_sandbox_unavailable() {
        use crate::jailer::NoopSandbox;

        // NoopSandbox.is_available() always returns false — simulates a runner
        // where bwrap/sandbox-exec is missing. With jailer_enabled=true the
        // policy service has stored and promised isolation; running without it
        // is a silent security bypass. command() must refuse.
        let security = SecurityOptions {
            jailer_enabled: true,
            ..SecurityOptions::default()
        };
        let jail = JailerBuilder::new()
            .with_box_id("fail-closed-test")
            .with_layout(test_layout("/tmp/fail-closed"))
            .with_security(security)
            .build_with(NoopSandbox::new())
            .unwrap();

        let result = jail.command(Path::new("/usr/bin/boxlite-shim"), &[]);
        assert!(
            result.is_err(),
            "command() must fail closed when jailer_enabled=true and sandbox is unavailable"
        );
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("noop") || err_msg.contains("not available"),
            "error message should identify the unavailable sandbox: {err_msg}"
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

        // jailer_enabled=false → no sandbox check → always succeeds
        let _cmd = jail
            .command(Path::new("/usr/bin/boxlite-shim"), &[])
            .unwrap();

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
