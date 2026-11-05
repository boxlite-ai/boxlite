use clap::Args;

#[derive(Args, Debug)]
pub struct ResizeArgs {
    /// Name or ID of the running box
    pub target: String,
    /// Absolute CPU allocation (grow only)
    #[arg(long)]
    pub cpus: Option<u8>,
    /// Absolute memory allocation in MiB (grow only)
    #[arg(long)]
    pub memory: Option<u32>,
}

pub async fn execute(args: ResizeArgs, global: &crate::cli::GlobalFlags) -> anyhow::Result<()> {
    let runtime = global.create_runtime()?;
    let bx = runtime
        .get(&args.target)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No such box: {}", args.target))?;
    let resources = bx
        .resize(boxlite::ResizeOptions {
            cpus: args.cpus,
            memory_mib: args.memory,
        })
        .await?;
    println!("{}", serde_json::to_string(&resources)?);
    Ok(())
}
