//! Print a public service URL without creating a local TCP listener.

use std::net::SocketAddr;

use anyhow::{Context, Result, anyhow};
use boxlite::litebox::BoxEndpoint;
use clap::Args;

use crate::cli::GlobalFlags;

#[derive(Args, Debug)]
pub struct TunnelArgs {
    /// Box ID or name
    #[arg(value_name = "BOX")]
    pub target: String,

    /// Guest port the service listens on
    #[arg(value_name = "PORT", value_parser = clap::value_parser!(u16).range(1..))]
    pub port: u16,
}

pub async fn execute(args: TunnelArgs, global: &GlobalFlags) -> Result<()> {
    let runtime = global.create_runtime()?;
    let box_handle = runtime
        .get(&args.target)
        .await?
        .ok_or_else(|| anyhow!("No such box: {}", args.target))?;

    let guest_ip = boxlite::net::constants::GUEST_IP
        .parse()
        .context("BoxLite guest IP constant is invalid")?;
    let tunnel = box_handle
        .network()
        .tunnel(SocketAddr::new(guest_ip, args.port))
        .await?;
    let url = match tunnel.endpoint() {
        BoxEndpoint::Uri(uri) => uri,
        BoxEndpoint::FileDescriptor(_) => {
            return Err(anyhow!(
                "boxlite tunnel requires a remote REST profile (--url or --profile)"
            ));
        }
    };
    println!("{url}");
    Ok(())
}
