use crate::cli::{
    GlobalFlags, ManagementFlags, ProcessFlags, PublishFlags, ResourceFlags, VolumeFlags,
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
    pub management: ManagementFlags,

    #[arg(index = 1)]
    pub image: String,

    /// Command to run inside the image
    #[arg(index = 2, trailing_var_arg = true)]
    pub command: Vec<String>,
}

/// Entry point
pub async fn execute(args: RunArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let mut runner = BoxRunner::new(args, global)?;
    let shell_exit_code = runner.run().await?;

    // Drop the runner (and the runtime it owns) BEFORE exiting so the runtime's
    // synchronous shutdown runs — the same teardown the success (exit 0) path
    // gets by returning normally. That shutdown SIGTERMs the box's shim (and
    // marks the box stopped); the `auto_remove` DB-record/home removal itself is
    // deferred to the next runtime startup's recovery sweep. Calling
    // `std::process::exit` while the runner is still alive skips every
    // destructor, so the shim is orphaned — which is why a non-zero
    // `boxlite run --rm <cmd>` previously left a live shim behind.
    drop(runner);

    if shell_exit_code != 0 {
        std::process::exit(shell_exit_code);
    }
    Ok(())
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

    /// Run the box and return the shell exit code (already mapped via
    /// `to_shell_exit_code`). Returns 0 for detach/success. The caller is
    /// responsible for dropping this runner before exiting the process so
    /// cleanup runs.
    async fn run(&mut self) -> anyhow::Result<i32> {
        // Validate flags and environment
        self.validate_flags()?;

        let litebox = self.create_box().await?;

        // Start execution
        let cmd = self.prepare_command();
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
        Ok(to_shell_exit_code(exit_code))
    }

    async fn create_box(&self) -> anyhow::Result<LiteBox> {
        let mut options = BoxOptions::default();
        self.args.resource.apply_to(&mut options);
        self.args.management.apply_to(&mut options);
        self.args.publish.apply_to(&mut options)?;
        self.args
            .volume
            .apply_to(&mut options, self.home.as_deref())?;
        self.args.process.apply_to(&mut options)?;

        // Runtime requires detached boxes to have manual lifecycle control (auto_remove=false)
        if self.args.management.detach {
            options.auto_remove = false;
        }

        options.rootfs = RootfsSpec::Image(self.args.image.clone());

        let litebox = self
            .rt
            .create(options, self.args.management.name.clone())
            .await?;

        Ok(litebox)
    }

    fn prepare_command(&self) -> BoxCommand {
        let (program, args) = parse_command_args(&self.args.command);
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
}
