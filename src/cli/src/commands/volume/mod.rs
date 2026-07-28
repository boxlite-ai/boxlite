//! `boxlite volume {create,ls,get,rm}` — manage volumes.
//!
//! Volumes are addressed by a server-assigned id (like boxes): `create` takes
//! no arguments and prints the new id, and get/rm operate on ids. Each leaf
//! module owns its own `Args` struct and `run()`; this module holds the
//! subcommand enum and dispatches. The backend is not implemented yet, so every
//! command currently returns "not supported".

use clap::{Args, Subcommand};

use crate::cli::GlobalFlags;

pub mod create;
pub mod get;
pub mod ls;
pub mod rm;

#[derive(Args, Debug)]
pub struct VolumeArgs {
    #[command(subcommand)]
    pub command: VolumeCommand,
}

#[derive(Subcommand, Debug)]
pub enum VolumeCommand {
    /// Create a volume (prints the new id).
    Create(create::CreateArgs),

    /// List volumes.
    #[command(visible_alias = "list")]
    Ls(ls::LsArgs),

    /// Show details for a volume by id.
    #[command(visible_alias = "inspect")]
    Get(get::GetArgs),

    /// Remove one or more volumes by id.
    #[command(visible_alias = "delete")]
    Rm(rm::RmArgs),
}

pub async fn execute(args: VolumeArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    match args.command {
        VolumeCommand::Create(a) => create::run(a, global).await,
        VolumeCommand::Ls(a) => ls::run(a, global).await,
        VolumeCommand::Get(a) => get::run(a, global).await,
        VolumeCommand::Rm(a) => rm::run(a, global).await,
    }
}
