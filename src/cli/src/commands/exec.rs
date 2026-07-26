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

/// Entry point.
///
/// Returns the shell exit code the CLI should exit with. Returning the code
/// — instead of calling `std::process::exit` here — lets the owning
/// `BoxliteRuntime` drop normally, so `RuntimeImpl::Drop` runs
/// `shutdown_sync()` as a safety net. The explicit `rt.shutdown(None).await`
/// below is the graceful path (Guest.Shutdown RPC); Drop is the backstop.
/// Mirrors the RAII fix in [`super::run::execute`] (#622).
pub async fn execute(args: ExecArgs, global: &GlobalFlags) -> anyhow::Result<i32> {
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

    async fn execute(&mut self) -> anyhow::Result<i32> {
        self.args.process.validate(self.args.detach)?;
        let litebox = self.get_box().await?;
        let cmd = self.prepare_command();
        let mut execution = litebox.exec(cmd).await?;

        // Detach mode: Exit immediately without waiting
        if self.args.detach {
            return Ok(0);
        }

        if self.args.process.tty {
            self.args.process.interactive = true;
        }

        // IO handle and signals
        let streamer = StreamManager::new(
            &mut execution,
            self.args.process.interactive,
            self.args.process.tty,
        );

        let exit_code = streamer.start().await?;

        // Gracefully stop non-detached boxes before CLI exits.
        // This is the primary shutdown path: async with live LiteBox handles.
        let _ = self.rt.shutdown(None).await;

        // Return the shell exit code instead of calling std::process::exit so
        // `BoxliteRuntime` drops normally and `RuntimeImpl::Drop` runs
        // `shutdown_sync()` as a safety net for anything the explicit shutdown
        // above missed (mirrors the RAII fix in run.rs, #622).
        Ok(to_shell_exit_code(exit_code))
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
