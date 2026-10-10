//! `boxlite network` — manage box network access.

use anyhow::Result;
use clap::{Args, Subcommand};

use crate::cli::GlobalFlags;

pub mod inbound;
pub mod tunnel;

#[derive(Args, Debug)]
pub struct NetworkArgs {
    #[command(subcommand)]
    pub command: NetworkCommand,
}

#[derive(Subcommand, Debug)]
pub enum NetworkCommand {
    /// Print a remote URL or forward a local listener to a box service.
    Tunnel(tunnel::TunnelArgs),
    /// Make a remote box's services public or private.
    Inbound(inbound::InboundArgs),
}

pub async fn execute(args: NetworkArgs, global: &GlobalFlags) -> Result<()> {
    match args.command {
        NetworkCommand::Tunnel(args) => tunnel::execute(args, global).await,
        NetworkCommand::Inbound(args) => inbound::execute(args, global).await,
    }
}
