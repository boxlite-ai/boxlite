use clap::Args;

use crate::cli::GlobalFlags;

/// Attach a managed volume to a box.
#[derive(Args, Debug)]
pub struct AttachArgs {
    /// Name or ID of the box to attach the volume to.
    pub box_ref: String,

    /// Name or ID of the volume to attach.
    pub volume_ref: String,

    /// Mount point inside the box.
    #[arg(long)]
    pub path: String,

    /// Mount the volume read-only.
    ///
    /// Not yet enforced at the mount layer, so the server rejects this flag
    /// today rather than silently mounting read-write.
    #[arg(long)]
    pub read_only: bool,
}

pub async fn run(args: AttachArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;

    let litebox = match rt.get(&args.box_ref).await? {
        Some(b) => b,
        None => anyhow::bail!("No such box: {}", args.box_ref),
    };

    litebox
        .attach_volume(&args.volume_ref, &args.path, args.read_only)
        .await?;

    println!("{}", args.volume_ref);
    Ok(())
}
