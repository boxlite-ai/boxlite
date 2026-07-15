use crate::cli::GlobalFlags;
use clap::Args;

/// Remove one or more volumes.
#[derive(Args, Debug)]
pub struct RmArgs {
    /// Ignore volumes that do not exist.
    #[arg(short, long)]
    pub force: bool,

    /// Id(s) of the volume(s) to remove.
    #[arg(required = true, num_args = 1..)]
    pub ids: Vec<String>,
}

pub async fn run(args: RmArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let handle = rt.volumes()?;

    // Remove each id independently so one bad id doesn't abort the rest;
    // report per-id and fail overall if any removal errored (mirrors
    // `boxlite rm`).
    let mut had_error = false;
    for id in &args.ids {
        match handle.remove(id, args.force).await {
            Ok(()) => println!("{id}"),
            Err(e) => {
                eprintln!("Error removing volume '{id}': {e}");
                had_error = true;
            }
        }
    }

    if had_error {
        anyhow::bail!("Some volumes could not be removed");
    }
    Ok(())
}
