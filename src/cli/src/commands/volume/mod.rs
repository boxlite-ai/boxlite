//! `boxlite volume {create,ls,get,rm}` — manage named local volumes.
//!
//! A named volume is a managed host directory under `<home>/volumes/<name>`
//! (Docker `local` driver style). Each leaf module owns its own `Args` struct
//! and `run()`; this module holds the subcommand enum and dispatches.

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
    /// Create a named local volume.
    Create(create::CreateArgs),

    /// List named local volumes.
    #[command(visible_alias = "list")]
    Ls(ls::LsArgs),

    /// Show details for a named local volume.
    #[command(visible_alias = "inspect")]
    Get(get::GetArgs),

    /// Remove one or more named local volumes.
    #[command(visible_alias = "delete")]
    Rm(rm::RmArgs),
}

pub async fn execute(args: VolumeArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    match args.command {
        VolumeCommand::Create(a) => create::run(a, global),
        VolumeCommand::Ls(a) => ls::run(a, global),
        VolumeCommand::Get(a) => get::run(a, global),
        VolumeCommand::Rm(a) => rm::run(a, global),
    }
}
