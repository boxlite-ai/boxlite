use std::time::Duration;

use crate::cli::GlobalFlags;
use clap::Args;

/// Create a volume.
///
/// Takes no arguments besides `--wait` — the server assigns the id, which is
/// printed on success (mirroring `boxlite create`).
#[derive(Args, Debug)]
pub struct CreateArgs {
    /// Poll client-side until the volume is ready (or errors/times out)
    /// before returning, instead of returning as soon as it's accepted.
    /// The server never blocks on this itself — see
    /// `VolumeHandle::wait_until_ready`.
    #[arg(long)]
    pub wait: bool,

    /// Timeout in seconds for `--wait`.
    #[arg(long, default_value_t = 30, requires = "wait")]
    pub wait_timeout: u64,
}

pub async fn run(args: CreateArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let volumes = rt.volumes()?;
    let info = volumes.create().await?;

    if args.wait {
        volumes
            .wait_until_ready(&info.id, Duration::from_secs(args.wait_timeout))
            .await?;
    }

    // Like `boxlite create`, print the new id on success.
    println!("{}", info.id);
    Ok(())
}
