//! Make an existing box's services public or private.

use anyhow::anyhow;
use boxlite::runtime::options::NetworkMode;
use clap::Args;

use crate::cli::GlobalFlags;

#[derive(Args, Debug)]
pub struct InboundArgs {
    /// Name or ID of the box to change
    #[arg(value_name = "BOX")]
    pub target: String,

    /// Inbound mode: "enabled" (services the box exposes are publicly
    /// reachable) or "disabled" (private). Remote boxes only.
    #[arg(value_name = "MODE", value_parser = parse_network_mode)]
    pub mode: NetworkMode,
}

fn parse_network_mode(value: &str) -> Result<NetworkMode, String> {
    value
        .parse()
        .map_err(|error: boxlite::BoxliteError| error.to_string())
}

pub async fn execute(args: InboundArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let runtime = global.create_runtime()?;
    let litebox = runtime
        .get(&args.target)
        .await?
        .ok_or_else(|| anyhow!("No such box: {}", args.target))?;

    litebox.network().set_inbound(args.mode).await?;
    println!("{}", args.target);
    Ok(())
}
