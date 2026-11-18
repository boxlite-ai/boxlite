use clap::Args;

/// Remove untagged local images and reclaim unused cache data
#[derive(Args, Debug)]
pub struct RmiArgs {
    /// Full image IDs or unambiguous hexadecimal prefixes
    #[arg(required = true, num_args = 1.., value_name = "IMAGE_ID")]
    pub targets: Vec<String>,
}

pub async fn execute(args: RmiArgs, global: &crate::cli::GlobalFlags) -> anyhow::Result<()> {
    let runtime = global.create_runtime()?;
    let images = runtime.images()?;
    // Resolve the complete batch before mutation. Removing one target cannot
    // turn a later ambiguous prefix into an eligible target.
    let resolved = images.resolve_ids(&args.targets).await?;
    let mut failed = false;
    let mut reclaimed_bytes = 0u64;
    for (target, resolved) in args.targets.iter().zip(resolved) {
        let result = match resolved {
            Ok(id) => images.delete(&id).await,
            Err(error) => Err(error),
        };
        match result {
            Ok(result) => {
                println!("{}", result.image_id);
                reclaimed_bytes = reclaimed_bytes.saturating_add(result.reclaimed_bytes);
            }
            Err(error) => {
                eprintln!("Error removing image '{target}': {error}");
                failed = true;
            }
        }
    }
    eprintln!("Reclaimed space: {reclaimed_bytes} bytes");
    if failed {
        anyhow::bail!("Some images could not be removed");
    }
    Ok(())
}
