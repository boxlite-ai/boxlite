//! Print a public preview URL for a box port.

use crate::cli::GlobalFlags;
use clap::Args;

#[derive(Args, Debug)]
pub struct PreviewUrlArgs {
    /// Box ID or name
    #[arg(index = 1, value_name = "BOX")]
    pub target: String,

    /// Guest port to preview
    #[arg(index = 2, value_name = "PORT")]
    pub port: u16,

    /// Generate a short-lived signed URL
    #[arg(long)]
    pub signed: bool,

    /// Signed URL expiration, in seconds
    #[arg(long, requires = "signed")]
    pub expires_in_seconds: Option<u32>,
}

pub async fn execute(args: PreviewUrlArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let litebox = rt
        .get(&args.target)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No such box: {}", args.target))?;

    let url = if args.signed {
        litebox
            .network()
            .signed_preview_url(args.port, args.expires_in_seconds)
            .await?
            .url
    } else {
        litebox.network().preview_url(args.port).await?.url
    };

    println!("{}", url);
    Ok(())
}
