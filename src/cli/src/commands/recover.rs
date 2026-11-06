use anyhow::Result;
use clap::Args;

use super::checkpoint::{StorageArgs, runtime};
use crate::cli::GlobalFlags;

#[derive(Args, Debug)]
pub struct RecoverArgs {
    /// Existing stopped or failed box to replace.
    pub target: String,
    #[arg(long, value_name = "ID")]
    pub checkpoint: String,
    #[command(flatten)]
    pub storage: StorageArgs,
}

pub async fn execute(args: RecoverArgs, global: &GlobalFlags) -> Result<()> {
    let rt = runtime(global, &args.storage)?;
    let bx = rt
        .checkpoints()
        .recover_box(&args.checkpoint, &args.target)
        .await?;
    println!("{}", bx.id());
    Ok(())
}
