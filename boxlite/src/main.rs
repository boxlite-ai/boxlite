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

    // Initialize logging based on global flags (placeholder)
    if cli.global.debug {
        // SAFETY: We set this early in main, racing with other threads reading env is unlikely/acceptable for CLI tool
        unsafe {
            std::env::set_var("RUST_LOG", "debug");
        }
    }

    match cli.command {
        Commands::Run(args) => cli::commands::container::run::execute(args).await?,
    }

    Ok(())
}
