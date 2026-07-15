use crate::cli::GlobalFlags;
use clap::Args;

/// Create a volume.
///
/// Takes no arguments — the server assigns the id, which is printed on success
/// (mirroring `boxlite create`).
#[derive(Args, Debug)]
pub struct CreateArgs {}

pub async fn run(_args: CreateArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let info = rt.volumes()?.create().await?;
    // Like `boxlite create`, print the new id on success.
    println!("{}", info.id);
    Ok(())
}
