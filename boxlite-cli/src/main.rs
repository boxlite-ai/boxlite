mod cli;
mod commands;

use clap::Parser;
use cli::Cli;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Set default BOXLITE_RUNTIME_DIR from compile-time value if not already set
    // SAFETY: Called early in main before spawning threads
    if std::env::var("BOXLITE_RUNTIME_DIR").is_err()
        && let Some(runtime_dir) = option_env!("BOXLITE_RUNTIME_DIR")
    {
        unsafe {
            std::env::set_var("BOXLITE_RUNTIME_DIR", runtime_dir);
        }
    }

    let cli = Cli::parse();

    // Initialize logging based on global flags
    if cli.global.debug {
        // SAFETY: We set this early in main, racing with other threads reading env is unlikely/acceptable for CLI tool
        unsafe {
            std::env::set_var("RUST_LOG", "debug");
        }
    }

    match cli.command {
        cli::Commands::Run(args) => commands::run::execute(args).await?,
    }

    Ok(())
}
