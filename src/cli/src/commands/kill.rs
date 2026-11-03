use crate::cli::GlobalFlags;
use clap::Args;

#[derive(Args, Debug)]
pub struct KillArgs {
    /// Box ID or name
    pub target_box: String,
    /// Execution ID from `boxlite top`
    pub execution_id: String,
}

pub async fn execute(args: KillArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let bx = rt
        .get(&args.target_box)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No such box: {}", args.target_box))?;
    bx.get_execution(&args.execution_id).await?.kill().await?;
    Ok(())
}
