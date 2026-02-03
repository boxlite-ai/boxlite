mod cli;
mod commands;
mod config;
mod formatter;
pub mod terminal;
pub mod util;

use std::process;

use clap::CommandFactory;
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

    let cli = Cli::parse();

    // Handle shell completion before starting tokio or tracing
    if let cli::Commands::Completion(args) = &cli.command {
        let mut cmd = Cli::command();
        cli::generate_completion(&args.shell, &mut cmd, "boxlite", &mut std::io::stdout());
        process::exit(0);
    }

    // Start tokio runtime manually to ensure environment is set up safely
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to build tokio runtime");

    let _ = rt.block_on(run_cli(cli));
}

async fn run_cli(cli: Cli) -> anyhow::Result<()> {
    // Initialize tracing based on --debug flag
    let level = if cli.global.debug { "debug" } else { "info" };
    let env_filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new(level))
        .unwrap_or_else(|_| EnvFilter::new(level));

    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt::layer().with_writer(std::io::stderr))
        .init();

    let global = cli.global;
    let result = match cli.command {
        cli::Commands::Run(args) => commands::run::execute(args, &global).await,
        cli::Commands::Exec(args) => commands::exec::execute(args, &global).await,
        cli::Commands::Create(args) => commands::create::execute(args, &global).await,
        cli::Commands::List(args) => commands::list::execute(args, &global).await,
        cli::Commands::Rm(args) => commands::rm::execute(args, &global).await,
        cli::Commands::Start(args) => commands::start::execute(args, &global).await,
        cli::Commands::Stop(args) => commands::stop::execute(args, &global).await,
        cli::Commands::Restart(args) => commands::restart::execute(args, &global).await,
        cli::Commands::Pull(args) => commands::pull::execute(args, &global).await,
        cli::Commands::Images(args) => commands::images::execute(args, &global).await,
        cli::Commands::Inspect(args) => commands::inspect::execute(args, &global).await,
        cli::Commands::Cp(args) => commands::cp::execute(args, &global).await,
        // Handled in main() before tokio; never reaches run_cli
        cli::Commands::Completion(_) => {
            unreachable!("completion subcommand is handled before tokio in main()")
        }
    };

    if let Err(error) = result {
        eprintln!("Error: {}", error);
        process::exit(1);
    }

    Ok(())
}
