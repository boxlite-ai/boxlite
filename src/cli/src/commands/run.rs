use crate::cli::{
    GlobalFlags, ManagementFlags, NetworkFlags, ProcessFlags, PublishFlags, ResourceFlags,
    VolumeFlags,
};
use crate::terminal::StreamManager;
use crate::util::to_shell_exit_code;
use boxlite::{BoxOptions, BoxliteRuntime, LiteBox, RootfsSpec};
use clap::Args;
use std::io::{self, IsTerminal};

#[derive(Args, Debug)]
pub struct RunArgs {
    #[command(flatten)]
    pub process: ProcessFlags,

    #[command(flatten)]
    pub resource: ResourceFlags,

    #[command(flatten)]
    pub publish: PublishFlags,

    #[command(flatten)]
    pub volume: VolumeFlags,

    #[command(flatten)]
    pub network: NetworkFlags,

    #[command(flatten)]
    pub management: ManagementFlags,

    /// Path to an already prepared rootfs
    #[arg(long = "rootfs", value_name = "PATH")]
    pub rootfs: Option<String>,

    /// Image and command, or command only when --rootfs is set
    #[arg(index = 1, trailing_var_arg = true, value_name = "IMAGE|COMMAND")]
    pub args: Vec<String>,
}

/// Entry point.
///
/// Returns the shell exit code the CLI should exit with (0 on success, the
/// box's mapped exit code on a non-zero command exit). Returning the code —
/// instead of calling `std::process::exit` mid-function — lets `BoxRunner`
/// (and the `BoxliteRuntime` it owns) drop normally, so `RuntimeImpl::Drop`
/// runs `shutdown_sync()` and stops the box's shim on every return path.
/// `std::process::exit` would bypass that Drop chain and leak the shim (#622).
pub async fn execute(args: RunArgs, global: &GlobalFlags) -> anyhow::Result<i32> {
    let (rootfs, command_args) = args.rootfs_and_command()?;
    let command_args = command_args.to_vec();
    let mut runner = BoxRunner::new(args, global)?;
    runner.run(rootfs, command_args).await
}

struct BoxRunner {
    args: RunArgs,
    rt: BoxliteRuntime,
    home: Option<std::path::PathBuf>,
}

impl BoxRunner {
    fn new(args: RunArgs, global: &GlobalFlags) -> anyhow::Result<Self> {
        let rt = global.create_runtime()?;
        let home = global.home.clone();

        Ok(Self { args, rt, home })
    }

    async fn run(&mut self, rootfs: RootfsSpec, command_args: Vec<String>) -> anyhow::Result<i32> {
        // Validate flags and environment
        self.validate_flags()?;

        // COMMAND becomes the container's init (docker semantics — it replaces
        // the image CMD via options.cmd in create_box), so there is nothing to
        // spawn here: attach to the init session instead.
        let litebox = self.create_box(rootfs, &command_args).await?;

        // Detach mode: start it and get out of the way. Nobody is reading the
        // output, so there is nothing to be attached for.
        if self.args.management.detach {
            litebox.start().await?;
            println!("{}", litebox.id());
            return Ok(0);
        }

        // Keep the execution handle inside this scope so its local stream or
        // remote WebSocket is dropped before an explicit `--rm` deletion.
        let run_result: anyhow::Result<i32> = async {
            // Foreground: attach *before* the command runs, then start it.
            // Starting first races it — `run alpine echo hi` can finish before
            // the attach lands, and its output and exit code die with the VM.
            // Attaching only creates the container; `start()` runs its init.
            let mut execution = litebox.attach(None).await?;
            litebox.start().await?;

            // --tty implies --interactive when stdin is a terminal
            // (validate_flags already ensures stdin is a terminal when --tty is set)
            if self.args.process.tty {
                self.args.process.interactive = true;
            }

            // IO streaming and signal handling via shared StreamManager
            let streamer = StreamManager::new(
                &mut execution,
                self.args.process.interactive,
                self.args.process.tty,
            );

            let exit_code = streamer.start().await?;
            Ok(to_shell_exit_code(exit_code))
        }
        .await;

        if self.args.management.rm {
            // The stream can finish just before the box watcher persists
            // Stopped. Force removal makes `--rm` deterministic across local
            // and REST runtimes without turning it into an AutoDelete timer.
            let box_id = litebox.id().to_string();
            if let Err(remove_error) = self.rt.remove(&box_id, true).await {
                // A successful command must report failed cleanup. For a
                // non-zero command or a run error, preserve the primary result
                // and surface cleanup failure as a warning.
                if matches!(&run_result, Ok(0)) {
                    return Err(anyhow::anyhow!(
                        "failed to remove box {box_id} after run: {remove_error}"
                    ));
                }
                tracing::warn!(
                    box_id,
                    error = %remove_error,
                    "Failed to remove box after unsuccessful run"
                );
            }
        }

        // Returning (vs. calling `std::process::exit` here) lets `litebox` and
        // the owning `BoxliteRuntime` drop normally, so `RuntimeImpl::Drop`
        // runs `shutdown_sync()` on every path. `std::process::exit` bypasses
        // Drop entirely and leaked the shim on the non-zero path (#622).
        run_result
    }

