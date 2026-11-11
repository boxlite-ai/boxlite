use anyhow::Result;
use clap::Args;
use std::path::PathBuf;

use super::checkpoint;
use crate::cli::GlobalFlags;

#[derive(Args, Debug)]
pub struct ImportArgs {
    /// Import a .boxlite archive into a new box.
    #[arg(
        value_name = "ARCHIVE",
        required_unless_present = "checkpoint",
        conflicts_with = "checkpoint"
    )]
    pub archive: Option<PathBuf>,
    /// Import a managed checkpoint instead of uploading an archive.
    #[arg(long, value_name = "ID", required_unless_present = "archive")]
    pub checkpoint: Option<String>,
    /// Name for a new box; cannot be combined with --box.
    #[arg(long, conflicts_with = "box_id")]
    pub name: Option<String>,
    /// Existing idle box to replace from a checkpoint.
    #[arg(long = "box", value_name = "ID", requires = "checkpoint")]
    pub box_id: Option<String>,
}

pub async fn execute(args: ImportArgs, global: &GlobalFlags) -> Result<()> {
    let bx = if let Some(key) = args.checkpoint {
        let backend = checkpoint::backend(global)?;
        backend
            .import_box(&key, args.name, args.box_id.as_deref())
            .await?
    } else {
        let path = args
            .archive
            .expect("clap requires an archive or checkpoint");
        let rt = global.create_runtime()?;
        rt.import_box(boxlite::BoxArchive::new(path), args.name)
            .await?
    };
    println!("{}", bx.id());
    Ok(())
}
