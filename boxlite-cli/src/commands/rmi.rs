use anyhow::Result;
use clap::Args;

use crate::cli::GlobalFlags;
use boxlite::BoxliteError;

#[derive(Args, Debug)]
pub struct RmiArgs {
    /// Image(s) to remove
    pub images: Vec<String>,

    /// Force remove even if image is in use
    #[arg(short, long)]
    pub force: bool,
}

pub async fn execute(args: RmiArgs, global: &GlobalFlags) -> Result<()> {
    let runtime = global.create_runtime()?;
    if args.images.is_empty() {
        anyhow::bail!("at least one image must be specified");
    }

    let mut has_failed = false;
    for image in &args.images {
        match runtime.remove_image(image, args.force).await {
            Ok(report) => {
                if !report.is_empty() {
                    println!("{}", report);
                }
            }
            Err(e) => {
                match e {
                    BoxliteError::ImageInUse { .. } => {
                        eprintln!(
                            "Error: Cannot remove image '{}' because it is being used by a box",
                            image
                        );
                        eprintln!("       Use --force to remove it anyway");
                    }
                    BoxliteError::NotFound(_) => {
                        eprintln!("Error: Image '{}' not found", image);
                    }
                    BoxliteError::ImageMultipleTags { .. } => {
                        eprintln!("Error: Image '{}' has multiple tags", image);
                        eprintln!(
                            "       Use --force to remove all tags, or specify a specific tag"
                        );
                    }
                    _ => {
                        eprintln!("Error removing image '{}': {}", image, e);
                    }
                }
                has_failed = true;
            }
        }
    }

    if has_failed {
        anyhow::bail!("one or more images could NOT be removed");
    }

    Ok(())
}
