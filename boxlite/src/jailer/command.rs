//! Command building for isolated process execution.
//!
//! **Deprecated**: This module's logic has moved to the [`Jail`](super::Jail)
//! trait and [`Sandbox`](super::Sandbox) implementations. This file exists
//! only for tests that verify the `Jail` trait contract.

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
            fn wrap(&self, ctx: &SandboxContext, binary: &Path, args: &[String]) -> Command {
                *self.captured_id.lock().unwrap() = Some(ctx.id.to_string());
                *self.captured_network.lock().unwrap() = Some(ctx.network_enabled);
                let mut cmd = Command::new(binary);
                cmd.args(args);
                cmd
            }
            fn cgroup_procs_path(&self, _ctx: &SandboxContext) -> Option<std::ffi::CString> {
                None
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
