use crate::cli::GlobalFlags;
use clap::Args;

/// Remove a shared ext4 image.
///
/// A `disk.root` reference refuses the removal, including with `--force`.
#[derive(Args, Debug)]
pub struct RmiArgs {
    /// Stop a live build when this is the last name for that ext4.
    /// Does not override a disk that still roots at the ext4.
    #[arg(long)]
    pub force: bool,

    /// Remove ext4 files that no image name and no disk root use.
    #[arg(long, conflicts_with_all = ["image", "disk_key"])]
    pub unused: bool,

    /// Remove one ext4 by its disk key instead of an image name.
    #[arg(long, conflicts_with = "image")]
    pub disk_key: Option<String>,

    /// Image name to remove.
    #[arg(required_unless_present_any = ["unused", "disk_key"])]
    pub image: Option<String>,
}

pub async fn execute(args: RmiArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let options = global.resolve_runtime_options()?;
    let runtime = global.create_runtime_with_options(options)?;
    let images = runtime.images()?;
    if args.unused {
        images.remove_unused().await?;
        return Ok(());
    }
    if let Some(disk_key) = args.disk_key {
        images.remove_disk(&disk_key).await?;
        return Ok(());
    }
    let image = args
        .image
        .expect("image is required without --unused or --disk-key");
    images.remove(&image, args.force).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::cli::{Commands, try_parse_from};

    #[test]
    fn rmi_parses_a_name_unused_or_a_disk_key() {
        let cli = try_parse_from(["boxlite", "rmi", "alpine:latest"]).expect("name");
        let Commands::Rmi(args) = cli.command else {
            panic!("expected rmi");
        };
        assert_eq!(args.image.as_deref(), Some("alpine:latest"));
        assert!(!args.force);
        assert!(!args.unused);

        let cli = try_parse_from(["boxlite", "rmi", "--unused"]).expect("unused");
        let Commands::Rmi(args) = cli.command else {
            panic!("expected rmi");
        };
        assert!(args.unused);
        assert!(args.image.is_none());

        let cli = try_parse_from(["boxlite", "rmi", "--disk-key", "sha256-abc"]).expect("disk key");
        let Commands::Rmi(args) = cli.command else {
            panic!("expected rmi");
        };
        assert_eq!(args.disk_key.as_deref(), Some("sha256-abc"));

        assert!(try_parse_from(["boxlite", "rmi"]).is_err());
        assert!(try_parse_from(["boxlite", "rmi", "--unused", "alpine"]).is_err());
        assert!(
            try_parse_from(["boxlite", "rmi", "--force", "--disk-key", "k", "alpine"]).is_err()
        );
    }
}
