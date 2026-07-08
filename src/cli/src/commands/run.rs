use crate::cli::{
    GlobalFlags, ManagementFlags, NetworkFlags, ProcessFlags, PublishFlags, ResourceFlags,
    VolumeFlags,
};
use crate::terminal::StreamManager;
use crate::util::to_shell_exit_code;
use boxlite::BoxCommand;
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

        let litebox = self.create_box(rootfs).await?;

        // Start execution
        let cmd = self.prepare_command(&command_args);
        let mut execution = litebox.exec(cmd).await?;

        // Detach mode: Print ID and exit
        if self.args.management.detach {
            println!("{}", litebox.id());
            return Ok(0);
        }

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
        // Just return the shell exit code. Returning (vs. calling
        // `std::process::exit` here) lets `execution`, `litebox`, and the
        // owning `BoxliteRuntime` drop normally, so `RuntimeImpl::Drop`
        // runs `shutdown_sync()` and tears the box's shim down — the RAII
        // teardown the success path already relied on. `std::process::exit`
        // bypasses Drop entirely and leaked the shim on the non-zero path
        // (#622).
        Ok(to_shell_exit_code(exit_code))
    }

    async fn create_box(&self, rootfs: RootfsSpec) -> anyhow::Result<LiteBox> {
        let mut options = BoxOptions::default();
        self.args.resource.apply_to(&mut options);
        self.args.management.apply_to(&mut options)?;
        self.args.publish.apply_to(&mut options)?;
        self.args
            .volume
            .apply_to(&mut options, self.home.as_deref())?;
        self.args.network.apply_to(&mut options)?;
        self.args.process.apply_to(&mut options)?;

        // Runtime requires detached boxes to have manual lifecycle control (auto_remove=false)
        if self.args.management.detach {
            options.auto_remove = false;
        }

        options.rootfs = rootfs;

        let litebox = self
            .rt
            .create(options, self.args.management.name.clone())
            .await?;

        Ok(litebox)
    }

    fn prepare_command(&self, command_args: &[String]) -> BoxCommand {
        let (program, args) = parse_command_args(command_args);
        BoxCommand::new(program)
            .args(args)
            .tty(self.args.process.tty)
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

fn parse_command_args(input: &[String]) -> (&str, &[String]) {
    if input.is_empty() {
        ("sh", &[])
    } else {
        (&input[0], &input[1..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Commands};
    use clap::Parser;

    #[test]
    fn test_parse_command_args_defaults() {
        let empty: Vec<String> = vec![];
        assert_eq!(parse_command_args(&empty), ("sh", &[] as &[String]));
    }

    #[test]
    fn test_parse_command_args_explicit() {
        let input = vec!["echo".to_string(), "hello".to_string()];
        assert_eq!(
            parse_command_args(&input),
            ("echo", &["hello".to_string()] as &[String])
        );
    }

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
    fn run_rootfs_without_command_defaults_to_shell() {
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
        assert_eq!(parse_command_args(command), ("sh", &[] as &[String]));
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
