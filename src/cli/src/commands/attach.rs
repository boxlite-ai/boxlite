use std::io::IsTerminal;

use crate::cli::GlobalFlags;
use crate::terminal::StreamManager;
use crate::util::to_shell_exit_code;
use clap::Args;

#[derive(Args, Debug)]
pub struct AttachArgs {
    /// Attach without taking stdin ownership
    #[arg(long = "no-stdin")]
    pub no_stdin: bool,

    /// Box ID or name
    #[arg(index = 1, value_name = "BOX")]
    pub target_box: String,

    /// Execution ID
    #[arg(index = 2, value_name = "EXECID")]
    pub execution_id: String,
}

pub async fn execute(args: AttachArgs, global: &GlobalFlags) -> anyhow::Result<i32> {
    let rt = global.create_runtime()?;
    let litebox = rt
        .get(&args.target_box)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No such box: {}", args.target_box))?;

    let mut execution = if args.no_stdin {
        litebox.attach_no_stdin(&args.execution_id).await?
    } else {
        litebox.attach(&args.execution_id).await?
    };

    let interactive = !args.no_stdin;
    let tty = interactive && std::io::stdin().is_terminal();
    let streamer = StreamManager::new(&mut execution, interactive, tty);
    let exit_code = streamer.start().await?;

    let _ = rt.shutdown(None).await;
    Ok(to_shell_exit_code(exit_code))
}
