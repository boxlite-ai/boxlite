use clap::Args;

use crate::cli::GlobalFlags;

/// Detach a managed volume from a box.
#[derive(Args, Debug)]
pub struct DetachArgs {
    /// Name or ID of the box to detach the volume from.
    pub box_ref: String,

    /// Name or ID of the volume to detach.
    pub volume_ref: String,

    /// Treat a volume that is not currently attached as already detached.
    #[arg(short, long)]
    pub force: bool,
}

pub async fn run(args: DetachArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;

    let litebox = match rt.get(&args.box_ref).await? {
        Some(b) => b,
        None => anyhow::bail!("No such box: {}", args.box_ref),
    };

    litebox.detach_volume(&args.volume_ref, args.force).await?;

    println!("{}", args.volume_ref);
    Ok(())
}
