mod cli;
mod commands;

use std::process;

use clap::Parser;
use cli::Cli;
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() {
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

    // Initialize tracing based on --debug flag
    let level = if cli.global.debug { "debug" } else { "info" };
    let env_filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new(level))
        .unwrap_or_else(|_| EnvFilter::new(level));

    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt::layer().with_writer(std::io::stderr))
        .init();

    let result = match cli.command {
        cli::Commands::Run(args) => commands::run::execute(args, &cli.global).await,
        cli::Commands::Rm(args) => commands::rm::execute(args, &cli.global).await,
    };

    if let Err(error) = result {
        eprintln!("Error: {}", error);
        process::exit(1);
    }
}
