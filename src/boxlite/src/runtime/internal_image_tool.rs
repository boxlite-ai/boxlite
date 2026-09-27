//! Feature-gated entry point for the infra-local image disk binary.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Instant;

use clap::{Parser, ValueEnum};

use super::options::{BoxliteOptions, ImageRegistry};
use super::rt_impl::RuntimeImpl;

#[derive(Clone, Copy, ValueEnum)]
enum Mode {
    Path,
    Prepare,
}

#[derive(Parser)]
struct Args {
    #[arg(long)]
    home: PathBuf,
    #[arg(long, value_enum)]
    mode: Mode,
    #[arg(required = true)]
    references: Vec<String>,
}

fn registry_credentials(
    user: &str,
    token: &str,
    host: &str,
    search: bool,
) -> Option<ImageRegistry> {
    let username = std::env::var(user).ok().filter(|value| !value.is_empty())?;
    let password = std::env::var(token)
        .ok()
        .filter(|value| !value.is_empty())?;
    Some(
        ImageRegistry::https(host)
            .with_search(search)
            .with_basic_auth(username, password),
    )
}

/// Run the project-internal image disk command.
pub async fn run_from_args() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    tracing_subscriber::fmt()
        .with_env_filter("boxlite::images=info")
        .with_writer(std::io::stderr)
        .without_time()
        .with_target(false)
        .try_init()
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let mut options = BoxliteOptions {
        home_dir: args.home,
        ..Default::default()
    };
    if let Some(registry) = registry_credentials(
        "BOXLITE_DOCKERHUB_USER",
        "BOXLITE_DOCKERHUB_TOKEN",
        "docker.io",
        true,
    ) {
        options.image_registries.push(registry);
    }
    if let Some(registry) =
        registry_credentials("BOXLITE_GHCR_USER", "BOXLITE_GHCR_TOKEN", "ghcr.io", false)
    {
        options.image_registries.push(registry);
    }

    eprintln!("[infra-local] opening image cache...");
    let runtime = RuntimeImpl::new(options)?;
    let mut paths = BTreeMap::new();
    let total = args.references.len();
    for (index, reference) in args.references.into_iter().enumerate() {
        let started = Instant::now();
        let action = match args.mode {
            Mode::Path => "checking",
            Mode::Prepare => "preparing",
        };
        eprintln!(
            "[infra-local] image {}/{}: {action} {reference}",
            index + 1,
            total
        );
        let image = runtime.image_manager.pull(&reference).await?;
        let path = match args.mode {
            Mode::Path => runtime.image_disk_mgr.cache_path_for(&image),
            Mode::Prepare => {
                let disk = runtime.image_disk_mgr.get_or_create(&image).await?;
                disk.path().to_path_buf()
            }
        };
        let result = match args.mode {
            Mode::Path if path.is_file() => "ext4 cached",
            Mode::Path => "ext4 missing",
            Mode::Prepare => "ready",
        };
        eprintln!(
            "[infra-local] image {}/{}: {result} {reference} ({:.1}s)",
            index + 1,
            total,
            started.elapsed().as_secs_f64()
        );
        paths.insert(reference, path.to_string_lossy().into_owned());
    }
    println!("BOXLITE_IMAGE_DISKS={}", serde_json::to_string(&paths)?);
    Ok(())
}
