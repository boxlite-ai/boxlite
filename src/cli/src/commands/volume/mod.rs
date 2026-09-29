//! `boxlite volume {create,ls,get,rm}` — manage volumes.
//!
//! Volumes carry a server-assigned id and a name; `create` prints the new id
//! and takes an optional `--name`, while get/rm operate on ids. A name is
//! mountable in place of the id (`-v my-data:/data`).
//!
//! Each leaf module owns its own `Args` struct and `run()`; this module holds
//! the subcommand enum and dispatches. Against a REST runtime the commands
//! call `/v1/volumes`; against the local runtime they work on the store under
//! `{home}/volumes/`, one directory per volume. Either way an unknown id or
//! name is "not found": only `create` and an anonymous `-v /path` mount make
//! a volume.

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
    /// Create a volume, optionally named (prints the new id).
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
