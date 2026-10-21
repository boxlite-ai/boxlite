//! Manage box network policy and tunnels.

use anyhow::Result;
use clap::{Args, Subcommand};

use crate::cli::GlobalFlags;

mod policy;
pub mod tunnel;

#[derive(Args, Debug)]
pub struct NetworkArgs {
    #[command(subcommand)]
    pub command: NetworkCommand,
}

#[derive(Subcommand, Debug)]
pub enum NetworkCommand {
    /// Replace inbound access policy.
    Inbound(policy::InboundArgs),
    /// Replace outbound policy and its entire allowlist.
    Outbound(policy::OutboundArgs),
    /// Print a remote URL, forward a local listener, or revoke a box service's URL.
    Tunnel(tunnel::TunnelArgs),
}

pub async fn execute(args: NetworkArgs, global: &GlobalFlags) -> Result<()> {
    match args.command {
        NetworkCommand::Inbound(args) => policy::set_inbound(args, global).await,
        NetworkCommand::Outbound(args) => policy::set_outbound(args, global).await,
        NetworkCommand::Tunnel(args) => tunnel::execute(args, global).await,
    }
}
