//! Change settings of an existing box.

use anyhow::anyhow;
use boxlite::runtime::options::NetworkMode;
use clap::Args;

use crate::cli::GlobalFlags;

#[derive(Args, Debug)]
pub struct UpdateArgs {
    /// Name or ID of the box to update
    #[arg(value_name = "BOX")]
    pub target: String,

    /// Inbound mode: "enabled" (services the box exposes are publicly
    /// reachable) or "disabled" (private). Remote boxes only.
    #[arg(long = "inbound", value_name = "MODE", required = true, value_parser = parse_network_mode)]
    pub inbound: NetworkMode,
}

fn parse_network_mode(value: &str) -> Result<NetworkMode, String> {
    value
        .parse()
        .map_err(|error: boxlite::BoxliteError| error.to_string())
}

pub async fn execute(args: UpdateArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let runtime = global.create_runtime()?;
    let litebox = runtime
        .get(&args.target)
        .await?
        .ok_or_else(|| anyhow!("No such box: {}", args.target))?;

    litebox.network().set_inbound(args.inbound).await?;
    println!("{}", args.target);
    Ok(())
}
