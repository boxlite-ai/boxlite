mod cli;
mod commands;
mod formatter;
pub mod terminal;
pub mod util;

use std::process;

use clap::Parser;
use cli::Cli;
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

fn main() {
    // Set default BOXLITE_RUNTIME_DIR from compile-time value if not already set
    // This MUST be done before starting tokio runtime and spawning threads
    if std::env::var("BOXLITE_RUNTIME_DIR").is_err()
        && let Some(runtime_dir) = option_env!("BOXLITE_RUNTIME_DIR")
    {
        unsafe {
            std::env::set_var("BOXLITE_RUNTIME_DIR", runtime_dir);
        }
    }

    // Start tokio runtime manually to ensure environment is set up safely
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to build tokio runtime");

    let _ = rt.block_on(run_cli());
}

async fn run_cli() -> anyhow::Result<()> {
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
        cli::Commands::Exec(args) => commands::exec::execute(args, &cli.global).await,
        cli::Commands::Create(args) => commands::create::execute(args, &cli.global).await,
        cli::Commands::List(args) => commands::list::execute(args, &cli.global).await,
        cli::Commands::Rm(args) => commands::rm::execute(args, &cli.global).await,
        cli::Commands::Start(args) => commands::start::execute(args, &cli.global).await,
        cli::Commands::Stop(args) => commands::stop::execute(args, &cli.global).await,
        cli::Commands::Restart(args) => commands::restart::execute(args, &cli.global).await,
        cli::Commands::Pull(args) => commands::pull::execute(args, &cli.global).await,
        cli::Commands::Images(args) => commands::images::execute(args, &cli.global).await,
        cli::Commands::Cp(args) => commands::cp::execute(args, &cli.global).await,
    };

    if let Err(error) = result {
        eprintln!("Error: {}", error);
        process::exit(1);
    }

    Ok(())
}
