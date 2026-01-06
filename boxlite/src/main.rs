use clap::{Parser, Subcommand};

mod cli;

use cli::flags::GlobalFlags;

#[derive(Parser, Debug)]
#[command(
    name = "boxlite",
    author,
    version,
    about = "BoxLite Container Runtime CLI"
)]
struct Cli {
    #[command(flatten)]
    global: GlobalFlags,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Create and run a new container from an image
    Run(cli::commands::container::run::RunArgs),
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    // Initialize logging based on global flags
    let mut filter = tracing_subscriber::EnvFilter::from_default_env();

    if cli.global.debug {
        // If --debug is set, force debug level globally
        // This overrides RUST_LOG if both are present, or extends it.
        // For simplicity, we create a new filter "debug"
        filter = tracing_subscriber::EnvFilter::new("debug");
    } else if std::env::var("RUST_LOG").is_err() {
        // If no RUST_LOG and no --debug, default to showing only warnings/errors from boxlite
        // and suppressing noisy external crates
        filter = tracing_subscriber::EnvFilter::new("boxlite=warn,error");
    }

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();

    match cli.command {
        Commands::Run(args) => cli::commands::container::run::execute(args, &cli.global).await?,
    }

    Ok(())
}
