//! `boxlite volume {create,ls,get,rm,attach,detach}` — manage volumes.
//!
//! Volumes are addressed by a server-assigned id (like boxes): `create` takes
//! no arguments and prints the new id, and get/rm operate on ids; `attach`
//! and `detach` also accept a volume name (organization-unique), resolved
//! server-side. Each leaf module owns its own `Args` struct and `run()`;
//! this module holds the subcommand enum and dispatches.

use clap::{Args, Subcommand};

use crate::cli::GlobalFlags;

pub mod attach;
pub mod create;
pub mod detach;
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

    /// Attach a managed volume to a box. No hot-plug: the box must be
    /// stopped, and the mount takes effect on the box's next start.
    Attach(attach::AttachArgs),

    /// Detach a managed volume from a box. No hot-plug: the box must be
    /// stopped.
    Detach(detach::DetachArgs),
}

pub async fn execute(args: VolumeArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    match args.command {
        VolumeCommand::Create(a) => create::run(a, global).await,
        VolumeCommand::Ls(a) => ls::run(a, global).await,
        VolumeCommand::Get(a) => get::run(a, global).await,
        VolumeCommand::Rm(a) => rm::run(a, global).await,
        VolumeCommand::Attach(a) => attach::run(a, global).await,
        VolumeCommand::Detach(a) => detach::run(a, global).await,
    }
}