    async fn create_box(
        &self,
        rootfs: RootfsSpec,
        command_args: &[String],
    ) -> anyhow::Result<LiteBox> {
        let mut options = BoxOptions::default();
        self.args.resource.apply_to(&mut options);
        self.args.management.apply_to(&mut options)?;
        self.args.publish.apply_to(&mut options)?;
        self.args
            .volume
            .apply_to(&mut options, self.home.as_deref())?;
        self.args.network.apply_to(&mut options)?;
        self.args.process.apply_to(&mut options)?;

        // Docker semantics: the user COMMAND replaces the image CMD (the image
        // ENTRYPOINT is preserved and prepended) and the result runs as the
        // container's init. No COMMAND → the image default runs.
        if !command_args.is_empty() {
            options.cmd = Some(command_args.to_vec());
        }

        options.rootfs = rootfs;

        let litebox = self
            .rt
            .create(options, self.args.management.name.clone())
            .await?;

        Ok(litebox)
    }

    fn validate_flags(&self) -> anyhow::Result<()> {
        // Check TTY availability if requested
        if self.args.process.tty && !io::stdin().is_terminal() {
            anyhow::bail!("the input device is not a TTY.");
        }

        Ok(())
    }
}

impl RunArgs {
    fn rootfs_and_command(&self) -> anyhow::Result<(RootfsSpec, &[String])> {
        resolve_rootfs_and_command(self.rootfs.as_deref(), &self.args)
    }
}

fn resolve_rootfs_and_command<'a>(
    rootfs: Option<&str>,
    args: &'a [String],
) -> anyhow::Result<(RootfsSpec, &'a [String])> {
    if let Some(path) = rootfs {
        return Ok((RootfsSpec::RootfsPath(path.to_string()), args));
    }

    let Some((image, command)) = args.split_first() else {
        anyhow::bail!("provide IMAGE or --rootfs PATH");
    };

    Ok((RootfsSpec::Image(image.clone()), command))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Commands};
    use clap::Parser;

    #[test]
    fn run_rootfs_flag_sets_rootfs_path_and_uses_trailing_command() {
        let cli = Cli::try_parse_from(["boxlite", "run", "--rootfs", "/tmp/rootfs", "echo", "hi"])
            .expect("run --rootfs should parse");
        let Commands::Run(args) = cli.command else {
            panic!("expected run command");
        };

        let (rootfs, command) = args
            .rootfs_and_command()
            .expect("rootfs command should resolve");

        match rootfs {
            RootfsSpec::RootfsPath(path) => assert_eq!(path, "/tmp/rootfs"),
            other => panic!("expected RootfsPath, got {other:?}"),
        }
        assert_eq!(command, &["echo".to_string(), "hi".to_string()]);
    }

    #[test]
    fn run_rootfs_without_command_leaves_command_empty() {
        let cli = Cli::try_parse_from(["boxlite", "run", "--rootfs", "/tmp/rootfs"])
            .expect("run --rootfs should parse");
        let Commands::Run(args) = cli.command else {
            panic!("expected run command");
        };

        let (rootfs, command) = args
            .rootfs_and_command()
            .expect("rootfs command should resolve");

        match rootfs {
            RootfsSpec::RootfsPath(path) => assert_eq!(path, "/tmp/rootfs"),
            other => panic!("expected RootfsPath, got {other:?}"),
        }
        // No COMMAND → empty; the image/rootfs default init runs (docker
        // semantics), rather than the CLI forcing a shell.
        assert!(command.is_empty());
    }

    #[test]
    fn run_without_rootfs_preserves_image_and_command() {
        let cli = Cli::try_parse_from(["boxlite", "run", "alpine:latest", "echo", "hi"])
            .expect("run image command should parse");
        let Commands::Run(args) = cli.command else {
            panic!("expected run command");
        };

        let (rootfs, command) = args
            .rootfs_and_command()
            .expect("image command should resolve");

        match rootfs {
            RootfsSpec::Image(image) => assert_eq!(image, "alpine:latest"),
            other => panic!("expected Image, got {other:?}"),
        }
        assert_eq!(command, &["echo".to_string(), "hi".to_string()]);
    }

    #[test]
    fn run_requires_image_or_rootfs() {
        let cli = Cli::try_parse_from(["boxlite", "run"]).expect("run should parse");
        let Commands::Run(args) = cli.command else {
            panic!("expected run command");
        };

        let err = args
            .rootfs_and_command()
            .expect_err("missing source must be rejected");

        assert!(err.to_string().contains("IMAGE or --rootfs"));
    }
}
