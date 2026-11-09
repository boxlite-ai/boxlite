use crate::cli::GlobalFlags;
use clap::Args;

#[derive(Args, Debug)]
pub struct SignalArgs {
    /// Box ID or name
    pub target_box: String,
    /// Execution ID from `boxlite top`
    pub execution_id: String,
    /// Unix signal number
    pub signal: i32,
}

pub async fn execute(args: SignalArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let bx = rt
        .get(&args.target_box)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No such box: {}", args.target_box))?;
    bx.executions()
        .get(&args.execution_id)
        .await?
        .signal(args.signal)
        .await?;
    Ok(())
}
