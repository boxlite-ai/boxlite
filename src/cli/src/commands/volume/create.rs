use crate::cli::GlobalFlags;
use clap::Args;

/// Create a named local volume.
#[derive(Args, Debug)]
pub struct CreateArgs {
    /// Volume name (single path segment: [A-Za-z0-9][A-Za-z0-9_.-]*)
    pub name: String,

    /// Advisory size in GB. Stored in metadata only; not enforced for a
    /// local directory (a plain dir has no quota).
    #[arg(short = 's', long = "size", value_name = "GB")]
    pub size: Option<u64>,
}

pub fn run(args: CreateArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let info = rt.volumes()?.create(&args.name, args.size)?;
    // Docker prints the created volume's name on success.
    println!("{}", info.name);
    Ok(())
}
