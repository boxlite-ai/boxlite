use anyhow::Result;
use clap::Args;

use crate::cli::GlobalFlags;

#[derive(Args, Debug)]
pub struct PullArgs {
    /// Image to pull
    pub image: String,

    /// Quiet mode - only show digest
    #[arg(short, long)]
    pub quiet: bool,
}

pub async fn execute(args: PullArgs, global: &GlobalFlags) -> Result<()> {
    let runtime = global.create_runtime()?;
    let images = runtime.images()?;

    let image = images.pull(&args.image).await?;
    if args.quiet {
        println!("{}", image.config_digest());
    } else {
        println!("Pulled: {}", image.reference());
        println!("Digest: {}", image.config_digest());
        println!("Layers: {}", image.layer_count());
    }

    Ok(())
}
