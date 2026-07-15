use crate::cli::GlobalFlags;
use clap::Args;

/// Remove one or more named local volumes.
#[derive(Args, Debug)]
pub struct RmArgs {
    /// Ignore volumes that do not exist.
    #[arg(short, long)]
    pub force: bool,

    /// Name(s) of the volume(s) to remove.
    #[arg(required = true, num_args = 1..)]
    pub names: Vec<String>,
}

pub async fn run(args: RmArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let handle = rt.volumes()?;

    // Remove each name independently so one bad name doesn't abort the rest;
    // report per-name and fail overall if any removal errored (mirrors
    // `boxlite rm`).
    let mut had_error = false;
    for name in &args.names {
        match handle.remove(name, args.force).await {
            Ok(()) => println!("{name}"),
            Err(e) => {
                eprintln!("Error removing volume '{name}': {e}");
                had_error = true;
            }
        }
    }

    if had_error {
        anyhow::bail!("Some volumes could not be removed");
    }
    Ok(())
}
