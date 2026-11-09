use crate::cli::GlobalFlags;
use crate::terminal::StreamManager;
use boxlite::AttachOptions;
use clap::Args;

#[derive(Args, Debug)]
pub struct AttachArgs {
    /// Box ID or name
    pub target_box: String,
    /// Execution ID from `boxlite top`
    pub execution_id: String,
    /// Attach without sending stdin
    #[arg(long)]
    pub no_stdin: bool,
}

pub async fn execute(args: AttachArgs, global: &GlobalFlags) -> anyhow::Result<i32> {
    let rt = global.create_runtime()?;
    let bx = rt
        .get(&args.target_box)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No such box: {}", args.target_box))?;
    let info = bx
        .executions()
        .list()
        .await?
        .into_iter()
        .find(|item| item.execution_id == args.execution_id)
        .ok_or_else(|| anyhow::anyhow!("No such execution: {}", args.execution_id))?;
    let options = AttachOptions::execution(&args.execution_id);
    let options = if args.no_stdin {
        options.read_only()
    } else {
        options
    };
    let mut handle = bx.attach(options).await?;
    let code = StreamManager::new(&mut handle, !args.no_stdin, info.tty)
        .start()
        .await?;
    let _ = rt.shutdown(None).await;
    Ok(crate::util::to_shell_exit_code(code))
}
