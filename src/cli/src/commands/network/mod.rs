//! `boxlite network tunnel` — manage box network access.

use anyhow::Result;
use clap::{Args, Subcommand};

use crate::cli::GlobalFlags;

pub mod tunnel;

#[derive(Args, Debug)]
pub struct NetworkArgs {
    #[command(subcommand)]
    pub command: NetworkCommand,
}

#[derive(Subcommand, Debug)]
pub enum NetworkCommand {
    /// Print the public URL for a box service port.
    Tunnel(tunnel::TunnelArgs),
}

pub async fn execute(args: NetworkArgs, global: &GlobalFlags) -> Result<()> {
    match args.command {
        NetworkCommand::Tunnel(args) => tunnel::execute(args, global).await,
    }
}
