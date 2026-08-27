use crate::cli::GlobalFlags;
use clap::Args;

/// Create a volume.
///
/// The server assigns the id, which is printed on success (mirroring
/// `boxlite create`). A `--name` can be mounted in place of that id.
#[derive(Args, Debug)]
pub struct CreateArgs {
    /// Volume name, mountable in place of the id (e.g. `-v my-data:/data`).
    /// At least two characters of `[a-zA-Z0-9][a-zA-Z0-9_.-]`.
    /// Defaults to the server-assigned id.
    #[arg(long)]
    pub name: Option<String>,
}

pub async fn run(args: CreateArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let info = rt.volumes()?.create(args.name.as_deref()).await?;
    // Like `boxlite create`, print the new id on success.
    println!("{}", info.id);
    Ok(())
}
