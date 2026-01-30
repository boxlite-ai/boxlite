use crate::cli::{GlobalFlags, ProcessFlags};
use crate::terminal::StreamManager;
use crate::util::to_shell_exit_code;
use boxlite::{BoxCommand, BoxliteRuntime, LiteBox};
use clap::Args;

#[derive(Args, Debug)]
pub struct ExecArgs {
    #[command(flatten)]
    pub process: ProcessFlags,

    /// Run command in the background (detached mode)
    #[arg(short = 'd', long)]
    pub detach: bool,

    /// Box ID or name
    #[arg(index = 1, value_name = "BOX")]
    pub target_box: String,

    /// Command to execute inside the box
    #[arg(index = 2, last = true, required = true)]
    pub command: Vec<String>,
}

/// Entry point
pub async fn execute(args: ExecArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let mut executor = BoxExecutor::new(args, global)?;
    executor.execute().await
}

struct BoxExecutor {
    args: ExecArgs,
    rt: BoxliteRuntime,
}

impl BoxExecutor {
    fn new(args: ExecArgs, global: &GlobalFlags) -> anyhow::Result<Self> {
        let rt = global.create_runtime()?;
        Ok(Self { args, rt })
    }

    async fn execute(&mut self) -> anyhow::Result<()> {
        self.args.process.validate(self.args.detach)?;
        let litebox = self.get_box().await?;
        let cmd = self.prepare_command();
        let mut execution = litebox.exec(cmd).await?;

        // Detach mode: Exit immediately without waiting
        if self.args.detach {
            return Ok(());
        }

        // IO handle and signals
        let streamer = StreamManager::new(
            &mut execution,
            self.args.process.interactive,
            self.args.process.tty,
        );

        let exit_code = streamer.start().await?;

        if exit_code != 0 {
            std::process::exit(to_shell_exit_code(exit_code));
        }

        Ok(())
    }

    async fn get_box(&self) -> anyhow::Result<LiteBox> {
        self.rt
            .get(&self.args.target_box)
            .await?
            .ok_or_else(|| anyhow::anyhow!("No such box: {}", self.args.target_box))
    }

    fn prepare_command(&self) -> BoxCommand {
        let cmd = BoxCommand::new(&self.args.command[0]).args(&self.args.command[1..]);
        self.args.process.configure_command(cmd)
    }
}
